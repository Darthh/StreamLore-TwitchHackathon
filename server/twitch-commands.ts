export function parseCommand(text: string): { name: 'catchup' | 'lore' | 'lorevote'; query: string } | null {
  const match = text.trim().match(/^!(catchup|lore|lorevote)(?:\s+(.{0,200}))?$/i);
  return match ? { name: match[1].toLowerCase() as 'catchup' | 'lore' | 'lorevote', query: (match[2] || '').trim() } : null;
}

export function chatReply(command: { name: 'catchup' | 'lore'; query: string }, options: { getCatchup: () => string; getLore: (query: string) => string }, publicUrl: string): string {
  const text = command.name === 'catchup' ? options.getCatchup() : options.getLore(command.query);
  const cleaned = text.replace(/[\r\n]+/g, ' ');
  const sourceLink = cleaned.match(/https?:\/\/\S+$/)?.[0];
  const link = sourceLink || (/^https?:\/\//.test(publicUrl) ? publicUrl.replace(/\/$/, '') : '');
  const suffix = link ? ` · ${link}` : '';
  const body = sourceLink ? cleaned.slice(0, -sourceLink.length).trim() : cleaned;
  return `${body.slice(0, Math.max(0, 490 - suffix.length))}${suffix}`.slice(0, 500);
}

