<instructions>
Each idea has a checkbox that can be marked done.
Work each idea on its own feature branch (see /idea-next).
Commit all work after marking an idea done.
</instructions>

# RESOMANCE — Enhancement Ideas (Batches 2–3)

Ideas for extending the audio-reactive WebGL2 visualizer in `index.html`. The
first batch (playlist, seek bar, bloom, orbit camera, onset detection, palette
editor, PWA, etc.) shipped and is preserved in git history. Batch 2 below also
shipped (all checked) and is kept as a record. Batch 3 is the current open work
and intentionally avoids re-suggesting anything already implemented. Effort is
rough.

## Batch 2 — shipped (record only)

### Audio sources
- [x] **Load audio from a URL or stream** — Accept a pasted URL (or internet-radio stream) in addition to local files, wired via `<audio>` + `MediaElementSource` into the analyser so online tracks and live streams drive the viz without a download. (effort: medium)
- [x] **Persist the full playlist queue across reloads** — Today only the last single track is cached in IndexedDB; store the whole queue (name + decoded audio) so a dropped folder survives a refresh and resumes at the right position. (effort: medium)

### Transport & playback
- [x] **Shuffle + repeat (one / all) transport modes** — Add the usual shuffle and repeat-one/repeat-all toggles to the playlist so long sets vary or loop as intended instead of always advancing linearly. (effort: small)
- [x] **Beat-synced auto-mix** — The scene crossfade currently fires on a fixed timer; snap it to bar/beat boundaries derived from the existing BPM estimate so transitions land on the downbeat and feel musical. (effort: medium)

### Scenes & look
- [x] **Custom user-shader scene** — Add a 5th scene powered by user-pasted GLSL that receives the same audio uniforms (`u_bass`, `u_mid`, `u_treble`, `u_beat`, `u_snare`, `u_hat`, `palette()`), with compile-error reporting, so anyone can drop in their own fragment shader. (effort: large)
- [x] **Additional raymarched scene** — Add a new scene such as an audio-reactive particle galaxy or a scrolling frequency-bar terrain to expand the four current fields (Fractal/Tunnel/Plasma/Vortex) and give auto-mix more variety. (effort: large)
- [x] **Post-FX toggles (vignette / chromatic aberration / film grain)** — Extend the copy/tonemap pass with optional, beat-reactive vignette, chromatic aberration, and film-grain controls in the existing "look" panel for a graded, cinematic finish. (effort: medium)
- [x] **Per-scene palette memory** — Remember a separate palette choice per scene so switching scenes keeps each one's intended mood, rather than one global palette across all four. (effort: small)

### Audio analysis & reactivity
- [x] **Auto-gain / reactivity calibration** — Normalize bass/mid/treble against a rolling loudness estimate so both quiet and loud tracks react at full range, instead of today's fixed thresholds under/over-triggering depending on the master level. (effort: medium)
- [x] **Reactivity router (map kick/snare/hat to visuals)** — The `u_snare`/`u_hat` uniforms are detected but barely wired; add a small mapping UI so users can route kick/snare/hat/bass to chosen visual params (e.g. snare→swirl, hat→glow, kick→shockwave intensity). (effort: medium)

### UX, performance & integration
- [x] **Named look presets / snapshot slots** — Save and recall the full visual state (scene + palette + look sliders + toggles) into named slots switchable with keys, so polished looks can be queued and recalled during a set. (effort: medium)
- [x] **Mobile / touch polish** — Make the HUD responsive with larger hit targets, add pinch-to-zoom and two-finger orbit gestures alongside the existing pointer-drag camera, so the viz is usable on phones/tablets, not just desktop Chromium. (effort: medium)

## Batch 3 — open

### Audio sources & input
- [ ] **Live microphone / line-in input** — Add `getUserMedia` as a fourth source feeding the analyser, so the viz reacts to a mic, instrument, or loopback system-audio capture in real time — turning RESOMANCE into a live-performance rig, not just a file player. (effort: medium)

### Capture & output
- [ ] **Video recording with audio (WebM export)** — Wire `canvas.captureStream()` plus a `MediaStreamAudioDestinationNode` track into a `MediaRecorder` so users can record a clip of the visualization *with sound* and download a `.webm`, complementing the existing still `S` screenshot. (effort: large)
- [ ] **Second-window / projection output** — Open a clean, fullscreen, UI-free copy of the canvas in a separate window (synced over `BroadcastChannel`) so a VJ can control the look from the main window while projecting the pristine viz to a second monitor or projector. (effort: large)

### Audio analysis & reactivity
- [ ] **Mel-spaced spectrum + chromagram / key detection** — Replace the linear FFT band split with perceptual (mel/log) binning and add a chroma vector + key estimate, so palette and scene choices can follow the song's actual harmonic content and key instead of only bass/mid/treble energy. (effort: large)
- [ ] **Beat-grid / beat-phase tracking** — Promote the raw BPM estimate into a running beat-phase (0..1 across the bar) exposed as a `u_beatPhase` uniform, so scenes can anticipate and pulse on the downbeat rather than only reacting after the onset fires. (effort: medium)

### Playback & library
- [ ] **A-B loop / cue points** — Let users mark in/out points to loop a section, plus drop per-track cue markers on the seek bar, for rehearsing or looping specific drops instead of whole-track linear playback. (effort: small)
- [ ] **Waveform overview scrubber** — Decode each track's PCM once and downsample it into a mini waveform drawn on the seek bar, so the bar shows the track's energy/structure (drops, breaks) instead of a bare progress line. (effort: medium)
- [ ] **ID3 metadata + album-art palette tint** — Read ID3v2 tags (title/artist/artwork) from loaded files, surface them in the HUD, and optionally derive a palette from the cover art so the viz inherits the album's mood automatically. (effort: medium)
- [ ] **Per-track look binding** — Tie a look preset (scene + palette + look + router) to a specific track or URL so loading it auto-recalls its intended visual, falling back to the global preset for unbound tracks. (effort: small)
- [ ] **Crossfade between tracks** — Overlap the outgoing and incoming audio (and optionally crossfade the scene) on track change for seamless DJ-style transitions, instead of the current hard cut at `onTrackEnd`. (effort: medium)

### Scenes & look
- [x] **Per-scene look params** — Extend per-scene memory from palette alone to the full look-slider set (feedback / swirl / glow / vignette / chroma / grain), so each scene keeps its own tuned feel rather than sharing one global look. (effort: small)
- [ ] **Audio-reactive particle / galaxy scene (7th scene)** — Add a GPU-instanced particle field (star swirl / galaxy) driven by the spectrum texture, giving auto-mix a distinctly different aesthetic alongside the raymarched scenes. (effort: large)

### UX & platform
- [x] **Hotkeys for palette + reactivity router** — Add keyboard shortcuts to cycle palettes and nudge router mappings without opening the look panel, rounding out the existing scene/preset hotkeys for fast live tweaking. (effort: small)
