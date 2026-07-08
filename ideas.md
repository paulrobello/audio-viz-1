<instructions>
Each idea has a checkbox that can be marked done.
Work each idea on its own feature branch (see /idea-next).
Commit all work after marking an idea done.
</instructions>

# RESOMANCE — Enhancement Ideas

Ideas for extending the audio-reactive WebGL2 visualizer in `index.html`. Mix of audio-input, capture, scene/look, transport, performance, and packaging work. Effort is rough.

## Audio sources
- [x] **Playlist & next/previous** — Accept multiple files or a dropped folder, build a queue, and add skip-forward/back controls (and `←`/`→` keys) so a full set can run without manual reloads. (effort: medium)

## Transport & playback
- [x] **Seek bar + elapsed/remaining time** — Show a scrubable progress bar with current/total time for file playback; today audio loops silently with no transport UI. Requires tracking the `BufferSource` playback offset. (effort: medium)
- [x] **Persist scene, palette & ring across reloads** — Volume already persists via `localStorage`; extend it to remember last scene, palette, ring toggle, and idle-hide so reloads resume the exact look. (effort: small)

## Capture & presentation
- [x] **Screenshot hotkey (PNG)** — `S` key grabs the current rendered frame straight off the canvas to a PNG download. (effort: small)
- [x] **Fullscreen mode** — `F` key toggles the Fullscreen API for clean projector/stage presentation. (effort: small)
- [x] **PWA: installable + offline** — Add a web manifest and a tiny service worker so the (already self-contained, dependency-free) app installs and runs fully offline. (effort: medium)
- [ ] **Open Graph / share metadata** — Add OG/Twitter tags and a preview image so links render richly when shared. (effort: small)

## Scenes & look
- [x] **Auto-mix / scene cycling** — Optionally crossfade or cut between scenes on beat boundaries (or a timer) so long sessions stay dynamic. Needs a blend mode in the shader or a smooth lerp between two rendered scenes. (effort: large)
- [x] **Adjustable feedback & look controls** — Expose currently hardcoded constants — feedback decay (`0.90`), swirl angle, glow/zoom — as sliders in a collapsible "look" panel, persisted like volume. (effort: medium)
- [ ] **Bloom post-process pass** — Insert a bright-pass + blur bloom pass between the scene and copy shaders for punchier glow on bright hits, intensified on beats. (effort: large)
- [x] **Custom palette editor** — Let users edit the cosine-palette `a/b/c/d` vectors with color pickers and save their own palette to `localStorage`, beyond the four built-ins. (effort: medium)
- [ ] **Orbit camera for the raymarch scenes** — Mouse-drag to orbit/pan the Fractal (and Tunnel) camera so users can explore the field interactively instead of the fixed auto-camera. (effort: large)

## Audio analysis
- [x] **Onset detection across bands** — Replace the single bass-energy-flux beat detector with spectral-flux onset detection split into kick/snare/hat, feeding distinct uniforms (`u_snare`, `u_hat`) for richer reactivity. (effort: medium)
- [x] **Beat-aware palette shifting** — Bias or rotate the palette based on detected tempo and energy so the mood evolves with the music instead of staying fixed per manual selection. (effort: medium)

## UX, performance & accessibility
- [x] **Render-scale / quality toggle + FPS meter** — Expose a Low/Med/High quality control (DPR cap and raymarch step counts are currently hardcoded) and an optional debug FPS counter so it runs on lower-end GPUs. (effort: medium)
- [x] **`prefers-reduced-motion` mode** — Respect the OS reduced-motion setting by slowing/disabling the heavy swirl, feedback trails, and beat flashes for accessibility. (effort: small)
- [x] **Keyboard cheat-sheet overlay** — `?` opens a clean overlay listing every shortcut (scenes, play/pause, ring, fullscreen, screenshot) since today hints are only in a fading footer. (effort: small)
