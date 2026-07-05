# Grok Media Studio — UI Kit (implemented)

A self-contained, **no-build** implementation of the `grok-media-studio` design
handoff. Open `index.html` directly (double-click / `file://`) — no server, no
bundler, no transpile step. Pick a mode, edit the prompt, add references, change
settings, press **Generate**, watch the fake job run into the gallery, then
scroll — the composer docks into a compact-but-complete sticky bar.

## What it is
- `index.html` — the whole app, self-contained: both stylesheets and all seven
  components inlined. Each component is delimited by an `<!-- File.jsx -->` banner
  so it stays liftable into a real build.
- `vendor/` — production React 18.3.1 + ReactDOM, vendored locally (no CDN).
- `assets/media/` — sample outputs (`m1–m12`) and references (`ref1–5`).

## How this differs from the design-tool prototype
The prototype was an in-browser React + **Babel-standalone** setup loading seven
separate `.jsx` files. This implementation keeps the component logic byte-for-byte
but ships it as production-ready static files:

1. **Babel dropped.** The `.jsx` files contained **no JSX** — they're pure
   `React.createElement` calls — so in-browser transpilation was dead weight.
   Components now run as plain classic `<script>` blocks.
2. **Production React, vendored.** Swapped the dev UMD builds (and their
   SRI hashes, which were pinned to the dev bundles) for production builds served
   from `vendor/` — fully offline, matching this repo's local-first, no-build style.
3. **Stylesheets inlined.** `colors_and_type.css` (tokens) + `styles.css` (kit) are
   inlined into one `<style>`, removing the dangling `../../colors_and_type.css`
   reference.
4. **Fixed a crash.** `Gallery` filtered on `it.name`, but no gallery item has a
   `name` field — the first search keystroke threw and blanked the app. Guarded as
   `(it.name || "")`.

## Known dependency
Fonts (Inter + Geist Mono) load via a Google Fonts `@import`, so pixel-perfect
type needs a network connection; offline it falls back to system fonts and drifts
slightly. Vendor the fonts locally if fully-offline type fidelity matters.

## Regenerating
`index.html` was assembled programmatically from the design sources (no retyping).
The original modular sources live in the design bundle under
`project/ui_kits/grok-media-studio/`.
