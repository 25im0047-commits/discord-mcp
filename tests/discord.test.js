import test from "node:test";
import assert from "node:assert/strict";
import { DiscordReader, MAX_ATTACHMENT_BYTES } from "../src/discord.js";
import { TODO_INSTRUCTIONS } from "../src/server.js";

const env = { DISCORD_BOT_TOKEN: "TEST_ONLY_BOT_FIXTURE", ALLOWED_GUILD_IDS: "1", ALLOWED_CHANNEL_IDS: "2", ALLOWED_DM_CHANNEL_IDS: "8", ALLOWED_DM_USER_IDS: "9" };
const message = { id: "3", channel_id: "2", content: "明日までに資料を確認します", author: { id: "9", username: "fixture" }, timestamp: "2026-10-13T00:00:00Z", attachments: [] };
function mock(routes) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), options });
    const key = new URL(url).pathname;
    assert.ok(key in routes, `Unexpected request: ${url}`);
    const value = typeof routes[key] === "function" ? routes[key](url, options) : routes[key];
    return value instanceof Response ? value : new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetcher };
}
const channel = { id: "2", guild_id: "1", type: 0 };

test("unallowed guild fails before a guild request", async () => {
  const m = mock({});
  await assert.rejects(new DiscordReader(env, m.fetcher).listChannels("99"), { code: "NOT_ALLOWED" });
  assert.equal(m.calls.length, 0);
});
test("message pagination preserves evidence, attachments and ID strings", async () => {
  const m = mock({ "/api/v10/channels/2": channel, "/api/v10/channels/2/messages": [message] });
  const result = await new DiscordReader(env, m.fetcher).messages("2", { before: "10", limit: 1 });
  assert.equal(result.next_before, "3");
  assert.equal(result.has_more, true);
  assert.equal(result.messages[0].source_url, "https://discord.com/channels/1/2/3");
  assert.equal(result.messages[0].untrusted_content, true);
  assert.ok(m.calls[1].url.includes("before=10"));
  for (const c of m.calls) { assert.equal(c.options.method, "GET"); assert.equal(c.options.headers.Authorization, `Bot ${env.DISCORD_BOT_TOKEN}`); }
});
test("channel scope includes threads of an allowed parent only", async () => {
  const m = mock({ "/api/v10/channels/5": { id: "5", guild_id: "1", type: 11, parent_id: "2" }, "/api/v10/channels/6": { id: "6", guild_id: "1", type: 11, parent_id: "7" } });
  const reader = new DiscordReader(env, m.fetcher);
  assert.equal((await reader.allowedChannel("5")).id, "5");
  await assert.rejects(reader.allowedChannel("6"), { code: "NOT_ALLOWED" });
});
test("Bot DMs require both allowed channel and allowed recipient; group DMs fail", async () => {
  for (const c of [{ id: "8", type: 1, recipients: [{ id: "99" }] }, { id: "8", type: 3, recipients: [{ id: "9" }] }, { id: "8", type: 1 }]) {
    const m = mock({ "/api/v10/channels/8": c });
    await assert.rejects(new DiscordReader(env, m.fetcher).allowedChannel("8"), { code: "NOT_ALLOWED" });
  }
  const m = mock({ "/api/v10/channels/8": { id: "8", type: 1, recipients: [{ id: "9" }] } });
  assert.equal((await new DiscordReader(env, m.fetcher).allowedChannel("8")).type, 1);
});
test("202 index pending and 429 expose bounded retry instructions", async () => {
  for (const [status, code] of [[202, "INDEX_PENDING"], [429, "RATE_LIMITED"]]) {
    const m = mock({ "/api/v10/guilds/1/channels": new Response(JSON.stringify({ retry_after: 2 }), { status }) });
    await assert.rejects(new DiscordReader(env, m.fetcher).listChannels("1"), (e) => e.code === code && e.details.retry_after_seconds === 2);
    assert.equal(m.calls.length, 1);
  }
});
test("Discord 401/403/404 are useful errors without upstream body leaks", async () => {
  for (const status of [401, 403, 404]) {
    const m = mock({ "/api/v10/guilds/1/channels": new Response("sensitive upstream body", { status }) });
    await assert.rejects(new DiscordReader(env, m.fetcher).listChannels("1"), (e) => e.details.status === status && !e.message.includes("sensitive"));
  }
});
test("exhausted response bucket prevents immediate repeated route reads", async () => {
  const m = mock({ "/api/v10/guilds/1/channels": new Response("[]", { headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "5", "X-RateLimit-Bucket": "fixture" } }) });
  const reader = new DiscordReader(env, m.fetcher);
  await reader.listChannels("1");
  await assert.rejects(reader.listChannels("1"), { code: "RATE_LIMITED" });
  assert.equal(m.calls.length, 1);
});
test("joined private archive uses read-only route and correct cursor", async () => {
  const m = mock({ "/api/v10/channels/2": channel, "/api/v10/channels/2/users/@me/threads/archived/private": { threads: [{ id: "5", parent_id: "2" }], has_more: true } });
  const result = await new DiscordReader(env, m.fetcher).archivedThreads("2", { kind: "joined_private", before: "10" });
  assert.equal(result.next_before, "5");
  assert.equal(m.calls.at(-1).options.method, "GET");
});
test("official search filters configured channels and rechecks result channels", async () => {
  const m = mock({ "/api/v10/channels/2": channel, "/api/v10/guilds/1/messages/search": (url) => {
    assert.deepEqual(new URL(url).searchParams.getAll("channel_id"), ["2"]);
    return { messages: [[message]], total_results: 1 };
  } });
  const result = await new DiscordReader(env, m.fetcher).search("1", { content: "資料" });
  assert.equal(result.messages[0].id, "3");
  assert.match(result.coverage, /completeness/);
});
test("attachments are obtained from current allowed messages; CDN gets no credentials", async () => {
  const attachment = { id: "4", filename: "test.txt", size: 5, content_type: "text/plain", url: "https://cdn.discordapp.com/attachments/2/4/test.txt?ex=fixture" };
  const m = mock({ "/api/v10/channels/2": channel, "/api/v10/channels/2/messages/3": { ...message, attachments: [attachment] }, "/attachments/2/4/test.txt": (_url, options) => {
    assert.equal(options.headers, undefined); assert.equal(options.redirect, "manual"); return new Response("hello");
  } });
  const reader = new DiscordReader(env, m.fetcher);
  assert.equal((await reader.attachment("2", "3", "4")).blob, "aGVsbG8=");
  const download = await reader.attachmentDownload("2", "3", "4");
  assert.equal(await download.text(), "hello");
  assert.equal(download.headers.get("Content-Type"), "application/octet-stream");
});
test("attachment URL injection and declared/actual oversize fail closed", async () => {
  for (const url of ["https://evil.example/attachments/2/4/test.txt", "https://cdn.discordapp.com/attachments/99/4/test.txt", "http://cdn.discordapp.com/attachments/2/4/test.txt"]) {
    const m = mock({ "/api/v10/channels/2": channel, "/api/v10/channels/2/messages/3": { ...message, attachments: [{ id: "4", size: 1, url }] } });
    await assert.rejects(new DiscordReader(env, m.fetcher).attachment("2", "3", "4"), { code: "UNSAFE_ATTACHMENT_URL" });
    assert.equal(m.calls.length, 2);
  }
  for (const declared of [1, MAX_ATTACHMENT_BYTES + 1]) {
    const m = mock({ "/api/v10/channels/2": channel, "/api/v10/channels/2/messages/3": { ...message, attachments: [{ id: "4", size: declared, url: "https://cdn.discordapp.com/attachments/2/4/file" }] }, "/attachments/2/4/file": new Response(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)) });
    await assert.rejects(new DiscordReader(env, m.fetcher).attachment("2", "3", "4"), { code: "ATTACHMENT_TOO_LARGE" });
  }
});
test("Discord and CDN redirects are rejected with no follow-up fetch", async () => {
  const redirect = () => new Response(null, { status: 302, headers: { Location: "https://evil.example/file" } });
  const m = mock({ "/api/v10/guilds/1/channels": (_url, options) => { assert.equal(options.redirect, "manual"); return redirect(); } });
  await assert.rejects(new DiscordReader(env, m.fetcher).listChannels("1"), { code: "DISCORD_ERROR" });
  assert.equal(m.calls.length, 1);
  const cdn = mock({ "/api/v10/channels/2": channel, "/api/v10/channels/2/messages/3": { ...message, attachments: [{ id: "4", size: 1, url: "https://cdn.discordapp.com/attachments/2/4/file" }] }, "/attachments/2/4/file": redirect });
  await assert.rejects(new DiscordReader(env, cdn.fetcher).attachment("2", "3", "4"), { code: "ATTACHMENT_UNAVAILABLE" });
  assert.equal(cdn.calls.length, 3);
});
test("ToDo extraction instructions require evidence and distinguish uncertainty", () => {
  for (const word of ["untrusted", "message_id", "source_url", "uncertain", "due_date", "No external ToDo system"]) assert.ok(TODO_INSTRUCTIONS.includes(word));
});
