const statusEl = document.getElementById('status');
const readBtn = document.getElementById('read');
const pauseBtn = document.getElementById('pause');
const resumeBtn = document.getElementById('resume');
const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const speedInput = document.getElementById('speed');
const speedLabel = document.getElementById('speedLabel');

function setStatus(text) {
  statusEl.textContent = text ?? '';
}

function formatRate(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return '1×';
  const t = Math.round(n * 100) / 100;
  return `${t}×`;
}

/**
 * Callback-style messaging so `chrome.runtime.lastError` is always consumed
 * (avoids "Unchecked runtime.lastError" when the service worker is asleep).
 * @param {object} message
 * @returns {Promise<unknown | undefined>}
 */
function sendExtensionMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** While the user drags the speed slider, do not overwrite from broadcast state. */
let speedUserAdjustUntil = 0;

/** @type {boolean} */
let syncingSpeedFromState = false;

/** Whether the last poll saw an active read session (for end detection). */
let wasActive = false;

/** @type {chrome.runtime.Port | null} */
let statePort = null;

function applyPlaybackState(st) {
  if (!st) return;

  const active = !!st.active;
  const paused = !!st.paused;
  const lostSession = !!st.lostSession;
  const effectivelyActive = active || lostSession;
  const total = Number(st.total) || 0;
  const idx = Number(st.index) || 0;

  pauseBtn.disabled = !effectivelyActive || paused;
  resumeBtn.disabled = !effectivelyActive || !paused;
  backBtn.disabled = !effectivelyActive;
  forwardBtn.disabled = !effectivelyActive;

  if (
    typeof st.playbackRate === 'number' &&
    Number.isFinite(st.playbackRate) &&
    Date.now() > speedUserAdjustUntil
  ) {
    syncingSpeedFromState = true;
    speedInput.value = String(st.playbackRate);
    speedLabel.textContent = formatRate(st.playbackRate);
    syncingSpeedFromState = false;
  }

  if (lostSession) {
    wasActive = true;
    setStatus('Audio playing — session re-synced from storage; Pause stops playback.');
  } else if (active && total > 0) {
    wasActive = true;
    const cur = Math.min(idx + 1, total);
    setStatus(`Playing sentence ${cur} of ${total}.${paused ? ' (paused)' : ''}`);
  } else if (wasActive) {
    wasActive = false;
    setStatus('Playback finished.');
  }
}

async function connectStatePort() {
  await sendExtensionMessage({ type: 'PING' });
  await new Promise((r) => setTimeout(r, 0));

  try {
    const port = chrome.runtime.connect({ name: 'popup-state' });
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'PLAYBACK_STATE') {
        applyPlaybackState(msg);
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (statePort === port) statePort = null;
    });
    statePort = port;
    queueMicrotask(() => {
      void chrome.runtime.lastError;
    });
  } catch {
    statePort = null;
  }
}

async function refreshPlaybackUi() {
  try {
    await hydratePlaybackStateOnce();
  } catch {
    /* ignore */
  }
}

async function hydratePlaybackStateOnce() {
  const st = await sendExtensionMessage({ type: 'GET_PLAYBACK_STATE' });
  if (st != null) {
    applyPlaybackState(st);
  }
}

speedInput.addEventListener('input', () => {
  speedUserAdjustUntil = Date.now() + 900;
  const v = Number(speedInput.value);
  speedLabel.textContent = formatRate(v);
  if (syncingSpeedFromState) return;
  void sendExtensionMessage({ type: 'SET_PLAYBACK_RATE', value: v });
});

speedInput.addEventListener('change', () => {
  speedUserAdjustUntil = 0;
});

pauseBtn.addEventListener('click', async () => {
  try {
    const res = await sendExtensionMessage({ type: 'PLAYBACK_PAUSE' });
    if (!res?.ok) {
      setStatus(res?.error || 'Could not pause.');
    }
    await refreshPlaybackUi();
  } catch (err) {
    setStatus(String(err?.message ?? err));
  }
});

resumeBtn.addEventListener('click', async () => {
  try {
    const res = await sendExtensionMessage({ type: 'PLAYBACK_RESUME' });
    if (!res?.ok) {
      setStatus(res?.error || 'Could not resume.');
    }
    await refreshPlaybackUi();
  } catch (err) {
    setStatus(String(err?.message ?? err));
  }
});

backBtn.addEventListener('click', async () => {
  try {
    const res = await sendExtensionMessage({ type: 'PLAYBACK_BACK' });
    if (!res?.ok) {
      setStatus(res?.error || 'Could not go back.');
    }
    await refreshPlaybackUi();
  } catch (err) {
    setStatus(String(err?.message ?? err));
  }
});

forwardBtn.addEventListener('click', async () => {
  try {
    const res = await sendExtensionMessage({ type: 'PLAYBACK_FORWARD' });
    if (!res?.ok) {
      setStatus(res?.error || 'Could not skip forward.');
    }
    await refreshPlaybackUi();
  } catch (err) {
    setStatus(String(err?.message ?? err));
  }
});

readBtn.addEventListener('click', async () => {
  setStatus('Starting…');
  readBtn.disabled = true;
  try {
    const picked = await sendExtensionMessage({ type: 'GET_SELECTION_TEXT' });
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

    const res = await sendExtensionMessage({ type: 'SYNTHESIZE_TEXT', text });
    if (res?.ok) {
      const n = Number(res.sentences) || 1;
      setStatus(
        `Reading… (${n} sentence${n === 1 ? '' : 's'}). Pause, Play, Back, or Fwd anytime.`
      );
    } else {
      setStatus(res?.error || 'Failed.');
    }
  } catch (err) {
    setStatus(String(err?.message ?? err));
  } finally {
    readBtn.disabled = false;
    await refreshPlaybackUi();
  }
});

void connectStatePort();
speedLabel.textContent = formatRate(Number(speedInput.value));
void refreshPlaybackUi();

/* Fallback if port could not connect; primary updates come from the port push. */
setInterval(() => {
  if (statePort) return;
  void refreshPlaybackUi();
}, 600);
