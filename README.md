# Discord MCP for Cloudflare Workers

> 単体テストとローカル workerd の模擬 OAuth テストで検証しています。実 ChatGPT・実 GitHub OAuth App・実 Discord との接続は、利用者が認証情報を設定してから確認してください。

ChatGPT のカスタム MCP 接続から、Discord の公式 Bot API で投稿・スレッド・添付を読むためのソースです。**OAuth で本人確認した所有者だけが使えます。** Cloudflare のデプロイと認証情報の設定は利用者自身で行います。

## できること・制約

- 許可サーバーのチャンネル一覧、投稿履歴、単一投稿、公式メッセージ検索。
- Bot が読めるアクティブスレッド、公開アーカイブ、参加済み非公開アーカイブ。フォーラム投稿はスレッドとして取得。
- 添付のメタデータ、2 MiB 以下の原本を MCP の binary resource として取得。大きい原本は同じ OAuth で守った `/mcp/attachments/<channel>/<message>/<attachment>` からストリーミング取得。
- Bot 自身との DM：指定した DM チャンネルと指定した相手の ID の両方が必要。
- 元投稿 ID・引用・リンク付きの ToDo 抽出用コンテキスト／prompt。**抽出は接続先の ChatGPT が実行**し、サーバーではモデル推論もタスク登録も行いません。

**本人と他人との通常 DM は、公式 Bot API で一括・継続取得できません。** 他人同士の DM とグループ DM もこの Bot の対象外です。個人アカウントトークン・self-bot・非公開 API・権限の迂回は実装していません。

通常 DM の代案は、利用者が原文・添付を Bot に手動送信すること、または選んだログを明示的に提供することです。元の通常 DM リンクだけでは Bot は本文を読めません。公式データパッケージに含まれるのは本人の送信分なので、相手の発言を含む往復会話全部の代わりにはなりません。**通常 DM importer は未実装で、設計候補だけを RESEARCH.md に記載**しています。

取得できる「全部」は **Bot に閲覧権限のある現存データ**に限定されます。履歴・アーカイブはページングを繰り返してください。一回のツールでサーバー全体を同期しません。削除済み、権限外、未参加の非公開スレッドは取得できません。原本取得と OCR/PDF テキスト抽出は別の処理で、後者は未実装です。定期監視・永続バックアップもありません。

## 認証の構成

ChatGPT → この Worker の OAuth 2.1 + S256 PKCE → GitHub で本人確認 → 設定した GitHub ユーザー ID と照合 → 所有者だけに Discord 読み取りを許可。

GitHub はログイン確認だけに使い、リポジトリ操作の権限を要求しません。GitHub OAuth token は本人確認の一度の API 呼出しに使い、保存・MCP クライアントへの返却・Discord への送信をしません。

Cloudflare 公式 `@cloudflare/workers-oauth-provider` が discovery、CIMD / DCR、PKCE、コード交換、期限、更新、resource/audience、ブラウザーに結び付いた consent/state を扱います。アプリはさらに所有者 ID と read scope をリクエストごとに照合します。名前が同じ別アカウントや、単にログインできる他人へ grant を発行しません。

公開される認証メタデータには Discord 内容も token も含まれません。MCP と添付原本はすべて認証対象です。ChatGPT の正確な redirect URI と CIMD URL の許可リストも設定します。接続ごとの許可画面に、クライアント名・公開ドメイン・戻り先・read / refresh scope を表示します。

## 1. Discord Bot の準備（利用者が操作）

1. [Developer Portal](https://discord.com/developers/applications) で Application と Bot を作成。
2. Bot の **Message Content Intent** を有効にします。REST の本文・添付・embed にも影響します。審査が必要かは規模・資格と最新 Portal 表示で確認してください。
3. Guild Install / OAuth2 の `bot` スコープで対象サーバーへ追加。サーバーへの追加権限が必要です。
4. 対象チャンネルに `View Channel` と `Read Message History` を許可。招待の permissions 値は `66560`。Administrator・投稿・削除・Webhook 管理は不要です。チャンネル固有の拒否も確認。
5. 読みたい既存の非公開スレッドには、管理者から Bot を招待。本ソースは参加・アーカイブ解除・その他変更を行いません。非公開アーカイブの全件列挙は MANAGE_THREADS が必要なため、参加済みだけを列挙します。
6. 開発者モードでサーバー・対象チャンネルの ID をコピー。Bot DM を使う場合は、利用者から Bot に送信してその DM チャンネル ID と利用者 ID をコピー。
7. Bot token は利用者自身が保持し、チャット・GitHub・`vars` へ貼りません。

## 2. Cloudflare と GitHub OAuth の準備（利用者が操作）

Node.js **22.18 以降の 22 LTS** または **24.11 以降**を使用します。

```sh
npm ci
npm run check
npm test
npm run build
npm run smoke
```

`build` は `wrangler deploy --dry-run` によるローカル bundle 生成だけです。`smoke` は実際のローカル workerd 内で OAuth をテストしますが、GitHub / Discord は mock、KV はローカル、テスト用の grant / token は外部へ送信されません。実 API や本番デプロイを行いません。

Cloudflare の Worker URL は先にアカウントの Workers subdomain から確認してください。例として以下を使います。

- Worker origin: `https://discord-mcp.<subdomain>.workers.dev`（末尾 `/` なし）
- MCP resource: `https://discord-mcp.<subdomain>.workers.dev/mcp`
- GitHub の callback: `https://discord-mcp.<subdomain>.workers.dev/callback`

GitHub の Settings → Developer settings → OAuth Apps で専用 OAuth App を作成し、Homepage は Worker origin、Authorization callback URL は上の `/callback` を登録します。利用者が Client ID と Client Secret を取得してください。**これは GitHub の本人確認用アプリです。ChatGPT からこの MCP へ接続する OAuth client と別です。**

Cloudflare の OAuth 用 KV namespace を利用者が作ります。

```sh
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

表示された namespace ID を `wrangler.jsonc` の `kv_namespaces[0].id` に入力してください。提供ソースの 32 個の `0` は未設定を表すダミーです。KV は OAuth のクライアント・grant・ブラウザー state 用で、Discord 投稿／添付は保存しません。ライブラリは token / code を hash、props と state を暗号化して保持します。

`wrangler.jsonc` の `vars` に公開設定を入力します。

| 名前 | 設定 |
| --- | --- |
| `AUTH_MODE` | `oauth` のまま使用 |
| `PUBLIC_BASE_URL` | Worker の正確な origin、末尾 `/` なし |
| `ALLOWED_HOSTNAMES` | Worker の hostname、scheme / port なし |
| `OWNER_GITHUB_USER_ID` | 自分の GitHub **数値 ID**。ユーザー名ではありません。自分で `gh api user --jq .id` 等で確認 |
| `GITHUB_CLIENT_ID` | 自分で作成した GitHub OAuth App の Client ID |
| `CHATGPT_REDIRECT_URIS` | ChatGPT の接続管理画面に表示される **正確な redirect URI**。複数ならカンマ区切り |
| `CHATGPT_CLIENT_METADATA_URLS` | ChatGPT の接続管理画面に表示される **正確な CIMD URL**。複数ならカンマ区切り |
| `ALLOWED_GUILD_IDS` | 対象サーバー ID、カンマ区切り。空ならサーバーアクセス拒否 |
| `ALLOWED_CHANNEL_IDS` | 任意のチャンネル ID 制限。空なら許可サーバー内で Bot が読める範囲。指定するとそのチャンネルと子スレッドだけ |
| `ALLOWED_DM_CHANNEL_IDS` | Bot 自身との DM ID。空なら DM 拒否 |
| `ALLOWED_DM_USER_IDS` | DM 相手の利用者 ID。DM チャンネル許可と両方必要 |
| `ALLOWED_ORIGINS` | 必要な browser Origin の完全一致リスト。例 `https://chatgpt.com`。Worker 自身の origin は consent form 用に自動許可 |

このライブラリは issuer identification に対応するため、初期値として ChatGPT の stable redirect `https://chatgpt.com/connector_platform_oauth_redirect` と CIMD `https://chatgpt.com/oauth/client.json` を置いています。**実際の管理画面で確認してください。** callback ID を含む URL が表示される場合はその値を追加します。`chatgpt.com` の全 URL を許可する wildcard にはしません。

本物の秘密情報は利用者が対話入力で設定します。

```sh
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put GITHUB_CLIENT_SECRET
```

値をコマンド引数や `vars` に書かないでください。ローカルの手動確認には `.dev.vars.example` を `.dev.vars` にコピーし、必要な値を利用者が入力します。`.dev.vars` は Git 管理対象外です。OAuth mode では `MCP_ACCESS_TOKEN` は不要です。

## 3. 利用者自身がデプロイし、ChatGPT に接続

設定後、利用者が実行します。

```sh
npm run deploy
```

Bot secret・OAuth secret・所有者・公開 URL・許可範囲が未設定なら 503 で拒否します。共有した公開 URL だけで Discord を読める状態にはなりません。

ChatGPT のカスタム MCP / Apps 接続画面で MCP URL `https://discord-mcp.<subdomain>.workers.dev/mcp` と OAuth を選択し、表示されるログイン／許可フローを完了します。GitHub では `OWNER_GITHUB_USER_ID` のアカウントでログインします。他の GitHub アカウントは access_denied になります。

CIMD または DCR を使う場合、ChatGPT → Worker 用の OAuth client はその仕組みで識別・登録されます。**GitHub OAuth App の Client Secret を ChatGPT の MCP client-secret 欄へ入れないでください。** UI が手動 client 設定を必須にする場合は、その画面と実際の登録方式を確認してください。

所有者がログインできても、アプリの利用可否・設定画面は ChatGPT のプランや workspace 設定に従います。本ソースだけでその制限は変更できません。実 ChatGPT / GitHub OAuth App / 実 Discord での接続は、利用者が設定後に確認する必要があります。

## ツールと ToDo

| ツール | 用途 |
| --- | --- |
| `discord_list_channels` | 許可サーバーのチャンネル一覧 |
| `discord_get_messages` | 1–100 件の履歴。`before` / `after` のどちらかでページング |
| `discord_get_message` | 投稿 ID で取得 |
| `discord_list_active_threads` | 読めるアクティブスレッド |
| `discord_list_archived_threads` | `public` / `joined_private`、返却 `next_before` で続行 |
| `discord_search_messages` | 公式検索。1–25 件、offset 上限 9975。古い範囲は `min_id` / `max_id` を分ける |
| `discord_get_attachment` | 2 MiB 以下の inline 原本。取得済み投稿の添付 ID を指定 |
| `discord_attachment_download` | 大きい原本も取得できる Worker URL。OAuth access token が必要 |
| `discord_todo_context` | 元投稿と AI 向けの根拠付き抽出指示 |

ChatGPT には例えば「対象チャンネルの今週の投稿とスレッドを確認し、ToDo 候補を担当者・期限・状況・根拠引用・元投稿リンク付きで整理して。後続の完了・取消も確認して」と依頼します。prompt を扱えるクライアントでは `discord_extract_todos` も使えます。

ToDo の担当者・期限は明示されたものだけを使い、なければ null、曖昧な提案は uncertain とします。相対期限は元の日時と timezone の根拠が必要です。ページ範囲と添付未読を示し、サーバー全体を確認済みと推測しません。抽出後に利用者が確認します。タスク管理アプリへ自動登録しません。

添付 download URL は `/mcp/attachments/...` で、URL だけでは取得できません。元の MCP resource に対する有効な OAuth token の Authorization header が必要です。ChatGPT がその URL をそのままブラウザーで開いてファイル解析できることは保証しません。inline tool が使えない大きい原本は、認証 header を扱えるクライアントで利用者が download するか、必要な原本を明示的に提供してください。

## 検索・安全性・テスト

- 最新の公式 `Search Guild Messages` を使用。Message Content Intent と Read Message History が必要。202 は索引待ち、429 はレート制限で、返却 retry_after 後に再試行します。
- 各リクエスト内では rate-limit bucket の exhausted 状態を守ります。複数 isolate をまたぐ集中 rate limiter はないため、大量並列の自動同期を追加する場合は別途設計が必要です。
- 短い検索ページ・検索件数は完全性の証拠ではありません。空の本文／添付が Intent 不足か実際に空かを断定しません。
- Discord へは固定 GET route のみ。添付は現在の許可済み投稿から得た Discord CDN URL のみを使い、ユーザー入力 URL の proxy、redirect、CDN への認証ヘッダー送信はしません。
- 投稿・添付は untrusted source。埋め込まれた AI 指示を実行せず、添付原本もブラウザーで active content として表示しません。
- Discord 内容の永続保存なし、レスポンス no-store、アプリ自身の本文・秘密情報ログなし。ChatGPT に送られた内容はそのサービス側の取り扱いに従います。
- `AUTH_MODE=bearer` は header を自分で設定できるローカル／専用クライアント用の互換モードです。別の十分長い MCP_ACCESS_TOKEN が必要で、ChatGPT 用には選択しません。OAuth mode で固定 token を代わりに受け入れる bypass はありません。

`npm test` は Node の Workers class shim と memory KV を使い、実 OAuth ライブラリのロジックとアプリの境界を確認。`npm run smoke` は本物の workerd で DCR → consent/cookie/state → mock GitHub → non-owner 拒否 → owner PKCE → audience 照合 → MCP tool を end-to-end 確認します。実サービスを設定した確認ではありません。

## 公式ソース

- [OpenAI MCP authentication / ChatGPT OAuth・CIMD・DCR・戻り先](https://developers.openai.com/plugins/build/auth)
- [Cloudflare OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
- [Cloudflare third-party sign-in](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md)
- [GitHub OAuth App web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Cloudflare MCP Handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Discord Message Resource](https://docs.discord.com/developers/resources/message)
- [Discord Message Content Intent](https://docs.discord.com/developers/events/gateway)
- [Discord Threads](https://docs.discord.com/developers/topics/threads)
- [Discord OAuth2 / DM・RPC の制約](https://docs.discord.com/developers/topics/oauth2)
- [Discord self-bot 禁止](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)
- [Discord data package](https://support.discord.com/hc/en-us/articles/360004957991-Your-Discord-Data-Package)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
