// Video recording with audio: canvas.captureStream() (video) + a MediaStreamAudioDestinationNode
// tap off the master gain (audio) → MediaRecorder → downloadable .webm. Complements the still
// PNG screenshot (render.js requestScreenshot). The audio tap mirrors exactly what reaches the
// speakers (master → destination + master → recDest), so the clip has sound at the live volume.
import { audio, ensureCtx } from './audio.js';
import { emit } from './state.js';

/** @type {{ recorder: MediaRecorder, dest: MediaStreamAudioDestinationNode, chunks: Blob[] } | null} */
let rec = null;

export function isRecording() { return !!rec; }

export function toggleRecording() { return rec ? stopRecording() : startRecording(); }

function startRecording() {
  ensureCtx();
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('gl'));
  if (!canvas || !canvas.captureStream || !window.MediaRecorder || !audio.ctx || !audio.master) { emit('transport', { type: 'toast', msg: 'recording not supported here' }); return; }
  try {
    const vstream = canvas.captureStream(30);
    const dest = audio.ctx.createMediaStreamDestination();
    audio.master.connect(dest);                                                 // tap the post-volume signal for the clip's audio
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const chunks = [];
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      try { audio.master.disconnect(dest); } catch (_) {}                       // remove the audio tap
      const blob = new Blob(chunks, { type: 'video/webm' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'resomance-' + Date.now() + '.webm'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      emit('transport', { type: 'toast', msg: 'recording saved' });
    };
    recorder.start(1000);   // gather a chunk every second so a crash still yields a file
    rec = { recorder, dest, chunks };
    emit('transport', { type: 'toast', msg: 'recording started' });
    emit('transport', { type: 'recState', on: true });
  } catch (e) {
    emit('transport', { type: 'toast', msg: 'could not start recording' });
  }
}

function stopRecording() {
  if (!rec) return;
  try { rec.recorder.stop(); } catch (_) {}
  rec = null;
  emit('transport', { type: 'recState', on: false });
}
