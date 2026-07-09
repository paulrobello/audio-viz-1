<instructions>
Each idea has a checkbox that can be marked done.
Work each idea on its own feature branch (see /idea-next).
Commit all work after marking an idea done.
</instructions>

# RESOMANCE — Enhancement Ideas (Batch 2)

Ideas for extending the audio-reactive WebGL2 visualizer in `index.html`. The
first batch (playlist, seek bar, bloom, orbit camera, onset detection, palette
editor, PWA, etc.) shipped and is preserved in git history — this list builds on
top of that and intentionally avoids re-suggesting anything already implemented.
Grouped by audio sources, transport, capture, scenes/look, analysis, and
UX/perf/integration. Effort is rough.

## Audio sources
- [ ] **Load audio from a URL or stream** — Accept a pasted URL (or internet-radio stream) in addition to local files, wired via `<audio>` + `MediaElementSource` into the analyser so online tracks and live streams drive the viz without a download. (effort: medium)
- [ ] **Persist the full playlist queue across reloads** — Today only the last single track is cached in IndexedDB; store the whole queue (name + decoded audio) so a dropped folder survives a refresh and resumes at the right position. (effort: medium)

## Transport & playback
- [ ] **Shuffle + repeat (one / all) transport modes** — Add the usual shuffle and repeat-one/repeat-all toggles to the playlist so long sets vary or loop as intended instead of always advancing linearly. (effort: small)
- [ ] **Beat-synced auto-mix** — The scene crossfade currently fires on a fixed timer; snap it to bar/beat boundaries derived from the existing BPM estimate so transitions land on the downbeat and feel musical. (effort: medium)

## Scenes & look
- [ ] **Custom user-shader scene** — Add a 5th scene powered by user-pasted GLSL that receives the same audio uniforms (`u_bass`, `u_mid`, `u_treble`, `u_beat`, `u_snare`, `u_hat`, `palette()`), with compile-error reporting, so anyone can drop in their own fragment shader. (effort: large)
- [ ] **Additional raymarched scene** — Add a new scene such as an audio-reactive particle galaxy or a scrolling frequency-bar terrain to expand the four current fields (Fractal/Tunnel/Plasma/Vortex) and give auto-mix more variety. (effort: large)
- [ ] **Post-FX toggles (vignette / chromatic aberration / film grain)** — Extend the copy/tonemap pass with optional, beat-reactive vignette, chromatic aberration, and film-grain controls in the existing "look" panel for a graded, cinematic finish. (effort: medium)
- [ ] **Per-scene palette memory** — Remember a separate palette choice per scene so switching scenes keeps each one's intended mood, rather than one global palette across all four. (effort: small)

## Audio analysis & reactivity
- [ ] **Auto-gain / reactivity calibration** — Normalize bass/mid/treble against a rolling loudness estimate so both quiet and loud tracks react at full range, instead of today's fixed thresholds under/over-triggering depending on the master level. (effort: medium)
- [ ] **Reactivity router (map kick/snare/hat to visuals)** — The `u_snare`/`u_hat` uniforms are detected but barely wired; add a small mapping UI so users can route kick/snare/hat/bass to chosen visual params (e.g. snare→swirl, hat→glow, kick→shockwave intensity). (effort: medium)

## UX, performance & integration
- [ ] **Named look presets / snapshot slots** — Save and recall the full visual state (scene + palette + look sliders + toggles) into named slots switchable with keys, so polished looks can be queued and recalled during a set. (effort: medium)
- [ ] **Mobile / touch polish** — Make the HUD responsive with larger hit targets, add pinch-to-zoom and two-finger orbit gestures alongside the existing pointer-drag camera, so the viz is usable on phones/tablets, not just desktop Chromium. (effort: medium)
