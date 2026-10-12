# xboxPublisher

Xbox Live にログインし、`config.json` で指定した Bedrock Dedicated Server (BDS) を、そのアカウントのフレンドの「参加可能なフレンド」に表示します。フレンドが参加すると、その接続要求 (NetherNet の signaling) を BDS へ中継します。

```text
フレンド ──(franchise signaling)──▶ xboxPublisher ──(HTTP signaling: POST /v1/join/{id})──▶ BDS
フレンド ────────────────────────(WebRTC で直接接続)────────────────────────▶ BDS
```

- フレンド側は Mojang の franchise signaling (JSON-RPC) で受け付けます。セッションの公開方法は [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster) と同じです。
- フレンドの offer を本人の identity ごとそのまま BDS に渡すので、BDSにはフレンド本人として届きます。ゲームのデータは xboxPublisher を通りません。
- そのため、BDS の UDP ポートはインターネット (フレンド) から到達できる必要があります。

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

フレンド欄に表示されるワールド名、ホスト名、バージョン、人数、ゲームモードは、BDS の `GET /v1/join` から 30 秒ごとに取得します。

## 開発

```sh
pnpm check   # 型チェック
pnpm test
```

## 制限

- HTTP signaling が candidate を後から送れない (trickle できない) ため、フレンドが後から送ってくる candidate はサーバーに届きません。サーバーはフレンドからの接続確認 (ICE チェック) を受けた時点で、その送信元アドレスを相手の候補として学習するので、公開された UDP ポートさえあれば接続できます。

## ライセンス

[GPL-3.0-only](LICENSE)

先行プログラムの [MCXboxBroadcast](https://github.com/MCXboxBroadcast/Broadcaster) (GPL-3.0) を参考にしているため、同じライセンスにしています。

依存ライブラリは [`prismarine-auth`](https://github.com/PrismarineJS/prismarine-auth) (MIT) だけです。
