const statusEl = document.getElementById('status');
const readBtn = document.getElementById('read');

function setStatus(text) {
  statusEl.textContent = text ?? '';
}

readBtn.addEventListener('click', async () => {
  setStatus('Starting…');
  readBtn.disabled = true;
  try {
    const picked = await chrome.runtime.sendMessage({ type: 'GET_SELECTION_TEXT' });
    let text = (picked?.text ?? '').trim();

    if (!text) {
      try {
        text = (await navigator.clipboard.readText()).trim();
      } catch {
        /* permission denied or no clipboard access */
      }
    }

    if (!text) {
      setStatus(
        'No text found. On PDFs: highlight text, press Ctrl+C, then click Read again.'
      );
      return;
    }

    const res = await chrome.runtime.sendMessage({ type: 'SYNTHESIZE_TEXT', text });
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
