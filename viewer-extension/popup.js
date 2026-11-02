import { apiOrigin, viewerCookie } from './config.js';
const account = document.getElementById('account');
const enabled = document.getElementById('enabled');
document.getElementById('connect').href = `${apiOrigin}/auth/viewer/start`;
document.getElementById('connect').target = '_blank';
document.getElementById('connect').rel = 'noreferrer';
enabled.checked = (await chrome.storage.local.get('enabled')).enabled !== false;
enabled.addEventListener('change', () => chrome.storage.local.set({ enabled: enabled.checked }));
async function refresh() {
  try { const result = await chrome.runtime.sendMessage({ type: 'STATUS' }); if (!result?.ok) throw new Error(result?.error || 'Connect Twitch first.'); account.textContent = `Connected as ${result.viewer.displayName}`; }
  catch (error) { account.textContent = error.message || 'Connect your Twitch account to receive Whispers.'; }
}
await refresh();
document.getElementById('test').addEventListener('submit', async event => {
  event.preventDefault(); const resultText = document.getElementById('result'); resultText.textContent = 'Requesting your Whisper…';
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try { const result = await chrome.runtime.sendMessage({ type: 'ASK_LORE', ...values }); resultText.textContent = result?.ok ? result.message : result?.error || 'StreamLore could not send this Whisper.'; }
  catch { resultText.textContent = 'Reopen the add-on and try again.'; }
});
document.getElementById('disconnect').addEventListener('click', async () => { await chrome.cookies.remove({ url: apiOrigin, name: viewerCookie }); await chrome.storage.local.set({ enabled: false }); enabled.checked = false; await refresh(); });
window.addEventListener('focus', refresh);
