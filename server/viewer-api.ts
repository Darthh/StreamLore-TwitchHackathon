import { requestViewer } from './viewer-auth.ts';
import { loreQuestion } from '../shared/chat-questions.ts';

function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
function cors(response: Response) {
  const result = new Response(response.body, response);
  result.headers.set('Access-Control-Allow-Origin', '*');
  result.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  result.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return result;
}
async function smallJson(request: Request): Promise<any> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body.');
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 4096) { await reader.cancel(); throw new Error('Body too large.'); } chunks.push(next.value); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function personalViewerApi(request: Request, key: string, botConfigured: boolean, send: (recipient: string, channel: string, question: string) => Promise<unknown>): Promise<Response> {
  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
  const viewer = requestViewer(request, key);
  if (!viewer) return cors(json({ error: 'Connect your own Twitch account in the StreamLore browser add-on.' }, 401));
  const path = new URL(request.url).pathname;
  if (path === '/api/viewer/session' && request.method === 'GET') return cors(json({ viewer: { login: viewer.login, displayName: viewer.displayName }, botConfigured }));
  if (path !== '/api/viewer/ask' || request.method !== 'POST') return cors(json({ error: 'Method not allowed.' }, 405));
  let body;
  try { body = await smallJson(request); } catch { return cors(json({ error: 'Send a JSON question within 4096 bytes.' }, 400)); }
  if (!body || typeof body.channelLogin !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(body.channelLogin) || typeof body.question !== 'string' || !loreQuestion(body.question)) return cors(json({ error: 'Send a short lore question and the current channel login.' }, 400));
  if (!botConfigured) return cors(json({ error: 'The StreamLore Whisper sender is not configured yet.' }, 503));
  try { return cors(json(await send(viewer.userId, body.channelLogin.toLowerCase(), body.question))); }
  catch { return cors(json({ error: 'StreamLore could not send this Whisper. Check your connection and try again.' }, 502)); }
}
