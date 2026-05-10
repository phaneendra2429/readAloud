const OFFSCREEN_AUDIO = 'OFFSCREEN_AUDIO';
const OFFSCREEN_CONTROL = 'OFFSCREEN_CONTROL';
const OFFSCREEN_QUERY = 'OFFSCREEN_QUERY';

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

function sendToOffscreenControl(payload) {
  return new Promise((resolve, reject) => {
    const controlPayload =
      payload?.type === 'clear' ? { ...payload, cutoffSeq: audioMessageSeq } : payload;
    chrome.runtime.sendMessage({ channel: OFFSCREEN_CONTROL, payload: controlPayload }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (res && res.ok === false) {
        reject(new Error(res.error || 'Offscreen control failed'));
        return;
      }
      resolve(res);
    });
  });
}

/** @type {import('chrome').runtime.Port | null} */
let activeSynthPort = null;

/** Native ports intentionally disconnected by pause/seek/restart. */
const abortedSynthPorts = new Set();

/** Monotonic sequence used to invalidate stale chunks after clear/seek/restart. */
let audioMessageSeq = 0;

/** Monotonic sequence used to prevent stale read loops from advancing sentence state. */
let readLoopSeq = 0;

function invalidateActiveReadLoop() {
  readLoopSeq += 1;
}

/** Monotonic sequence used so only the latest seek/restart can resume playback. */
let seekSeq = 0;

function beginPlaybackRestart() {
  seekSeq += 1;
  invalidateActiveReadLoop();
  abortSynthesis();
  return seekSeq;
}

function replaceCurrentSessionAt(index) {
  if (!session) return null;
  session = {
    ...session,
    id: ++sessionIdSeq,
    index,
    paused: false,
    cancelled: false,
    seeking: true
  };
  return session;
}

function abortSynthesis() {
  const port = activeSynthPort;
  if (!port) return;
  abortedSynthPorts.add(port);
  try {
    port.disconnect();
  } catch {
    /* ignore */
  }
  if (activeSynthPort === port) activeSynthPort = null;
}

function splitSentences(text) {
  const t = text.trim();
  if (!t) return [];

  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    const parts = [];
    for (const { segment } of seg.segment(t)) {
      const s = segment.trim();
      if (s) parts.push(s);
    }
    if (parts.length) return parts;
  } catch {
    /* fall through */
  }

  /* Split after sentence punctuation + whitespace (no quantifier on lookbehind — invalid in JS). */
  return t
    .split(/(?<=[.!?…])[\s\u00A0]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @typedef {{ id: number, sentences: string[], index: number, paused: boolean, cancelled: boolean, seeking: boolean, playbackRate: number, voice: string | null }} ReadSession
 * @type {ReadSession | null}
 */
let session = null;

/** @type {number} */
let sessionIdSeq = 0;

/** User speed (1 = normal); persisted when idle for the popup slider. */
let defaultPlaybackRate = 1.0;

/** Popup ports for live state push (sendMessage can stall while native/offscreen are busy). */
const popupStatePorts = new Set();

/** @type {ReturnType<typeof setInterval> | null} */
let playbackStateBroadcastTimer = null;

/** @type {ReturnType<typeof setTimeout> | number} */
let rateRestartTimer = 0;

function buildPlaybackState() {
  if (!session) {
    return {
      active: false,
      paused: false,
      index: 0,
      total: 0,
      playbackRate: defaultPlaybackRate,
      lostSession: false
    };
  }
  return {
    active: true,
    paused: session.paused,
    index: session.index,
    total: session.sentences.length,
    playbackRate: session.playbackRate,
    lostSession: false
  };
}

async function queryOffscreenAudioQueued() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 500);
    try {
      chrome.runtime.sendMessage(
        { channel: OFFSCREEN_QUERY, payload: { type: 'audioQueued' } },
        (res) => {
          clearTimeout(timeout);
          void chrome.runtime.lastError;
          resolve(!!res?.queued);
        }
      );
    } catch {
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

/**
 * Align UI with reality: SW can lose `session` while offscreen still plays scheduled audio.
 */
async function getPlaybackStateForUi() {
  await hydratePlaybackSession();
  let st = buildPlaybackState();
  if (st.active) return st;

  const queued = await queryOffscreenAudioQueued();
  if (!queued) return st;

  await hydratePlaybackSession();
  st = buildPlaybackState();
  if (st.active) return st;

  await new Promise((r) => setTimeout(r, 50));
  await hydratePlaybackSession();
  st = buildPlaybackState();
  if (st.active) return st;

  return {
    active: true,
    paused: false,
    index: 0,
    total: 1,
    playbackRate: defaultPlaybackRate,
    lostSession: true
  };
}

function broadcastPlaybackState() {
  void broadcastPlaybackStateAsync();
}

async function broadcastPlaybackStateAsync() {
  const st = await getPlaybackStateForUi();
  for (const port of popupStatePorts) {
    try {
      port.postMessage({ type: 'PLAYBACK_STATE', ...st });
    } catch (_) {
      popupStatePorts.delete(port);
    }
  }
}

function ensurePlaybackStateBroadcastLoop() {
  if (playbackStateBroadcastTimer != null) return;
  playbackStateBroadcastTimer = setInterval(() => {
    if (popupStatePorts.size === 0) {
      clearInterval(playbackStateBroadcastTimer);
      playbackStateBroadcastTimer = null;
      return;
    }
    broadcastPlaybackState();
  }, 250);
}

const PLAYBACK_SNAP_KEY = 'piperReadPlayback';
const PLAYBACK_SNAP_MAX_AGE_MS = 30 * 60 * 1000;

/** `session` when available (Chrome 114+); else `local` for older builds. */
function playbackStorageArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

async function persistPlaybackSnapshot() {
  try {
    if (!session) {
      await playbackStorageArea().remove(PLAYBACK_SNAP_KEY);
      return;
    }
    await playbackStorageArea().set({
      [PLAYBACK_SNAP_KEY]: {
        savedAt: Date.now(),
        id: session.id,
        sentences: session.sentences,
        index: session.index,
        paused: session.paused,
        playbackRate: session.playbackRate,
        voice: session.voice
      }
    });
  } catch (e) {
    console.warn('[piper-read] persist snapshot', e);
  }
  broadcastPlaybackState();
}

async function hydratePlaybackSession() {
  if (session) return;
  try {
    const data = await playbackStorageArea().get(PLAYBACK_SNAP_KEY);
    const snap = data[PLAYBACK_SNAP_KEY];
    if (!snap?.sentences?.length) return;
    if (Date.now() - (snap.savedAt || 0) > PLAYBACK_SNAP_MAX_AGE_MS) {
      await playbackStorageArea().remove(PLAYBACK_SNAP_KEY);
      return;
    }
    const len = snap.sentences.length;
    const rawIdx = Number(snap.index) || 0;
    /* Never revive a "finished" snapshot — it made controls dead while offscreen kept playing. */
    if (rawIdx >= len) {
      await playbackStorageArea().remove(PLAYBACK_SNAP_KEY);
      return;
    }
    session = {
      id: snap.id ?? ++sessionIdSeq,
      sentences: snap.sentences,
      index: rawIdx,
      paused: !!snap.paused,
      cancelled: false,
      seeking: false,
      playbackRate: snap.playbackRate ?? 1.0,
      voice: snap.voice ?? null
    };
  } catch (e) {
    console.warn('[piper-read] hydrate snapshot', e);
  }
}

/** Piper `length_scale`: higher = slower. Server allows (0, 5]. */
function speedToLengthScale(speed) {
  const s = Math.min(4, Math.max(0.25, Number(speed) || 1));
  const scale = 1 / s;
  return Math.min(5, Math.max(0.2, scale));
}

function streamSynthesize(text, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const port = chrome.runtime.connectNative('com.piper.reader');
    activeSynthPort = port;

    port.postMessage({
      type: 'synthesize',
      text,
      voice: opts.voice ?? null,
      length_scale: opts.length_scale ?? 1.0
    });

    port.onMessage.addListener((msg) => {
      const payload = { ...msg, audioSeq: ++audioMessageSeq };
      chrome.runtime.sendMessage(
        { channel: OFFSCREEN_AUDIO, payload },
        () => void chrome.runtime.lastError
      );

      if (msg?.type === 'done') {
        settled = true;
        abortedSynthPorts.delete(port);
        if (activeSynthPort === port) activeSynthPort = null;
        port.disconnect();
        resolve();
      } else if (msg?.type === 'error') {
        settled = true;
        abortedSynthPorts.delete(port);
        if (activeSynthPort === port) activeSynthPort = null;
        port.disconnect();
        reject(new Error(msg.message || 'Native host reported an error'));
      }
    });

    port.onDisconnect.addListener(() => {
      if (activeSynthPort === port) activeSynthPort = null;
      if (settled) return;
      const last = chrome.runtime.lastError?.message;
      if (abortedSynthPorts.has(port)) {
        abortedSynthPorts.delete(port);
        reject(Object.assign(new Error('Playback aborted'), { code: 'ABORTED' }));
        return;
      }
      reject(new Error(last || 'Native messaging disconnected'));
    });
  });
}

async function waitForOffscreenPlaybackEnd(loopId, loopSeq) {
  while (true) {
    if (
      !session ||
      session.id !== loopId ||
      loopSeq !== readLoopSeq ||
      session.cancelled ||
      session.seeking
    ) {
      return false;
    }

    const queued = await queryOffscreenAudioQueued();

    if (
      !session ||
      session.id !== loopId ||
      loopSeq !== readLoopSeq ||
      session.cancelled ||
      session.seeking
    ) {
      return false;
    }
    if (!queued) {
      return true;
    }

    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Currently running read loop key. We intentionally do not queue behind old loops:
 * pause/seek/new-read invalidates old loop tokens, then the new loop starts immediately.
 * Waiting behind the old promise can deadlock if Chrome is slow to disconnect native messaging.
 * @type {string | null}
 */
let activeReadLoopKey = null;

async function runReadSessionWorker(loopId, loopSeq) {
  while (
    session &&
    session.id === loopId &&
    loopSeq === readLoopSeq &&
    !session.cancelled
  ) {
    if (session.paused) return;

    if (session.index >= session.sentences.length) {
      session = null;
      await persistPlaybackSnapshot();
      return;
    }

    await persistPlaybackSnapshot();

    try {
      await ensureOffscreen();
      await streamSynthesize(session.sentences[session.index], {
        voice: session.voice,
        length_scale: speedToLengthScale(session.playbackRate)
      });
      const played = await waitForOffscreenPlaybackEnd(loopId, loopSeq);
      if (!played) return;
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code;
      if (code === 'ABORTED' && session?.paused) {
        return;
      }
      if (code === 'ABORTED' && session?.cancelled) {
        return;
      }
      if (code === 'ABORTED' && session?.seeking) {
        return;
      }
      if (code === 'ABORTED' && session && session.id !== loopId) {
        return;
      }
      console.error('[piper-read]', err);
      if (session && session.id === loopId) session = null;
      await persistPlaybackSnapshot();
      return;
    }

    if (!session || session.id !== loopId || loopSeq !== readLoopSeq || session.cancelled) return;
    if (session.paused) return;

    session.index += 1;
    if (session.index >= session.sentences.length) {
      session = null;
      await persistPlaybackSnapshot();
      return;
    }
    await persistPlaybackSnapshot();
  }
}

function runReadSession() {
  const loopId = session?.id;
  const loopSeq = readLoopSeq;
  if (!loopId) return;

  const key = `${loopId}:${loopSeq}`;
  if (activeReadLoopKey === key) return;
  activeReadLoopKey = key;

  void runReadSessionWorker(loopId, loopSeq)
    .catch((e) => console.error('[piper-read]', e))
    .finally(() => {
      if (activeReadLoopKey === key) {
        activeReadLoopKey = null;
      }
    });
}

function queuePlaybackRateRestart() {
  clearTimeout(rateRestartTimer);
  rateRestartTimer = setTimeout(() => {
    rateRestartTimer = 0;
    void applyPlaybackRateRestart();
  }, 220);
}

async function applyPlaybackRateRestart() {
  await hydratePlaybackSession();
  if (!session || session.paused) return;
  session.seeking = true;
  const mySeekSeq = beginPlaybackRestart();
  try {
    await sendToOffscreenControl({ type: 'clear' });
  } catch (_) {
    /* ignore */
  }
  if (!session || mySeekSeq !== seekSeq) return;
  session.seeking = false;
  await persistPlaybackSnapshot();
  runReadSession();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup-state') return;
  popupStatePorts.add(port);
  void (async () => {
    const st = await getPlaybackStateForUi();
    try {
      port.postMessage({ type: 'PLAYBACK_STATE', ...st });
    } catch (_) {
      popupStatePorts.delete(port);
    }
  })();
  ensurePlaybackStateBroadcastLoop();
  port.onDisconnect.addListener(() => {
    popupStatePorts.delete(port);
  });
});

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
  if (message?.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'GET_SELECTION_TEXT') {
    getSelectionTextFromActiveTab()
      .then((text) => sendResponse({ ok: true, text }))
      .catch(() => sendResponse({ ok: true, text: '' }));
    return true;
  }

  if (message?.type === 'GET_PLAYBACK_STATE') {
    (async () => {
      const st = await getPlaybackStateForUi();
      sendResponse(st);
    })();
    return true;
  }

  if (message?.type === 'SET_PLAYBACK_RATE') {
    (async () => {
      await hydratePlaybackSession();
      const v = Number(message.value);
      if (!Number.isFinite(v) || v <= 0) {
        sendResponse({ ok: false, error: 'Invalid rate' });
        return;
      }
      const rate = Math.min(4, Math.max(0.25, v));
      defaultPlaybackRate = rate;
      if (session) session.playbackRate = rate;
      await persistPlaybackSnapshot();
      sendResponse({ ok: true, playbackRate: rate });
      if (session && !session.paused) {
        queuePlaybackRateRestart();
      }
    })();
    return true;
  }

  if (message?.type === 'PLAYBACK_PAUSE') {
    (async () => {
      await hydratePlaybackSession();
      if (!session) {
        const queued = await queryOffscreenAudioQueued();
        if (queued) {
          abortSynthesis();
          try {
            await sendToOffscreenControl({ type: 'clear' });
          } catch (_) {
            /* ignore */
          }
          await persistPlaybackSnapshot();
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, error: 'Nothing playing' });
        return;
      }
      session.paused = true;
      void sendToOffscreenControl({ type: 'pause' }).catch(() => {});
      await persistPlaybackSnapshot();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === 'PLAYBACK_RESUME') {
    (async () => {
      await hydratePlaybackSession();
      if (!session) {
        sendResponse({ ok: false, error: 'Nothing playing' });
        return;
      }
      session.paused = false;
      await persistPlaybackSnapshot();
      sendResponse({ ok: true });
      void sendToOffscreenControl({ type: 'resume' }).catch(() => {});
      void runReadSession();
    })();
    return true;
  }

  if (message?.type === 'PLAYBACK_BACK') {
    (async () => {
      await hydratePlaybackSession();
      if (!session) {
        sendResponse({ ok: false, error: 'Nothing playing' });
        return;
      }
      const snap = replaceCurrentSessionAt(Math.max(0, session.index - 1));
      if (!snap) {
        sendResponse({ ok: false, error: 'Nothing playing' });
        return;
      }
      const mySeekSeq = beginPlaybackRestart();
      sendResponse({ ok: true });
      try {
        await sendToOffscreenControl({ type: 'clear' });
        if (!session || session !== snap || mySeekSeq !== seekSeq) return;
        snap.seeking = false;
        await persistPlaybackSnapshot();
        void runReadSession();
      } catch (e) {
        console.error(e);
        snap.seeking = false;
      }
    })();
    return true;
  }

  if (message?.type === 'PLAYBACK_FORWARD') {
    (async () => {
      await hydratePlaybackSession();
      if (!session) {
        sendResponse({ ok: false, error: 'Nothing playing' });
        return;
      }
      let nextIndex;
      if (session.index < session.sentences.length - 1) {
        nextIndex = session.index + 1;
      } else {
        nextIndex = session.sentences.length;
      }
      const snap = replaceCurrentSessionAt(nextIndex);
      if (!snap) {
        sendResponse({ ok: false, error: 'Nothing playing' });
        return;
      }
      const mySeekSeq = beginPlaybackRestart();
      sendResponse({ ok: true });
      try {
        await sendToOffscreenControl({ type: 'clear' });
        if (!session || session !== snap || mySeekSeq !== seekSeq) return;
        snap.seeking = false;
        await persistPlaybackSnapshot();
        void runReadSession();
      } catch (e) {
        console.error(e);
        snap.seeking = false;
      }
    })();
    return true;
  }

  if (message?.type === 'SYNTHESIZE_TEXT') {
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) {
      sendResponse({ ok: false, error: 'No text to read' });
      return undefined;
    }

    const sentences = splitSentences(text);
    if (!sentences.length) {
      sendResponse({ ok: false, error: 'No text to read' });
      return undefined;
    }

    (async () => {
      beginPlaybackRestart();

      const prevRate = session?.playbackRate ?? defaultPlaybackRate;
      const newSession = {
        id: ++sessionIdSeq,
        sentences,
        index: 0,
        paused: false,
        cancelled: false,
        seeking: false,
        playbackRate: prevRate,
        voice: null
      };
      session = newSession;
      await persistPlaybackSnapshot();
      sendResponse({ ok: true, sentences: sentences.length });

      try {
        await ensureOffscreen();
        await sendToOffscreenControl({ type: 'clear' });
        await runReadSession();
      } catch (e) {
        console.error(e);
        if (session && session.id === newSession.id) session = null;
        await persistPlaybackSnapshot();
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
        const sentences = splitSentences(text);
        if (!sentences.length) {
          sendResponse({ ok: false, error: 'No text to read' });
          return;
        }
        beginPlaybackRestart();
        const prevRate = session?.playbackRate ?? defaultPlaybackRate;
        const newSession = {
          id: ++sessionIdSeq,
          sentences,
          index: 0,
          paused: false,
          cancelled: false,
          seeking: false,
          playbackRate: prevRate,
          voice: null
        };
        session = newSession;
        await persistPlaybackSnapshot();
        await ensureOffscreen();
        await sendToOffscreenControl({ type: 'clear' });
        sendResponse({ ok: true, sentences: sentences.length });
        await runReadSession();
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      }
    })();

    return true;
  }

  return undefined;
});
