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

/**
 * Best-effort selection across isolated/main worlds and all frames (helps some embedded viewers).
 * Chrome's built-in PDF viewer often blocks injection or selection APIs — callers should fall back to clipboard.
 */
async function getSelectionTextFromActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    return '';
  }

  const tabId = tab.id;
  let best = '';

  const snippetRunner = () => {
    try {
      const sel = window.getSelection && window.getSelection();
      return sel ? sel.toString() : '';
    } catch {
      return '';
    }
  };

  for (const useMain of [true, false]) {
    try {
      const inject = {
        target: { tabId, allFrames: true },
        func: snippetRunner
      };
      if (useMain) {
        inject.world = 'MAIN';
      }

      const frames = await chrome.scripting.executeScript(inject);
      for (const { result } of frames ?? []) {
        const s = typeof result === 'string' ? result.trim() : '';
        if (s.length > best.length) best = s;
      }
    } catch {
      /* blocked tab (e.g. chrome://), PDF internals, or policy */
    }
  }

  return best.trim();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_SELECTION_TEXT') {
    getSelectionTextFromActiveTab()
      .then((text) => sendResponse({ ok: true, text }))
      .catch(() => sendResponse({ ok: true, text: '' }));
    return true;
  }

  if (message?.type === 'SYNTHESIZE_TEXT') {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) {
      sendResponse({ ok: false, error: 'No text to read' });
      return undefined;
    }

    (async () => {
      try {
        await ensureOffscreen();
        await streamSynthesize(text);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();

    return true;
  }

  /** @deprecated Use SYNTHESIZE_TEXT from popup (supports clipboard fallback). */
  if (message?.type === 'SYNTHESIZE_SELECTION') {
    (async () => {
      try {
        const text = await getSelectionTextFromActiveTab();
        if (!text) {
          sendResponse({
            ok: false,
            error:
              'No text selected. In PDFs, select text then press Ctrl+C, open this popup again, and click Read.'
          });
          return;
        }
        await ensureOffscreen();
        await streamSynthesize(text);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();

    return true;
  }

  return undefined;
});
