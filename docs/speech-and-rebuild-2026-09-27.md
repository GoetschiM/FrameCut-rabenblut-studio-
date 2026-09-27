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
