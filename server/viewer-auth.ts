import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const viewerCookie = '__Host-streamlore-viewer';
const stateCookie = '__Host-streamlore-viewer-login';
export type ViewerSession = { userId: string; login: string; displayName: string; expiresAt: number };
export type ViewerAuthEnv = { STREAMLORE_PUBLIC_URL: string; STREAMLORE_TOKEN_ENCRYPTION_KEY?: string; TWITCH_CLIENT_ID?: string; TWITCH_CLIENT_SECRET?: string; STREAMLORE_BOT_USER_ID?: string };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value);
const sign = (payload: string, purpose: string, key: string) => createHmac('sha256', Buffer.from(key, 'base64')).update(`streamlore:${purpose}:${payload}`).digest('base64url');
function signed(value: object, purpose: string, key: string) { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${sign(payload, purpose, key)}`; }
function verified(token: string, purpose: string, key: string, now: number): any {
  if (Buffer.from(key, 'base64').length !== 32 || token.length > 2048) return null;
  const match = token.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const expected = sign(match[1], purpose, key);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) return null;
  try { const data = JSON.parse(Buffer.from(match[1], 'base64url').toString()); return Number.isSafeInteger(data.expiresAt) && data.expiresAt > now ? data : null; } catch { return null; }
}
export function makeViewerSession(viewer: Omit<ViewerSession, 'expiresAt'>, key: string, now = Date.now()): string {
  if (Buffer.from(key, 'base64').length !== 32 || !validId(viewer.userId) || !/^[a-zA-Z0-9_]{1,25}$/.test(viewer.login) || viewer.displayName.length > 100) throw new Error('Invalid viewer identity.');
  return signed({ ...viewer, expiresAt: now + 86400000 }, 'viewer-session', key);
}
export function readViewerSession(token: string, key: string, now = Date.now()): ViewerSession | null {
  const data = verified(token, 'viewer-session', key, now);
  return data && validId(data.userId) && typeof data.login === 'string' && /^[a-zA-Z0-9_]{1,25}$/.test(data.login) && typeof data.displayName === 'string' && data.displayName.length <= 100 && data.expiresAt <= now + 86460000 ? data : null;
}
export function requestViewer(request: Request, key: string): ViewerSession | null {
  const match = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/);
  return match ? readViewerSession(match[1], key) : null;
}
function cookie(request: Request, name: string): string { return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) || ''; }
export function cookieViewer(request: Request, key: string) { return readViewerSession(cookie(request, viewerCookie), key); }
function setCookie(name: string, value: string, seconds: number) { return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`; }
function page(success: boolean, name = '') {
  const escaped = name.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamLore · Viewer connection</title><link rel="stylesheet" href="/viewer.css"><main><div class="brand"><span class="logo"><img src="/assets/streamlore-logo.png" alt=""></span>StreamLore</div><h1>${success ? `Connected as ${escaped}` : 'Connection could not finish'}</h1><p>${success ? 'Return to Twitch and open your StreamLore browser add-on. Enable Whispers, then ask a question in the chat you are watching.' : 'Start a new connection from the StreamLore browser add-on. The request may have expired or been declined.'}</p><p>Your viewer login does not give StreamLore access to your chat or private Whispers. The add-on sends your own submitted lore questions for a private bot reply.</p><a href="/viewer">Viewer setup</a></main></html>`;
}
async function provider(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Twitch sign-in failed.');
  return response.json();
}
export async function handleViewerAuth(request: Request, env: ViewerAuthEnv): Promise<Response | undefined> {
  const url = new URL(request.url), key = env.STREAMLORE_TOKEN_ENCRYPTION_KEY || '';
  if (!['/auth/viewer/start', '/auth/viewer/callback'].includes(url.pathname)) return undefined;
  if (request.method !== 'GET') return new Response('Method not allowed.', { status: 405 });
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || Buffer.from(key, 'base64').length !== 32) return new Response('The operator must configure Twitch login.', { status: 503 });
  const redirectUri = `${env.STREAMLORE_PUBLIC_URL}/auth/viewer/callback`;
  if (url.pathname.endsWith('/start')) {
    const state = signed({ nonce: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 300000, bot: url.searchParams.get('bot') === '1' }, 'viewer-login', key);
    const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
    authorize.search = new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'openid', state }).toString();
    return new Response(null, { status: 302, headers: { Location: authorize.href, 'Set-Cookie': setCookie(stateCookie, state, 300), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
  headers.append('Set-Cookie', setCookie(stateCookie, '', 0));
  const state = url.searchParams.get('state') || '';
  const pending = verified(state, 'viewer-login', key, Date.now());
  if (!state || state !== cookie(request, stateCookie) || !pending || url.searchParams.has('error') || !url.searchParams.get('code') || url.searchParams.get('code')!.length > 4096) return new Response(page(false), { status: 400, headers });
  try {
    const tokens = await provider('https://id.twitch.tv/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: 'authorization_code', code: url.searchParams.get('code')!, redirect_uri: redirectUri }) });
    if (typeof tokens.access_token !== 'string' || tokens.access_token.length > 8192) throw new Error('Missing token.');
    const identity = await provider('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${tokens.access_token}` } });
    if (identity.client_id !== env.TWITCH_CLIENT_ID || !validId(identity.user_id) || !(identity.expires_in > 0)) throw new Error('Wrong Twitch identity.');
    const users = await provider('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${tokens.access_token}`, 'Client-Id': env.TWITCH_CLIENT_ID } });
    const user = users.data?.[0];
    if (!user || user.id !== identity.user_id || typeof user.login !== 'string' || typeof user.display_name !== 'string') throw new Error('Profile mismatch.');
    if (pending.bot && user.id !== env.STREAMLORE_BOT_USER_ID) throw new Error('Sign in as the dedicated StreamLore bot account.');
    const session = makeViewerSession({ userId: user.id, login: user.login, displayName: user.display_name }, key);
    headers.append('Set-Cookie', setCookie(viewerCookie, session, 86400));
    if (pending.bot) { headers.set('Location', `${env.STREAMLORE_PUBLIC_URL}/auth/bot/start`); return new Response(null, { status: 302, headers }); }
    // Viewer Twitch tokens are used only to prove identity, never persisted or sent to the add-on.
    return new Response(page(true, user.display_name), { headers });
  } catch { return new Response(page(false), { status: 502, headers }); }
}
