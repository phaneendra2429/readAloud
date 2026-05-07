const statusEl = document.getElementById('status');
const readBtn = document.getElementById('read');

function setStatus(text) {
  statusEl.textContent = text ?? '';
}

readBtn.addEventListener('click', async () => {
  setStatus('Starting…');
  readBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNTHESIZE_SELECTION' });
    if (res?.ok) {
      setStatus('Playback finished.');
    } else {
      setStatus(res?.error || 'Failed.');
    }
  } catch (err) {
    setStatus(String(err?.message ?? err));
  } finally {
    readBtn.disabled = false;
  }
});
