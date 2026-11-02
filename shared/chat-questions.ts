const asking = /^(?:(?:what|wat|wut)(?:['’]?s|\s+(?:is|are|r|does|do))|wtf\s+(?:is|are)|who(?:['’]?s|\s+(?:is|are))|why\s+(?:is|does|do|are))\s+.+/i;

export function loreQuestion(message: string): string | null {
  const command = message.trim().match(/^!lore\s+(.{1,200})$/i);
  if (command) return command[1].trim();
  // Chat questions often open with @mentions and skip the apostrophe: "@xqc whats a juicer".
  const question = message.trim().replace(/^(?:@\w{1,25}[\s,:]+)+/, '');
  return question.length <= 300 && asking.test(question) ? question : null;
}

export function chatChannelLogin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.twitch.tv') return null;
    const match = url.pathname.match(/^\/(?:popout\/)?([a-zA-Z0-9_]{1,25})(?:\/(?:chat|about))?\/?$/);
    if (!match || ['directory', 'downloads', 'settings', 'subscriptions', 'wallet', 'inventory', 'search', 'videos', 'jobs'].includes(match[1].toLowerCase())) return null;
    return match[1].toLowerCase();
  } catch { return null; }
}
