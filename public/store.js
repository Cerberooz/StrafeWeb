const serverStatusNode = document.querySelector('[data-server-status]');
if (serverStatusNode) {
  let loadingStatus = false;
  async function refreshServerStatus() {
    if (loadingStatus || document.hidden) return;
    loadingStatus = true;
    try {
      const response = await fetch('/server-status', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!response.ok) throw new Error('Status unavailable');
      const status = await response.json();
      const online = status.state === 'online' && Number.isSafeInteger(status.players) && status.players >= 0;
      serverStatusNode.dataset.state = online ? 'online' : status.state === 'offline' ? 'offline' : 'unavailable';
      serverStatusNode.querySelector('[data-server-status-text]').textContent = online
        ? `${status.players.toLocaleString('en-US')} online` : status.state === 'offline' ? 'Offline' : 'Status unavailable';
    } catch {
      serverStatusNode.dataset.state = 'unavailable';
      serverStatusNode.querySelector('[data-server-status-text]').textContent = 'Status unavailable';
    } finally { loadingStatus = false; }
  }
  refreshServerStatus();
  setInterval(refreshServerStatus, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshServerStatus(); });
}
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  const feedback = button.querySelector('.copy-feedback');
  try { await navigator.clipboard.writeText(button.dataset.copy); if (feedback) feedback.textContent = 'Copied to clipboard'; }
  catch { if (feedback) feedback.textContent = 'Select and copy the server address above'; }
  setTimeout(() => { if (feedback) feedback.textContent = ''; }, 2500);
}));
document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => {
  // Native dialog forms close a popup; they do not submit a network request.
  if (event.defaultPrevented || form.method === 'dialog' || event.submitter?.formMethod === 'dialog') return;
  const button = event.submitter || form.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.textContent = 'Please wait…'; }
}));
document.querySelectorAll('[data-account-portrait]').forEach(image => {
  // Keep the reserved image slot if the render CDN is unavailable.
  const fallback = () => { image.src = '/assets/design/default-player-bust.svg'; };
  image.addEventListener('error', fallback, { once: true });
  if (image.complete && image.naturalWidth === 0) fallback();
});
const playerProfile = document.querySelector('.player-profile');
if (playerProfile) {
  const nameNode = playerProfile.querySelector('[data-profile-name]');
  const regionNode = playerProfile.querySelector('[data-profile-region]');
  const identityNode = playerProfile.querySelector('[data-profile-identity]');
  const portraitNode = playerProfile.querySelector('[data-profile-portrait]');
  portraitNode.addEventListener('error', () => {
    if (!portraitNode.src.endsWith('/assets/design/default-player-bust.svg')) portraitNode.src = '/assets/design/default-player-bust.svg';
  });
  document.querySelectorAll('[data-player-profile]').forEach(button => button.addEventListener('click', async () => {
    const playerName = button.dataset.name || 'Player';
    nameNode.textContent = playerName;
    regionNode.textContent = button.dataset.region || 'Region unavailable';
    portraitNode.src = button.dataset.portrait || '/assets/design/default-player-bust.svg';
    const premium = button.dataset.premium === 'true';
    const linked = button.dataset.linked === 'true';
    identityNode.replaceChildren();
    const addIdentity = (label, modifier = '') => {
      const pill = document.createElement('span');
      pill.className = `profile-identity ${modifier}`.trim();
      pill.textContent = label;
      identityNode.append(pill);
    };
    if (linked) addIdentity('Discord', 'identity-discord');
    if (premium) addIdentity('Premium', 'identity-premium');
    if (!linked && !premium) addIdentity('Discord not linked');
    playerProfile.showModal();
  }));
  playerProfile.addEventListener('click', event => {
    if (event.target === playerProfile) playerProfile.close();
  });
}

const tierInformation = document.querySelector('[data-tier-information]');
if (tierInformation) {
  const trigger = tierInformation.querySelector('[data-information-trigger]');
  const panel = tierInformation.querySelector('.information-panel');
  const tabs = [...panel.querySelectorAll('[role="tab"]')];
  const close = (restoreFocus = false) => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  };
  const selectTab = tab => {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    }
  };
  trigger.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) tabs.find(tab => tab.getAttribute('aria-selected') === 'true').focus();
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });
  document.addEventListener('click', event => {
    if (!tierInformation.contains(event.target)) close();
  });
  document.addEventListener('focusin', event => {
    if (!tierInformation.contains(event.target)) close();
  });
  tierInformation.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      close(true);
    }
  });
  const kitImage = panel.querySelector('[data-season-kit]');
  if (kitImage) {
    const unavailable = () => {
      kitImage.hidden = true;
      panel.querySelector('[data-kit-unavailable]').hidden = false;
    };
    kitImage.addEventListener('error', unavailable, { once: true });
    if (kitImage.complete && kitImage.naturalWidth === 0) unavailable();
  }
}
