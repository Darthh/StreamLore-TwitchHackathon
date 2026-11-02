const byId = id => document.getElementById(id);
const notices = {
  unavailable: 'StreamLore can’t turn on right now: its Whisper account or Twitch connection isn’t set up. Try again later.',
  full: 'StreamLore is full. Twitch limits how many people one account can whisper each day, so new viewers have to wait for a spot.',
};

function setEnabled(enabled) {
  const button = byId('enable');
  button.classList.toggle('disabled', !enabled);
  button.setAttribute('aria-disabled', String(!enabled));
  button.tabIndex = enabled ? 0 : -1;
  if (enabled) button.href = '/everywhere/on'; else button.removeAttribute('href');
}

async function loadStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  byId('error').hidden = true;
  byId('retry').disabled = true;
  setEnabled(false);
  try {
    const response = await fetch('/api/everywhere/status', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error('StreamLore status is unavailable right now. Please try again.');
    const status = await response.json();
    if (!status || !status.bot || typeof status.viewers !== 'number' || typeof status.capacity !== 'number') throw new Error('StreamLore returned an incomplete status. Please try again.');
    if (/^[a-z0-9_]{1,25}$/.test(status.bot.login || '')) document.querySelectorAll('[data-bot]').forEach(node => { node.textContent = status.bot.login; });
    const open = status.configured === true && status.bot.connected === true && status.full !== true;
    byId('badge').textContent = open ? 'Open' : status.full ? 'Full' : 'Not ready';
    byId('badge').classList.toggle('ready', open);
    byId('availability').classList.toggle('ready', open);
    byId('availability-title').textContent = open ? 'Ready to turn on' : status.full ? 'All spots are taken' : 'Not accepting viewers yet';
    byId('availability-description').textContent = open ? `${status.viewers} of ${status.capacity} spots in use. Sign in with Twitch to get answers in every chat.` : status.full ? notices.full : 'The Whisper account still needs to be connected by its owner.';
    byId('bot-label').textContent = status.bot.connected ? 'Connected' : 'Not connected';
    byId('bot-dot').classList.toggle('ready', status.bot.connected === true);
    setEnabled(open);
  } catch (error) {
    byId('badge').textContent = 'Status unavailable';
    byId('availability-title').textContent = 'We couldn’t check StreamLore';
    byId('availability-description').textContent = 'Try again in a moment.';
    byId('error-message').textContent = controller.signal.aborted ? 'The status request timed out. Please check your connection and retry.' : error instanceof Error ? error.message : 'Could not load StreamLore status.';
    byId('error').hidden = false;
  } finally { clearTimeout(timeout); byId('retry').disabled = false; }
}

const notice = notices[new URLSearchParams(location.search).get('notice')];
byId('enable').addEventListener('click', event => { if (byId('enable').getAttribute('aria-disabled') === 'true') event.preventDefault(); });
byId('retry').addEventListener('click', loadStatus);
loadStatus().then(() => { if (notice) { byId('error-message').textContent = notice; byId('error').hidden = false; } });
