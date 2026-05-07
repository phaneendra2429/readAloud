const CHANNEL = 'OFFSCREEN_AUDIO';

/** @type {AudioContext | null} */
let audioCtx = null;

/** @type {number} */
let metaSampleRate = 22050;

/** @type {number} */
let nextStartTime = 0;

/** @type {Promise<void>} */
let decodeChain = Promise.resolve();

function buildWavFromPcm16Le(pcmBytes, sampleRate, channels = 1) {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(pcmBytes);
  return buffer;
}

async function ensureAudioContext(sampleRate) {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext({ sampleRate });
  }
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
}

function pcmB64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function handlePayload(msg) {
  if (msg.type === 'meta') {
    metaSampleRate = msg.sample_rate;
    await ensureAudioContext(metaSampleRate);
    nextStartTime = audioCtx.currentTime + 0.02;
    decodeChain = Promise.resolve();
    return;
  }

  if (msg.type === 'pcm') {
    decodeChain = decodeChain
      .then(async () => {
        if (!audioCtx) return;
        const pcmBytes = pcmB64ToBytes(msg.b64);
        const wav = buildWavFromPcm16Le(pcmBytes, metaSampleRate, 1);
        const copy = wav.slice(0);
        const decoded = await audioCtx.decodeAudioData(copy);
        const src = audioCtx.createBufferSource();
        src.buffer = decoded;
        src.connect(audioCtx.destination);

        const startAt = Math.max(audioCtx.currentTime, nextStartTime);
        src.start(startAt);
        nextStartTime = startAt + decoded.duration;
      })
      .catch((err) => console.error('[piper-offscreen]', err));
    return;
  }

  if (msg.type === 'done') {
    return;
  }

  if (msg.type === 'error') {
    console.error('[piper-offscreen]', msg.message);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== CHANNEL) return undefined;

  handlePayload(message.payload)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));

  return true;
});
