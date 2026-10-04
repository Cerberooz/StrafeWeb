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
    identityNode.textContent = premium ? 'Premium' : linked ? 'Discord linked' : 'Discord not linked';
    identityNode.classList.toggle('identity-premium', premium);
    identityNode.classList.toggle('identity-discord', !premium && linked);
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
