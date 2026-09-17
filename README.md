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

## Current production baseline

This initial commit is a source snapshot of the FrameCut service running on the Proxmox LXC
on 17 September 2026, plus the local GPU worker and the adapters it needs. It is deliberately
a baseline: follow-up commits should introduce repeatable deployment, tests and a formal media
cleanup policy.
