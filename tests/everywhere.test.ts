import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { get } from 'node:http';
import express from 'express';
import { createViewerListener, type ChatQuestion } from '../server/everywhere.ts';
import { communities, communitySlang } from '../server/community-lore.ts';
import { createWhisperLimiter, loreQuestion } from '../server/whispers.ts';
import { createTwitchOAuthWithDatabase } from '../server/oauth-core.ts';
import type { SqlDatabase } from '../server/sql-database.ts';

class FakeSocket {
  closed = false;
  url: string;
  private listeners = new Map<string, ((event: any) => void)[]>();
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  close() { if (this.closed) return; this.closed = true; for (const listener of this.listeners.get('close') || []) listener({}); }
  receive(message: object) { for (const listener of this.listeners.get('message') || []) listener({ data: JSON.stringify(message) }); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const welcome = (id: string) => ({ metadata: { message_type: 'session_welcome' }, payload: { session: { id, keepalive_timeout_seconds: 10 } } });
const chat = (event: Record<string, unknown>) => ({ metadata: { message_type: 'notification', subscription_type: 'channel.chat.message' }, payload: { event } });

function fixture(t: import('node:test').TestContext) {
  const sockets: FakeSocket[] = [], calls: { path: string; method: string; body?: any }[] = [], questions: ChatQuestion[] = [];
  let revoked = 0;
  const listener = createViewerListener({
    viewerId: '500',
    openSocket: async url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    helix: async (path, init = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ path, method: init.method || 'GET', body });
      return init.method === 'POST' ? { data: [{ id: `sub-${body.condition.broadcaster_user_id}` }] } : {};
    },
    onQuestion: question => { questions.push(question); },
    onRevoked: () => { revoked++; },
  });
  t.after(() => listener.close());
  return { listener, sockets, calls, questions, revoked: () => revoked };
}

test('chat slang questions are recognized the way viewers actually type them', () => {
  for (const text of ['Whats a juicer', 'whats a juicer?', "what's a JUICER", '@xQc whats a juicer', 'wat is a juicer', 'what r juicers', 'wtf is a juicer', 'whos sally', 'who is Sally', 'What does Sally mean?', '!lore juicer']) assert.ok(loreQuestion(text), text);
  for (const text of ['whatsapp is down again', 'I wonder whats a juicer', 'juicer?', 'Juicers unite']) assert.equal(loreQuestion(text), null, text);
  assert.equal(loreQuestion('@xqc, @caedrel whats a juicer'), 'whats a juicer');
});

test('slang answers prefer the channel being watched, then name the community a phrase belongs to', () => {
  assert.equal(communitySlang('71092938', 'Whats a juicer')?.entry.term, 'Juicer');
  assert.equal(communitySlang('71092938', 'Whats a juicer')?.community, 'xQc');
  assert.equal(communitySlang('92038375', 'who is sally')?.community, 'Caedrel');
  // Asked elsewhere, the answer still says whose phrase it is.
  assert.equal(communitySlang('92038375', 'whats a juicer')?.community, 'xQc');
  assert.equal(communitySlang('12345', 'who is sally')?.entry.term, 'Sally');
  assert.equal(communitySlang('71092938', 'whats up chat'), undefined);
});

test('the top-streamer dataset answers each community’s phrase in its own chat, with no phrase claimed twice', () => {
  const asked: [string, string, string, string][] = [
    ['411377640', 'who is junko', 'Junko', 'Jynxzi'],
    ['641972806', 'whats the kai mafia', 'Mafia', 'Kai Cenat'],
    ['641972806', 'what is a mafiathon?', 'Mafiathon', 'Kai Cenat'],
    ['220476955', 'whats sewey', 'Sewey', 'IShowSpeed'],
    ['22484632', 'what does bajs mean', 'Bajs', 'forsen'],
    ['51496027', 'what does reformed mean', 'Reformed', 'Tyler1'],
    ['23936415', 'what are jermamites', 'Jermamites', 'Jerma985'],
  ];
  for (const [channelId, question, term, community] of asked) assert.deepEqual({ term: communitySlang(channelId, question)?.entry.term, community: communitySlang(channelId, question)?.community }, { term, community }, question);
  // In xQc's chat, Kai Cenat's phrase still answers, credited to Kai Cenat.
  assert.equal(communitySlang('71092938', 'whats a mafiathon')?.community, 'Kai Cenat');
  const phrases = communities.flatMap(community => community.entries.flatMap(entry => [entry.term, ...entry.aliases].map(phrase => phrase.toLowerCase())));
  assert.equal(new Set(phrases).size, phrases.length);
  assert.equal(new Set(communities.map(community => community.channelId)).size, communities.length);
});

test('a viewer listener reads live followed channels as that viewer and reports only their own questions, once', async t => {
  const f = fixture(t);
  await f.listener.watch(['71092938', '92038375']);
  await flush();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'wss://eventsub.wss.twitch.tv/ws');
  f.sockets[0].receive(welcome('session-1'));
  await f.listener.watch(['71092938', '92038375']);
  const subscribes = f.calls.filter(call => call.method === 'POST');
  assert.deepEqual(subscribes.map(call => call.body.condition), [{ broadcaster_user_id: '71092938', user_id: '500' }, { broadcaster_user_id: '92038375', user_id: '500' }]);
  for (const call of subscribes) { assert.equal(call.body.type, 'channel.chat.message'); assert.deepEqual(call.body.transport, { method: 'websocket', session_id: 'session-1' }); }
  assert.equal(f.listener.connected(), true);

  const socket = f.sockets[0];
  socket.receive(chat({ message_id: 'm1', broadcaster_user_id: '71092938', broadcaster_user_login: 'xqc', chatter_user_id: '777', message: { text: 'whats a juicer' } }));
  socket.receive(chat({ message_id: 'm2', broadcaster_user_id: '71092938', broadcaster_user_login: 'xqc', chatter_user_id: '500', message: { text: 'Whats a juicer' } }));
  socket.receive(chat({ message_id: 'm2', broadcaster_user_id: '71092938', broadcaster_user_login: 'xqc', chatter_user_id: '500', message: { text: 'Whats a juicer' } }));
  socket.receive(chat({ message_id: 'm3', broadcaster_user_id: '71092938', broadcaster_user_login: 'xqc', chatter_user_id: '500', message: { text: 'LUL juicer moment' } }));
  // Shared chat: one message typed in Caedrel's chat arrives through both subscriptions.
  for (const channel of [{ id: '71092938', login: 'xqc' }, { id: '92038375', login: 'caedrel' }]) socket.receive(chat({ message_id: `copy-${channel.id}`, source_message_id: 'm4', broadcaster_user_id: channel.id, broadcaster_user_login: channel.login, source_broadcaster_user_id: '92038375', source_broadcaster_user_login: 'caedrel', chatter_user_id: '500', message: { text: 'who is sally?' } }));
  await flush();
  assert.deepEqual(f.questions, [
    { channelId: '71092938', channelLogin: 'xqc', question: 'Whats a juicer' },
    { channelId: '92038375', channelLogin: 'caedrel', question: 'who is sally?' },
  ]);
});

test('listeners follow channels going live and offline, and hold no connection when nothing is live', async t => {
  const f = fixture(t);
  await f.listener.watch(['71092938']);
  await flush();
  f.sockets[0].receive(welcome('session-1'));
  await f.listener.watch(['71092938']);
  assert.deepEqual(f.listener.channels(), ['71092938']);
  await f.listener.watch(['92038375']);
  assert.deepEqual(f.calls.filter(call => call.method === 'DELETE').map(call => call.path), ['eventsub/subscriptions?id=sub-71092938']);
  assert.deepEqual(f.listener.channels(), ['92038375']);
  await f.listener.watch([]);
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.listener.connected(), false);
  await flush();
  assert.equal(f.sockets.length, 1);
  await f.listener.watch(['92038375']);
  await flush();
  assert.equal(f.sockets.length, 2);
});

test('Twitch reconnects keep subscriptions, foreign reconnect URLs are refused, and revocation stops the listener', async t => {
  const f = fixture(t);
  await f.listener.watch(['71092938']);
  await flush();
  f.sockets[0].receive(welcome('session-1'));
  await f.listener.watch(['71092938']);
  f.sockets[0].receive({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://evil.example/ws' } } });
  await flush();
  assert.equal(f.sockets.length, 1);
  f.sockets[0].receive({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?id=next' } } });
  await flush();
  assert.equal(f.sockets[1].url, 'wss://eventsub.wss.twitch.tv/ws?id=next');
  f.sockets[1].receive(welcome('session-2'));
  await f.listener.watch(['71092938']);
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(f.listener.channels(), ['71092938']);
  f.sockets[1].receive(chat({ message_id: 'm1', broadcaster_user_id: '71092938', chatter_user_id: '500', message: { text: 'whats a juicer' } }));
  await flush();
  assert.equal(f.questions.length, 1);
  f.sockets[1].receive({ metadata: { message_type: 'revocation' }, payload: { subscription: { status: 'authorization_revoked', condition: { broadcaster_user_id: '71092938' } } } });
  assert.equal(f.revoked(), 1);
  assert.equal(f.sockets[1].closed, true);
  await f.listener.watch(['71092938']);
  await flush();
  assert.equal(f.sockets.length, 2);
});

test('a silent connection is replaced after its keepalive window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.listener.watch(['71092938']);
  await flush();
  f.sockets[0].receive(welcome('session-1'));
  await f.listener.watch(['71092938']);
  t.mock.timers.tick(15_001);
  assert.equal(f.sockets[0].closed, true);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.sockets.length, 2);
});

test('the Whisper sender budget allows 40 different viewers a day and resets the next day', () => {
  let now = Date.parse('2026-11-02T12:00:00Z');
  const reserve = createWhisperLimiter({ now: () => now });
  for (let viewer = 1; viewer <= 40; viewer++) { assert.equal(reserve(String(viewer)), true); now += 1000; }
  assert.equal(reserve('41'), false);
  now += 15_000;
  assert.equal(reserve('1'), true);
  now = Date.parse('2026-11-03T00:00:01Z');
  assert.equal(reserve('41'), true);
});

test('viewer sign-up accepts whoever authorizes, asks only for read permissions, and respects capacity', async t => {
  const database = new DatabaseSync(':memory:'), revoked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    const token = String((init.headers as Record<string, string> | undefined)?.Authorization || '').split(' ')[1];
    if (url.endsWith('/token')) { const code = new URLSearchParams(String(init.body)).get('code'); return Response.json({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, expires_in: 3600 }); }
    if (url.endsWith('/revoke')) { revoked.push(new URLSearchParams(String(init.body)).get('token')!); return new Response(null, { status: 200 }); }
    const viewer = { 'access-a': '501', 'access-b': '502', 'access-c': '503' }[token]!;
    if (url.endsWith('/validate')) return Response.json({ client_id: 'test-client', user_id: viewer, scopes: ['user:read:chat', 'user:read:follows'] });
    return Response.json({ data: [{ id: viewer, login: `viewer${viewer}`, display_name: `Viewer ${viewer}` }] });
  });
  const oauth = createTwitchOAuthWithDatabase({ databasePath: ':memory:', clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'https://example.com/auth/twitch/callback', encryptionKey: randomBytes(32).toString('base64'), scopes: ['user:read:chat', 'user:read:follows'], anyAccount: true, table: 'viewer_accounts', maxAccounts: 2, makeState: (_id, nonce) => `viewer.${nonce}`, onConnect() {}, onDisconnect() {} }, database as unknown as SqlDatabase);
  const app = express(); app.use(oauth.router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); oauth.close(); });
  const callback = (state: string, code: string) => new Promise<number>(resolve => { get(`http://127.0.0.1:${address.port}/callback?${new URLSearchParams({ state, code })}`, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); }); });

  const first = new URL(oauth.begin()), second = new URL(oauth.begin()), third = new URL(oauth.begin());
  assert.equal(first.searchParams.get('scope'), 'user:read:chat user:read:follows');
  assert.ok(first.searchParams.get('state')!.startsWith('viewer.'));
  // Two people signing up at once do not cancel each other.
  assert.equal(await callback(first.searchParams.get('state')!, 'a'), 200);
  assert.equal(await callback(second.searchParams.get('state')!, 'b'), 200);
  assert.deepEqual(oauth.listAccounts().map(account => account.channelId), ['501', '502']);
  assert.equal(await callback(first.searchParams.get('state')!, 'a'), 400);
  assert.equal(await callback(third.searchParams.get('state')!, 'c'), 400);
  assert.deepEqual(revoked, ['access-c']);
  assert.equal(await oauth.getAccessToken('502'), 'access-b');
  assert.throws(() => createTwitchOAuthWithDatabase({ databasePath: ':memory:', clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'https://example.com/auth/twitch/callback', encryptionKey: randomBytes(32).toString('base64'), onConnect() {}, onDisconnect() {} }, new DatabaseSync(':memory:') as unknown as SqlDatabase).begin(), /valid Twitch channel/);
});
