# 公式資料に基づく設計判断

## Discord の読み取り範囲

公式 Bot を対象サーバーに追加し、VIEW_CHANNEL と READ_MESSAGE_HISTORY を許可した範囲だけを読む。チャンネルの個別 overwrite や非公開スレッドへの参加条件も適用される。本文・添付・embed は Message Content Intent の制限を受け、Gateway を接続しない REST 専用構成でも Intent の設定が必要。

公開スレッドと Bot 参加済み非公開スレッドの active / archive を扱う。非公開 archive 全件の列挙には MANAGE_THREADS が必要なので、この最小版は joined private の列挙を使い、Bot の参加・unarchive・投稿は行わない。取得できる範囲の限界を coverage で示す。

最新公式 Message Resource には Search Guild Messages が存在する。MESSAGE_CONTENT と READ_MESSAGE_HISTORY に従い、limit 25、offset 9975、202 index pending、件数の不確実性を扱う。「Bot に検索 API がない」という旧前提は使わない。

- [Messages](https://docs.discord.com/developers/resources/message)
- [Gateway / Intents](https://docs.discord.com/developers/events/gateway)
- [Threads](https://docs.discord.com/developers/topics/threads)
- [Channels / archived threads](https://docs.discord.com/developers/resources/channel)
- [Rate limits](https://docs.discord.com/developers/topics/rate-limits)

## 通常 DM の制約と設計候補

本人と他人との通常 DM は、Bot が本人の代わりに横断して読めるものではない。OAuth の dm_channels.read は approved partners 限定の DM 情報アクセス、messages.read は local RPC 用、rpc も approved partners 限定。これを一般 Bot の全 DM 本文 read 権限として扱わない。個人アカウント token を取得したり、self-bot を作ったりしない。

対応できる DM は Bot 自身との会話だけで、利用者 ID と Bot DM channel ID を明示的に許可する。通常 DM の原文を利用者が手動送信・転送して提供する場合は、その提供範囲を読める。リンクだけでは元の通常 DM を読めない。

将来の手動ログ importer は、利用者が選んだ JSON/text をローカルで正規化し、出典・話者・日時・投稿 ID・元データの欠落を保持する候補。現時点では未実装。任意の URL を自動 fetch せず、全 ZIP をクラウドへ送らない設計が望ましい。

公式データパッケージは本人の送信分（DM を含む）、ID・日時・添付 CDN link を含む。相手の送信分を含む往復ログの代わりにはならず、取得には最大30日かかる。送信分だけから抽出した ToDo は受信側の依頼や完了確認が欠けるため、coverage を明示する必要がある。

- [OAuth2 scopes](https://docs.discord.com/developers/topics/oauth2)
- [Self-bot 禁止](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)
- [Data package](https://support.discord.com/hc/en-us/articles/360004957991-Your-Discord-Data-Package)
- [Data request](https://support.discord.com/hc/en-us/articles/360004027692-Requesting-a-Copy-of-your-Data)

## Workers と ChatGPT 認証

新規 MCP は `agents/mcp/server` の createMcpHandler と SDK v2 による stateless Streamable HTTP。McpAgent と常時 Gateway 接続は使わず、必要時に REST GET を行う。添付の inline 取得は 2 MiB、原本の streaming は同じ MCP resource 下で OAuth により保護する。

ChatGPT は独自 API key の提示方式に対応しないので、OAuth 2.1 / PKCE、protected-resource と authorization-server metadata、CIMD/DCR、resource parameter と issuer identification を提供する。Cloudflare 公式 OAuth Provider 1.2.3 に認証プロトコルと browser-bound consent/state の処理を任せる。

GitHub の OAuth App で本人確認し、不変の数値ユーザー ID が設定済み owner と一致するときだけ grant を発行する。scope/audience/expiry と owner を API ごとに確認。GitHub token は本人確認にだけ使い保存せず、Discord Bot token は Worker secret で分離する。read 以外の Discord scope は提供しない。

- [OpenAI Authentication](https://developers.openai.com/plugins/build/auth)
- [Cloudflare MCP Handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
- [Third-party sign-in / consent and state](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md)
- [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

ToDo の推論は ChatGPT に任せ、MCP は出典と抽出指示を提供する。担当者・期限を推測せず、提案と約束・完了を区別し、元投稿引用と URL を返して人間が確認する。外部タスク管理への書き込みは行わない。
