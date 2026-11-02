# Launch StreamLore as a Twitch Extension

This procedure prepares the native panel and mobile experience. Building the ZIP does not register, approve, release, or activate an Extension in Twitch.

## Current registration

StreamLore is registered as **StreamLore Companion**, client ID `m7tirdtzbocxkfacsis37lvc81i4uc`. Version **0.1.0** enables **Panel** and **Mobile** and is in **Hosted Test**. [Open the registered version](https://dev.twitch.tv/console/extensions/m7tirdtzbocxkfacsis37lvc81i4uc/0.1.0/status).

The steps below remain a reproducible launch guide. The Cloudflare Worker has the genuine Extension shared secret. The eight-file production ZIP was uploaded to Twitch, and StreamLore is installed and active in **EXTENSION-PANEL-2** on **TheDarthh**. The Twitch-hosted panel loads and a private question returns a private result. The confidential **StreamLore Chat** OAuth app is registered, its credentials are installed, TheDarthh completed broadcaster authorization, and the native configuration reports the Twitch chat webhook connected. Real Whisper receipt, review materials, Twitch review, and release remain outstanding.

The registered version has `panel.html`, `mobile.html`, `config.html`, and `live.html` saved, with a 500px panel height. **Request Identity Link** is enabled, configuration uses **Custom/My Own Service**, and the required per-channel configuration string is empty. Extension chat-message capabilities remain disabled because this implementation uses broadcaster OAuth and Helix instead. The saved testing base URI is `https://streamlore.patrickvaldivia123.workers.dev/extension/`. Hosted Test currently serves the uploaded assets from Twitch’s CDN. The fetching allowlist includes the Worker origin; config and panel opening allowlists include the OAuth/backend and the starter references’ source sites.

The supplied StreamLore logo is preserved in [`assets/streamlore-logo.png`](assets/streamlore-logo.png) and used in the repository README. It has not been uploaded to Twitch. The listing uploader requires these assets:

| Asset | Twitch listing size |
| --- | --- |
| Logo | 100 × 100 PNG |
| Discovery image | 300 × 200 PNG |
| Extension screenshot | 1024 × 768 PNG |

Upload the listing assets and provide actual author/support contacts and public legal URLs before review. Twitch currently flags the missing Privacy Notice for the mobile-enabled version.

The registration belongs to **TheDarthh**, and the setup browser is now signed in to that account. Its existing shared secret was retrieved privately without rotation and installed in Cloudflare. Never substitute a locally generated testing key for Twitch's genuine shared secret. The separate **StreamLore Chat** confidential OAuth app uses the production callback and Chat Bot category. Its real credentials were validated against Twitch and installed privately in `.env` and Cloudflare. TheDarthh authorized all five required scopes; configuration reports **Twitch webhook chat connected**.

## Private phrase answers

The native panel opens on **Ask privately**. Signed viewer requests use `/api/extension/ask`; the JWT selects the channel. This returns a private panel answer without storing the question in stream history. The two sourced starter definitions are xQc’s **Juicer/Juicers** and Caedrel’s **Sally**. They are separate from moderator-approved lore, and creators can hide them.

To answer questions typed in chat, reconnect the broadcaster account and allow **`user:manage:whispers`** alongside **`user:read:chat`** and **`user:write:chat`**. The sender needs a verified phone number. Test from a different viewer account, with recipient settings permitting Whispers. Ask “What is Sally?” on the corresponding configured channel, then verify the private message arrives; a successful API response alone cannot establish delivery. Test unknown terms and blocked Whispers, ensuring no answer appears publicly and chat stays connected. Twitch limits new recipients and can silently drop Whispers; use the private panel when delivery fails. [Official Whisper limitations](https://dev.twitch.tv/docs/chat/whispers/)

Existing chat-only grants remain usable but cannot send Whispers until reauthorized. StreamLore must be installed and the broadcaster connected on each channel; a dataset entry does not grant access to that channel. Local previews at `/extension/panel.html?demo=1&community=xqc` and `?demo=1&community=caedrel` send no Twitch messages. The updated package and provider behavior have local coverage. Native installation, activation, panel loading, and a private no-match response have been checked in Twitch on TheDarthh. Asking “What is a juicer?” there correctly produces no match because the starter definition belongs to xQc. Broadcaster OAuth consent completed and the chat webhook reports connected. Real Whisper receipt from a different viewer still requires verification.

## Launch process

For the deployed Cloudflare Worker, follow [Cloudflare setup](cloudflare-setup.md). It uses per-channel durable SQLite storage and signed EventSub webhooks; a tunnel or running laptop is not needed. The Node/Docker steps below describe the alternative local/server deployment.

**Account prerequisite:** Enable two-factor authentication on the Twitch developer account in [Security settings](https://www.twitch.tv/settings/security). Twitch blocks Extension creation until 2FA is enabled. Complete that account-security step yourself; never put verification or recovery codes in project files or chat.

1. **Run the EBS on persistent hosting.** The Extension Backend Service is the Node.js 24+ server in this repository. Run `npm install`, `npm run build`, and `npm start` behind a public HTTPS address. Keep its SQLite data and encryption key across restarts; an ephemeral function filesystem cannot preserve channel history or OAuth credentials. Hosting may have costs: check your account’s actual allowance before provisioning anything.

2. **Register the Extension.** In the [Twitch developer console](https://dev.twitch.tv/console/extensions), create a StreamLore Extension and enable **Panel** and **Mobile**. Set the viewer paths to `panel.html` and `mobile.html`, the configuration path to `config.html`, and the live configuration path to `live.html`. Enable **Request Identity Link** for moderators who publish content. Leave the server-side **Required Configuration** identifier empty for this version: the frontend configuration marker does not implement Twitch's server-side configuration-status API. Configuration uses the EBS, rather than a local password. Twitch’s [lifecycle guide](https://dev.twitch.tv/docs/extensions/life-cycle/) explains these fields and the testing states.

3. **Configure separate credentials.** The Extension client ID and shared secret identify embedded viewers. A separate OAuth application connects each broadcaster’s chat account. Register that application in the [application console](https://dev.twitch.tv/console/apps) and set its exact callback to `https://YOUR-EBS/auth/twitch/callback`. Keep both application secrets on the server. The Extension’s shared secret is supplied in base64; do not paste its decoded bytes or include it in frontend assets. See [Twitch’s JWT background](https://dev.twitch.tv/docs/extensions/required-technical-background/#json-web-tokens-jwts).

   Set these values on the server (also documented in [`.env.example`](../.env.example)):

   ```dotenv
   STREAMLORE_MODE=extension
   STREAMLORE_PUBLIC_URL=https://YOUR-EBS
   TWITCH_EXTENSION_CLIENT_ID=your-extension-client-id
   TWITCH_EXTENSION_SECRET=your-base64-extension-shared-secret
   TWITCH_CLIENT_ID=your-separate-oauth-application-client-id
   TWITCH_CLIENT_SECRET=your-oauth-application-secret
   TWITCH_OAUTH_REDIRECT_URI=https://YOUR-EBS/auth/twitch/callback
   STREAMLORE_TOKEN_ENCRYPTION_KEY=your-base64-32-byte-encryption-key
   ```

   Generate a new random encryption key and retain it with your database backups. `STREAMLORE_EXTENSION_ORIGINS` adds explicitly allowed HTTPS development origins when needed; the production Extension origin is `https://YOUR-EXTENSION-CLIENT-ID.ext-twitch.tv`. Do not add wildcard origins. An optional OpenAI key enables AI drafting. Broadcasters authorize chat through configuration; viewers never receive those credentials.

4. **Build the frontend bundle for that EBS.**

   ```sh
   npm run build:extension -- --api-url https://YOUR-EBS
   ```

   Use the generated Extension ZIP and its matching asset directory reported by the build. The EBS URL is public configuration, not a secret. Add its HTTPS origin and every other fetched resource to the Extension version’s allowlists; allowlist the OAuth/configuration destination where required. Keep the Twitch Helper as the first script and bundle application scripts and assets. Do not add an iframe, inline script, or remote application-code dependency. These constraints are documented in the [Extension policies](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/#2-technical) and [hosting CSP](https://dev.twitch.tv/docs/extensions/life-cycle/#asset-hosting).

5. **Test inside Twitch.** Start in **Local Test** with an HTTPS testing base URI ending in `/`. Add your test accounts. For a localhost API, build with `--local-test`, set `STREAMLORE_EXTENSION_LOCAL_TEST=true`, and explicitly list its testing origin in `STREAMLORE_EXTENSION_ORIGINS`; never release that local configuration. A standalone browser page cannot supply Twitch identity. Install the test Extension, open configuration, and use **Connect Twitch** as the same broadcaster. Test reads, moderator boundaries, replies, nominations, votes, mobile layout, and disconnect. Anonymous viewers can read; persistent voting requires a signed-in identity. Content editors must grant identity sharing. Always use the latest `onAuthorized` JWT. [JWT schema](https://dev.twitch.tv/docs/extensions/reference/#jwt-schema)

6. **Upload and run Hosted Test.** Upload the production ZIP, check that paths match the archive, and move the version to Hosted Test. Test from the Twitch CDN with both a broadcaster and an ordinary test viewer. Verify the HTTPS EBS remains reachable and the approved channel’s history appears. Local and Hosted Test are limited to allowed test accounts; ordinary viewers cannot install an unreviewed version. [Testing lifecycle](https://dev.twitch.tv/docs/extensions/life-cycle/#twitch-cdn--hosted-test)

7. **Complete the listing and submit for review.** Supply the console’s required description, contact details, screenshots, review channel, walkthrough, Privacy Policy URL, and EULA/Terms URL. Replace operator/contact placeholders in any provided legal pages; describe actual chat, transcript, AI, vote, and credential handling. Do not claim legal compliance or approval that has not been verified. Use StreamLore’s own branding: Twitch’s policy prohibits Twitch names/logos/Glitch/global emotes in Extension content. Avoid an interface that appears to be Twitch’s own login; OAuth authorization occurs on Twitch. Viewer-authored public content requires identity sharing, attribution, and broadcaster removal controls, so do not expand the read-and-vote viewer scope without those controls. [Listing fields](https://dev.twitch.tv/docs/extensions/life-cycle/#moving-from-hosted-test-to-review), [content and moderation policies](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/)

8. **Release after approval, then activate.** Follow the console’s returned review state, address requested changes, and release an approved version. A broadcaster then installs, configures, and activates it in a panel slot. Verify a real viewer can load it on the channel. Review timing and final approval belong to Twitch; no registration, review, or release is implied by local tests or the build output. [Release lifecycle](https://dev.twitch.tv/docs/extensions/life-cycle/#released)

## Listing copy to review

**Name:** StreamLore

**Summary:** Catch up on stream moments and discover the stories behind your channel's inside jokes.

**Description:** StreamLore welcomes new viewers with a stream recap and explanations of community phrases. Ask privately in the panel for moderator-approved lore or clearly labeled, sourced starter references. Creators record objectives and moments, attach origin clips, and review lore before publishing. Reviewed nominations can enter the library through community voting. Optional AI drafts use supplied captions and clip transcripts and require moderator review. A connected broadcaster account can send private Twitch Whispers in response to known chat questions or !lore requests; delivery depends on Twitch permissions, privacy settings, and limits. !catchup and !lorevote connect viewers to the current stream and community ballot. Broadcasters configure and activate StreamLore as a channel panel.

Before submitting, supply your actual support contact, operator identity, public backend domain, Privacy Policy URL, and Terms/EULA URL. Use screenshots from the native `panel.html` view, rather than the companion website. These are operator-supplied listing details, not values the application can infer.
