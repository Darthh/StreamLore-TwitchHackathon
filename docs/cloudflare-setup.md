# Run the Twitch backend through Cloudflare

The native Extension needs a public HTTPS backend. Cloudflare Tunnel can publish the existing Node server while SQLite and encrypted credentials stay on the host. The host must remain running; a tunnel does not move the application into Cloudflare Workers or supply an always-on server.

## Test backend

Install `cloudflared` from the official Cloudflare distribution or Homebrew, build StreamLore, and configure `.env` with `STREAMLORE_MODE=extension`, a free local port, and the real Twitch credentials. Never expose `demo` mode: its local moderator controls are inappropriate for public hosting.

```sh
npm ci
npm run build
npm start
```

In a second terminal, replace the port with the configured backend port:

```sh
cloudflared tunnel --url http://127.0.0.1:8791
```

Set `STREAMLORE_PUBLIC_URL` and `TWITCH_OAUTH_REDIRECT_URI` in `.env` to the returned HTTPS origin and its `/auth/twitch/callback` path, then restart Node. Register that exact callback on the separate Twitch OAuth application. Build the native package against the same origin:

```sh
npm run build:extension -- --api-url https://YOUR-ACTUAL-TUNNEL-HOST
```

Use `https://YOUR-ACTUAL-TUNNEL-HOST/extension/` as the version's **Testing Base URI**, retaining `panel.html`, `mobile.html`, `config.html`, and `live.html`. Add the backend origin to **Allowlist for URL Fetching Domains** and allow the OAuth destination/configuration links. Open `/install` to inspect remaining setup requirements.

Quick Tunnels have changing hostnames and no uptime guarantee, stop when their process stops, and do not support SSE. Native panels use polling and can use this test path; the full companion's SSE updates need a named tunnel or another appropriate deployment. [Cloudflare Quick Tunnel limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## Stable named tunnel

Use an account and a domain managed in Cloudflare:

```sh
cloudflared tunnel login
cloudflared tunnel create streamlore
cloudflared tunnel route dns streamlore streamlore.YOUR-DOMAIN
```

The login needs its final domain authorization, not just a signed-in dashboard. Keep the returned certificate and tunnel credential files private. Configure the named tunnel to send only the chosen hostname to `http://127.0.0.1:8791` and return 404 for unmatched hostnames. Update the public origin, registered OAuth callback, asset-hosting URL, and fetching allowlist to the stable hostname, rebuild the ZIP, and verify them again before Hosted Test. [Cloudflare setup guide](https://developers.cloudflare.com/tunnel/get-started/)

Keep the backend and tunnel supervised on a persistent host, preserve `data/extensions`, and retain the same `STREAMLORE_TOKEN_ENCRYPTION_KEY` with database backups. This repository's synchronous SQLite and in-process chat connections require a suitable running Node host; deploying them directly as an ephemeral Worker would lose those properties.

## Twitch credentials and verification

The HTTPS URL alone does not authorize Twitch. Put the registered Extension's base64 shared secret in local `.env` as `TWITCH_EXTENSION_SECRET`, and configure the separate broadcaster OAuth application's client ID/secret. The Extension ID and OAuth application ID serve different purposes. No secret belongs in the ZIP or Git.

Connect the broadcaster account with chat and Whisper scopes. Install/activate the Local Test Extension on an allowed test channel, open it as a different viewer, ask a known phrase, and verify receipt of the private answer. Check the panel separately from actual Twitch Whisper delivery. The included dataset does not grant access to xQc's or Caedrel's channel. See the [full Twitch launch guide](twitch-extension-launch.md).
