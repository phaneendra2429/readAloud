(() => {
  const HOST_ID = 'piper-read-aloud-float-root';
  const POS_KEY = 'piper-read-aloud-floater-pos-v1';

  /** @type {HTMLElement | null} */
  let hostEl = null;
  /** @type {ShadowRoot | null} */
  let shadow = null;
  /** @type {HTMLElement | null} */
  let wrap = null;
  /** @type {HTMLButtonElement | null} */
  let readBtn = null;
  /** @type {HTMLButtonElement | null} */
  let backBtn = null;
  /** @type {HTMLButtonElement | null} */
  let pauseBtn = null;
  /** @type {HTMLButtonElement | null} */
  let resumeBtn = null;
  /** @type {HTMLButtonElement | null} */
  let forwardBtn = null;
  /** @type {HTMLButtonElement | null} */
  let closeBtn = null;
  /** @type {HTMLElement | null} */
  let metaEl = null;
  /** @type {HTMLElement | null} */
  let dragHandle = null;

  /** @type {any} */
  let playbackState = {
    active: false,
    paused: false,
    index: 0,
    total: 0,
    lostSession: false
  };

  /** User dismissed the bar; cleared when playback runs or selection is cleared. */
  let forcedHidden = false;

  function getSelectionTrim() {
    try {
      const s = window.getSelection && window.getSelection();
      return (s ? s.toString() : '').trim();
    } catch {
      return '';
    }
  }

  function playing() {
    return !!(playbackState.active || playbackState.lostSession);
  }

  function shouldShow() {
    return getSelectionTrim().length > 0 || playing();
  }

  function sendBg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch {
        resolve(undefined);
      }
    });
  }

  function readSavedPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (typeof j?.x === 'number' && typeof j?.y === 'number') return j;
    } catch {
      /* ignore */
    }
    return null;
  }

  function savePos(x, y) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
    } catch {
      /* ignore */
    }
  }

  function applyWrapPosition() {
    if (!wrap) return;
    const p = readSavedPos();
    if (p) {
      wrap.style.left = `${p.x}px`;
      wrap.style.top = `${p.y}px`;
      wrap.style.right = 'auto';
      return;
    }
    wrap.style.left = 'auto';
    wrap.style.top = '10px';
    wrap.style.right = '12px';
  }

  function clampWrapToViewport() {
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const pad = 6;
    const maxX = Math.max(pad, window.innerWidth - r.width - pad);
    const maxY = Math.max(pad, window.innerHeight - r.height - pad);
    let x = r.left;
    let y = r.top;
    x = Math.min(maxX, Math.max(pad, x));
    y = Math.min(maxY, Math.max(pad, y));
    wrap.style.left = `${x}px`;
    wrap.style.top = `${y}px`;
    wrap.style.right = 'auto';
    savePos(x, y);
  }

  function wireDrag() {
    if (!dragHandle || !wrap) return;
    if (dragHandle.dataset.piperDragWired === '1') return;
    dragHandle.dataset.piperDragWired = '1';

    dragHandle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const br = wrap.getBoundingClientRect();
      const state = { dx: e.clientX - br.left, dy: e.clientY - br.top };

      const onMove = (ev) => {
        if (!wrap) return;
        ev.preventDefault();
        let x = ev.clientX - state.dx;
        let y = ev.clientY - state.dy;
        const r = wrap.getBoundingClientRect();
        const w = r.width;
        const h = r.height;
        const pad = 6;
        x = Math.min(Math.max(pad, x), window.innerWidth - w - pad);
        y = Math.min(Math.max(pad, y), window.innerHeight - h - pad);
        wrap.style.left = `${x}px`;
        wrap.style.top = `${y}px`;
        wrap.style.right = 'auto';
      };

      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (wrap) wrap.style.transition = '';
        clampWrapToViewport();
      };

      wrap.style.transition = 'none';
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  function cacheRefsFromShadow() {
    if (!shadow) return;
    wrap = shadow.querySelector('.wrap');
    metaEl = shadow.querySelector('.meta');
    readBtn = shadow.querySelector('[data-act="read"]');
    backBtn = shadow.querySelector('[data-act="back"]');
    pauseBtn = shadow.querySelector('[data-act="pause"]');
    resumeBtn = shadow.querySelector('[data-act="resume"]');
    forwardBtn = shadow.querySelector('[data-act="forward"]');
    closeBtn = shadow.querySelector('[data-act="close"]');
    dragHandle = shadow.querySelector('.drag-handle');
  }

  function installShadowTemplate() {
    if (!shadow) return;
    if (shadow.querySelector('.wrap')) {
      cacheRefsFromShadow();
      applyWrapPosition();
      return;
    }

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        }
        .wrap {
          position: fixed;
          top: 10px;
          right: 12px;
          left: auto;
          z-index: 2147483646;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 8px 6px 6px;
          border-radius: 999px;
          background: rgba(12, 15, 20, 0.88);
          border: 1px solid rgba(125, 168, 210, 0.22);
          box-shadow:
            0 0 0 1px rgba(0, 0, 0, 0.35),
            0 10px 28px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          color: #e9eef5;
          opacity: 0.94;
          transition: opacity 0.15s ease, box-shadow 0.15s ease;
          max-width: min(100vw - 24px, 380px);
          user-select: none;
          -webkit-user-select: none;
        }
        .wrap:hover {
          opacity: 1;
          box-shadow:
            0 0 0 1px rgba(0, 0, 0, 0.35),
            0 12px 36px rgba(0, 0, 0, 0.55),
            0 0 24px rgba(94, 176, 255, 0.18);
        }
        .drag-handle {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          min-height: 30px;
          margin: -2px 0 -2px 2px;
          border-radius: 8px;
          cursor: grab;
          color: #6b7c90;
          font-size: 14px;
          letter-spacing: -2px;
        }
        .drag-handle:active {
          cursor: grabbing;
        }
        .drag-handle:hover {
          color: #9db4cc;
          background: rgba(255, 255, 255, 0.06);
        }
        .meta {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.04em;
          color: #8fa3b8;
          white-space: nowrap;
          margin-right: 2px;
          font-variant-numeric: tabular-nums;
          max-width: 72px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .btns {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        button {
          all: unset;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 30px;
          height: 30px;
          padding: 0 8px;
          border-radius: 8px;
          font-size: 11px;
          font-weight: 650;
          line-height: 1;
          cursor: pointer;
          color: #c5d4e3;
          background: rgba(28, 36, 48, 0.95);
          border: 1px solid rgba(125, 168, 210, 0.2);
        }
        button.read-btn {
          min-width: 44px;
          padding: 0 10px;
          color: #0a1628;
          background: linear-gradient(180deg, #5eb0ff 0%, #3d8fd9 100%);
          border-color: rgba(94, 176, 255, 0.45);
        }
        button.read-btn:hover:not(:disabled) {
          background: linear-gradient(180deg, #7fc2ff 0%, #4c9ee8 100%);
        }
        button:hover:not(:disabled) {
          color: #fff;
          border-color: rgba(125, 168, 210, 0.35);
          background: #222b38;
        }
        button.read-btn:hover:not(:disabled) {
          color: #0a1628;
        }
        button:active:not(:disabled) {
          transform: scale(0.96);
        }
        button:disabled {
          opacity: 0.38;
          cursor: not-allowed;
        }
        button.close-btn {
          min-width: 26px;
          padding: 0 4px;
          font-size: 16px;
          font-weight: 400;
          line-height: 1;
          color: #7a8a9e;
          background: transparent;
          border-color: transparent;
        }
        button.close-btn:hover:not(:disabled) {
          color: #f07178;
          background: rgba(240, 113, 120, 0.12);
          border-color: rgba(240, 113, 120, 0.25);
        }
        .ic { font-size: 13px; }
      </style>
      <div class="wrap" role="toolbar" aria-label="Piper read aloud">
        <div class="drag-handle" title="Drag" aria-label="Drag toolbar">⋮⋮</div>
        <span class="meta" part="meta"></span>
        <div class="btns">
          <button type="button" class="read-btn" data-act="read" title="Read selection or clipboard">Read</button>
          <button type="button" data-act="back" title="Previous sentence"><span class="ic" aria-hidden="true">↩</span></button>
          <button type="button" data-act="pause" title="Pause"><span class="ic" aria-hidden="true">⏸</span></button>
          <button type="button" data-act="resume" title="Play"><span class="ic" aria-hidden="true">▶</span></button>
          <button type="button" data-act="forward" title="Next sentence"><span class="ic" aria-hidden="true">↪</span></button>
          <button type="button" class="close-btn" data-act="close" title="Close toolbar" aria-label="Close">×</button>
        </div>
      </div>
    `;

    cacheRefsFromShadow();
    applyWrapPosition();
    wireDrag();

    if (!wrap.dataset.piperClickWired) {
      wrap.dataset.piperClickWired = '1';
      wrap.addEventListener('click', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        const btn = t.closest('button[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        if (act === 'read') {
          void doRead();
          return;
        }
        if (act === 'close') {
          forcedHidden = true;
          renderBar();
          return;
        }
        if (act === 'back') void sendBg({ type: 'PLAYBACK_BACK' });
        else if (act === 'forward') void sendBg({ type: 'PLAYBACK_FORWARD' });
        else if (act === 'pause') void sendBg({ type: 'PLAYBACK_PAUSE' });
        else if (act === 'resume') void sendBg({ type: 'PLAYBACK_RESUME' });
      });
    }
  }

  async function doRead() {
    if (!readBtn) return;
    let text = getSelectionTrim();
    if (!text) {
      try {
        text = (await navigator.clipboard.readText()).trim();
      } catch {
        /* no clipboard */
      }
    }
    if (!text) {
      if (metaEl) {
        metaEl.textContent = 'Select text';
        setTimeout(() => renderBar(), 1200);
      }
      return;
    }
    readBtn.disabled = true;
    const res = await sendBg({ type: 'SYNTHESIZE_TEXT', text });
    readBtn.disabled = false;
    if (!res?.ok && metaEl) {
      metaEl.textContent = 'Failed';
      setTimeout(() => renderBar(), 1400);
    }
  }

  function purgeDuplicateHosts() {
    const nodes = document.querySelectorAll(`#${HOST_ID}`);
    for (let i = 1; i < nodes.length; i++) {
      try {
        nodes[i].remove();
      } catch {
        /* ignore */
      }
    }
  }

  function ensureHost() {
    purgeDuplicateHosts();
    const existing = document.getElementById(HOST_ID);
    if (existing && existing.getAttribute('data-piper-read-aloud') === 'float') {
      hostEl = existing;
      shadow = hostEl.shadowRoot;
      if (!shadow) {
        shadow = hostEl.attachShadow({ mode: 'open' });
        installShadowTemplate();
      } else {
        installShadowTemplate();
      }
      return;
    }

    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    hostEl.setAttribute('data-piper-read-aloud', 'float');
    document.documentElement.appendChild(hostEl);
    shadow = hostEl.attachShadow({ mode: 'open' });
    installShadowTemplate();
  }

  /** @param {any} st */
  function mergePlaybackState(st) {
    if (!st) return;
    playbackState = {
      active: !!st.active,
      paused: !!st.paused,
      index: Number(st.index) || 0,
      total: Number(st.total) || 0,
      lostSession: !!st.lostSession
    };
  }

  function renderBar() {
    const hasSel = getSelectionTrim().length > 0;
    const play = playing();

    if (play) forcedHidden = false;
    if (!play && !hasSel) forcedHidden = false;

    if (!shouldShow() || forcedHidden) {
      if (hostEl) {
        hostEl.style.setProperty('display', 'none', 'important');
      }
      return;
    }

    ensureHost();
    if (!hostEl || !wrap || !metaEl || !readBtn || !backBtn || !pauseBtn || !resumeBtn || !forwardBtn || !closeBtn)
      return;

    hostEl.style.removeProperty('display');

    readBtn.disabled = false;

    closeBtn.disabled = play;
    closeBtn.style.visibility = play ? 'hidden' : 'visible';
    closeBtn.style.pointerEvents = play ? 'none' : 'auto';

    backBtn.disabled = !play;
    forwardBtn.disabled = !play;
    pauseBtn.disabled = !play || playbackState.paused;
    resumeBtn.disabled = !play || !playbackState.paused;

    if (playbackState.lostSession) {
      metaEl.textContent = 'Piper';
    } else if (playbackState.active && playbackState.total > 0) {
      const cur = Math.min(playbackState.index + 1, playbackState.total);
      metaEl.textContent = `${cur}/${playbackState.total}`;
    } else if (hasSel) {
      metaEl.textContent = 'Sel';
    } else {
      metaEl.textContent = 'Piper';
    }
  }

  /** @param {any} st */
  function applyPlaybackState(st) {
    mergePlaybackState(
      st ?? {
        active: false,
        paused: false,
        index: 0,
        total: 0,
        lostSession: false
      }
    );
    renderBar();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PIPER_FLOAT_STATE') {
      applyPlaybackState(message.state);
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  let selTimer = 0;
  function scheduleSelectionRender() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      renderBar();
    }, 60);
  }

  document.addEventListener('selectionchange', scheduleSelectionRender);
  window.addEventListener('resize', () => {
    if (wrap && hostEl && hostEl.style.display !== 'none') clampWrapToViewport();
  });

  chrome.runtime.sendMessage({ type: 'GET_PLAYBACK_STATE' }, (st) => {
    void chrome.runtime.lastError;
    if (st) mergePlaybackState(st);
    renderBar();
  });
})();
