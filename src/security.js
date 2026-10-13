export class SafeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function csv(value = "") {
  return new Set(value.split(",").map((v) => v.trim()).filter(Boolean));
}

export function snowflake(value) {
  if (typeof value !== "string" || !/^[0-9]{1,20}$/.test(value) || BigInt(value) <= 0n || BigInt(value) > 18446744073709551615n) {
    throw new SafeError("INVALID_ID", "Discord IDs must be decimal snowflake strings.");
  }
  return value;
}

export function config(env) {
  const result = {
    guilds: csv(env.ALLOWED_GUILD_IDS), channels: csv(env.ALLOWED_CHANNEL_IDS),
    dms: csv(env.ALLOWED_DM_CHANNEL_IDS), dmUsers: csv(env.ALLOWED_DM_USER_IDS),
    origins: csv(env.ALLOWED_ORIGINS), hosts: csv(env.ALLOWED_HOSTNAMES)
  };
  for (const list of [result.guilds, result.channels, result.dms, result.dmUsers]) {
    for (const id of list) snowflake(id);
  }
  if (!env.DISCORD_BOT_TOKEN || !result.hosts.size) {
    throw new SafeError("NOT_CONFIGURED", "Required secrets and host allowlist must be configured by the owner.");
  }
  if (!result.guilds.size && !result.dms.size) {
    throw new SafeError("NOT_CONFIGURED", "An explicit guild or Bot DM allowlist is required.");
  }
  result.mode = env.AUTH_MODE || "oauth";
  if (result.mode === "bearer") {
    if (!env.MCP_ACCESS_TOKEN || env.MCP_ACCESS_TOKEN.length < 32) throw new SafeError("NOT_CONFIGURED", "Bearer mode requires a separate MCP token.");
  } else if (result.mode === "oauth") {
    const base = new URL(env.PUBLIC_BASE_URL || "https://invalid.example");
    if (!env.PUBLIC_BASE_URL || base.origin !== env.PUBLIC_BASE_URL || !result.hosts.has(base.hostname) || !["https:", "http:"].includes(base.protocol) || (base.protocol === "http:" && !["localhost", "127.0.0.1"].includes(base.hostname))) throw new SafeError("NOT_CONFIGURED", "OAuth requires the exact canonical public origin.");
    result.origins.add(base.origin);
    if (!env.OWNER_GITHUB_USER_ID || !/^[1-9][0-9]*$/.test(env.OWNER_GITHUB_USER_ID) || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.OAUTH_KV?.get || !env.OAUTH_KV?.put) throw new SafeError("NOT_CONFIGURED", "Owner ID, GitHub OAuth settings and OAUTH_KV are required.");
    if (!csv(env.CHATGPT_REDIRECT_URIS).size) throw new SafeError("NOT_CONFIGURED", "Exact ChatGPT redirect URIs are required.");
  } else throw new SafeError("NOT_CONFIGURED", "AUTH_MODE must be oauth or bearer.");
  return result;
}

// Fixed-length digest comparison avoids prefix-dependent comparisons of secret strings.
export async function validBearer(request, secret) {
  const value = request.headers.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  if (!match || !secret || match[1].length > 1024) return false;
  const digest = async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [actual, expected] = await Promise.all([digest(match[1]), digest(secret)]);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

export function validateRequestLocation(request, settings) {
  const url = new URL(request.url);
  if (!settings.hosts.has(url.hostname)) return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true; // Native MCP clients do not send Origin.
  try {
    const parsed = new URL(origin);
    return ["https:", "http:"].includes(parsed.protocol) && origin === parsed.origin && settings.origins.has(origin);
  } catch { return false; }
}

export function publicError(error) {
  if (error instanceof SafeError) return { code: error.code, message: error.message, ...error.details };
  return { code: "INTERNAL_ERROR", message: "Operation failed. No Discord data or credentials were logged." };
}
