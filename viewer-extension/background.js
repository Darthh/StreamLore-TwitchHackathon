import { apiOrigin, viewerCookie } from './config.js';
import { chatChannelLogin, loreQuestion } from './chat-questions.js';

async function api(path, body) {
  const cookie = await chrome.cookies.get({ url: apiOrigin, name: viewerCookie });
  if (!cookie) throw new Error('Connect your Twitch account in the StreamLore add-on first.');
  const response = await fetch(`${apiOrigin}/api/viewer${path}`, {
    method: body ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${cookie.value}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'StreamLore could not complete this request.');
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  const currentChannel = sender.tab?.url ? chatChannelLogin(sender.tab.url) : null;
  if (!popup && !currentChannel) return false;
  (async () => {
    if (message?.type === 'STATUS' && popup) return { ...(await api('/session')), enabled: (await chrome.storage.local.get('enabled')).enabled !== false };
    if (message?.type === 'ASK_LORE') {
      if ((await chrome.storage.local.get('enabled')).enabled === false) return { delivery: 'disabled', message: 'StreamLore is switched off.' };
      const channelLogin = popup ? message.channelLogin : currentChannel;
      if (typeof channelLogin !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(channelLogin) || typeof message.question !== 'string' || !loreQuestion(message.question)) throw new Error('Ask a short question such as “whats a juicer?” or use !lore juicer.');
      // The recipient is the authenticated viewer on the server, never a message field.
      return api('/ask', { channelLogin: channelLogin.toLowerCase(), question: message.question });
    }
    throw new Error('Unknown StreamLore action.');
  })().then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error instanceof Error ? error.message : 'StreamLore is unavailable.' }));
  return true;
});
