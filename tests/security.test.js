import test from "node:test";
import assert from "node:assert/strict";
import { config, validBearer, validateRequestLocation, snowflake, publicError } from "../src/security.js";
import worker from "../src/index.js";

// Deliberately non-secret fixtures. No production credentials are generated or read.
export const env = { AUTH_MODE: "bearer", DISCORD_BOT_TOKEN: "TEST_ONLY_BOT_FIXTURE", MCP_ACCESS_TOKEN: "TEST_ONLY_MCP_FIXTURE_DO_NOT_DEPLOY", ALLOWED_GUILD_IDS: "1", ALLOWED_HOSTNAMES: "localhost", ALLOWED_ORIGINS: "https://client.example" };
const req = (headers = {}, path = "/mcp", method = "POST", body) => new Request(`http://localhost${path}`, { method, headers: { Host: "localhost", ...headers }, body });

test("configuration fails closed with missing secrets, host or scopes", () => {
  for (const field of ["DISCORD_BOT_TOKEN", "MCP_ACCESS_TOKEN", "ALLOWED_HOSTNAMES", "ALLOWED_GUILD_IDS"]) assert.throws(() => config({ ...env, [field]: "" }));
  assert.throws(() => config({ ...env, ALLOWED_GUILD_IDS: "../1" }));
});
test("snowflakes stay strings and reject path injection and overflow", () => {
  for (const bad of [0, "0", "-1", "../1", "1?x=2", "18446744073709551616"]) assert.throws(() => snowflake(bad));
  assert.equal(snowflake("18446744073709551615"), "18446744073709551615");
});
test("Bearer is required on each request and never taken from URL", async () => {
  assert.equal(await validBearer(req({ Authorization: `Bearer ${env.MCP_ACCESS_TOKEN}` }), env.MCP_ACCESS_TOKEN), true);
  for (const auth of ["", `Bearer ${env.MCP_ACCESS_TOKEN}x`, `Basic ${env.MCP_ACCESS_TOKEN}`]) assert.equal(await validBearer(req({ Authorization: auth }), env.MCP_ACCESS_TOKEN), false);
  assert.equal(await validBearer(req({}, `/mcp?token=${env.MCP_ACCESS_TOKEN}`), env.MCP_ACCESS_TOKEN), false);
});
test("exact Origins and host allowlist prevent browser origin bypasses", () => {
  const settings = config(env);
  assert.equal(validateRequestLocation(req(), settings), true);
  assert.equal(validateRequestLocation(req({ Origin: "https://client.example" }), settings), true);
  for (const origin of ["null", "https://evil.example", "http://client.example", "https://client.example:8443", "https://client.example/"]) assert.equal(validateRequestLocation(req({ Origin: origin }), settings), false);
  assert.equal(validateRequestLocation(new Request("https://evil.example/mcp"), settings), false);
});
test("Worker denies unconfigured and anonymous MCP and attachment requests", async () => {
  assert.equal((await worker.fetch(req(), {}, {})).status, 503);
  for (const path of ["/mcp", "/mcp/attachments/2/3/4"]) assert.equal((await worker.fetch(req({}, path, "GET"), env, {})).status, 401);
  assert.equal((await worker.fetch(req({ Authorization: `Bearer ${env.MCP_ACCESS_TOKEN}`, Origin: "https://evil.example" }), env, {})).status, 403);
});
test("authenticated MCP discovery advertises only read-only tools", async () => {
  const response = await worker.fetch(req({ Authorization: `Bearer ${env.MCP_ACCESS_TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, "/mcp", "POST", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const payload = JSON.parse(response.headers.get("Content-Type")?.includes("text/event-stream") ? raw.split("\n").find((line) => line.startsWith("data: ")).slice(6) : raw);
  assert.ok(payload.result?.tools?.length >= 8, JSON.stringify(payload));
  for (const tool of payload.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
test("unexpected errors do not disclose credentials", () => {
  assert.equal(JSON.stringify(publicError(new Error(env.DISCORD_BOT_TOKEN))).includes(env.DISCORD_BOT_TOKEN), false);
});
