import test from "node:test";
import assert from "node:assert/strict";
import worker, { protectedApi } from "../src/index.js";
import { config } from "../src/security.js";
import { consentPage, ownerCanRead, validateAuthRequest, oauthDefaultHandler, githubIdentity } from "../src/oauth.js";
import { oauthEnv } from "./fixtures.js";

const authRequest = (env) => ({ clientId: "registered-test-client", redirectUri: env.CHATGPT_REDIRECT_URIS, responseType: "code", resource: `${env.PUBLIC_BASE_URL}/mcp`, issuer: env.PUBLIC_BASE_URL, scope: ["discord:read", "offline_access"], codeChallenge: "TEST_ONLY_CHALLENGE", codeChallengeMethod: "S256", state: "TEST_ONLY_STATE" });
const request = (env, path, method = "GET", body) => new Request(env.PUBLIC_BASE_URL + path, { method, headers: { Host: "localhost:8787", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const context = () => ({ waitUntil() {} });

test("OAuth defaults fail closed without owner settings; no fallback to static token", () => {
  assert.throws(() => config({ DISCORD_BOT_TOKEN: "TEST_ONLY", ALLOWED_GUILD_IDS: "1", ALLOWED_HOSTNAMES: "localhost", MCP_ACCESS_TOKEN: "TEST_ONLY_LONG_ENOUGH_STATIC_FIXTURE" }));
  for (const field of ["OWNER_GITHUB_USER_ID", "GITHUB_CLIENT_SECRET", "GITHUB_CLIENT_ID", "PUBLIC_BASE_URL", "CHATGPT_REDIRECT_URIS", "OAUTH_KV"]) assert.throws(() => config({ ...oauthEnv(), [field]: "" }));
});
test("verified owner is required along with correct audience, expiry and read scope", async () => {
  const env = oauthEnv();
  const good = { props: { ownerGithubUserId: "123" }, auth: { userId: "123", audience: `${env.PUBLIC_BASE_URL}/mcp`, expiresAt: Date.now() / 1000 + 100, scope: ["discord:read"] } };
  assert.equal(ownerCanRead(env, good), true);
  const bad = [ {}, { ...good, props: { ownerGithubUserId: "456" } }, { ...good, auth: { ...good.auth, userId: "456" } }, { ...good, auth: { ...good.auth, scope: [] } }, { ...good, auth: { ...good.auth, audience: "https://evil.example/mcp" } }, { ...good, auth: { ...good.auth, expiresAt: 1 } } ];
  for (const ctx of bad) {
    assert.equal(ownerCanRead(env, ctx), false);
    for (const path of ["/mcp", "/mcp/attachments/2/3/4"]) assert.equal((await protectedApi(request(env, path), env, ctx, config(env))).status, 403);
  }
});
test("authorize validation refuses attacker redirects, missing PKCE and extra scope", () => {
  const env = oauthEnv(), good = authRequest(env);
  validateAuthRequest(good, env);
  for (const changes of [{ redirectUri: "https://evil.example/callback" }, { clientId: "https://evil.example/client.json" }, { codeChallengeMethod: "plain" }, { codeChallenge: undefined }, { resource: "https://evil.example/mcp" }, { scope: ["discord:write"] }]) assert.throws(() => validateAuthRequest({ ...good, ...changes }, env));
});
test("consent page escapes client and handle input and displays redirect destination", () => {
  const html = consentPage({ clientName: "<script>alert(1)</script>", redirectHost: "chatgpt.com", redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect" }, '" onfocus="evil');
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&#60;script&#62;"));
  assert.ok(html.includes("chatgpt.com"));
  assert.ok(html.includes('value="deny"'));
});
test("GitHub OAuth exchange is pinned, uses PKCE, discards its token after identity check", async () => {
  const env = oauthEnv(); let calls = 0;
  const identity = await githubIdentity("TEST_ONLY_CODE", "TEST_ONLY_VERIFIER", env, async (url, options) => {
    calls++;
    assert.equal(options.redirect, "manual");
    if (calls === 1) {
      assert.equal(url, "https://github.com/login/oauth/access_token");
      assert.equal(options.body.get("code_verifier"), "TEST_ONLY_VERIFIER");
      return Response.json({ access_token: "TEST_ONLY_UPSTREAM_TOKEN" });
    }
    assert.equal(url, "https://api.github.com/user");
    assert.equal(options.headers.Authorization, "Bearer TEST_ONLY_UPSTREAM_TOKEN");
    return Response.json({ id: 123, login: "untrusted-display-name" });
  });
  assert.equal(identity, "123");
});
test("callback denies non-owner without creating a grant", async () => {
  const env = oauthEnv(); let completed = false;
  env.OAUTH_PROVIDER = {
    finishUpstream: async () => ({ request: authRequest(env), data: { verifier: "TEST_ONLY_VERIFIER" }, headers: new Headers() }),
    completeAuthorization: async () => { completed = true; throw new Error("must not be called"); }
  };
  let calls = 0;
  const fetcher = async () => ++calls === 1 ? Response.json({ access_token: "TEST_ONLY_UPSTREAM" }) : Response.json({ id: 456 });
  const response = await oauthDefaultHandler(fetcher).fetch(request(env, "/callback?code=TEST_ONLY_CODE&state=TEST_ONLY_STATE"), env);
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get("Location")).searchParams.get("error"), "access_denied");
  assert.equal(completed, false);
});
test("GitHub identity redirects are rejected without forwarding credentials", async () => {
  let calls = 0;
  await assert.rejects(githubIdentity("TEST_ONLY_CODE", "TEST_ONLY_VERIFIER", oauthEnv(), async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://evil.example/token" } });
  }), { code: "IDENTITY_UNAVAILABLE" });
  assert.equal(calls, 1);
});
test("callback grants only owner identity and never persists upstream token", async () => {
  const env = oauthEnv(); let completed;
  env.OAUTH_PROVIDER = {
    finishUpstream: async () => ({ request: authRequest(env), data: { verifier: "TEST_ONLY_VERIFIER" }, headers: new Headers() }),
    completeAuthorization: async (options) => { completed = options; return { redirectTo: env.CHATGPT_REDIRECT_URIS }; }
  };
  let calls = 0;
  const response = await oauthDefaultHandler(async () => ++calls === 1 ? Response.json({ access_token: "TEST_ONLY_UPSTREAM" }) : Response.json({ id: 123 })).fetch(request(env, "/callback?code=TEST_ONLY_CODE&state=TEST_ONLY_STATE"), env);
  assert.equal(response.status, 302);
  assert.deepEqual(completed.props, { ownerGithubUserId: "123" });
  assert.equal(JSON.stringify(completed).includes("TEST_ONLY_UPSTREAM"), false);
});
test("library discovery advertises resource, S256, CIMD and DCR; anonymous content is protected", async () => {
  const env = oauthEnv();
  const response = await worker.fetch(request(env, "/.well-known/oauth-authorization-server"), env, context());
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.ok(meta.code_challenge_methods_supported.includes("S256"));
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  assert.equal(meta.client_id_metadata_document_supported, true);
  assert.equal(meta.registration_endpoint, `${env.PUBLIC_BASE_URL}/oauth/register`);
  for (const path of ["/mcp", "/mcp/attachments/2/3/4"]) {
    const denied = await worker.fetch(request(env, path), env, context());
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("WWW-Authenticate"), /resource_metadata/);
  }
});
test("DCR rejects unapproved redirect destinations before any identity login", async () => {
  const env = oauthEnv();
  const response = await worker.fetch(request(env, "/oauth/register", "POST", { client_name: "attacker", redirect_uris: ["https://evil.example/callback"], token_endpoint_auth_method: "none" }), env, context());
  assert.equal(response.status, 400);
});
test("real helper refuses callback with missing browser-bound state", async () => {
  const env = oauthEnv();
  const response = await worker.fetch(request(env, "/callback?code=TEST_ONLY_CODE&state=forged"), env, context());
  assert.equal(response.status, 400);
  assert.equal([...env.OAUTH_KV.data.keys()].some((key) => key.startsWith("grant:")), false);
});
