import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Entire flow runs locally in workerd with mock GitHub/Discord endpoints.
// Ephemeral OAuth test grants live only in Miniflare KV and are never printed.
const origin = "https://discord-mcp.test";
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
let identity = 456;
let discordCalls = 0;
let identityCalls = 0;
let redirectIdentity = false;
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: "dist/index.js", compatibilityDate: "2026-10-13",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  kvNamespaces: ["OAUTH_KV"],
  // Miniflare's local dispatcher keeps a loopback Host header even with a virtual URL.
  // Permit loopback only in this fixture; production config uses the exact Worker host.
  bindings: { AUTH_MODE: "oauth", PUBLIC_BASE_URL: origin, OWNER_GITHUB_USER_ID: "123", GITHUB_CLIENT_ID: "TEST_ONLY_CLIENT", GITHUB_CLIENT_SECRET: "TEST_ONLY_SECRET", DISCORD_BOT_TOKEN: "TEST_ONLY_BOT", ALLOWED_GUILD_IDS: "1", ALLOWED_HOSTNAMES: "discord-mcp.test,127.0.0.1", CHATGPT_REDIRECT_URIS: redirect, CHATGPT_CLIENT_METADATA_URLS: "https://chatgpt.com/oauth/client.json" },
  outboundService: async (req) => {
    const url = new URL(req.url);
    if (url.href === "https://github.com/login/oauth/access_token") { identityCalls++; return redirectIdentity ? new Response(null, { status: 302, headers: { Location: "https://untrusted.test/token" } }) : Response.json({ access_token: "TEST_ONLY_UPSTREAM" }); }
    if (url.href === "https://api.github.com/user") return Response.json({ id: identity });
    if (url.href === "https://discord.com/api/v10/guilds/1/channels") {
      discordCalls++;
      assert.equal(req.method, "GET");
      assert.equal(req.headers.get("Authorization"), "Bot TEST_ONLY_BOT");
      return Response.json([{ id: "2", guild_id: "1", type: 0, name: "fixture" }]);
    }
    throw new Error("Unexpected outbound request; real network is disabled by the fixture.");
  }
}));

const send = (path, options = {}) => mf.dispatchFetch(origin + path, { ...options, headers: { Host: new URL(origin).hostname, ...options.headers }, redirect: "manual" });
const verifier = "TEST_ONLY_PKCE_VERIFIER_012345678901234567890123456789";
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
const challenge = Buffer.from(digest).toString("base64url");
function keepCookies(response, jar) {
  const headers = response.headers.getSetCookie();
  for (const value of headers) {
    const pair = value.split(";")[0];
    jar.set(pair.slice(0, pair.indexOf("=")), pair);
  }
}

try {
  const metadata = await send("/.well-known/oauth-authorization-server");
  assert.equal(metadata.status, 200);
  const meta = await metadata.json();
  assert.ok(meta.code_challenge_methods_supported.includes("S256"));
  assert.equal(meta.client_id_metadata_document_supported, true);
  assert.equal((await send("/mcp")).status, 401);
  assert.equal((await send("/mcp/attachments/2/3/4")).status, 401);
  assert.equal((await send("/mcp", { headers: { Authorization: "Bearer TEST_ONLY_INVALID_TOKEN" } })).status, 401);
  const registered = await send("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Local test", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  assert.equal(registered.status, 201);
  const client = await registered.json();

  async function authorize({ callbackStatus = 302 } = {}) {
    const jar = new Map();
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, scope: "discord:read offline_access", state: "TEST_ONLY_CLIENT_STATE", resource: `${origin}/mcp`, code_challenge: challenge, code_challenge_method: "S256" });
    const page = await send(`/authorize?${params}`);
    assert.equal(page.status, 200);
    keepCookies(page, jar);
    const handle = /name="handle" value="([^"]+)"/.exec(await page.text())?.[1];
    assert.ok(handle);
    const approve = await send("/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: [...jar.values()].join("; "), Origin: origin }, body: new URLSearchParams({ handle, decision: "approve" }).toString() });
    assert.equal(approve.status, 302);
    keepCookies(approve, jar);
    const upstream = new URL(approve.headers.get("Location"));
    assert.equal(upstream.hostname, "github.com");
    assert.equal(upstream.searchParams.get("code_challenge_method"), "S256");
    const callback = await send(`/callback?${new URLSearchParams({ code: "TEST_ONLY_GITHUB_CODE", state: upstream.searchParams.get("state") })}`, { headers: { Cookie: [...jar.values()].join("; ") } });
    assert.equal(callback.status, callbackStatus, `Unexpected callback status; mocked identity calls: ${identityCalls}`);
    if (callbackStatus !== 302) return null;
    return new URL(callback.headers.get("Location"));
  }

  const denied = await authorize();
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("code"), null);
  assert.equal(discordCalls, 0);
  const kv = await mf.getKVNamespace("OAUTH_KV");
  assert.equal((await kv.list({ prefix: "grant:" })).keys.length, 0);

  redirectIdentity = true;
  await authorize({ callbackStatus: 400 });
  assert.equal((await kv.list({ prefix: "grant:" })).keys.length, 0);
  redirectIdentity = false;

  identity = 123;
  const allowed = await authorize();
  assert.equal(allowed.searchParams.get("iss"), origin);
  const code = allowed.searchParams.get("code");
  assert.ok(code);
  const exchange = (resource, proof = verifier) => send("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: proof, redirect_uri: redirect, resource }).toString() });
  assert.equal((await exchange("https://wrong.example/mcp")).status, 400);
  assert.equal((await exchange(`${origin}/mcp`, "TEST_ONLY_INCORRECT_VERIFIER_01234567890123456789")).status, 400);
  const tokenResponse = await exchange(`${origin}/mcp`);
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.ok(token.access_token);
  const tool = await send("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "discord_list_channels", arguments: { guild_id: "1" } } }) });
  if (tool.status !== 200) throw new Error(`MCP tool denied (${tool.status}): ${await tool.text()}`);
  const raw = await tool.text();
  const result = JSON.parse(tool.headers.get("Content-Type").includes("text/event-stream") ? raw.split("\n").find((line) => line.startsWith("data: ")).slice(6) : raw);
  assert.equal(result.result.isError, undefined);
  assert.equal(JSON.parse(result.result.content[0].text)[0].id, "2");
  assert.equal(discordCalls, 1);
  console.log("workerd OAuth smoke passed: discovery, DCR, browser consent/state, non-owner denial, owner PKCE exchange, audience rejection, authenticated read-only tool.");
} finally {
  await mf.dispose();
}
