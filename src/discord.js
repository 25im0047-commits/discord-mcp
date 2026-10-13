import { csv, SafeError, snowflake } from "./security.js";

const API = "https://discord.com/api/v10";
const THREAD_TYPES = new Set([10, 11, 12]);
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

export class DiscordReader {
  constructor(env, fetcher = (input, init) => fetch(input, init)) {
    this.token = env.DISCORD_BOT_TOKEN;
    this.guilds = csv(env.ALLOWED_GUILD_IDS);
    this.channels = csv(env.ALLOWED_CHANNEL_IDS);
    this.dms = csv(env.ALLOWED_DM_CHANNEL_IDS);
    this.dmUsers = csv(env.ALLOWED_DM_USER_IDS);
    this.fetcher = fetcher;
    // Lifetime is one MCP request; do not retain permissions across tool calls.
    this.channelCache = new Map();
    this.routeBuckets = new Map();
    this.cooldowns = new Map();
  }

  // Only fixed GET routes are exposed; no generic API proxy or Discord writes.
  async get(path, query = {}) {
    const url = new URL(API + path);
    const major = /^\/(channels|guilds)\/([0-9]+)/.exec(path);
    const routeKey = path.replace(/\/[0-9]+/g, "/:id") + `:${major?.[2] ?? ""}`;
    const bucketKey = this.routeBuckets.get(routeKey) ?? routeKey;
    const remainingDelay = (this.cooldowns.get(bucketKey) ?? 0) - Date.now();
    if (remainingDelay > 0) throw new SafeError("RATE_LIMITED", "Retry this operation after the indicated delay.", { retry_after_seconds: Math.ceil(remainingDelay / 1000) });
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    let response;
    try {
      response = await this.fetcher(url, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bot ${this.token}`, "User-Agent": "DiscordBot (https://developers.cloudflare.com/, 0.1.0)" }
      });
    } catch { throw new SafeError("DISCORD_UNAVAILABLE", "Discord request timed out or failed."); }
    if (response.status === 202 || response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const retry = Number(body.retry_after ?? response.headers.get("Retry-After") ?? 1);
      throw new SafeError(response.status === 202 ? "INDEX_PENDING" : "RATE_LIMITED", "Retry this operation after the indicated delay.", { retry_after_seconds: Number.isFinite(retry) ? Math.max(1, retry) : 1 });
    }
    const bucket = response.headers.get("X-RateLimit-Bucket");
    const key = bucket ? `${bucket}:${major?.[2] ?? ""}` : routeKey;
    this.routeBuckets.set(routeKey, key);
    if (response.headers.get("X-RateLimit-Remaining") === "0") {
      const seconds = Number(response.headers.get("X-RateLimit-Reset-After"));
      if (Number.isFinite(seconds) && seconds > 0) this.cooldowns.set(key, Date.now() + seconds * 1000);
    }
    if (!response.ok) {
      const codes = { 401: "BOT_AUTH_FAILED", 403: "DISCORD_ACCESS_DENIED", 404: "DISCORD_NOT_FOUND" };
      throw new SafeError(codes[response.status] || "DISCORD_ERROR", "Discord could not return this resource.", { status: response.status });
    }
    return response.json();
  }

  requireGuild(id) {
    snowflake(id);
    if (!this.guilds.has(id)) throw new SafeError("NOT_ALLOWED", "Guild is outside the configured allowlist.");
  }

  async allowedChannel(id) {
    snowflake(id);
    if (this.channelCache.has(id)) return this.channelCache.get(id);
    const channel = await this.get(`/channels/${id}`);
    if (channel.type === 1) {
      if (!this.dms.has(id) || !this.dmUsers.size || !channel.recipients?.length || channel.recipients.some((r) => !this.dmUsers.has(r.id))) {
        throw new SafeError("NOT_ALLOWED", "Only explicitly allowed users' DM channels with this Bot are supported.");
      }
      this.channelCache.set(id, channel);
      return channel;
    }
    if (!channel.guild_id) throw new SafeError("NOT_ALLOWED", "Personal/group DMs are not supported.");
    this.requireGuild(channel.guild_id);
    if (this.channels.size && !this.channels.has(id)) {
      if (!THREAD_TYPES.has(channel.type) || !this.channels.has(channel.parent_id)) {
        throw new SafeError("NOT_ALLOWED", "Channel is outside the configured allowlist.");
      }
    }
    this.channelCache.set(id, channel);
    return channel;
  }

  async listChannels(guildId) {
    this.requireGuild(guildId);
    const channels = await this.get(`/guilds/${guildId}/channels`);
    return channels.filter((c) => !this.channels.size || this.channels.has(c.id)).map(({ id, name, type, parent_id, nsfw }) => ({ id, name, type, parent_id, nsfw }));
  }

  async messages(channelId, { limit = 50, before, after } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SafeError("INVALID_LIMIT", "Message limit must be 1–100.");
    if (before && after) throw new SafeError("INVALID_CURSOR", "Use only before or after.");
    if (before) snowflake(before);
    if (after) snowflake(after);
    const channel = await this.allowedChannel(channelId);
    const messages = await this.get(`/channels/${channelId}/messages`, { limit, before, after });
    return {
      messages: messages.map((m) => this.messageView(m, channel.guild_id)),
      next_before: messages.length ? messages.at(-1).id : null,
      // A full page may have more results; a short page ends ordinary history pagination.
      has_more: messages.length === limit,
      coverage: "This page only; repeat with before to read older history. Deleted or inaccessible messages cannot be recovered.",
      content_note: "Empty content/attachments can mean no content or missing Message Content Intent; absence alone is not proof of no attachment."
    };
  }

  async message(channelId, messageId) {
    snowflake(messageId);
    const channel = await this.allowedChannel(channelId);
    return this.messageView(await this.get(`/channels/${channelId}/messages/${messageId}`), channel.guild_id);
  }

  messageView(m, guildId) {
    return {
      id: m.id, channel_id: m.channel_id, guild_id: guildId ?? null,
      author: { id: m.author?.id, username: m.author?.username, bot: m.author?.bot ?? false },
      content: m.content ?? "", timestamp: m.timestamp, edited_timestamp: m.edited_timestamp,
      source_url: `https://discord.com/channels/${guildId ?? "@me"}/${m.channel_id}/${m.id}`,
      attachments: (m.attachments ?? []).map(({ id, filename, content_type, size, description }) => ({ id, filename, content_type, size, description })),
      embeds: m.embeds ?? [], referenced_message_id: m.message_reference?.message_id ?? null,
      thread_id: m.thread?.id ?? null,
      untrusted_content: true
    };
  }

  async activeThreads(guildId) {
    this.requireGuild(guildId);
    const result = await this.get(`/guilds/${guildId}/threads/active`);
    return { threads: result.threads.filter((t) => !this.channels.size || this.channels.has(t.id) || this.channels.has(t.parent_id)), coverage: "All currently accessible active threads only. Archived threads require separate calls." };
  }

  async archivedThreads(channelId, { kind = "public", before, limit = 50 } = {}) {
    if (!["public", "joined_private"].includes(kind)) throw new SafeError("INVALID_KIND", "Only public or joined_private archived threads are supported.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SafeError("INVALID_LIMIT", "Thread limit must be 1–100.");
    const channel = await this.allowedChannel(channelId);
    if (!channel.guild_id) throw new SafeError("INVALID_CHANNEL", "Threads require a guild channel.");
    if (before && kind === "joined_private") snowflake(before);
    if (before && kind === "public" && !Number.isFinite(Date.parse(before))) throw new SafeError("INVALID_CURSOR", "Public archived before must be an ISO timestamp.");
    const route = kind === "public" ? `/channels/${channelId}/threads/archived/public` : `/channels/${channelId}/users/@me/threads/archived/private`;
    const result = await this.get(route, { before, limit });
    const threads = result.threads.filter((t) => !this.channels.size || this.channels.has(channelId) || this.channels.has(t.id));
    const last = result.threads.at(-1);
    return { threads, has_more: result.has_more, next_before: last ? kind === "public" ? last.thread_metadata.archive_timestamp : last.id : null };
  }

  async search(guildId, { content, channel_ids = [], limit = 25, offset = 0, min_id, max_id } = {}) {
    this.requireGuild(guildId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isInteger(offset) || offset < 0 || offset > 9975) throw new SafeError("INVALID_SEARCH", "Search limit must be 1–25 and offset 0–9975.");
    if (content && (typeof content !== "string" || content.length > 1024)) throw new SafeError("INVALID_SEARCH", "Search text must be at most 1024 characters.");
    if (min_id) snowflake(min_id);
    if (max_id) snowflake(max_id);
    const ids = channel_ids.length ? channel_ids : [...this.channels];
    if (ids.length > 500) throw new SafeError("INVALID_SEARCH", "At most 500 channel filters are supported.");
    // Search must never escape an explicitly configured channel scope.
    for (const id of ids) {
      const channel = await this.allowedChannel(id);
      if (channel.guild_id !== guildId) throw new SafeError("NOT_ALLOWED", "Search channels must belong to the selected guild.");
    }
    const result = await this.get(`/guilds/${guildId}/messages/search`, { content, "channel_id": ids.length ? ids : undefined, limit, offset, min_id, max_id });
    const messages = [];
    for (const m of result.messages.flat()) {
      // Recheck each returned channel, including threads, against owner allowlists.
      const c = await this.allowedChannel(m.channel_id);
      if (c.guild_id !== guildId) throw new SafeError("NOT_ALLOWED", "Discord returned an unexpected guild.");
      messages.push(this.messageView(m, guildId));
    }
    return { messages, total_results: result.total_results, next_offset: offset + limit <= 9975 ? offset + limit : null,
      coverage: "Indexed search results only; counts and short pages do not prove completeness. Use time ranges for older results." };
  }

  async attachmentSource(channelId, messageId, attachmentId) {
    snowflake(messageId); snowflake(attachmentId);
    await this.allowedChannel(channelId);
    const message = await this.get(`/channels/${channelId}/messages/${messageId}`);
    const attachment = message.attachments?.find((a) => a.id === attachmentId);
    if (!attachment) throw new SafeError("ATTACHMENT_NOT_FOUND", "Attachment was not present in this accessible message.");
    const url = new URL(attachment.url);
    if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com" || url.port || url.username || url.password || !url.pathname.startsWith(`/attachments/${channelId}/${attachmentId}/`)) {
      throw new SafeError("UNSAFE_ATTACHMENT_URL", "Attachment URL is not an expected Discord CDN path.");
    }
    return { attachment, url };
  }

  async attachmentResponse(channelId, messageId, attachmentId, { inline = false } = {}) {
    const { attachment, url } = await this.attachmentSource(channelId, messageId, attachmentId);
    if (inline && attachment.size > MAX_ATTACHMENT_BYTES) throw new SafeError("ATTACHMENT_TOO_LARGE", "Inline attachment retrieval is limited to 2 MiB. Use the authenticated download endpoint for larger files.");
    let response;
    try {
      // No Bot or MCP credentials may be forwarded to the CDN. Redirects forbidden.
      response = await this.fetcher(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000) });
    } catch { throw new SafeError("ATTACHMENT_UNAVAILABLE", "Attachment fetch failed."); }
    if (!response.ok || !response.body) throw new SafeError("ATTACHMENT_UNAVAILABLE", "Attachment is unavailable. Refetch the message if its signed URL expired.");
    return { attachment, response };
  }

  async attachmentDownload(channelId, messageId, attachmentId) {
    const { attachment, response } = await this.attachmentResponse(channelId, messageId, attachmentId);
    // Stream original bytes without loading the complete file into Worker memory.
    return new Response(response.body, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename || "attachment")}`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"
    } });
  }

  async attachment(channelId, messageId, attachmentId) {
    const { attachment, response } = await this.attachmentResponse(channelId, messageId, attachmentId, { inline: true });
    if (Number(response.headers.get("Content-Length")) > MAX_ATTACHMENT_BYTES) {
      await response.body.cancel();
      throw new SafeError("ATTACHMENT_TOO_LARGE", "Attachment exceeded the 2 MiB inline limit.");
    }
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_ATTACHMENT_BYTES) { await reader.cancel(); throw new SafeError("ATTACHMENT_TOO_LARGE", "Attachment exceeded the 2 MiB inline limit."); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { uri: `discord-attachment://${channelId}/${messageId}/${attachmentId}`, mimeType: attachment.content_type || "application/octet-stream", blob: btoa(binary) };
  }
}
