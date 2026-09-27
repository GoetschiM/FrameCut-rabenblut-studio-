# Speech quality and all-episode production

Release target: 2026.09.27.5. Deployment and batch completion must be checked live.

## Speech

- Local default: Qwen 1.7B VoiceDesign. Explicit worker configuration still wins.
- Age, timbre and performance directions enter synthesis; no artificial emotional time stretching.
- Long utterances extend their shot. A fixed VoiceDesign seed reduces variation but does NOT guarantee identical timbre across texts. Approved voice cloning remains a future improvement.
- Optional ElevenLabs Free integration: Settings → Stimmen · lokal / ElevenLabs. Per-user encrypted API key and per-character/narrator voice IDs; blank key keeps the existing key.
- Quota is checked before synthesis; paid tiers deliberately rejected in this initial free-only integration. No automatic purchase or top-up. Cached successful lines avoid repeat synthesis.
- Explicit opt-in permits local fallback only on quota exhaustion. Provider/network/auth errors do not silently switch voices. Fallback is marked on the audio track and activity log. Voice changes can be audible.
- No ElevenLabs live test without a user-provided key. Mocked provider tests are not audio-quality verification.

## Rebuild

The maintenance command requires FRAMECUT_REBUILD_CONFIRM=REBUILD_ALL_EXISTING and FRAMECUT_REBUILD_USER_ID. It refuses an existing waiting/running queue, snapshots SQLite, and processes existing episodes. An empty story is skipped. Stories, cast photos, styles, and media files remain intact.

DeepSeek prepares the plan before a transactional storyboard replacement; a malformed plan rolls back rather than deleting the old storyboard. New audio, missing references, and final-tier videos are queued. Each episode automatically mixes and exports after its tracks and clips finish. Exports bypass manual visual approval only as clearly labelled TESTEXPORT, never as approved final quality.

Runtime report: data/rebuild-USER.json, authenticated GET /api/production-rebuild and Settings → Gesamtlauf prüfen. State queued means PLANNED/QUEUED, not rendered or quality-approved. Failed jobs need inspection; do not blindly restart the entire batch.

## Verification

44 Node tests and 6 Python tests passed locally, including actual HTTP settings/auth/isolation, encrypted storage, quota guards, empty/failed storyboard rollback, two-worker claims, scene provenance, and real FFmpeg mixes.

Two local Gradio VoiceDesign probes produced Leo (4.1s) and Opi (5.2s). These establish runtime generation only; listening/character approval remains necessary. No guarantee of lipsync or emotional quality follows from successful file generation.

## Live handoff

2026-09-27: release .5 published with SHA-256 `8fdfd552d2b29cc0e21d6e51f81b7d4f1e665407b959be508513ea21a6a27d3c`. Laptop automatically updated from .4 and resumed. Real production job 2631 completed and uploaded a 4.455s PCM 48kHz stereo file; job 2632 also completed, extending its shot for the full spoken line. Missing-reference job 2808 completed.

The full rebuild is running as `framecut-rebuild-20260927.service`. Read its report and journal before taking action; do not restart it while active. SQLite snapshots are in `/srv/framecut-data/backups/`, including `rebuild-1790543360742.db`. The original 133 waiting old render jobs were cancelled before the fresh run; no media files were removed. Existing voice profiles for Leo (asset 64) and Opi (asset 81) were clarified for child/older-grandfather timbres and Standard German.

Production authenticated settings/status endpoints and served UI script were verified. ElevenLabs remains unconfigured/local. The Gaming-PC is still `awaiting_runtime` with a stale heartbeat, not an available second renderer. GitHub issue 64 received progress comment 5859886943; it remains open for quality verification.
