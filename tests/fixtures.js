export class MemoryKV {
  constructor() { this.data = new Map(); }
  async put(key, value, options = {}) { this.data.set(key, { value, metadata: options.metadata, expires: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : Infinity }); }
  async get(key, options = {}) {
    const item = this.data.get(key);
    if (!item || item.expires < Date.now()) return null;
    const type = typeof options === "string" ? options : options.type;
    return type === "json" ? JSON.parse(item.value) : item.value;
  }
  async getWithMetadata(key, options = {}) { return { value: await this.get(key, options), metadata: this.data.get(key)?.metadata ?? null }; }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "" } = {}) { return { keys: [...this.data].filter(([key, item]) => key.startsWith(prefix) && item.expires > Date.now()).map(([name, item]) => ({ name, metadata: item.metadata })), list_complete: true, cursor: "" }; }
}
export const oauthEnv = () => ({
  AUTH_MODE: "oauth", DISCORD_BOT_TOKEN: "TEST_ONLY_BOT_FIXTURE",
  GITHUB_CLIENT_ID: "TEST_ONLY_GITHUB_CLIENT", GITHUB_CLIENT_SECRET: "TEST_ONLY_GITHUB_SECRET",
  OWNER_GITHUB_USER_ID: "123", PUBLIC_BASE_URL: "http://localhost:8787",
  ALLOWED_GUILD_IDS: "1", ALLOWED_HOSTNAMES: "localhost",
  CHATGPT_REDIRECT_URIS: "https://chatgpt.com/connector_platform_oauth_redirect",
  CHATGPT_CLIENT_METADATA_URLS: "https://chatgpt.com/oauth/client.json", OAUTH_KV: new MemoryKV()
});
