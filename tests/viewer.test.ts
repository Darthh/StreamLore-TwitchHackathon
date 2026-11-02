import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { makeViewerSession, readViewerSession, requestViewer, handleViewerAuth, viewerCookie } from '../server/viewer-auth.ts';
import { personalViewerApi } from '../server/viewer-api.ts';
import { chatChannelLogin, loreQuestion } from '../shared/chat-questions.ts';
import { createLoreWhispers } from '../server/whispers.ts';
import { starterLore } from '../server/community-lore.ts';
// @ts-expect-error Packaging is a plain ESM utility, matching the native Extension builder.
import { buildViewerExtension } from '../scripts/build-viewer-extension.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { buildSync } from 'esbuild';
import express from 'express';
import { get } from 'node:http';
import { createTwitchOAuth } from '../server/oauth.ts';

test('personal viewer questions accept the requested spelling and only actual Twitch channel routes', () => {
  assert.equal(loreQuestion('whats a juicer?'), 'whats a juicer?');
  assert.equal(loreQuestion('What is Sally?'), 'What is Sally?');
  assert.equal(loreQuestion('!lore juicer'), 'juicer');
  assert.equal(loreQuestion('juicer juicer juicer'), null);
  assert.equal(chatChannelLogin('https://www.twitch.tv/xQc'), 'xqc');
  assert.equal(chatChannelLogin('https://www.twitch.tv/caedrel/chat'), 'caedrel');
  assert.equal(chatChannelLogin('https://www.twitch.tv/popout/caedrel/chat'), 'caedrel');
  for (const url of ['https://evil.test/xqc', 'https://www.twitch.tv/directory', 'https://www.twitch.tv/settings/security', 'https://www.twitch.tv/xqc/clip/fake']) assert.equal(chatChannelLogin(url), null);
});

test('viewer sessions bind a verified recipient, expire, and cannot be forged or reused as login state', () => {
  const key = randomBytes(32).toString('base64'), now = Date.now();
  const token = makeViewerSession({ userId: '12345', login: 'viewer', displayName: 'Viewer' }, key, now);
  assert.equal(readViewerSession(token, key, now)?.userId, '12345');
  assert.equal(readViewerSession(token, key, now + 86400001), null);
  assert.equal(readViewerSession(token, randomBytes(32).toString('base64'), now), null);
  assert.equal(readViewerSession(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), key, now), null);
  assert.equal(requestViewer(new Request('https://example.com/api/viewer/ask', { headers: { Cookie: `${viewerCookie}=${token}` } }), key), null);
});

test('personal ask delivers only to its signed-in viewer, with no broadcaster grant and no caller-selected recipient', async () => {
  const key = randomBytes(32).toString('base64'), token = makeViewerSession({ userId: '12345', login: 'viewer', displayName: 'Viewer' }, key);
  const calls: unknown[][] = [];
  const send = async (...args: [string, string, string]) => { calls.push(args); return { delivery: 'accepted' }; };
  const request = (body: object, authorization = `Bearer ${token}`) => new Request('https://example.com/api/viewer/ask', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await personalViewerApi(request({ channelLogin: 'XQC', question: 'whats a juicer?', recipientId: '99999' }), key, true, send);
  assert.equal(response.status, 200); assert.deepEqual(calls, [['12345', 'xqc', 'whats a juicer?']]);
  assert.equal((await personalViewerApi(request({ channelLogin: 'caedrel', question: 'What is Sally?' }, ''), key, true, send)).status, 401);
  assert.equal((await personalViewerApi(request({ channelLogin: '../xqc', question: 'What is Sally?' }), key, true, send)).status, 400);
  assert.equal((await personalViewerApi(request({ channelLogin: 'xqc', question: 'x'.repeat(5000) }), key, true, send)).status, 400);
  assert.equal((await personalViewerApi(request({ channelLogin: 'xqc', question: 'whats a juicer?' }), key, false, send)).status, 503);
  assert.equal(calls.length, 1);
});

test('viewer sign-in uses identity only, checks cookie state and provider identity, and returns no Twitch tokens', async t => {
  const env = { STREAMLORE_PUBLIC_URL: 'https://example.com', STREAMLORE_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), TWITCH_CLIENT_ID: 'test-client', TWITCH_CLIENT_SECRET: 'server-secret' };
  const start = await handleViewerAuth(new Request('https://example.com/auth/viewer/start'), env); assert.ok(start);
  const authorize = new URL(start.headers.get('Location')!); assert.equal(authorize.searchParams.get('scope'), 'openid');
  const state = authorize.searchParams.get('state')!, cookie = start.headers.get('Set-Cookie')!.split(';')[0];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    if (url.endsWith('/token')) return Response.json({ access_token: 'private-viewer-access-token', refresh_token: 'private-refresh-token' });
    if (url.endsWith('/validate')) return Response.json({ client_id: 'test-client', user_id: '12345', expires_in: 3600 });
    return Response.json({ data: [{ id: '12345', login: 'viewer', display_name: '<Viewer>' }] });
  });
  const callbackUrl = `https://example.com/auth/viewer/callback?${new URLSearchParams({ code: 'test-code', state })}`;
  const rejected = await handleViewerAuth(new Request(callbackUrl), env); assert.equal(rejected?.status, 400); assert.equal(calls, 0);
  const response = await handleViewerAuth(new Request(callbackUrl, { headers: { Cookie: cookie } }), env); assert.equal(response?.status, 200);
  const body = await response!.text(); assert.match(body, /&lt;Viewer&gt;/); assert.ok(!body.includes('private-viewer-access-token'));
  const cookies = response!.headers.getSetCookie();
  const session = cookies.find(c => c.startsWith(viewerCookie + '='))!.split(';')[0].slice(viewerCookie.length + 1);
  assert.equal(readViewerSession(session, env.STREAMLORE_TOKEN_ENCRYPTION_KEY)?.userId, '12345');
  assert.ok(!session.includes('private-refresh-token'));
});

test('cross-channel personal Whispers use the matched channel and share the account cooldown', async () => {
  const sent: { term: string; channel?: string }[] = [];
  const whisper = createLoreWhispers({ answer: () => undefined, send: async (_recipient, entry, channel) => { sent.push({ term: entry.term, channel }); } });
  assert.equal(await whisper('whats a juicer?', '12345', '98765', { entry: starterLore('71092938')[0], channelName: 'xQc' }), true);
  assert.equal(await whisper('What is Sally?', '12345', '98765', { entry: starterLore('92038375')[0], channelName: 'Caedrel' }), false);
  assert.deepEqual(sent, [{ term: 'Juicer', channel: 'xQc' }]);
});

test('viewer package has only its backend cookie permission and Twitch content access, with no server credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'streamlore-viewer-test-'));
  try {
    const result = buildViewerExtension({ apiUrl: 'https://example.com', outputDir: join(directory, 'unpacked'), archivePath: join(directory, 'viewer.zip') });
    const manifest = JSON.parse(readFileSync(join(result.outputDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.host_permissions, ['https://example.com/*']);
    assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.twitch.tv/*']);
    assert.ok(!manifest.permissions.includes('debugger'));
    const names = JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', result.archivePath], { encoding: 'utf8' }));
    assert.ok(names.includes('logo.png')); assert.ok(!names.some((name: string) => name.includes('.env') || name.includes('server/')));
    const content = readFileSync(join(result.outputDir, 'content.js'), 'utf8'); assert.ok(content.includes('isTrusted')); assert.ok(!content.includes('preventDefault('));
    const config = readFileSync(join(result.outputDir, 'config.js'), 'utf8'); assert.ok(!config.includes('TWITCH_CLIENT_SECRET'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the dedicated personal sender requests and accepts only the Whisper permission', async t => {
  const oauth = createTwitchOAuth({ databasePath: ':memory:', encryptionKey: randomBytes(32).toString('base64'), clientId: 'client', clientSecret: 'secret', redirectUri: 'https://example.com/auth/twitch/callback', scopes: ['user:manage:whispers'], onConnect() {}, onDisconnect() {} });
  const authorize = new URL(oauth.begin('98765'));
  assert.equal(authorize.searchParams.get('scope'), 'user:manage:whispers');
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/token')) return Response.json({ access_token: 'sender-access', refresh_token: 'sender-refresh', expires_in: 3600 });
    if (url.endsWith('/validate')) return Response.json({ user_id: '98765', client_id: 'client', scopes: ['user:manage:whispers'] });
    return Response.json({ data: [{ id: '98765', login: 'sender', display_name: 'Sender' }] });
  });
  const app = express(); app.use(oauth.router); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); oauth.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const status = await new Promise<number>(resolve => get(`http://127.0.0.1:${address.port}/callback?${new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'test-code' })}`, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); }));
  assert.equal(status, 200); assert.equal(oauth.account('98765')?.login, 'sender');
});

test('the content script handles only trusted submissions from the viewer editor and follows channel navigation', async () => {
  const handlers: Record<string, (event: any) => void> = {}, calls: any[] = []; let enabled = true;
  class Element {
    innerText = ''; value = ''; textContent = ''; isConnected = true; id = ''; type = ''; onclick?: () => void;
    kind: string;
    constructor(kind = '') { this.kind = kind; }
    closest(selector: string) { return (this.kind === 'editor' && selector.includes('chat-input')) || (this.kind === 'send' && selector.includes('chat-send-button')) ? this : null; }
    attachShadow() { return { append() {} }; } append() {} setAttribute() {} remove() { this.isConnected = false; }
  }
  const editor = new Element('editor'); editor.innerText = 'whats a juicer?';
  const location = { href: 'https://www.twitch.tv/xqc' };
  const script = buildSync({ entryPoints: ['viewer-extension/content.js'], bundle: true, write: false, format: 'iife', logLevel: 'silent' }).outputFiles[0].text;
  runInContext(script, createContext({ URL, Element, location, console, document: { addEventListener(type: string, handler: any) { handlers[type] = handler; }, createElement: () => new Element(), documentElement: { append() {} }, querySelector: () => editor }, chrome: { storage: { local: { get: async () => ({ enabled }) } }, runtime: { sendMessage: async (message: any) => { calls.push(message); return { ok: true, message: 'Check Whispers.' }; } } } }));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  handlers.keydown({ isTrusted: false, key: 'Enter', target: editor });
  handlers.keydown({ isTrusted: true, key: 'Enter', target: new Element('chat-message') });
  handlers.keydown({ isTrusted: true, key: 'Enter', shiftKey: true, target: editor }); await tick(); assert.equal(calls.length, 0);
  handlers.keydown({ isTrusted: true, key: 'Enter', target: editor }); await tick(); assert.equal(calls.length, 1); assert.equal(calls[0].question, 'whats a juicer?');
  handlers.click({ isTrusted: true, target: new Element('send') }); await tick(); assert.equal(calls.length, 1);
  location.href = 'https://www.twitch.tv/caedrel'; editor.innerText = 'What is Sally?';
  handlers.keydown({ isTrusted: true, key: 'Enter', target: editor }); await tick(); assert.equal(calls.length, 2);
  enabled = false; editor.innerText = 'Who is Sally?'; handlers.keydown({ isTrusted: true, key: 'Enter', target: editor }); await tick(); assert.equal(calls.length, 2);
});

test('the background worker derives the channel from its Twitch tab and keeps the viewer proof out of content messages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'streamlore-background-test-'));
  try {
    const result = buildViewerExtension({ apiUrl: 'https://example.com', outputDir: join(directory, 'unpacked'), archivePath: join(directory, 'viewer.zip') });
    const script = buildSync({ entryPoints: [join(result.outputDir, 'background.js')], bundle: true, write: false, format: 'iife', logLevel: 'silent' }).outputFiles[0].text;
    let handler: any; const fetches: { url: string; init: any }[] = [];
    runInContext(script, createContext({ URL, AbortSignal, console, chrome: { runtime: { getURL: (path: string) => `chrome-extension://own/${path}`, onMessage: { addListener(value: any) { handler = value; } } }, storage: { local: { get: async () => ({ enabled: true }) } }, cookies: { get: async (options: any) => { assert.deepEqual(options.url, 'https://example.com'); assert.equal(options.name, viewerCookie); return { value: 'private-viewer-proof' }; } } }, fetch: async (url: string, init: any) => { fetches.push({ url, init }); return Response.json({ delivery: 'accepted' }); } }));
    const ask = (sender: any) => new Promise<any>(resolve => { const waiting = handler({ type: 'ASK_LORE', channelLogin: 'caedrel', recipientId: '99999', question: 'whats a juicer?' }, sender, resolve); if (!waiting) resolve(null); });
    assert.equal(await ask({ tab: { url: 'https://evil.test/xqc' }, url: 'https://evil.test/xqc' }), null);
    const reply = await ask({ tab: { url: 'https://www.twitch.tv/xqc' }, url: 'https://www.twitch.tv/xqc' });
    assert.equal(reply.delivery, 'accepted'); assert.equal(fetches.length, 1);
    assert.deepEqual(JSON.parse(fetches[0].init.body), { channelLogin: 'xqc', question: 'whats a juicer?' });
    assert.equal(fetches[0].init.headers.Authorization, 'Bearer private-viewer-proof');
    assert.ok(!JSON.stringify(reply).includes('private-viewer-proof'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
