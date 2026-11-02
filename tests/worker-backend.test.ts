import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { get } from 'node:http';
import express from 'express';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { durableDatabase, persistentMap } from '../cloudflare/database.ts';
import { createStoreFromDatabase } from '../server/store-core.ts';
import { createTwitchOAuthWithDatabase } from '../server/oauth-core.ts';
import { oauthRoutingState, oauthStateChannel, verifyEventSub } from '../server/eventsub.ts';
import { createLoreWhispers, type WhisperUsage } from '../server/whispers.ts';
import { starterLore } from '../server/community-lore.ts';

function storageFixture() {
  const database = new DatabaseSync(':memory:'), kv = new Map<string, unknown>();
  const storage = {
    kv: { get: (key: string) => structuredClone(kv.get(key)), put: (key: string, value: unknown) => { kv.set(key, structuredClone(value)); }, delete: (key: string) => kv.delete(key) },
    sql: { exec(sql: string, ...bindings: any[]) {
      let rows: any[] = [];
      if (sql.split(';').filter(part => part.trim()).length > 1) database.exec(sql);
      else { const query = database.prepare(sql), values = bindings.map(value => value instanceof ArrayBuffer ? Buffer.from(value) : value); if (query.columns().length) rows = query.all(...values); else query.run(...values); }
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync<T>(work: () => T): T { database.exec('BEGIN'); try { const value = work(); database.exec('COMMIT'); return value; } catch (error) { database.exec('ROLLBACK'); throw error; } },
  };
  return { storage: storage as unknown as DurableObjectStorage, database };
}

test('Durable Object database adapter preserves channel state and atomic votes across runtime recreation', () => {
  const f = storageFixture(), db = durableDatabase(f.storage);
  const first = createStoreFromDatabase(db, false), entry = { ...starterLore('71092938')[0], id: 'reviewed', status: 'nominated' as const, source: 'moderator' as const, votes: 4 };
  first.update(data => { data.lore.push(entry); });
  assert.equal(first.vote('reviewed', 'viewer-one').entry?.status, 'approved');
  const second = createStoreFromDatabase(db, false);
  assert.equal(second.read().lore[0].votes, 5); assert.equal(second.vote('reviewed', 'viewer-one').status, 409);
  f.database.exec("CREATE TRIGGER fail_vote BEFORE INSERT ON votes BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => second.vote('reviewed', 'viewer-two'), /test failure/);
  assert.equal(second.read().lore[0].votes, 5);
  assert.equal(createStoreFromDatabase(db, false).read().lore[0].votes, 5);
  f.database.close();
});

test('webhook signatures bind exact payload and message identity, rejecting forged, stale, and future events', () => {
  const secret = randomBytes(32).toString('hex'), now = Date.now(), timestamp = new Date(now).toISOString(), body = '{"event":{"message":{"text":"What is Sally?"}}}';
  const id = 'event-123';
  const headers = new Headers({ 'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Signature': 'sha256=' + createHmac('sha256', secret).update(id + timestamp + body).digest('hex') });
  assert.equal(verifyEventSub(headers, body, secret, now), true);
  assert.equal(verifyEventSub(headers, body + ' ', secret, now), false);
  assert.equal(verifyEventSub(headers, body, 'x'.repeat(64), now), false);
  assert.equal(verifyEventSub(headers, body, secret, now + 600001), false);
  assert.equal(verifyEventSub(headers, body, secret, now - 60001), false);
  headers.set('Twitch-Eventsub-Message-Id', 'forged'); assert.equal(verifyEventSub(headers, body, secret, now), false);
});

test('OAuth routing state cannot be redirected to another channel or manufactured without the backend secret', () => {
  const key = randomBytes(32).toString('base64'), state = oauthRoutingState('12345', randomBytes(32).toString('base64url'), key);
  assert.equal(oauthStateChannel(state, key), '12345');
  assert.equal(oauthStateChannel(state.replace('12345', '54321'), key), undefined);
  assert.equal(oauthStateChannel(state, 'another-secret'), undefined);
  assert.equal(oauthStateChannel('12345.fake', key), undefined);
});

test('persisted OAuth state survives a Worker restart, completes only once, and stores encrypted credentials', async t => {
  const f = storageFixture(), db = durableDatabase(f.storage), key = randomBytes(32).toString('base64');
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    providerCalls++;
    if (url.endsWith('/token')) return Response.json({ access_token: 'test-access-secret', refresh_token: 'test-refresh-secret', expires_in: 3600 });
    if (url.endsWith('/validate')) return Response.json({ client_id: 'test-client', user_id: '12345', scopes: ['user:read:chat', 'user:write:chat', 'user:manage:whispers', 'user:bot', 'channel:bot'] });
    return Response.json({ data: [{ id: '12345', login: 'testchannel', display_name: 'Test Channel' }] });
  });
  function create() { return createTwitchOAuthWithDatabase({ databasePath: ':durable:', clientId: 'test-client', clientSecret: 'test-client-secret', redirectUri: 'https://example.com/auth/twitch/callback', encryptionKey: key, extraScopes: ['user:bot', 'channel:bot'], states: persistentMap(f.storage, 'states'), generations: persistentMap(f.storage, 'generations'), makeState: (id, nonce) => oauthRoutingState(id, nonce, key), onConnect() {}, onDisconnect() {} }, db); }
  const before = create(), state = new URL(before.begin('12345')).searchParams.get('state')!;
  const after = create(), app = express(); app.use(after.router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); f.database.close(); });
  const callback = () => new Promise<number>(resolve => { get(`http://127.0.0.1:${address.port}/callback?${new URLSearchParams({ state, code: 'test-code' })}`, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); }); });
  assert.equal(await callback(), 200);
  assert.equal(await after.getAccessToken('12345'), 'test-access-secret');
  const row = f.database.prepare('SELECT credentials FROM twitch_oauth_accounts').get() as { credentials: Uint8Array };
  assert.ok(!Buffer.from(row.credentials).includes(Buffer.from('test-access-secret')));
  const calls = providerCalls; assert.equal(await callback(), 400); assert.equal(providerCalls, calls);
  assert.equal(create().account('12345')?.login, 'testchannel');
});

test('Whisper recipient cooldown persists across Worker restarts', async () => {
  let saved: WhisperUsage | undefined, sent = 0, now = Date.now();
  const options = { answer: () => starterLore('71092938')[0], send: async () => { sent++; }, now: () => now, saveUsage: (usage: WhisperUsage) => { saved = structuredClone(usage); } };
  assert.equal(await createLoreWhispers(options)('What is a juicer?', '123', '999'), true);
  now += 2000;
  assert.equal(await createLoreWhispers({ ...options, usage: saved })('What is a juicer?', '123', '999'), false);
  now += 15000;
  assert.equal(await createLoreWhispers({ ...options, usage: saved })('What is a juicer?', '123', '999'), true);
  assert.equal(sent, 2);
});
