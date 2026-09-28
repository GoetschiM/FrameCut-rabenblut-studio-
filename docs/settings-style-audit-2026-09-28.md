# Settings, style and production audit — 2026-09-28

Issue #87 tracks focused settings navigation and voice discovery; #64 remains open for full audio verification.

## Live findings before changes

- Laptop worker .5 online, processing audio. Gaming PC has a stale heartbeat and awaits runtime setup.
- All nine nonempty episodes were replanned on 27 September, 21:10–21:20 UTC: 309 shots. Empty Testing Episode 01 was skipped. None of the new clips had rendered at inspection time. Prior exports are not evidence of the new generation.
- ElevenLabs key works; Free quota 10,000 remaining. Saved account voices include three German-labelled voices (Dobby, Helmut, Grimble), but no character mappings. English-labelled default voices dominated the old unsorted list. Do not assign or spend credits automatically.
- Leo style mixes 3D/Pixar and Ghibli with scene objects; Rabenblut and Testing style bibles contain cast/sets/actions. Preserve style intent while removing conflicting media and scene contents. Keep Michel's realism and Testing Glaswürfel's distinct cel-shaded style; per-episode styles need not match across projects.

## Changes

- Seven settings subpages, inline speech form, auto-load saved voice catalog, native-language/Swiss-accent/search filters, project filter, safe existing preview URLs, preserved choices outside the current filter. No synthetic test generation on opening settings. A Swiss accent is not a promise of Swiss-German dialect support; current scripts remain Standard German.
- Reference visual-note fallback is filtered like appearance tags; never reintroduce a competing style from a portrait's notes. Keyframe prompt explicitly separates identity from rendering medium.
- `normalize-episode-styles.mjs` creates a DB backup, checks there is no active video render, cleans only known legacy bibles and audits all episodes. Does not delete/replan stories or existing media. Pending jobs use current styles when claimed.
- Audio cue payload is stored separately from mutable status text, so retries retain cue identity. Duplicate upload responses are idempotent and cannot turn a completed audio job into a failed one.
- Queue selection groups normal work by episode, preserving voice-preview/caption priority, so all projects' audio no longer starves already-ready episode videos.

## Verification / remaining gates

46 Node tests pass, including auth, settings isolation, filters, retry payload and duplicate uploads, scene contracts and multi-worker claims. Headless Edge checks desktop and 390px mobile, all seven pages, filter/selection preservation and no implicit PUT calls. The UI skill detector reports only a pre-existing width-transition warning outside the changed settings surface.

Two Rabenblut audio tracks failed in the overnight run. The music failure includes a Stable Audio Gradio file-download 403; do not call the music/master pipeline fully verified until this is fixed and heard. Naturalness, lipsync and visual consistency still require inspecting completed new clips; prompt corrections are not a guarantee.
