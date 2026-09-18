# FrameCut

FrameCut is a local-first production system for AI-assisted video episodes. The central
server manages projects, stories, characters, locations, references, prompts, render jobs
and exports. GPU-intensive generation remains on Windows workers connected to Pinokio,
ComfyUI, MiniMax H3 and optional Qwen TTS.

## Repository layout

- `server.mjs`, `public/` — the production web application currently running in the LXC.
- `worker/` — the Windows GPU worker, launchers and bundled MiniMax/ComfyUI/Qwen adapters.
- `deploy/proxmox/` — LXC deployment material.
- `FRAMECUT-HANDBUCH.md` — operating guide captured from production.

No model weights, SQLite databases, uploaded assets, rendered media or credentials belong in
Git. Runtime data is intentionally ignored by `.gitignore`.

## Windows worker

1. Clone this repository on the render machine.
2. Copy `worker/worker.config.example.json` to `worker/data/worker.config.json` and adapt
   the server and Pinokio paths.
3. Provision the worker token through the FrameCut setup flow. It is stored using Windows
   DPAPI in `worker/data/worker-token.dpapi` and must never be committed.
4. Start `worker/FrameCut-Worker.bat`; use `worker/FrameCut-Worker-stoppen.bat` to stop it.

The worker claims jobs serially. A job retains its project, episode, shot and owner metadata,
so multiple users can safely submit work to one GPU queue.

### Audio production

Open an episode's **Audio, Ton & Stimmen** view to review its generated dialogue plan,
choose the narration mode and add score, ambience or SFX cues. **Alle offenen Spuren
rendern** queues one independent cue job per line or sound: Qwen3-TTS generates dialogue and
narration; Stable Audio 3 generates music, ambience and effects. The worker automatically
releases MiniMax H3 before an audio job and starts Stable Audio through Pinokio when needed;
it switches back before the next video job. Once every cue and every video clip is confirmed,
the worker creates a ducked AAC master MP4 and an SRT subtitle export. A master is deliberately
blocked while the picture cut or an individual cue is incomplete, rather than exporting a
silently partial film.

### Local storage lifecycle

Only centrally confirmed uploads are considered final project media. After the server accepts
a video, image, audio preview or audio master, the worker removes its corresponding local job
workspace and the duplicated H3 output. Failed workspaces remain available for diagnosis for
`FailedJobRetentionHours` (default: 168 hours) and are then removed on the worker's next poll.
`MinimumFreeDiskGb` (default: 12 GB) pauses claims for new jobs before the local render disk
becomes full. It never deletes approved keyframes, reference caches or any project media on the
server; those need an explicit project retention/deletion policy.

## Current production baseline

This initial commit is a source snapshot of the FrameCut service running on the Proxmox LXC
on 17 September 2026, plus the local GPU worker and the adapters it needs. It is deliberately
a baseline: follow-up commits should introduce repeatable deployment, tests and a formal media
cleanup policy.
