import { chatChannelLogin, loreQuestion } from '../shared/chat-questions.ts';

const inputSelector = '[data-a-target="chat-input"], [data-test-selector="chat-input"]';
let lastRequest = { channel: '', question: '', at: 0 };
let notice;
function show(message) {
  if (!notice?.isConnected) {
    notice = document.createElement('div');
    notice.id = 'streamlore-personal-notice';
    const shadow = notice.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{position:fixed;right:20px;bottom:75px;z-index:2147483647;max-width:310px;font:13px/1.5 Arial,sans-serif;color:#efeff1}section{background:#18181b;border:1px solid #9147ff;border-radius:6px;box-shadow:0 8px 30px #0008;padding:14px}strong{color:#bf94ff}p{margin:7px 0 0}button{float:right;border:0;background:transparent;color:#adadb8;font-size:18px;cursor:pointer}';
    const box = document.createElement('section');
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss StreamLore status'); close.onclick = () => notice.remove();
    const title = document.createElement('strong'); title.textContent = 'StreamLore · private Whispers';
    const text = document.createElement('p'); text.setAttribute('role', 'status');
    box.append(close, title, text); shadow.append(style, box); document.documentElement.append(notice);
    notice.update = value => { text.textContent = value; };
  }
  notice.update(message);
}
async function submitted(editor) {
  const channel = chatChannelLogin(location.href);
  const question = (editor?.innerText || editor?.value || editor?.textContent || '').trim();
  if (!channel || !loreQuestion(question)) return;
  const now = Date.now();
  if (lastRequest.channel === channel && lastRequest.question === question && now - lastRequest.at < 10000) return;
  lastRequest = { channel, question, at: now };
  try {
    const settings = await chrome.storage.local.get('enabled');
    if (settings.enabled === false) return;
    show(`Looking up ${channel}’s lore for your Whisper…`);
    const result = await chrome.runtime.sendMessage({ type: 'ASK_LORE', question });
    if (!result?.ok) throw new Error(result?.error || 'StreamLore could not reach its background service.');
    show(result.message || 'Check your Twitch Whispers.');
  } catch (error) { show(error instanceof Error ? error.message : 'Reopen the StreamLore add-on and try again.'); }
}
document.addEventListener('keydown', event => {
  if (!event.isTrusted || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  const editor = event.target instanceof Element ? event.target.closest(inputSelector) : null;
  if (editor) void submitted(editor);
}, true);
document.addEventListener('click', event => {
  if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest('[data-a-target="chat-send-button"]')) return;
  void submitted(document.querySelector(inputSelector));
}, true);
