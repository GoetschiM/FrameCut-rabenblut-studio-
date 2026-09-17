# Audio Pipeline Contract (v1)

This document defines the smallest stable boundary between the application, the
queue, an audio worker, and the final exporter.  It is deliberately independent
of a particular project, TTS engine, sound library, or filesystem layout.

The contract is an implementation guide, not an instruction to enable audio in
the UI.  A producer should create a manifest only after its video timeline is
known.  A worker may render one cue at a time.  The mixer may use only cues in
state `ready` (or explicitly approved `skipped` cues); no generated video audio
is part of this contract.

## Ownership and lifecycle

Every audio job carries `owner_id`, `project_id`, `episode_id`, and, where
applicable, `shot_id` and `cue_id`.  The server must derive ownership from the
authenticated session, rather than trust a worker-supplied owner.  Workers poll
and report through the existing authenticated queue protocol.

The queue job types are:

| Type | Input | Successful result |
| --- | --- | --- |
| `tts_cue` | One dialogue or narration cue | A normalized cue artifact |
| `audio_sfx` | One SFX or ambience cue | A normalized cue artifact |
| `audio_music` | One music cue | A normalized cue artifact |
| `episode_mix` | A validated cue manifest and video timeline | Master MP4, cue manifest, and SRT when speech is present |

Jobs must use an idempotency key.  A useful key is a hash of the job type,
episode ID, cue ID (if any), source revision, and renderer settings.  A retry
may resume a `rendering` job after its lease expires, but it must reuse an
existing verified artifact for a `ready` job.  Failed jobs require an explicit
retry action; a worker should continue polling after reporting the failure.

## Cue manifest

The manifest is JSON with the following shape.  IDs are opaque application
identifiers, not filenames.

```json
{
  "schema_version": 1,
  "owner_id": "user-opaque-id",
  "project_id": "project-opaque-id",
  "episode_id": "episode-opaque-id",
  "timeline": {
    "duration_ms": 10000,
    "sample_rate_hz": 48000,
    "channels": 2
  },
  "cues": [
    {
      "id": "cue-001",
      "kind": "narration",
      "state": "ready",
      "start_ms": 500,
      "target_duration_ms": 1800,
      "gain_db": 0,
      "speaker_role": "narrator",
      "text": "A short spoken line.",
      "source_job_id": "job-opaque-id",
      "artifact": {
        "path": "audio/cues/cue-001.wav",
        "sha256": "optional-lowercase-sha256"
      }
    }
  ]
}
```

`kind` is one of `dialogue`, `narration`, `sfx`, `music`, or `ambience`.
`state` is one of `pending`, `rendering`, `ready`, `failed`, or `skipped`.
All times use integer milliseconds on the episode timeline.  Cue overlaps are
valid and intentional.  A cue must fit entirely inside `timeline.duration_ms`.

`dialogue` and `narration` require non-empty `text` and `speaker_role`.  SFX,
music, and ambience require either a non-empty `prompt` (for generation) or an
artifact (for an uploaded/reused source).  A `ready` cue always requires an
artifact.  Artifact paths are relative to the episode export directory and may
not be absolute or contain `..`; this keeps a queue payload from selecting an
arbitrary worker file.

The optional `source_job_id`, `shot_id`, `asset_id`, and `voice_profile_id`
retain provenance without coupling the contract to a particular database.  A
rendered artifact should be WAV/PCM during mixing.  A worker records its actual
format and checksum alongside the artifact if the storage layer supports it.

## Rendering and mix requirements

1. Renderers accept only job JSON plus explicit configuration.  They must not
   embed title-specific dialogue, paths, endpoints, or voice names in code.
2. Each renderer has a timeout, captures stdout/stderr to a job log, and reports
   a concise error code plus safe message.  Secrets and complete provider URLs
   never enter job logs or manifests.
3. Normalize all mix inputs to 48 kHz stereo before alignment.  Delay each cue
   to `start_ms`, trim it to its target duration as needed, and keep dialogue
   intelligible by ducking music/ambience under speech.
4. Apply final loudness normalization and a true-peak limiter.  The exact target
   can be configurable; the initial operational ceiling is -1 dBTP.
5. Build SRT from the final, successfully used dialogue/narration cues in
   timeline order.  Prefer an MP4 `mov_text` subtitle stream.  Burned subtitles
   are optional and allowed only after detecting FFmpeg `libass` support.
6. The final verification uses `ffprobe`: a master has one video stream and an
   AAC, 48 kHz, stereo audio stream; its duration is within 250 ms of the video
   timeline.  An SRT and the exact manifest used for the mix are retained as
   export artifacts.

## Safe rollout checkpoints

1. Store and validate manifests before adding queue handling.
2. Add `tts_cue` and resume/idempotency behavior, then test a worker restart.
3. Add the deterministic `episode_mix` and SRT/mux fallback.
4. Run an end-to-end two-clip, three-line test episode through the authenticated
   queue.  Verify streams, duration, manifest, subtitles, and a failed TTS
   service that does not block the next job.
5. Only then expose a production audio action.  SFX, ambience, and score
   previews/freigabe are a later expansion of the same contract.

## Local validation

Validate a manifest before it is queued or mixed:

```powershell
node .\scripts\validate-audio-manifest.mjs .\episode-audio-manifest.json
```

`docs/audio-manifest.example.json` is a minimal valid input (its referenced WAV
is intentionally not included, so do not use `--check-artifacts` against it).

Add `--check-artifacts` when the artifact paths are available below the manifest
directory.  The helper checks schema and path safety; it does not call a TTS
provider, FFmpeg, or mutate files.  Its built-in regression cases run with:

```powershell
node .\scripts\validate-audio-manifest.mjs --self-test
```
