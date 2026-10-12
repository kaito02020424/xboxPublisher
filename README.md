# xboxPublisher

Xbox Live にログインし、`config.json` で指定した Bedrock Dedicated Server (BDS) を、そのアカウントのフレンドの「参加可能なフレンド」に表示します。フレンドが参加すると、その NetherNet 接続を BDS へ中継 (proxy) します。中継の方法は `mode` で選べます。

```text
relay (既定):
  フレンド ──(franchise signaling / WebRTC)──▶ xboxPublisher ──(HTTP signaling / WebRTC)──▶ BDS

signaling:
  フレンド ──(franchise signaling)──▶ xboxPublisher ──(HTTP signaling)──▶ BDS
  フレンド ─────────────────────(WebRTC で直接接続)─────────────────────▶ BDS
```

- フレンド側は Mojang の franchise signaling (JSON-RPC) で受け付けます。セッションの公開方法は [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster) と同じです。
- `relay` では、BDS 側の接続、`a=identity` の付与、データチャネルの中継に [`@nethernet-proxy/relay`](https://github.com/SKYNETWORK-MCBE/nethernet-proxy) を使います。
- Bedrock のパケットは解釈せずにそのまま転送します。ログイン認証 (online-mode) や allowlist は BDS がそのまま行います。

## 必要なもの

- pnpm。Node.js 26 は `devEngines` によって pnpm が自動で用意します。
- BDS 1.26.50 以降。`server.properties` に次の設定が必要です。
  - `transport=nethernet` (既定値)
  - `enable-lan-visibility=true`。`false` だと `GET /v1/join` が空のボディを返し、バージョンや人数を取得できません。
- 配信用の Xbox アカウント。サブアカウントを推奨します。
  - セッションはこのアカウントのフレンドに表示され、参加できます。
  - 参加者を制限したい場合は、BDS の allowlist を使ってください。

## 使い方

```sh
pnpm install
cp config.example.json config.json   # server を BDS の server-port に合わせる
pnpm start
```

初回だけ、表示されたコードを https://www.microsoft.com/link で入力してサインインしてください。トークンは `.auth/` に保存されます。

`Ctrl+C` で止めると、Xbox のセッションから抜けてから終了します。

### config.json

| キー                | 内容                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `server`            | BDS の NetherNet signaling の URL (`http://<host>:<server-port>`、TLS の場合は `https://…`)。xboxPublisher から到達できる必要があります |
| `autoAcceptFriends` | 届いたフレンド申請を 30 秒ごとに自動で承認します。既定値は `true` です                              |
| `mode`              | `relay` (既定) か `signaling`。下の表を参照してください                                            |

| `mode`      | 動作                                                                                   | 向いているサーバー                                                                                   |
| ----------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `relay`     | xboxPublisher がデータを中継します。サーバーからは、配信アカウントが接続してきたように見えます | インターネットから直接到達できない BDS (例: `127.0.0.1` や LAN 内)                                    |
| `signaling` | signaling だけを中継し、フレンドがサーバーに直接接続します。サーバーにはフレンド本人の identity が届きます | UDP ポートがインターネットから到達できるサーバー。signaling の identity とログインの XUID を照合するサーバー (`@nethernet-proxy/proxy` など) は、こちらでないと接続できません |

フレンド欄に表示されるワールド名、ホスト名、バージョン、人数、ゲームモードは、BDS の `GET /v1/join` から 30 秒ごとに取得します。

### ログ

`DEBUG=nethernet pnpm start` で、signaling (offer、answer、candidate) と relay のイベントのログを出します。WebRTC と ICE のログも見たい場合は `DEBUG=nethernet,werift*` にしてください。

## 開発

```sh
pnpm check   # 型チェック
pnpm test
```

## 制限

- `relay` では、フレンド側の ICE に STUN だけを使い、ホスト側では TURN の中継を使いません。参加するクライアントは自前の TURN 中継を使うので、通常はこれで接続できます。
- `signaling` では、HTTP signaling が candidate を後から送れない (trickle できない) ため、フレンドが後から送ってくる candidate はサーバーに届きません。サーバーはフレンドからの接続確認 (ICE チェック) を受けた時点で、その送信元アドレスを相手の候補として学習するので、公開された UDP ポートさえあれば接続できます。

## ライセンス

[GPL-3.0-only](LICENSE)

先行プログラムの [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster) (GPL-3.0) を参考にしているため、同じライセンスにしています。

依存ライブラリは [`@nethernet-proxy/relay`](https://github.com/SKYNETWORK-MCBE/nethernet-proxy)、[`nethernet`](https://github.com/PrismarineJS/node-nethernet)、[`prismarine-auth`](https://github.com/PrismarineJS/prismarine-auth) で、いずれも MIT ライセンスです。
