const OFFSCREEN_AUDIO = 'OFFSCREEN_AUDIO';

async function ensureOffscreen() {
  try {
    if (chrome.offscreen?.hasDocument) {
      const exists = await chrome.offscreen.hasDocument();
      if (exists) return;
    }
  } catch (_) {
    /* ignore */
  }
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Decode streamed Piper PCM chunks and play audio.'
    });
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!msg.includes('Only a single offscreen')) throw err;
  }
}

function streamSynthesize(text, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const port = chrome.runtime.connectNative('com.piper.reader');

    port.postMessage({
      type: 'synthesize',
      text,
      voice: opts.voice ?? null,
      length_scale: opts.length_scale ?? 1.0
    });

    port.onMessage.addListener((msg) => {
      chrome.runtime.sendMessage(
        { channel: OFFSCREEN_AUDIO, payload: msg },
        () => void chrome.runtime.lastError
      );

      if (msg?.type === 'done') {
        settled = true;
        port.disconnect();
        resolve();
      } else if (msg?.type === 'error') {
        settled = true;
        port.disconnect();
        reject(new Error(msg.message || 'Native host reported an error'));
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      const last = chrome.runtime.lastError?.message;
      reject(new Error(last || 'Native messaging disconnected'));
    });
  });
}

async function readSelectionFromActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error('No active tab');
  }

  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.getSelection().toString()
  });

  const text = (injected?.[0]?.result ?? '').trim();
  if (!text) {
    throw new Error('No text selected');
  }
  return text;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SYNTHESIZE_SELECTION') {
    return undefined;
  }

  (async () => {
    try {
      const text = await readSelectionFromActiveTab();
      await ensureOffscreen();
      await streamSynthesize(text);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();

  return true;
});
