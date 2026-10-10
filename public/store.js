// Keep the real select for form submission and a native fallback without JS.
document.querySelectorAll('.checkout-card select, .season-switcher select').forEach(select => {
  if (!select.options.length || select.multiple) return;
  const wrapper = document.createElement('div'); wrapper.className = 'checkout-select';
  const trigger = document.createElement('button'); trigger.type = 'button';
  trigger.className = 'checkout-select-trigger'; trigger.id = `${select.id}-trigger`;
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false'); trigger.disabled = select.disabled;
  const label = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
  if (label) { label.id ||= `${select.id}-label`; label.htmlFor = trigger.id; trigger.setAttribute('aria-labelledby', `${label.id} ${trigger.id}`); }
  const list = document.createElement('div'); list.className = 'checkout-select-options';
  list.id = `${select.id}-options`; list.setAttribute('role', 'listbox'); list.hidden = true;
  trigger.setAttribute('aria-controls', list.id);
  if (label) list.setAttribute('aria-labelledby', label.id);
  select.before(wrapper); wrapper.append(trigger, list, select);
  const choices = [...select.options].map((option, index) => {
    const item = document.createElement('button'); item.type = 'button'; item.tabIndex = -1;
    item.className = 'checkout-select-option'; item.setAttribute('role', 'option');
    item.textContent = option.text; item.disabled = option.disabled;
    item.addEventListener('click', () => {
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index;
      close(true);
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    list.append(item); return item;
  });
  const refresh = () => {
    trigger.textContent = select.options[select.selectedIndex]?.text || 'Choose an option';
    choices.forEach((item, index) => item.setAttribute('aria-selected', String(index === select.selectedIndex)));
    trigger.removeAttribute('aria-invalid');
  };
  const close = focus => { list.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); };
  const open = () => { list.hidden = false; trigger.setAttribute('aria-expanded', 'true'); (choices[select.selectedIndex] || choices.find(item => !item.disabled))?.focus(); };
  trigger.addEventListener('click', () => list.hidden ? open() : close(false));
  wrapper.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = choices.filter(item => !item.disabled);
    if (!enabled.length) return;
    if (list.hidden) { open(); return; }
    const index = enabled.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next].focus();
  });
  document.addEventListener('click', event => { if (!wrapper.contains(event.target)) close(false); });
  wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(false); });
  select.addEventListener('change', refresh);
  if (select.closest('.season-switcher')) {
    select.addEventListener('change', () => select.form?.requestSubmit());
  }
  select.addEventListener('invalid', event => { event.preventDefault(); trigger.setAttribute('aria-invalid', 'true'); trigger.focus(); });
  select.form?.addEventListener('reset', () => setTimeout(refresh, 0));
  refresh(); select.hidden = true;
});

// One shared preview lives outside the table's horizontal scrolling container.
const perkPreviews = [...document.querySelectorAll('.comparison .perk-preview[data-perk-image]')];
if (perkPreviews.length) {
  const panel = document.createElement('figure');
  panel.className = 'perk-image-preview'; panel.id = 'perk-image-preview';
  panel.setAttribute('role', 'tooltip'); panel.hidden = true;
  const image = document.createElement('img'); image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
  const status = document.createElement('p'); status.className = 'perk-image-preview-status';
  status.setAttribute('role', 'status');
  const caption = document.createElement('figcaption');
  panel.append(image, status, caption); document.body.append(panel);
  let active = null, pinned = false, closeTimer;
  const position = () => {
    if (!active || panel.hidden) return;
    const target = active.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const scroller = active.closest('.comparison-scroll').getBoundingClientRect();
    if (target.bottom < 0 || target.top > viewportHeight || target.right < Math.max(0, scroller.left) || target.left > Math.min(viewportWidth, scroller.right)) { close(); return; }
    const box = panel.getBoundingClientRect();
    const left = Math.min(viewportWidth - box.width - 12, Math.max(12, target.left + (target.width - box.width) / 2));
    const below = target.bottom + 10;
    const top = below + box.height <= viewportHeight - 12 ? below : Math.max(12, target.top - box.height - 10);
    panel.style.left = `${Math.max(12, left)}px`; panel.style.top = `${top}px`;
  };
  const close = () => {
    clearTimeout(closeTimer);
    if (active) {
      const trigger = active.querySelector('button');
      trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-describedby');
    }
    panel.hidden = true; active = null; pinned = false;
  };
  const show = entry => {
    clearTimeout(closeTimer);
    if (active !== entry) {
      close(); active = entry;
      image.hidden = true; status.hidden = false; status.textContent = 'Loading preview…';
      caption.textContent = entry.dataset.perkImageAlt;
      image.alt = entry.dataset.perkImageAlt;
      // Set the source only on demand; the browser caches repeat previews.
      image.src = entry.dataset.perkImage;
      if (image.complete) {
        image.hidden = !image.naturalWidth; status.hidden = !!image.naturalWidth;
        if (!image.naturalWidth) status.textContent = 'Image unavailable.';
      }
    }
    panel.hidden = false;
    const trigger = entry.querySelector('button');
    trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-describedby', panel.id);
    position();
  };
  const deferClose = () => {
    clearTimeout(closeTimer);
    if (!pinned && !active?.contains(document.activeElement)) closeTimer = setTimeout(close, 150);
  };
  image.addEventListener('load', () => { image.hidden = false; status.hidden = true; position(); });
  image.addEventListener('error', () => { image.hidden = true; status.hidden = false; status.textContent = 'Image unavailable.'; position(); });
  for (const entry of perkPreviews) {
    const trigger = entry.querySelector('button');
    trigger.setAttribute('aria-controls', panel.id);
    entry.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch' && !pinned) show(entry); });
    entry.addEventListener('pointerleave', deferClose);
    trigger.addEventListener('focus', () => show(entry));
    trigger.addEventListener('click', () => {
      if (active === entry && pinned) close();
      else { show(entry); pinned = true; }
    });
    entry.addEventListener('focusout', event => { if (!entry.contains(event.relatedTarget)) close(); });
  }
  panel.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  panel.addEventListener('pointerleave', deferClose);
  document.addEventListener('pointerdown', event => { if (active && !active.contains(event.target) && !panel.contains(event.target)) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) { event.preventDefault(); close(); }
  });
  document.addEventListener('scroll', position, { capture: true, passive: true });
  window.addEventListener('resize', position);
}

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
    const addIdentity = (label, modifier = '', icon = '') => {
      const pill = document.createElement('span');
      pill.className = `profile-identity ${modifier}`.trim();
      if (icon) {
        const image = document.createElement('img');
        image.src = icon;
        image.alt = '';
        image.className = 'identity-icon';
        image.width = 18;
        image.height = 18;
        pill.append(image);
      }
      pill.append(document.createTextNode(label));
      identityNode.append(pill);
    };
    if (premium) addIdentity('Premium', 'identity-premium', '/assets/design/minecraft-block.png');
    if (linked) addIdentity('Discord', 'identity-discord', '/assets/design/discord-symbol.svg');
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
  const fitPanel = () => {
    if (panel.hidden) return;
    panel.style.maxHeight = `${Math.max(80, window.innerHeight - Math.max(0, panel.getBoundingClientRect().top) - 12)}px`;
  };
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
    fitPanel();
  };
  trigger.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    fitPanel();
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
  window.addEventListener('resize', fitPanel);
  document.addEventListener('scroll', fitPanel, { capture: true, passive: true });
  panel.querySelectorAll('.season-kit-content img').forEach(image => {
    const unavailable = () => {
      if (image.dataset.kitFailed) return;
      image.dataset.kitFailed = 'true';
      image.hidden = true;
      if (image.classList.contains('kit-icon')) return;
      const note = document.createElement('p');
      note.className = 'kit-image-error'; note.textContent = 'Kit image is unavailable.';
      image.after(note);
    };
    image.addEventListener('error', unavailable, { once: true });
    if (image.complete && image.naturalWidth === 0) unavailable();
  });
  if (kitImage) {
    const unavailable = () => {
      kitImage.hidden = true;
      panel.querySelector('[data-kit-unavailable]').hidden = false;
    };
    kitImage.addEventListener('error', unavailable, { once: true });
    if (kitImage.complete && kitImage.naturalWidth === 0) unavailable();
  }
}
