# StreamLore on Cloudflare Workers

Deployment target: **https://streamlore.patrickvaldivia123.workers.dev**.

The backend runs as a Worker with a SQLite-backed Durable Object for each channel. Twitch chat arrives through signed EventSub webhooks. The deployment does not depend on this Mac, a Cloudflare Tunnel, local SQLite files, or a permanently open WebSocket.

Cloudflare has accepted the deployment. Command-line HTTPS requests to `workers.dev` are reset on this network. The browser successfully loads the Twitch-hosted panel and receives private question responses from the configured Worker. Local Worker integration checks passed. The separate OAuth app’s credentials were validated with Twitch, TheDarthh completed consent, and the configuration reports chat webhook connection. Real Whisper receipt from a different viewer still requires verification.

## Build and deploy

```sh
npm ci
npm run build:worker
npx wrangler login
npm run deploy:worker
```

[`wrangler.jsonc`](../wrangler.jsonc) declares the Worker, its assets, the channel Durable Object binding, and the SQLite migration. The build creates `dist-worker/`, native assets in `dist-extension/`, and `release/streamlore-twitch-extension.zip`, targeting the Workers origin. Build output and local credentials are ignored by Git.

Use `npm run dev:worker` for local Workers development. Local `.dev.vars` values are never production Twitch credentials; do not upload generated test keys as a genuine Extension shared secret.

## Private runtime secrets

Set secrets with `npx wrangler secret put NAME`, or a private JSON file passed to `wrangler secret bulk`. Never put them in frontend assets, the upload ZIP, Git, screenshots, or chat.

| Secret | Source / purpose |
| --- | --- |
| `TWITCH_EXTENSION_SECRET` | The registered Extension's actual base64 shared secret; verifies Twitch Helper JWTs. |
| `TWITCH_CLIENT_ID` | Client ID of the separate confidential broadcaster OAuth application. |
| `TWITCH_CLIENT_SECRET` | That OAuth application's secret. |
| `STREAMLORE_TOKEN_ENCRYPTION_KEY` | Stable base64 32-byte key for encrypted access/refresh tokens. Retain it with backups. |
| `TWITCH_EVENTSUB_SECRET` | Random webhook signing secret, at least 32 characters. |
| `OPENAI_API_KEY` | Optional model-assisted summaries and private lore drafts. |

The encryption key, EventSub verification secret, and the existing Extension’s genuine shared secret are installed in Cloudflare. The genuine StreamLore Chat OAuth client ID and secret are also installed. TheDarthh completed broadcaster consent and the native configuration reports the chat webhook connected. Changing the encryption key breaks access to existing stored credentials; changing the EventSub secret requires recreating subscriptions.

## Twitch console configuration

1. Open [Extension version 0.1.0](https://dev.twitch.tv/console/extensions/m7tirdtzbocxkfacsis37lvc81i4uc/0.1.0/status).
2. Set **Testing Base URI** to `https://streamlore.patrickvaldivia123.workers.dev/extension/`. Keep `panel.html`, `mobile.html`, `config.html`, and `live.html` as relative paths.
3. Add `https://streamlore.patrickvaldivia123.workers.dev` to the fetching allowlist. Permit configuration/OAuth destinations and external source links as required by Twitch.
4. Register the separate confidential OAuth app with callback **`https://streamlore.patrickvaldivia123.workers.dev/auth/twitch/callback`**. Install its credentials as Worker secrets.
5. The eight-file ZIP is already uploaded to Hosted Test, installed, and active in Panel 2 on TheDarthh. TheDarthh’s broadcaster account is connected through configuration.
6. Worker connections request `user:read:chat`, `user:write:chat`, `user:manage:whispers`, `user:bot`, and `channel:bot`. The additional bot permissions allow app-token EventSub webhook subscriptions. Reconnect old chat-only grants.
7. Test as a different viewer. Check private panel answers separately from receipt of real Twitch Whispers. Review/release are still required for public installation.

The webhook endpoint is `/twitch/eventsub`. Signatures and timestamps are checked before routing to a channel. Message IDs, OAuth state, channel history, votes, and Whisper usage survive Worker restarts. Tokens are encrypted at rest. Hourly Durable Object alarms validate authorization; incoming chat refreshes stream metadata at most once per minute.

[Twitch webhook authentication](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/), [chat subscription permissions](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage), [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Dataset and privacy

xQc's Juicer/Juicers and Caedrel's Sally are sourced starter references, separate from channel-approved lore. Their presence does not install StreamLore on those streamers' channels or authorize their accounts. Creators can hide starter references. Add and approve a test definition on your own channel when testing there.

Panel questions are answered directly and are not added to shared channel state. Chat questions are public on Twitch; the response is a private Whisper. No private question falls back to a public bot answer. Twitch may silently drop Whispers and imposes a 40-recipient daily limit. [Whisper limitations](https://dev.twitch.tv/docs/chat/whispers/)

## Operating limits

This is a prototype, not a load-tested service for a high-volume channel. Every subscribed chat message invokes the Worker, so Cloudflare request/CPU/storage quotas matter. Do not enable a paid plan automatically. The native panel can continue answering from approved/reference definitions without a connected chat account, using the configured genuine Extension secret. Twitch review materials, support/legal URLs, and real Whisper receipt remain outstanding. Installation and broadcaster consent have been exercised on TheDarthh.

The local Node/Docker backend is still available as a separate deployment option. Earlier Quick Tunnel instructions are superseded by this Workers setup.
