const form = document.getElementById('settings-form');
const statusEl = document.getElementById('status');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function load() {
  const res = await fetch('/api/settings');
  if (!res.ok) {
    setStatus('Could not load settings.', 'error');
    return;
  }
  const s = await res.json();
  form.displayName.value = s.displayName;
  form.timezone.value = s.timezone;
  form.digestFrequency.value = s.digestFrequency;
  form.marketingEmails.checked = s.marketingEmails;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('Saving…', '');
  const body = {
    displayName: form.displayName.value,
    timezone: form.timezone.value,
    digestFrequency: form.digestFrequency.value,
    marketingEmails: form.marketingEmails.checked,
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`Saving settings failed with HTTP ${res.status}`);
      setStatus('Could not save settings. Please try again.', 'error');
      return;
    }
    setStatus('Settings saved.', 'ok');
  } catch (err) {
    console.error('Saving settings failed:', err.message);
    setStatus('Could not save settings. Please try again.', 'error');
  }
});

load();
