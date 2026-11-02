import { loreQuestion } from './whispers.ts';

// The standard WebSocket surface shared by Workers, Node, and test fakes.
export type EventSubSocket = {
  addEventListener(type: string, listener: (event: any) => void): void;
  close(code?: number, reason?: string): void;
};
export type ChatQuestion = { channelId: string; channelLogin: string; question: string };

const eventSubUrl = 'wss://eventsub.wss.twitch.tv/ws';
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value);
export const maxWatchedChannels = 100;

// Reads chat as one opted-in viewer in the channels it is told to watch, and reports only that viewer's own questions.
// Twitch lets a user token read any channel's chat over an EventSub WebSocket; webhooks would need each broadcaster's consent.
export function createViewerListener({ viewerId, helix, openSocket, onQuestion, onRevoked }: {
  viewerId: string;
  helix: (path: string, init?: RequestInit) => Promise<any>;
  openSocket: (url: string) => Promise<EventSubSocket>;
  onQuestion: (question: ChatQuestion) => void | Promise<void>;
  onRevoked: () => void;
}) {
  let socket: EventSubSocket | undefined, sessionId = '', stopped = false, opening = false, attempts = 0;
  let retry: ReturnType<typeof setTimeout> | undefined, syncing: Promise<void> = Promise.resolve();
  const wanted = new Set<string>(), subscriptions = new Map<string, string>(), seen = new Set<string>();
  const timer = (run: () => void, ms: number) => { const handle = setTimeout(run, ms); (handle as { unref?: () => void }).unref?.(); return handle; };

  // Serialized so overlapping refreshes never subscribe a channel twice.
  function sync(): Promise<void> {
    syncing = syncing.then(async () => {
      for (const [channelId, id] of subscriptions) if (!wanted.has(channelId)) {
        subscriptions.delete(channelId);
        await helix(`eventsub/subscriptions?${new URLSearchParams({ id })}`, { method: 'DELETE' }).catch(() => {});
      }
      for (const channelId of wanted) {
        if (stopped || !sessionId) return;
        if (subscriptions.has(channelId)) continue;
        try {
          const data = await helix('eventsub/subscriptions', { method: 'POST', body: JSON.stringify({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: channelId, user_id: viewerId }, transport: { method: 'websocket', session_id: sessionId } }) });
          if (typeof data?.data?.[0]?.id === 'string') subscriptions.set(channelId, data.data[0].id);
        } catch { /* One unreadable channel (a ban, for example) must not block the rest; the next refresh retries. */ }
      }
    });
    return syncing;
  }

  function handle(event: any) {
    if (!event || event.chatter_user_id !== viewerId || typeof event.message?.text !== 'string') return;
    // Shared chat delivers one message to every participating channel; answer it once, for the channel it was typed in.
    const key = String(event.source_message_id || event.message_id || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    const question = loreQuestion(event.message.text.slice(0, 500));
    const channelId = event.source_broadcaster_user_id || event.broadcaster_user_id;
    if (!question || !numericId(channelId)) return;
    void Promise.resolve().then(() => onQuestion({ channelId, channelLogin: String(event.source_broadcaster_user_login || event.broadcaster_user_login || ''), question })).catch(() => {});
  }

  function reconnectLater() {
    if (stopped || retry || !wanted.size) return;
    retry = timer(() => { retry = undefined; if (!socket && !opening && wanted.size) connect(); }, Math.min(60_000, 1000 * 2 ** Math.min(attempts++, 6)));
  }

  function connect(url = eventSubUrl, previous?: EventSubSocket) {
    if (stopped) return;
    if (!previous) opening = true;
    void openSocket(url).then(current => {
      if (!previous) opening = false;
      if (stopped || (!previous && (socket || !wanted.size)) || (previous && previous !== socket)) { current.close(1000); return; }
      if (!previous) socket = current;
      let watchdog: ReturnType<typeof setTimeout> | undefined, keepalive = 10, done = false;
      const ended = () => {
        if (done) return;
        done = true; clearTimeout(watchdog);
        // A socket replaced by a reconnect, or dropped on purpose, closes without consequence.
        if (current !== socket || stopped) return;
        socket = undefined; sessionId = ''; subscriptions.clear();
        reconnectLater();
      };
      const arm = () => { clearTimeout(watchdog); watchdog = timer(() => { try { current.close(1000); } catch { /* Already closed. */ } ended(); }, (keepalive + 5) * 1000); };
      arm();
      current.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        arm();
        const type = message.metadata?.message_type;
        if (type === 'session_welcome') {
          keepalive = Number(message.payload?.session?.keepalive_timeout_seconds) || 10; arm();
          sessionId = String(message.payload?.session?.id || ''); attempts = 0;
          // Twitch moves existing subscriptions to a reconnect session; a fresh session starts with none.
          if (previous) { socket = current; try { previous.close(1000); } catch { /* Already closed. */ } }
          else { subscriptions.clear(); void sync(); }
        } else if (type === 'session_reconnect') {
          const next = message.payload?.session?.reconnect_url;
          if (typeof next === 'string' && next.startsWith('wss://') && new URL(next).hostname === 'eventsub.wss.twitch.tv') connect(next, current);
        } else if (type === 'revocation') {
          const status = message.payload?.subscription?.status, channelId = message.payload?.subscription?.condition?.broadcaster_user_id;
          if (status === 'authorization_revoked' || status === 'user_removed') { close(); onRevoked(); }
          else if (typeof channelId === 'string') subscriptions.delete(channelId);
        } else if (type === 'notification' && message.metadata?.subscription_type === 'channel.chat.message') handle(message.payload?.event);
      });
      current.addEventListener('close', ended);
    }).catch(() => { if (!previous) { opening = false; reconnectLater(); } });
  }

  function drop() {
    const current = socket;
    socket = undefined; sessionId = ''; subscriptions.clear();
    clearTimeout(retry); retry = undefined;
    try { current?.close(1000); } catch { /* Already closed. */ }
  }

  function watch(channelIds: string[]): Promise<void> {
    if (stopped) return Promise.resolve();
    wanted.clear();
    for (const id of channelIds) if (numericId(id) && wanted.size < maxWatchedChannels) wanted.add(id);
    // With no live followed channel there is nothing to read, so no connection is held open.
    if (!wanted.size) { drop(); return syncing; }
    if (!socket && !opening && !retry) connect();
    return sync();
  }

  function close() { stopped = true; drop(); }
  return { watch, close, connected: () => Boolean(sessionId), channels: () => [...subscriptions.keys()] };
}
