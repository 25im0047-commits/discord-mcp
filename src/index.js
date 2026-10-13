import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./server.js";
import { DiscordReader } from "./discord.js";
import { config, publicError, validBearer, validateRequestLocation } from "./security.js";
import { createOAuthHandlers, ownerCanRead } from "./oauth.js";

const reply = (body, status, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
});

export async function protectedApi(request, env, ctx, settings) {
    if (settings.mode === "oauth" && !ownerCanRead(env, ctx)) return reply({ error: "owner_read_access_required" }, 403);
    const url = new URL(request.url);
    const attachmentRoute = /^\/mcp\/attachments\/([0-9]{1,20})\/([0-9]{1,20})\/([0-9]{1,20})$/.exec(url.pathname);
    if (url.pathname !== "/mcp" && !attachmentRoute) return reply({ error: "not_found" }, 404);
    if (attachmentRoute) {
      if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405, { Allow: "GET" });
      try { return await new DiscordReader(env).attachmentDownload(...attachmentRoute.slice(1)); }
      catch (error) { return reply(publicError(error), 400); }
    }
    try {
      const handler = createMcpHandler(() => createServer(env, undefined, url.origin), {
        route: "/mcp", corsOptions: false,
        allowedHostnames: [...settings.hosts],
        // Exact scheme/host/port Origins have already been checked above.
        allowedOriginHostnames: [...settings.origins].map((origin) => new URL(origin).hostname)
      });
      const response = await handler(request, env, ctx);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch { return reply({ error: "mcp_request_failed" }, 500); }
}

export default {
  async fetch(request, env, ctx) {
    let settings;
    try { settings = config(env); }
    catch { return reply({ error: "owner_configuration_required" }, 503); }
    if (!validateRequestLocation(request, settings)) return reply({ error: "forbidden_origin_or_host" }, 403);
    const path = new URL(request.url).pathname;
    if (settings.mode === "bearer") {
      if (path !== "/mcp" && !path.startsWith("/mcp/attachments/")) return reply({ error: "not_found" }, 404);
      if (!await validBearer(request, env.MCP_ACCESS_TOKEN)) return reply({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
      return protectedApi(request, env, ctx, settings);
    }
    const provider = createOAuthHandlers(env, { fetch: (req, bindings, context) => protectedApi(req, bindings, context, settings) });
    try {
      const response = await provider.fetch(request, env, ctx);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch { return reply({ error: "authorization_unavailable" }, 503); }
  }
};
