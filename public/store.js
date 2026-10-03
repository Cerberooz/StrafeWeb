document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  const feedback = button.querySelector('.copy-feedback');
  try { await navigator.clipboard.writeText(button.dataset.copy); if (feedback) feedback.textContent = 'Copied to clipboard'; }
  catch { if (feedback) feedback.textContent = 'Select and copy the server address above'; }
  setTimeout(() => { if (feedback) feedback.textContent = ''; }, 2500);
}));
document.querySelectorAll('form').forEach(form => form.addEventListener('submit', event => {
  const button = event.submitter || form.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.textContent = 'Please wait…'; }
}));
document.querySelectorAll('[data-account-portrait]').forEach(image => {
  // Keep the reserved image slot if the public API's cached PNG fails.
  const fallback = () => { image.src = '/assets/design/default-player.svg'; };
  image.addEventListener('error', fallback, { once: true });
  if (image.complete && image.naturalWidth === 0) fallback();
});
