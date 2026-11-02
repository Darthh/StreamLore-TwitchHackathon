import type { Lore } from '../shared/types.ts';
import { loreQuestion } from '../shared/chat-questions.ts';
export { loreQuestion } from '../shared/chat-questions.ts';

export function whisperText(entry: Lore, channelName: string): string {
  const sourceLink = entry.clipUrl || entry.references?.[0]?.url || '';
  const link = sourceLink.length <= 200 ? sourceLink : '';
  const source = entry.source === 'starter' ? 'Starter reference' : 'Channel lore';
  const prefix = `StreamLore · ${channelName} · ${source}\n${entry.term}: `;
  const suffix = link ? ` ${link}` : '';
  const explanation = entry.explanation.replace(/\s+/g, ' ').trim();
  const available = Math.max(0, 500 - prefix.length - suffix.length);
  return `${prefix}${explanation.length > available ? `${explanation.slice(0, Math.max(0, available - 1))}…` : explanation}${suffix}`.slice(0, 500);
}

export type WhisperUsage = { day: string; lastSend: number; recipients: [string, number][] };
type UsageOptions = { now?: () => number; usage?: WhisperUsage; saveUsage?: (usage: WhisperUsage) => void };

// One sender's budget: one Whisper per second, one per recipient every 15 seconds, 40 recipients a day.
export function createWhisperLimiter({ now = Date.now, usage, saveUsage }: UsageOptions = {}) {
  let day = usage?.day || '', lastSend = usage?.lastSend ?? -Infinity;
  const recipients = new Map<string, number>(usage?.recipients || []);
  return (recipientId: string): boolean => {
    const time = now(), currentDay = new Date(time).toISOString().slice(0, 10);
    if (day !== currentDay) { day = currentDay; recipients.clear(); }
    // Twitch also enforces its own limits; reserve before awaiting concurrent sends.
    if (time - lastSend < 1000 || time - (recipients.get(recipientId) ?? -Infinity) < 15_000 || (!recipients.has(recipientId) && recipients.size >= 40)) return false;
    lastSend = time; recipients.set(recipientId, time);
    saveUsage?.({ day, lastSend, recipients: [...recipients] });
    return true;
  };
}

export function createLoreWhispers({ answer, send, ...usage }: UsageOptions & {
  answer: (question: string) => Lore | undefined;
  send: (recipientId: string, entry: Lore, channelName?: string) => Promise<void>;
}) {
  const reserve = createWhisperLimiter(usage);
  return async (message: string, recipientId: string, senderId: string, context?: { entry: Lore; channelName: string }): Promise<boolean> => {
    const question = loreQuestion(message);
    if (!question || !/^[1-9]\d{0,24}$/.test(recipientId) || recipientId === senderId) return false;
    const entry = context?.entry ?? answer(question);
    if (!entry || !reserve(recipientId)) return false;
    await send(recipientId, entry, context?.channelName);
    return true;
  };
}
