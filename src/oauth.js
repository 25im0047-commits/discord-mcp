import { OAuthProvider, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { csv, SafeError } from "./security.js";

export const READ_SCOPE = "discord:read";
const GRANTED_SCOPES = [READ_SCOPE, "offline_access"];
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const safeResponse = (message, status = 400, headers = {}) => new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });

export function ownerCanRead(env, ctx) {
  // These fields must come from OAuthProvider's validated token, never the request.
  return !!env.OWNER_GITHUB_USER_ID && ctx?.props?.ownerGithubUserId === env.OWNER_GITHUB_USER_ID && ctx.auth?.userId === env.OWNER_GITHUB_USER_ID && ctx.auth?.audience === `${env.PUBLIC_BASE_URL}/mcp` && ctx.auth?.scope?.includes(READ_SCOPE) && Number(ctx.auth?.expiresAt) > Date.now() / 1000;
}

export function validateAuthRequest(authRequest, env) {
  if (!csv(env.CHATGPT_REDIRECT_URIS).has(authRequest.redirectUri)) throw new SafeError("CLIENT_DENIED", "Client redirect URI is not allowed.");
  if (/^https?:/.test(authRequest.clientId) && !csv(env.CHATGPT_CLIENT_METADATA_URLS).has(authRequest.clientId)) throw new SafeError("CLIENT_DENIED", "Client metadata URL is not allowed.");
  if (authRequest.codeChallengeMethod !== "S256" || !authRequest.codeChallenge) throw new SafeError("PKCE_REQUIRED", "S256 PKCE is required for every client.");
  if (authRequest.resource !== `${env.PUBLIC_BASE_URL}/mcp`) throw new SafeError("INVALID_AUDIENCE", "OAuth resource must match this MCP endpoint.");
  if (authRequest.scope.some((s) => !GRANTED_SCOPES.includes(s))) throw new SafeError("INVALID_SCOPE", "Only Discord read access and refresh access can be granted.");
}

export function consentPage(details, handle) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Discord MCP 接続許可</title>
<body><h1>Discord MCP の読み取りを許可</h1>
<p>接続クライアント: <strong>${escape(details.clientName)}</strong></p>
<p>${details.clientDomain ? `クライアントの公開ドメイン: ${escape(details.clientDomain)}` : "クライアント名は自己申告です。名前だけでは本人性を保証しません。"}</p>
<p>戻り先: <strong>${escape(details.redirectHost)}</strong><br>${escape(details.redirectUri)}</p>
<p>この接続から、設定済みのサーバー・スレッド・添付・Bot 自身への許可された DM を読み取れるようになります。</p>
<p>許可内容: discord:read（読み取り）、offline_access（再接続用の更新）。投稿や削除は行いません。通常の人同士の DM は取得しません。</p>
<p>続行後、GitHub で本人確認します。設定した所有者以外は利用できません。</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">許可して GitHub で本人確認</button> <button name="decision" value="deny">拒否</button></form></body></html>`;
}

async function s256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function githubIdentity(code, verifier, env, fetcher = (input, init) => fetch(input, init)) {
  const response = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, code_verifier: verifier, redirect_uri: `${env.PUBLIC_BASE_URL}/callback` })
  });
  if (!response.ok) throw new SafeError("IDENTITY_UNAVAILABLE", "GitHub identity verification failed.");
  const token = await response.json();
  if (!token.access_token || token.error) throw new SafeError("IDENTITY_UNAVAILABLE", "GitHub identity verification failed.");
  const profile = await fetcher("https://api.github.com/user", {
    method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "discord-mcp-owner-auth" }
  });
  if (!profile.ok) throw new SafeError("IDENTITY_UNAVAILABLE", "GitHub identity verification failed.");
  const user = await profile.json();
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new SafeError("IDENTITY_UNAVAILABLE", "GitHub returned an invalid user identity.");
  // Do not return or persist the GitHub access token. It is not a Discord credential.
  return String(user.id);
}

export function oauthDefaultHandler(fetcher) {
  return {
    async fetch(req, bindings) {
      const url = new URL(req.url);
      const oauth = bindings.OAUTH_PROVIDER;
      try {
        if (url.pathname === "/authorize" && req.method === "GET") {
          // Restrict URL-form client IDs before the library performs a metadata fetch.
          const clientId = url.searchParams.get("client_id") || "";
          if (/^https?:/.test(clientId) && !csv(bindings.CHATGPT_CLIENT_METADATA_URLS).has(clientId)) return safeResponse("Client is not allowed.", 403);
          const original = await oauth.parseAuthRequest(req);
          validateAuthRequest(original, bindings);
          const details = await oauth.describeConsent(original);
          const consent = await oauth.beginConsent(original);
          consent.headers.set("Content-Type", "text/html; charset=utf-8");
          return new Response(consentPage(details, consent.handle), { headers: consent.headers });
        }
        if (url.pathname === "/authorize" && req.method === "POST") {
          const form = await req.formData();
          const handle = String(form.get("handle") || "");
          if (form.get("decision") !== "approve") {
            const denied = await oauth.denyConsent(req, handle);
            return new Response(null, { status: 302, headers: denied.headers });
          }
          const approved = await oauth.approveConsent(req, handle, { scope: GRANTED_SCOPES });
          validateAuthRequest(approved.request, bindings);
          // Generated only at runtime after owner deployment; never by the preparation agent.
          const verifier = crypto.randomUUID() + crypto.randomUUID();
          const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
          const target = new URL("https://github.com/login/oauth/authorize");
          target.search = new URLSearchParams({ client_id: bindings.GITHUB_CLIENT_ID, redirect_uri: `${bindings.PUBLIC_BASE_URL}/callback`, scope: "", state: upstream.state, code_challenge: await s256(verifier), code_challenge_method: "S256", allow_signup: "false", prompt: "select_account" }).toString();
          upstream.headers.set("Location", target.href);
          return new Response(null, { status: 302, headers: upstream.headers });
        }
        if (url.pathname === "/callback" && req.method === "GET") {
          const resumed = await oauth.finishUpstream(req); // Browser cookie, state, TTL and single-use validation.
          validateAuthRequest(resumed.request, bindings);
          if (url.searchParams.has("error") || !url.searchParams.get("code")) {
            resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied"));
            return new Response(null, { status: 302, headers: resumed.headers });
          }
          const userId = await githubIdentity(url.searchParams.get("code"), resumed.data.verifier, bindings, fetcher);
          if (userId !== bindings.OWNER_GITHUB_USER_ID) {
            // Crucially no grant or token is issued for any non-owner.
            resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied", "Only the configured owner may connect."));
            return new Response(null, { status: 302, headers: resumed.headers });
          }
          const { redirectTo } = await oauth.completeAuthorization({ request: resumed.request, userId, scope: resumed.request.scope, metadata: {}, props: { ownerGithubUserId: userId } });
          resumed.headers.set("Location", redirectTo);
          return new Response(null, { status: 302, headers: resumed.headers });
        }
        return safeResponse("Not found.", 404);
      } catch {
        // Do not echo OAuth codes, upstream responses, secrets or untrusted redirects.
        return safeResponse("Authorization failed or expired. Start again from ChatGPT.", 400);
      }
    }
  };
}

export function createOAuthHandlers(env, apiHandler, fetcher) {
  return new OAuthProvider({
    apiRoute: "/mcp", apiHandler, defaultHandler: oauthDefaultHandler(fetcher),
    authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
    resourceMetadata: { resource: `${env.PUBLIC_BASE_URL}/mcp`, authorization_servers: [env.PUBLIC_BASE_URL] },
    requiredScopes: [READ_SCOPE], scopesSupported: GRANTED_SCOPES,
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationCallback: ({ clientMetadata }) => {
      const redirects = clientMetadata.redirect_uris;
      if (!Array.isArray(redirects) || !redirects.length || !redirects.every((uri) => csv(env.CHATGPT_REDIRECT_URIS).has(uri))) return { code: "invalid_redirect_uri", description: "Only configured ChatGPT redirect URIs are allowed." };
    },
    onError: () => {} // No request/code/token or detailed upstream errors in logs.
  });
}
