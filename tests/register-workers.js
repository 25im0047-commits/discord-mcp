import { register } from "node:module";
// Node has no Workers-only class export. This shim supplies only that class;
// the real OAuth library, crypto, cookie/state and token logic are used unchanged.
register("./cloudflare-loader.js", import.meta.url);
globalThis.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
