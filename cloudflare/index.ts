import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createServer, type Server } from 'node:http';
import express, { type Request as ExpressRequest } from 'express';
import { createApp } from '../server/app.ts';
import { createStoreFromDatabase } from '../server/store-core.ts';
import { createTwitchOAuthWithDatabase, type TwitchAccount } from '../server/oauth-core.ts';
import { getExtensionIdentity, type ExtensionIdentity } from '../server/extension-auth.ts';
import { communities } from '../server/community-lore.ts';
import { createLoreWhispers, loreQuestion, whisperText, type WhisperUsage } from '../server/whispers.ts';
import { parseCommand, chatReply } from '../server/twitch-commands.ts';
import { verifyEventSub, oauthRoutingState, oauthStateChannel } from '../server/eventsub.ts';
import type { ContentAuthor } from '../shared/types.ts';
import { durableDatabase, persistentMap } from './database.ts';
import { handleViewerAuth, cookieViewer } from '../server/viewer-auth.ts';
import { personalViewerApi } from '../server/viewer-api.ts';
import { answerLoreQuestion } from '../shared/lore.ts';
import { starterLore } from '../server/community-lore.ts';

type Env = {
  CHANNELS: DurableObjectNamespace<StreamLoreChannel>; ASSETS: Fetcher;
  STREAMLORE_PUBLIC_URL: string; TWITCH_EXTENSION_CLIENT_ID: string;
  TWITCH_EXTENSION_SECRET?: string; TWITCH_CLIENT_ID?: string; TWITCH_CLIENT_SECRET?: string;
  STREAMLORE_TOKEN_ENCRYPTION_KEY?: string; TWITCH_EVENTSUB_SECRET?: string;
  OPENAI_API_KEY?: string; OPENAI_MODEL?: string;
  STREAMLORE_BOT_USER_ID?: string;
};
const numericId = (value: string) => /^[1-9]\d{0,24}$/.test(value);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const oauthReady = (env: Env) => Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET && env.STREAMLORE_TOKEN_ENCRYPTION_KEY && env.TWITCH_EVENTSUB_SECRET);
const botScopes = ['user:bot', 'channel:bot', 'user:manage:whispers'];
function allowedOrigin(request: Request, env: Env) {
  const origin = request.headers.get('Origin');
  return !origin || [env.STREAMLORE_PUBLIC_URL, `https://${env.TWITCH_EXTENSION_CLIENT_ID}.ext-twitch.tv`].includes(origin);
}
function cors(response: Response, request: Request) {
  const result = new Response(response.body, response);
  const origin = request.headers.get('Origin');
  if (origin) { result.headers.set('Access-Control-Allow-Origin', origin); result.headers.set('Vary', 'Origin'); }
  result.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Extension-JWT');
  result.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  return result;
}
function setup(env: Env) {
  const authenticated = Boolean(env.TWITCH_EXTENSION_CLIENT_ID && env.TWITCH_EXTENSION_SECRET);
  return {
    extension: { registered: Boolean(env.TWITCH_EXTENSION_CLIENT_ID), clientId: env.TWITCH_EXTENSION_CLIENT_ID, released: false, installUrl: null },
    backend: { configured: authenticated, publicUrl: env.STREAMLORE_PUBLIC_URL, runtime: 'Cloudflare Workers + Durable Objects' },
    oauth: { configured: oauthReady(env) }, package: { available: true, localTest: false, url: '/downloads/streamlore-twitch-extension.zip' }, previewUrl: null,
    missing: [!authenticated && 'Set the genuine Twitch Extension shared secret.', !oauthReady(env) && 'Configure the separate Twitch OAuth application, encryption key, and EventSub secret.', 'Complete Twitch Hosted Test, review, and release.'].filter(Boolean),
  };
}
function forward(request: Request, channelId: string, env: Env, body?: string) {
  const headers = new Headers(request.headers);
  headers.set('X-StreamLore-Channel', channelId);
  const target = new Request(request, { headers, ...(body === undefined ? {} : { body }) });
  return env.CHANNELS.get(env.CHANNELS.idFromName(channelId)).fetch(target);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (path.startsWith('/auth/viewer/')) return (await handleViewerAuth(request, env)) || json({ error: 'Not found.' }, 404);
    if (path === '/auth/bot/start' && request.method === 'GET') {
      if (!env.STREAMLORE_BOT_USER_ID || !numericId(env.STREAMLORE_BOT_USER_ID) || !oauthReady(env)) return json({ error: 'The operator must configure the dedicated StreamLore bot account.' }, 503);
      const operator = cookieViewer(request, env.STREAMLORE_TOKEN_ENCRYPTION_KEY || '');
      if (!operator || operator.userId !== env.STREAMLORE_BOT_USER_ID) return Response.redirect(`${env.STREAMLORE_PUBLIC_URL}/auth/viewer/start?bot=1`, 302);
      const bot = env.CHANNELS.get(env.CHANNELS.idFromName(env.STREAMLORE_BOT_USER_ID));
      return Response.redirect(await bot.startPersonalBotConnection(), 302);
    }
    if (['/api/viewer/session', '/api/viewer/ask'].includes(path)) {
      const configured = Boolean(env.STREAMLORE_BOT_USER_ID && numericId(env.STREAMLORE_BOT_USER_ID));
      return personalViewerApi(request, env.STREAMLORE_TOKEN_ENCRYPTION_KEY || '', configured, (recipient, channel, question) => env.CHANNELS.get(env.CHANNELS.idFromName(env.STREAMLORE_BOT_USER_ID!)).sendPersonalWhisper(recipient, channel, question));
    }
    if (path === '/api/health') return json({ ok: true, mode: 'extension', runtime: 'cloudflare-workers' });
    if (path === '/api/install/status') return json(setup(env));
    if (path.startsWith('/api/extension/')) {
      if (!allowedOrigin(request, env)) return json({ error: 'This origin is not allowed.' }, 403);
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), request);
      if (!env.TWITCH_EXTENSION_SECRET) return cors(json({ error: 'The operator must configure the Twitch Extension shared secret.' }, 503), request);
      let identity;
      try { identity = getExtensionIdentity({ headers: { authorization: request.headers.get('Authorization') || undefined, 'x-extension-jwt': request.headers.get('X-Extension-JWT') || undefined } }, env.TWITCH_EXTENSION_SECRET, env.TWITCH_EXTENSION_CLIENT_ID); }
      catch { return cors(json({ error: 'Twitch authorization is invalid or expired.' }, 401), request); }
      if (!identity) return cors(json({ error: 'Open StreamLore inside Twitch.' }, 401), request);
      try { return cors(await forward(request, identity.channelId, env), request); }
      catch (error) { console.error('Channel service failed:', error instanceof Error ? error.message : 'unavailable'); return cors(json({ error: 'StreamLore could not load this channel. Try again shortly.' }, 503), request); }
    }
    if (path === '/auth/twitch/callback') {
      const channelId = oauthStateChannel(url.searchParams.get('state') || '', env.STREAMLORE_TOKEN_ENCRYPTION_KEY || '');
      if (!channelId || !oauthReady(env)) return json({ error: 'Start a new connection from Twitch Extension configuration.' }, 400);
      return forward(request, channelId, env);
    }
    if (path === '/twitch/eventsub' && request.method === 'POST') {
      if (!env.TWITCH_EVENTSUB_SECRET || Number(request.headers.get('Content-Length') || 0) > 80_000) return json({ error: 'Webhook is unavailable.' }, 503);
      const body = await request.text();
      if (!verifyEventSub(request.headers, body, env.TWITCH_EVENTSUB_SECRET)) return json({ error: 'Invalid webhook signature or timestamp.' }, 403);
      let payload;
      try { payload = JSON.parse(body); } catch { return json({ error: 'Invalid webhook body.' }, 400); }
      const channelId = payload.subscription?.condition?.broadcaster_user_id;
      if (typeof channelId !== 'string' || !numericId(channelId) || payload.subscription?.condition?.user_id !== channelId || payload.subscription?.type !== 'channel.chat.message') return json({ error: 'Unexpected subscription.' }, 400);
      return forward(request, channelId, env, body);
    }
    const channel = path.match(/^\/channels\/([1-9]\d{0,24})(\/api\/.*)$/);
    if (channel) return request.method === 'GET' ? forward(request, channel[1], env) : json({ error: 'Use the Twitch Extension to make changes.' }, 403);
    if (path.startsWith('/api/')) return json({ error: 'Use the Twitch Extension for channel access.' }, 404);
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
    if (path === '/') return Response.redirect(`${env.STREAMLORE_PUBLIC_URL}/viewer`, 302);
    if (path === '/install') url.pathname = '/install.html';
    else if (path === '/viewer') url.pathname = '/viewer.html';
    else if (/^\/channels\/[1-9]\d{0,24}(?:\/overlay)?\/?$/.test(path)) url.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(url, request));
  },
};

export class StreamLoreChannel extends DurableObject<Env> {
  private channelId = '';
  private runtime?: ReturnType<typeof createApp>;
  private database?: ReturnType<typeof durableDatabase>;
  private oauth?: ReturnType<typeof createTwitchOAuthWithDatabase>;
  private server?: Server;
  private port = 0;
  private ready?: Promise<void>;
  private resetAfterResponse = false;
  private whisper?: ReturnType<typeof createLoreWhispers>;
  private appAccess?: { token: string; expiresAt: number };
  private personalLookupAt = new Map<string, number>();

  async startPersonalBotConnection(): Promise<string> {
    const id = this.env.STREAMLORE_BOT_USER_ID || '';
    if (!numericId(id)) throw new Error('Configure the StreamLore sender.');
    this.ready ||= this.initialize(id); await this.ready;
    if (!this.oauth) throw new Error('Configure Twitch OAuth.');
    return this.oauth.begin(id);
  }

  async lookupPersonalLore(channelId: string, question: string) {
    if (!numericId(channelId) || !loreQuestion(question)) return null;
    if (!this.ctx.storage.kv.get('initialized')) return answerLoreQuestion(starterLore(channelId), question) || null;
    this.ready ||= this.initialize(channelId); await this.ready;
    return this.runtime!.loreAnswer(question) || null;
  }

  async sendPersonalWhisper(recipientId: string, channelLogin: string, question: string) {
    const botId = this.env.STREAMLORE_BOT_USER_ID || '';
    if (!numericId(botId) || !numericId(recipientId) || !/^[a-z0-9_]{1,25}$/.test(channelLogin) || !loreQuestion(question)) throw new Error('Invalid personal request.');
    this.ready ||= this.initialize(botId); await this.ready;
    if (!this.oauth?.account(botId)) return { delivery: 'bot_not_connected', message: 'The StreamLore bot must be connected before it can send Whispers.' };
    if (recipientId === botId) return { delivery: 'self', message: 'Connect your viewer account. Twitch cannot Whisper to the sending bot itself.' };
    const now = Date.now();
    if (now - (this.personalLookupAt.get(recipientId) || 0) < 2000) return { delivery: 'rate_limited', message: 'Wait a moment before asking another question.' };
    if (this.personalLookupAt.size > 1000) this.personalLookupAt.clear();
    this.personalLookupAt.set(recipientId, now);
    const known = communities.find(item => item.login === channelLogin);
    let channelId: string, channelName: string;
    if (known) { channelId = known.channelId; channelName = known.displayName; }
    else {
      const response = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin)}`, { headers: { Authorization: `Bearer ${await this.appToken()}`, 'Client-Id': this.env.TWITCH_CLIENT_ID! }, signal: AbortSignal.timeout(10000) });
      const users = await response.json() as { data?: { id: string; display_name: string }[] };
      const channel = users.data?.[0];
      if (!response.ok || !channel || !numericId(channel.id)) return { delivery: 'no_match', message: 'This Twitch channel could not be found.' };
      channelId = channel.id; channelName = channel.display_name;
    }
    const entry = channelId === botId ? this.runtime!.loreAnswer(question) : await this.env.CHANNELS.get(this.env.CHANNELS.idFromName(channelId)).lookupPersonalLore(channelId, question);
    if (!entry) return { delivery: 'no_match', message: `No reviewed lore or sourced starter definition matches in ${channelName}.`, channel: channelName };
    try {
      const sent = await this.whisper!(question, recipientId, botId, { entry, channelName });
      return { delivery: sent ? 'accepted' : 'rate_limited', message: sent ? `Whisper requested for ${channelName} · ${entry.term}. Check your Twitch Whispers; Twitch may filter delivery.` : 'Whisper limits reached. Wait 15 seconds, or try again later if today’s recipient limit was reached.', channel: channelName, term: entry.term };
    } catch { return { delivery: 'failed', message: 'Twitch could not accept the Whisper. Check recipient privacy settings and the bot’s phone verification.', channel: channelName, term: entry.term }; }
  }

  async fetch(request: Request): Promise<Response> {
    const channelId = request.headers.get('X-StreamLore-Channel') || '';
    if (!numericId(channelId) || (this.channelId && this.channelId !== channelId)) return json({ error: 'Invalid channel.' }, 403);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/channels/') && !this.ctx.storage.kv.get('initialized')) return json({ error: 'This channel has not opened StreamLore yet.' }, 404);
    this.ready ||= this.initialize(channelId);
    await this.ready;
    if (url.pathname === '/twitch/eventsub') return this.webhook(request);
    if (url.pathname.startsWith('/channels/')) { url.pathname = url.pathname.replace(`/channels/${channelId}`, ''); request = new Request(url, request); }
    const response = await handleAsNodeRequest(this.port, request);
    if (this.resetAfterResponse) {
      this.runtime?.close(); this.oauth?.close(); this.database?.close(); this.server?.close();
      await this.ctx.storage.deleteAll(); this.runtime = undefined; this.oauth = undefined; this.database = undefined; this.server = undefined; this.ready = undefined; this.resetAfterResponse = false;
    }
    return response;
  }

  private async initialize(channelId: string) {
    if (this.channelId && this.channelId !== channelId) throw new Error('Channel mismatch.');
    this.channelId = channelId;
    const env = this.env, db = durableDatabase(this.ctx.storage);
    this.database = db;
    this.ctx.storage.kv.put('channel-id', channelId);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS eventsub_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS eventsub_seen_at ON eventsub_seen(at)');
    const store = createStoreFromDatabase(db, false);
    const identities = new WeakMap<ExpressRequest, ExtensionIdentity>(), authors = new WeakMap<ExpressRequest, ContentAuthor>();
    Object.assign(process.env, { OPENAI_API_KEY: env.OPENAI_API_KEY || '', OPENAI_MODEL: env.OPENAI_MODEL || 'gpt-5.4-mini' });
    const runtime = createApp({ store, mode: 'live', communityChannelId: channelId, publicUrl: `${env.STREAMLORE_PUBLIC_URL}/channels/${channelId}`, staticFiles: false, extensionManaged: true,
      authorizeModerator: req => { const id = identities.get(req); return Boolean(id?.userId && ['broadcaster', 'moderator'].includes(id.role)); },
      trustedRequest: req => identities.has(req), voterIdentity: req => { const id = identities.get(req); return id?.opaqueUserId.startsWith('U') ? `extension:${id.opaqueUserId}` : undefined; }, contentAuthor: req => authors.get(req),
    });
    this.runtime = runtime;
    const community = communities.find(item => item.channelId === channelId);
    if (community && !store.read().channel.login) runtime.setChannel({ ...store.read().channel, login: community.login, displayName: community.displayName });
    const app = express(); app.disable('x-powered-by');
    if (oauthReady(env)) {
      this.oauth = createTwitchOAuthWithDatabase({ databasePath: ':durable:', clientId: env.TWITCH_CLIENT_ID!, clientSecret: env.TWITCH_CLIENT_SECRET!, redirectUri: `${env.STREAMLORE_PUBLIC_URL}/auth/twitch/callback`, encryptionKey: env.STREAMLORE_TOKEN_ENCRYPTION_KEY!, extraScopes: botScopes,
        states: persistentMap(this.ctx.storage, 'oauth-states'), generations: persistentMap(this.ctx.storage, 'oauth-generations'),
        ...(channelId === env.STREAMLORE_BOT_USER_ID ? { scopes: ['user:manage:whispers'] } : {}),
        makeState: (id, nonce) => oauthRoutingState(id, nonce, env.STREAMLORE_TOKEN_ENCRYPTION_KEY!),
        onConnect: async account => {
          runtime.setChannel({ ...store.read().channel, login: account.login, displayName: account.displayName, profileImageUrl: account.profileImageUrl });
          if (channelId === env.STREAMLORE_BOT_USER_ID) { this.chatStatus(false, 'StreamLore personal Whisper sender connected.'); await this.ctx.storage.setAlarm(Date.now() + 3600000); return; }
          try { await this.subscribe(account); await this.refreshChannel(); await this.ctx.storage.setAlarm(Date.now() + 3600000); } catch { this.chatStatus(false, 'Twitch webhook setup failed. Reconnect with chat, bot, and Whisper permissions.'); }
        },
        onDisconnect: async () => { await this.unsubscribe(); await this.ctx.storage.deleteAlarm(); this.chatStatus(false, 'Broadcaster disconnected. Public definitions remain readable.'); },
      }, db);
      app.use('/auth/twitch', this.oauth.router);
      const account = this.oauth.account(channelId);
      if (account) runtime.setChannel({ ...store.read().channel, login: account.login, displayName: account.displayName, profileImageUrl: account.profileImageUrl });
      const connected = this.ctx.storage.kv.get<boolean>('chat-enabled') === true;
      runtime.setTwitchStatus({ configured: Boolean(account), connected: Boolean(account && connected), message: account ? connected ? 'Twitch webhook chat connected. Known questions receive private Whispers.' : 'Waiting for Twitch webhook verification. Reconnect if needed.' : 'Connect the broadcaster account for chat and private Whispers.' });
    }
    this.whisper = createLoreWhispers({ answer: runtime.loreAnswer,
      usage: this.ctx.storage.kv.get<WhisperUsage>('whisper-usage'), saveUsage: usage => { this.ctx.storage.kv.put('whisper-usage', usage); },
      send: async (recipient, entry, channelName) => { await this.api(`whispers?${new URLSearchParams({ from_user_id: channelId, to_user_id: recipient })}`, { method: 'POST', body: JSON.stringify({ message: whisperText(entry, channelName || store.read().channel.displayName) }) }); },
    });
    app.use('/api/extension', express.json({ limit: '80kb', strict: true }));
    app.use('/api/extension', async (req, res, next) => {
      try {
        if (!env.TWITCH_EXTENSION_SECRET) return res.status(503).json({ error: 'Extension secret is not configured.' });
        const identity = getExtensionIdentity(req, env.TWITCH_EXTENSION_SECRET, env.TWITCH_EXTENSION_CLIENT_ID);
        if (!identity || identity.channelId !== channelId) return res.status(401).json({ error: 'Invalid Twitch channel authorization.' });
        if (identity.role === 'broadcaster' && !identity.userId && identity.opaqueUserId === `U${channelId}`) identity.userId = channelId;
        identities.set(req, identity);
        const account = this.oauth?.account(channelId), creator = ['broadcaster', 'moderator'].includes(identity.role) && Boolean(identity.userId);
        if (req.path === '/status' && req.method === 'GET') return res.json({ channelId, role: identity.role, identityLinked: Boolean(identity.userId), canManage: creator, canModerate: creator && Boolean(account), canVote: identity.opaqueUserId.startsWith('U'), chat: runtime.state().connection.twitch, oauthConfigured: Boolean(this.oauth), configured: Boolean(store.read().extensionConfigured), viewerUrl: `${env.STREAMLORE_PUBLIC_URL}/channels/${channelId}`, overlayUrl: `${env.STREAMLORE_PUBLIC_URL}/channels/${channelId}/overlay`, ...(account ? { connectedAccount: { login: account.login, displayName: account.displayName } } : {}) });
        if (req.path === '/connect' && req.method === 'POST') {
          if (identity.role !== 'broadcaster') return res.status(403).json({ error: 'Only the broadcaster can connect.' });
          if (!this.oauth) return res.status(503).json({ error: 'Configure the Twitch OAuth application first.' });
          return res.json({ url: this.oauth.begin(channelId) });
        }
        if (req.path === '/connection' && req.method === 'DELETE') {
          if (identity.role !== 'broadcaster') return res.status(403).json({ error: 'Only the broadcaster can disconnect.' });
          await this.oauth?.disconnect(channelId); return res.json({ ok: true });
        }
        if (req.path === '/configure' && req.method === 'POST') {
          if (identity.role !== 'broadcaster' || !account) return res.status(403).json({ error: 'Connect as the broadcaster before finishing setup.' });
          store.update(data => { data.extensionConfigured = true; }); return res.json({ configured: true });
        }
        if (req.path === '/data' && req.method === 'DELETE') {
          if (identity.role !== 'broadcaster' || req.body?.confirm !== 'DELETE') return res.status(403).json({ error: 'The broadcaster must confirm deletion.' });
          await this.oauth?.disconnect(channelId); this.resetAfterResponse = true; return res.json({ ok: true });
        }
        const read = req.method === 'GET' && ['/state', '/catchup'].includes(req.path);
        const question = req.method === 'POST' && req.path === '/ask';
        const vote = req.method === 'POST' && /^\/lore\/[^/]+\/vote$/.test(req.path);
        const mod = req.path.startsWith('/mod/');
        if (!read && !question && !vote && !mod) return res.status(404).json({ error: 'Unknown Extension route.' });
        if (vote && !identity.opaqueUserId.startsWith('U')) return res.status(403).json({ error: 'Sign in to Twitch to vote.' });
        if (mod && !creator) return res.status(403).json({ error: 'A verified broadcaster or moderator identity is required.' });
        if (mod && req.method !== 'GET') {
          if (!this.oauth || !account) return res.status(409).json({ error: 'Connect the channel before publishing.' });
          authors.set(req, await this.oauth.resolveUser(channelId, identity.userId!));
        }
        const original = req.url; req.url = `/api${req.url}`;
        runtime.app(req, res, error => { req.url = original; next(error); });
      } catch { res.status(502).json({ error: 'Twitch could not complete this request. Reconnect or try again.' }); }
    });
    app.use('/api', (req, res, next) => {
      if (req.method !== 'GET' || !['/state', '/catchup', '/events', '/auth/session', '/health'].includes(req.path)) return res.status(403).json({ error: 'Use the Twitch Extension to manage this channel.' });
      req.url = `/api${req.url}`; runtime.app(req, res, next);
    });
    app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
    app.use((error: Error & { type?: string }, _req: ExpressRequest, res: express.Response, _next: express.NextFunction) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Send a valid JSON request within the size limit.' }));
    this.server = createServer(app);
    await new Promise<void>(resolve => this.server!.listen(0, () => { const address = this.server!.address(); if (address && typeof address !== 'string') this.port = address.port; resolve(); }));
    this.ctx.storage.kv.put('initialized', true);
  }

  private chatStatus(connected: boolean, message: string) {
    this.ctx.storage.kv.put('chat-enabled', connected);
    this.runtime?.setTwitchStatus({ configured: Boolean(this.oauth?.account(this.channelId)), connected, message });
  }
  private async appToken(): Promise<string> {
    if (this.appAccess && this.appAccess.expiresAt > Date.now() + 60000) return this.appAccess.token;
    const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: this.env.TWITCH_CLIENT_ID!, client_secret: this.env.TWITCH_CLIENT_SECRET!, grant_type: 'client_credentials' }), signal: AbortSignal.timeout(10000) });
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!response.ok || !data.access_token) throw new Error('Twitch app authorization failed.');
    this.appAccess = { token: data.access_token, expiresAt: Date.now() + Math.max(0, Number(data.expires_in) || 0) * 1000 };
    return data.access_token;
  }
  private async subscribe(account: TwitchAccount) {
    await this.unsubscribe();
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', { method: 'POST', headers: { Authorization: `Bearer ${await this.appToken()}`, 'Client-Id': this.env.TWITCH_CLIENT_ID!, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: account.channelId, user_id: account.channelId }, transport: { method: 'webhook', callback: `${this.env.STREAMLORE_PUBLIC_URL}/twitch/eventsub`, secret: this.env.TWITCH_EVENTSUB_SECRET } }), signal: AbortSignal.timeout(10000) });
    const data = await response.json() as { data?: { id: string }[] };
    if (!response.ok || !data.data?.[0]?.id) throw new Error('Twitch webhook subscription failed.');
    this.ctx.storage.kv.put('subscription', data.data[0].id);
  }
  private async unsubscribe() {
    const id = this.ctx.storage.kv.get<string>('subscription');
    this.ctx.storage.kv.delete('subscription'); this.ctx.storage.kv.put('chat-enabled', false);
    if (!id) return;
    try { await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await this.appToken()}`, 'Client-Id': this.env.TWITCH_CLIENT_ID! }, signal: AbortSignal.timeout(10000) }); } catch { /* A disconnected account never processes further messages, even if cleanup fails. */ }
  }
  private async api(path: string, init: RequestInit = {}): Promise<any> {
    if (!this.oauth) throw new Error('Twitch is not connected.');
    if (Date.now() - (this.ctx.storage.kv.get<number>('last-token-validation') || 0) > 3600000) await this.validateToken();
    const send = async (force = false) => fetch(`https://api.twitch.tv/helix/${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.oauth!.getAccessToken(this.channelId, force)}`, 'Client-Id': this.env.TWITCH_CLIENT_ID! }, signal: AbortSignal.timeout(10000) });
    let response = await send(); if (response.status === 401) response = await send(true);
    if (!response.ok) throw new Error(`Twitch request failed (${response.status}).`);
    return response.status === 204 ? {} : response.json();
  }
  private async validateToken() {
    const validate = async (force = false) => fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${await this.oauth!.getAccessToken(this.channelId, force)}` }, signal: AbortSignal.timeout(10000) });
    let response = await validate(); if (response.status === 401) response = await validate(true);
    const data = await response.json() as { user_id?: string; client_id?: string; scopes?: string[] };
    const required = this.channelId === this.env.STREAMLORE_BOT_USER_ID ? ['user:manage:whispers'] : ['user:read:chat', 'user:write:chat', ...botScopes];
    if (!response.ok || data.user_id !== this.channelId || data.client_id !== this.env.TWITCH_CLIENT_ID || !required.every(scope => data.scopes?.includes(scope))) throw new Error('Twitch authorization needs reconnecting.');
    this.ctx.storage.kv.put('last-token-validation', Date.now());
  }
  private async refreshChannel() {
    this.ctx.storage.kv.put('last-channel-refresh', Date.now());
    const [streams, channels] = await Promise.all([this.api(`streams?user_id=${this.channelId}`), this.api(`channels?broadcaster_id=${this.channelId}`)]);
    const account = this.oauth!.account(this.channelId)!;
    const stream = streams.data?.[0], channel = channels.data?.[0];
    this.runtime!.setChannel({ login: account.login, displayName: account.displayName, profileImageUrl: account.profileImageUrl, category: stream?.game_name || channel?.game_name || '', title: stream?.title || channel?.title || '', live: Boolean(stream), startedAt: stream?.started_at || '' });
  }
  async alarm() {
    const id = this.ctx.storage.kv.get<string>('channel-id');
    if (!id) return;
    this.ready ||= this.initialize(id); await this.ready;
    if (!this.oauth?.account(id)) return;
    try { await this.validateToken(); await this.refreshChannel(); }
    catch { this.chatStatus(false, 'Twitch validation failed. Reconnect the broadcaster if authorization was revoked.'); }
    await this.ctx.storage.setAlarm(Date.now() + 3600000);
  }
  private async webhook(request: Request): Promise<Response> {
    const body = await request.text();
    if (!verifyEventSub(request.headers, body, this.env.TWITCH_EVENTSUB_SECRET || '')) return json({ error: 'Invalid webhook signature.' }, 403);
    const payload = JSON.parse(body), account = this.oauth?.account(this.channelId);
    if (!account || payload.subscription?.condition?.broadcaster_user_id !== this.channelId || payload.subscription?.condition?.user_id !== this.channelId) return new Response(null, { status: 204 });
    const type = request.headers.get('Twitch-Eventsub-Message-Type');
    if (type === 'webhook_callback_verification') {
      if (typeof payload.challenge !== 'string' || payload.challenge.length > 2000) return json({ error: 'Invalid challenge.' }, 400);
      this.ctx.storage.kv.put('subscription', payload.subscription.id); this.chatStatus(true, 'Twitch webhook connected. Known chat questions receive private Whispers.');
      return new Response(payload.challenge, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
    if (payload.subscription?.id !== this.ctx.storage.kv.get('subscription')) return new Response(null, { status: 204 });
    if (type === 'revocation') { this.ctx.storage.kv.delete('subscription'); this.chatStatus(false, 'Twitch revoked chat authorization. Reconnect the broadcaster.'); return new Response(null, { status: 204 }); }
    if (type !== 'notification') return json({ error: 'Unsupported event type.' }, 400);
    const id = request.headers.get('Twitch-Eventsub-Message-Id')!;
    this.ctx.storage.sql.exec('DELETE FROM eventsub_seen WHERE at < ?', Date.now() - 600000);
    if (this.ctx.storage.sql.exec('SELECT 1 FROM eventsub_seen WHERE id = ?', id).toArray().length) return new Response(null, { status: 204 });
    this.ctx.storage.sql.exec('INSERT INTO eventsub_seen (id, at) VALUES (?, ?)', id, Date.now());
    this.ctx.waitUntil(this.onChat(payload.event).catch(() => this.chatStatus(true, 'Twitch could not accept a reply. Use Ask privately in the panel; check permissions, phone verification, and Whisper limits.')));
    return new Response(null, { status: 204 });
  }
  private async onChat(event: any) {
    if (!event || event.broadcaster_user_id !== this.channelId || event.chatter_user_id === this.channelId || typeof event.message?.text !== 'string' || (event.source_broadcaster_user_id && event.source_broadcaster_user_id !== this.channelId)) return;
    if (Date.now() - (this.ctx.storage.kv.get<number>('last-channel-refresh') || 0) > 60000) await this.refreshChannel();
    const text = event.message.text.slice(0, 500), runtime = this.runtime!;
    if (loreQuestion(text)) { await this.whisper!(text, String(event.chatter_user_id || ''), this.channelId); return; }
    runtime.ingestChat(String(event.chatter_user_name || 'Viewer').slice(0, 80), text);
    const command = parseCommand(text);
    if (!command) return;
    const vote = command.name === 'lorevote' ? runtime.voteLore(command.query, String(event.chatter_user_id || '')) : null;
    const now = Date.now(); if (now - (this.ctx.storage.kv.get<number>('last-chat-reply') || 0) < 3000) return;
    this.ctx.storage.kv.put('last-chat-reply', now);
    const reply = command.name === 'lorevote' ? vote!.slice(0, 500) : chatReply({ name: command.name as 'catchup' | 'lore', query: command.query }, { getCatchup: runtime.catchup, getLore: runtime.loreReply }, `${this.env.STREAMLORE_PUBLIC_URL}/channels/${this.channelId}`);
    await this.api('chat/messages', { method: 'POST', body: JSON.stringify({ broadcaster_id: this.channelId, sender_id: this.channelId, message: reply, reply_parent_message_id: event.message_id }) });
  }
}
