import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyEventSub(headers: Headers, body: string, secret: string, now = Date.now()): boolean {
  const id = headers.get('Twitch-Eventsub-Message-Id') || '';
  const timestamp = headers.get('Twitch-Eventsub-Message-Timestamp') || '';
  const signature = headers.get('Twitch-Eventsub-Message-Signature') || '';
  const time = Date.parse(timestamp);
  if (secret.length < 32 || !id || id.length > 256 || body.length > 80_000 || !Number.isFinite(time) || now - time > 600_000 || time - now > 60_000 || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(id + timestamp + body).digest('hex')}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function oauthRoutingState(channelId: string, nonce: string, secret: string): string {
  const value = `${channelId}.${nonce}`;
  return `${value}.${createHmac('sha256', secret).update(value).digest('hex')}`;
}

export function oauthStateChannel(state: string, secret: string): string | undefined {
  const parts = state.split('.');
  if (parts.length !== 3 || !/^[1-9]\d{0,24}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{40,64}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2]) || !secret) return;
  const expected = oauthRoutingState(parts[0], parts[1], secret);
  if (timingSafeEqual(Buffer.from(state), Buffer.from(expected))) return parts[0];
}
