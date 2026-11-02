import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { createTwitchOAuthWithDatabase, TwitchRejectedError } from '../server/oauth-core.ts';
import { createViewerListener, maxWatchedChannels, type ChatQuestion, type EventSubSocket } from '../server/everywhere.ts';
import { communitySlang } from '../server/community-lore.ts';
import { createWhisperLimiter, whisperText, type WhisperUsage } from '../server/whispers.ts';
import type { Lore } from '../shared/types.ts';
import { durableDatabase, persistentMap } from './database.ts';
import type { Env } from './index.ts';

type OAuth = ReturnType<typeof createTwitchOAuthWithDatabase>;
type ChannelAnswer = { installed?: boolean; chatConnected?: boolean; entry?: Lore | null; displayName?: string };
// Anonymous counts for the public status: where an opted-in question stopped, never who asked it or what it said.
type Activity = { questions: number; unknown: number; answeredByChannel: number; limited: number; sent: number; failed: number; lastFailure: number | null };
const emptyActivity = (): Activity => ({ questions: 0, unknown: 0, answeredByChannel: 0, limited: 0, sent: 0, failed: 0, lastFailure: null });
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value);
// Viewers let StreamLore read chat as them and see which followed channels are live; it never posts or whispers as them.
const viewerScopes = ['user:read:chat', 'user:read:follows'];

async function openSocket(url: string): Promise<EventSubSocket> {
  const response = await fetch(url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket' } });
  const socket = response.webSocket;
  if (!socket) throw new Error(`Twitch EventSub refused the WebSocket (${response.status}).`);
  socket.accept();
  return socket;
}

// One object for every opted-in viewer: their encrypted grants, one EventSub WebSocket each while a followed channel is
// live, and the Whisper account (STREAMLORE_BOT_LOGIN) that answers them. Outbound WebSockets keep it awake, so a
// one-minute alarm only restores listeners after an eviction.
export class StreamLoreEverywhere extends DurableObject<Env> {
  private ready?: Promise<void>;
  private server?: Server;
  private port = 0;
  private viewers?: OAuth;
  private bot?: OAuth;
  private reserve: (recipientId: string) => boolean = () => false;
  private listeners = new Map<string, ReturnType<typeof createViewerListener>>();
  private refreshed = new Map<string, number>();
  private validated = new Map<string, number>();
  private activity: Activity = emptyActivity();

  async fetch(request: Request): Promise<Response> {
    // Open WebSockets keep this object running old code through a deploy; restart when a newer Worker calls.
    const caller = request.headers.get('X-StreamLore-Version'), own = this.env.CF_VERSION_METADATA?.id;
    if (caller && own && caller !== own) this.ctx.abort('StreamLore was redeployed.');
    this.ready ||= this.initialize();
    await this.ready;
    return handleAsNodeRequest(this.port, request);
  }

  async alarm() {
    this.ready ||= this.initialize();
    await this.ready;
    await this.refreshAll();
  }

  private botLogin() {
    const login = (this.env.STREAMLORE_BOT_LOGIN || '').trim().toLowerCase();
    return /^[a-z0-9_]{1,25}$/.test(login) ? login : '';
  }
  private capacity() {
    const value = Number(this.env.STREAMLORE_MAX_VIEWERS || 40);
    return Number.isInteger(value) && value > 0 ? Math.min(value, 1000) : 40;
  }
  private botAccount() {
    const id = this.ctx.storage.kv.get<string>('bot-id'), account = id ? this.bot?.account(id) : null;
    return account && account.login.toLowerCase() === this.botLogin() ? account : null;
  }

  private async initialize() {
    const env = this.env, db = durableDatabase(this.ctx.storage), app = express(), bot = this.botLogin(), back = `${env.STREAMLORE_PUBLIC_URL}/everywhere`;
    app.disable('x-powered-by');
    this.reserve = createWhisperLimiter({ usage: this.ctx.storage.kv.get<WhisperUsage>('whisper-usage'), saveUsage: usage => { this.ctx.storage.kv.put('whisper-usage', usage); } });
    this.activity = { ...emptyActivity(), ...this.ctx.storage.kv.get<Activity>('activity') };
    if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET && env.STREAMLORE_TOKEN_ENCRYPTION_KEY) {
      // Both sign-ins reuse the OAuth app's registered callback; the state prefix routes them here.
      const shared = { databasePath: ':durable:', clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, redirectUri: `${env.STREAMLORE_PUBLIC_URL}/auth/twitch/callback`, encryptionKey: env.STREAMLORE_TOKEN_ENCRYPTION_KEY };
      this.viewers = createTwitchOAuthWithDatabase({ ...shared, scopes: viewerScopes, anyAccount: true, table: 'viewer_accounts', maxAccounts: this.capacity(),
        states: persistentMap(this.ctx.storage, 'viewer-states'), makeState: (_id, nonce) => `viewer.${nonce}`,
        page: { connected: 'StreamLore is on.', connectedBody: `Ask about a phrase in the chat of any channel you follow while it is live, like “whats a juicer?” in xQc’s chat, and ${bot || 'StreamLore'} will whisper you the answer. StreamLore reads chat as you but never posts or whispers as you. Turn it off anytime in Twitch Settings → Connections.`, failed: 'StreamLore could not turn on.', failedBody: `The sign-in expired or was declined, StreamLore is full, Twitch did not grant chat reading, or you signed in as ${bot || 'the Whisper account'}. Log in to Twitch with your own account and start again from the StreamLore page.`, returnUrl: back, returnLabel: 'Back to StreamLore' },
        onConnect: async account => {
          // The Whisper account cannot whisper itself; a browser still signed in as it would otherwise enroll it by mistake.
          if (account.channelId === this.ctx.storage.kv.get<string>('bot-id')) {
            await this.viewers!.disconnect(account.channelId);
            throw new Error('The Whisper account cannot turn StreamLore on for itself.');
          }
          this.refreshed.delete(account.channelId); await this.refreshViewer(account.channelId); await this.scheduleAlarm();
        },
        onDisconnect: id => { this.listeners.get(id)?.close(); this.listeners.delete(id); this.refreshed.delete(id); this.validated.delete(id); },
      }, db);
      this.bot = createTwitchOAuthWithDatabase({ ...shared, scopes: ['user:manage:whispers'], table: 'whisper_account', maxAccounts: 1,
        states: persistentMap(this.ctx.storage, 'bot-states'), generations: persistentMap(this.ctx.storage, 'bot-generations'), makeState: (_id, nonce) => `bot.${nonce}`,
        page: { connected: `${bot} can send answers.`, connectedBody: 'StreamLore will whisper slang answers from this account. Twitch only delivers Whispers from accounts with a verified phone number.', failed: 'The Whisper account was not connected.', failedBody: `Sign in as ${bot} and allow Whispers, then try again from the StreamLore page.`, returnUrl: back, returnLabel: 'Back to StreamLore' },
        onConnect: async account => { this.ctx.storage.kv.put('bot-id', account.channelId); await this.refreshAll(); },
        onDisconnect: () => { this.ctx.storage.kv.delete('bot-id'); },
      }, db);
      app.use('/auth/twitch', (req, res, next) => (String(req.query.state || '').startsWith('bot.') ? this.bot! : this.viewers!).router(req, res, next));
    }
    app.get('/api/everywhere/status', (_req, res) => {
      const viewers = this.viewers?.listAccounts().length || 0;
      const listeners = [...this.listeners.values()];
      res.set('Cache-Control', 'no-store').json({ configured: Boolean(this.viewers && bot), bot: { login: bot, connected: Boolean(this.botAccount()) }, viewers, capacity: this.capacity(), full: viewers >= this.capacity(), listening: listeners.filter(listener => listener.connected()).length, channels: listeners.reduce((total, listener) => total + listener.channels().length, 0), activity: this.activity });
    });
    app.get('/everywhere/on', (_req, res) => {
      if (!this.viewers || !this.botAccount()) return res.redirect(303, '/everywhere?notice=unavailable');
      if (this.viewers.listAccounts().length >= this.capacity()) return res.redirect(303, '/everywhere?notice=full');
      res.redirect(303, this.viewers.begin());
    });
    app.get('/everywhere/bot', async (_req, res) => {
      if (!this.bot || !bot) return res.redirect(303, '/everywhere?notice=unavailable');
      try {
        const id = await this.userId(bot), current = this.ctx.storage.kv.get<string>('bot-id');
        if (current && current !== id) await this.bot.disconnect(current);
        // Anyone may open this, but Twitch only completes it for the account that owns this user ID.
        res.redirect(303, this.bot.begin(id));
      } catch (error) {
        console.error('Whisper account connection failed:', error instanceof Error ? error.message : 'unavailable');
        res.redirect(303, '/everywhere?notice=unavailable');
      }
    });
    app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
    this.server = createServer(app);
    await new Promise<void>(resolve => this.server!.listen(0, () => { const address = this.server!.address(); if (address && typeof address !== 'string') this.port = address.port; resolve(); }));
    void this.refreshAll().catch(() => {});
  }

  private async userId(login: string): Promise<string> {
    const token = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: this.env.TWITCH_CLIENT_ID!, client_secret: this.env.TWITCH_CLIENT_SECRET!, grant_type: 'client_credentials' }), signal: AbortSignal.timeout(10000) });
    const { access_token } = await token.json() as { access_token?: string };
    if (!token.ok || !access_token) throw new Error('Twitch app authorization failed.');
    const users = await fetch(`https://api.twitch.tv/helix/users?${new URLSearchParams({ login })}`, { headers: { Authorization: `Bearer ${access_token}`, 'Client-Id': this.env.TWITCH_CLIENT_ID! }, signal: AbortSignal.timeout(10000) });
    const id = ((await users.json()) as { data?: { id?: string }[] }).data?.[0]?.id;
    if (!users.ok || !numericId(id)) throw new Error('The Whisper account was not found on Twitch.');
    return id;
  }

  private async helix(oauth: OAuth, userId: string, path: string, init: RequestInit = {}): Promise<any> {
    const send = async (force = false) => fetch(`https://api.twitch.tv/helix/${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await oauth.getAccessToken(userId, force)}`, 'Client-Id': this.env.TWITCH_CLIENT_ID! }, signal: AbortSignal.timeout(10000) });
    let response = await send();
    if (response.status === 401) response = await send(true);
    if (!response.ok) throw new TwitchRejectedError(response.status, `Twitch request failed (${response.status}).`);
    return response.status === 204 ? {} : response.json();
  }

  private listener(viewerId: string) {
    let listener = this.listeners.get(viewerId);
    if (!listener) {
      listener = createViewerListener({ viewerId, openSocket, helix: (path, init) => this.helix(this.viewers!, viewerId, path, init),
        onQuestion: question => this.answer(viewerId, question),
        onRevoked: () => { void this.viewers?.disconnect(viewerId).catch(() => {}); },
      });
      this.listeners.set(viewerId, listener);
    }
    return listener;
  }

  private async scheduleAlarm() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  private async refreshAll() {
    const botId = this.ctx.storage.kv.get<string>('bot-id');
    if (botId && this.viewers?.account(botId)) await this.viewers.disconnect(botId).catch(() => {});
    // Without a working Whisper account, reading chat would only cost resources: hold no connections until it is back.
    const accounts = this.botAccount() ? this.viewers?.listAccounts() || [] : [], ids = new Set(accounts.map(account => account.channelId));
    for (const [id, listener] of this.listeners) if (!ids.has(id)) { listener.close(); this.listeners.delete(id); this.refreshed.delete(id); }
    for (const id of ids) await this.refreshViewer(id);
    if (ids.size) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  // Followed live channels are re-read every three minutes; Twitch expects tokens to be validated hourly.
  private async refreshViewer(viewerId: string) {
    const now = Date.now();
    if (!this.viewers || !this.botAccount() || now - (this.refreshed.get(viewerId) || 0) < 170_000) return;
    this.refreshed.set(viewerId, now);
    try {
      if (now - (this.validated.get(viewerId) || 0) > 3_600_000) {
        const check = async (force = false) => fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${await this.viewers!.getAccessToken(viewerId, force)}` }, signal: AbortSignal.timeout(10000) });
        let response = await check();
        if (response.status === 401) response = await check(true);
        if (response.status === 401) throw new TwitchRejectedError(401, 'Viewer authorization was revoked.');
        if (response.ok) this.validated.set(viewerId, now);
      }
      const live: string[] = [];
      let after = '';
      for (let page = 0; page < 3 && live.length < maxWatchedChannels; page++) {
        const result = await this.helix(this.viewers, viewerId, `streams/followed?${new URLSearchParams({ user_id: viewerId, first: '100', ...(after ? { after } : {}) })}`);
        for (const stream of result.data || []) if (numericId(stream.user_id)) live.push(stream.user_id);
        after = typeof result.pagination?.cursor === 'string' ? result.pagination.cursor : '';
        if (!after) break;
      }
      await this.listener(viewerId).watch(live);
    } catch (error) {
      // A refused refresh or a 401 after refreshing means the viewer revoked StreamLore; anything else retries.
      if (error instanceof TwitchRejectedError && [400, 401].includes(error.status)) await this.viewers.disconnect(viewerId).catch(() => {});
    }
  }

  private async channelAnswer({ channelId, question }: ChatQuestion): Promise<ChannelAnswer> {
    try {
      const response = await this.env.CHANNELS.get(this.env.CHANNELS.idFromName(channelId)).fetch('https://streamlore.internal/internal/answer', { method: 'POST', headers: { 'X-StreamLore-Channel': channelId, 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      return response.ok ? await response.json() as ChannelAnswer : {};
    } catch { return {}; }
  }

  private count(update: (activity: Activity) => void) {
    update(this.activity);
    this.ctx.storage.kv.put('activity', this.activity);
  }

  private async answer(viewerId: string, question: ChatQuestion) {
    const bot = this.botAccount();
    if (!bot || !this.bot || bot.channelId === viewerId) return;
    this.count(activity => { activity.questions++; });
    const channel = await this.channelAnswer(question);
    // A channel running StreamLore with chat connected already whispers its askers from the broadcaster account.
    if (channel.chatConnected) return this.count(activity => { activity.answeredByChannel++; });
    const found = channel.entry ? { entry: channel.entry, community: channel.displayName || question.channelLogin } : communitySlang(question.channelId, question.question);
    if (!found) return this.count(activity => { activity.unknown++; });
    if (!this.reserve(viewerId)) return this.count(activity => { activity.limited++; });
    try {
      await this.helix(this.bot, bot.channelId, `whispers?${new URLSearchParams({ from_user_id: bot.channelId, to_user_id: viewerId })}`, { method: 'POST', body: JSON.stringify({ message: whisperText(found.entry, found.community) }) });
      this.count(activity => { activity.sent++; });
    } catch (error) {
      const status = error instanceof TwitchRejectedError ? error.status : 0;
      this.count(activity => { activity.failed++; activity.lastFailure = status; });
      console.error('StreamLore Whisper failed:', status || 'unavailable');
    }
  }
}
