import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { createStore } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { communities, starterLore } from '../server/community-lore.ts';
import { answerLoreQuestion } from '../shared/lore.ts';
import { createLoreWhispers, loreQuestion, whisperText } from '../server/whispers.ts';
import { startTwitch } from '../server/twitch.ts';

test('channel datasets answer the requested examples, plurals, and punctuation without cross-channel guesses', () => {
  assert.equal(answerLoreQuestion(starterLore('71092938'), 'What is a juicer?')?.term, 'Juicer');
  assert.equal(answerLoreQuestion(starterLore('71092938'), 'What are JUICERS?!')?.term, 'Juicer');
  assert.equal(answerLoreQuestion(starterLore('92038375'), 'What is Sally?')?.term, 'Sally');
  assert.equal(answerLoreQuestion(starterLore('92038375'), 'What is a juicer?'), undefined);
  assert.equal(answerLoreQuestion(starterLore('71092938'), 'Who is Sally?'), undefined);
  assert.deepEqual(starterLore('12345'), []);
  for (const community of communities) for (const entry of starterLore(community.channelId)) {
    assert.equal(entry.source, 'starter');
    assert.ok(entry.references?.length);
    for (const reference of entry.references!) assert.equal(new URL(reference.url).protocol, 'https:');
    assert.equal(entry.clipUrl, '');
    assert.equal(entry.reviewedBy, undefined);
  }
});

test('private questions never enter channel state or chat history; moderator definitions override and starter settings persist', async t => {
  const store = createStore(':memory:', false);
  const runtime = createApp({ store, mode: 'live', communityChannelId: '92038375', authorizeModerator: () => true });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { runtime.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const before = JSON.stringify(store.read());
  const response = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'What is Sally?', channelId: '71092938' }) });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.private, true); assert.equal(result.answer.term, 'Sally');
  assert.equal(JSON.stringify(store.read()), before);
  assert.equal((await (await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'x'.repeat(301) }) })).json()).answer, undefined);
  store.update(data => data.lore.push({ ...starterLore('92038375')[0], id: 'channel-sally', explanation: 'Our moderator’s current definition.', source: 'moderator', references: [] }));
  assert.equal(runtime.loreAnswer('What is Sally?')?.id, 'channel-sally');
  const off = await fetch(`${base}/api/mod/starter-lore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200); assert.deepEqual(runtime.state().starterLore, []); assert.equal(store.read().starterLoreEnabled, false);
  assert.equal(runtime.loreAnswer('What is Sally?')?.id, 'channel-sally');
});

test('only direct questions and !lore requests trigger private answers; unknown phrases and self-messages do not', async () => {
  for (const text of ['What is Sally?', 'Who’s Sally?', 'What does Sally mean?', '!lore Sally']) assert.ok(loreQuestion(text));
  for (const text of ['Sally Sally Sally', 'I wonder what is Sally', '!lorevote Sally', 'x'.repeat(301)]) assert.equal(loreQuestion(text), null);
  const sent: string[] = [];
  const respond = createLoreWhispers({ answer: question => answerLoreQuestion(starterLore('92038375'), question), send: async recipient => { sent.push(recipient); } });
  assert.equal(await respond('What is Sally?', '99', '99'), false);
  assert.equal(await respond('What is a juicer?', '123', '99'), false);
  assert.equal(await respond('What is Sally?', 'not-an-id', '99'), false);
  assert.equal(await respond('What is Sally?', '123', '99'), true);
  assert.equal(await respond('What is Sally?', '123', '99'), false);
  assert.deepEqual(sent, ['123']);
  const text = whisperText({ ...starterLore('92038375')[0], explanation: 'long explanation '.repeat(100) }, 'Caedrel');
  assert.ok(text.length <= 500); assert.ok(text.includes('Starter reference')); assert.ok(text.endsWith('&t=40s'));
});

test('Whisper limiter reserves concurrent sends and limits daily unique recipients without disabling panel answers', async () => {
  let time = Date.UTC(2026, 10, 2), sent = 0;
  const respond = createLoreWhispers({ now: () => time, answer: () => starterLore('71092938')[0], send: async () => { sent++; } });
  const concurrent = await Promise.all([respond('What is a juicer?', '1', '99'), respond('What is a juicer?', '2', '99')]);
  assert.deepEqual(concurrent, [true, false]);
  for (let id = 2; id <= 40; id++) { time += 1000; assert.equal(await respond('What is a juicer?', String(id), '99'), true); }
  time += 1000; assert.equal(await respond('What is a juicer?', '41', '99'), false); assert.equal(sent, 40);
  time += 86_400_000; assert.equal(await respond('What is a juicer?', '41', '99'), true);
});

test('EventSub questions send a real-format Helix Whisper request, never a public answer, and a blocked Whisper keeps chat alive', async t => {
  class Socket extends EventEmitter { readyState = 1; terminate() {} close() {} }
  const socket = new Socket();
  const requests: { url: string; body: any }[] = [];
  const statuses: string[] = [];
  let time = Date.now(); t.mock.method(Date, 'now', () => time);
  let blocked = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/validate')) return Response.json({ user_id: '92038375', client_id: 'test-client', scopes: ['user:read:chat', 'user:write:chat', 'user:manage:whispers'] });
    if (url.includes('/users?')) return Response.json({ data: [{ id: '92038375', display_name: 'Caedrel' }] });
    if (url.includes('/whispers?')) return new Response(null, { status: blocked ? 400 : 204 });
    return Response.json({ data: [] });
  });
  const client = startTwitch({ config: { clientId: 'test-client', channelLogin: 'caedrel', getAccessToken: async () => 'test-token' }, socketFactory: () => socket as unknown as WebSocket, onChat() {}, onStatus(status) { statuses.push(status.message); }, getCatchup: () => '', getLore: () => '', getLoreEntry: question => answerLoreQuestion(starterLore('92038375'), question) });
  t.after(() => client.close());
  const flush = () => new Promise(resolve => setImmediate(resolve)); await flush();
  socket.emit('message', Buffer.from(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'session' } } }))); await flush();
  const event = (id: string, user = '123', question = 'What is Sally?') => ({ metadata: { message_type: 'notification', subscription_type: 'channel.chat.message', message_id: id }, payload: { event: { broadcaster_user_id: '92038375', chatter_user_id: user, message_id: id, message: { text: question } } } });
  const shared = event('shared'); Object.assign(shared.payload.event, { source_broadcaster_user_id: '71092938' });
  socket.emit('message', Buffer.from(JSON.stringify(shared)));
  socket.emit('message', Buffer.from(JSON.stringify(event('self', '92038375'))));
  socket.emit('message', Buffer.from(JSON.stringify(event('unknown', '123', 'What is a juicer?')))); await flush();
  assert.equal(requests.filter(call => call.url.includes('/whispers?')).length, 0);
  socket.emit('message', Buffer.from(JSON.stringify(event('first')))); await flush();
  const whispers = requests.filter(call => call.url.includes('/whispers?'));
  assert.equal(whispers.length, 1); assert.equal(new URL(whispers[0].url).searchParams.get('to_user_id'), '123'); assert.equal(new URL(whispers[0].url).searchParams.get('from_user_id'), '92038375');
  assert.ok(whispers[0].body.message.includes('Sally')); assert.equal(requests.filter(call => call.url.includes('/chat/messages')).length, 0);
  socket.emit('message', Buffer.from(JSON.stringify(event('first')))); await flush(); assert.equal(requests.filter(call => call.url.includes('/whispers?')).length, 1);
  // Exercise a provider rejection after the per-account send interval.
  time += 2000; blocked = true;
  socket.emit('message', Buffer.from(JSON.stringify(event('blocked', '456')))); await flush();
  assert.ok(statuses.some(message => message.includes('could not accept a private lore Whisper')));
  assert.equal(requests.filter(call => call.url.includes('/chat/messages')).length, 0);
});

test('an existing chat-only grant never substitutes a public reply for a private question', async t => {
  class Socket extends EventEmitter { readyState = 1; terminate() {} close() {} }
  const socket = new Socket(), sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/validate')) return Response.json({ user_id: '92038375', client_id: 'test-client', scopes: ['user:read:chat', 'user:write:chat'] });
    if (url.includes('/users?')) return Response.json({ data: [{ id: '92038375', display_name: 'Caedrel' }] });
    sent.push(url); return Response.json({ data: [] });
  });
  const client = startTwitch({ config: { clientId: 'test-client', channelLogin: 'caedrel', getAccessToken: async () => 'test-token' }, socketFactory: () => socket as unknown as WebSocket, onChat() {}, onStatus() {}, getCatchup: () => '', getLore: () => 'Never publish me', getLoreEntry: () => starterLore('92038375')[0] });
  t.after(() => client.close());
  await new Promise(resolve => setImmediate(resolve));
  socket.emit('message', Buffer.from(JSON.stringify({ metadata: { message_type: 'notification', subscription_type: 'channel.chat.message', message_id: 'private' }, payload: { event: { broadcaster_user_id: '92038375', chatter_user_id: '123', message_id: 'private', message: { text: '!lore Sally' } } } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!sent.some(url => url.includes('/whispers?') || url.includes('/chat/messages')));
});
