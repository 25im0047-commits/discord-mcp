# 検証記録

2026-10-13。実 Discord の内容・実 OAuth credentials は使用せず、固定の非秘密 fixture と mock API を使用。

- `npm run check`: 構文検証成功。
- `npm test`: **31 件成功、失敗 0**。Node の Workers class shim と memory KV で、実 OAuth ライブラリとアプリの認証・所有者・scope・audience・期限・callback・consent・出典・Discord 許可範囲・HTTP エラー・添付を確認。
- `npm run build`: `wrangler deploy --dry-run` による bundle 生成成功。本番 deploy ではない。
- `npm run smoke`: **ローカル workerd の模擬 OAuth flow 成功**。DCR、consent/cookie/state、mock GitHub sign-in、非所有者の grant 発行拒否、上流 redirect 拒否、owner の PKCE 交換、異なる resource の拒否、認証後の Discord GET tool を確認。
- `npm audit --json`: **全依存の既知 vulnerabilities 0**。

ローカルで発行される模擬 OAuth grant/token は Miniflare KV だけに存在し、外部に送信・表示しない。本番 credentials の生成・設定はしていない。実 ChatGPT カスタム接続・実 GitHub OAuth App・実 Discord token / Message Content Intent / 権限・実添付は未検証で、利用者が設定後に確認する。

callback 400 の原因は workerd が fetch の `redirect: "error"` を受け付けないことだった。`manual` で取得し、3xx を非成功として拒否する方式に修正。GitHub・Discord・添付すべてに適用し、credential が redirect 先に送られない回帰テストを追加した。

ローカル Miniflare dispatcher は virtual URL を渡しても loopback Host を保持するため、smoke fixture だけ loopback を Host allowlist に含める。本番設定は実 Worker hostname の完全一致とする。

既存 Node 23.3.0 でローカル検証。利用者と CI は依存の engine 要件に合う Node 22.18 以降の 22 LTS（または24.11以降）を使用する。ローカルの古い npm の module warning はテストの失敗ではない。Wrangler log は `/tmp`、telemetry は無効で検証。

CI は GitHub Actions に check / 31 unit tests / dry-run build / workerd smoke / production dependency audit を用意。実行結果は GitHub の Verify workflow で対象コミットに対して確認する。CI は Bot・GitHub OAuth・Cloudflare の secrets を使用せず、deploy もしない。

通常 DM importer、OCR/PDF テキスト抽出、定期同期、永続バックアップは未実装。レート制限は各リクエスト内の bucket ヘッダーを尊重するが、複数 isolate で共有する集中 limiter はない。大量並列同期を追加する場合は別途設計が必要。
