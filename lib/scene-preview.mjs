import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Only this shot's approved external tracks. Never reuse native model audio or
// episode music here; the music bed belongs to the final episode mix.
export function scenePreviewTracks(cues, shotId, startMs, resolveMedia) {
  const relevant = cues.filter(c => String(c.shot_id) === String(shotId)
    && ['dialogue', 'narration', 'sfx', 'ambience'].includes(c.kind) && c.state !== 'skipped');
  const ready = relevant.filter(c => c.state === 'ready' && c.artifact?.path && existsSync(resolveMedia(c.artifact.path)));
  return { missing: relevant.filter(c => !ready.includes(c)).map(c => c.id), tracks: ready.map(c => ({
    id: c.id, path: resolveMedia(c.artifact.path), offsetMs: Math.max(0, Math.round(Number(c.start_ms) - startMs)),
    durationMs: Number(c.target_duration_ms), gainDb: Number(c.gain_db || 0),
  })) };
}

export function scenePreviewArgs(video, output, duration, tracks) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw new Error('Ungültige Szenendauer.');
  if (!tracks.length || tracks.length > 64) throw new Error('Keine fertigen Szenenspuren vorhanden oder zu viele Spuren.');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', video];
  for (const t of tracks) args.push('-i', t.path);
  const filters = [`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[base]`];
  tracks.forEach((t, i) => {
    if (![t.offsetMs, t.durationMs, t.gainDb].every(Number.isFinite) || t.offsetMs < 0 || t.durationMs <= 0 || Math.abs(t.gainDb) > 60) throw new Error('Ungültige Audio-Zeit oder Lautstärke.');
    filters.push(`[${i + 1}:a]aresample=48000,atrim=duration=${t.durationMs / 1000},asetpts=PTS-STARTPTS,volume=${t.gainDb}dB,adelay=${t.offsetMs}:all=1[a${i}]`);
  });
  filters.push(`[base]${tracks.map((_, i) => `[a${i}]`).join('')}amix=inputs=${tracks.length + 1}:normalize=0:duration=longest,alimiter=limit=0.95:latency=1[mix]`);
  return [...args, '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart', output];
}

const pending = new Map();
export async function createScenePreview({ video, tracks, duration, directory, ownerId, shotId, revision }) {
  const identity = path => { const s = statSync(path); return [path, s.size, s.mtimeMs]; };
  const hash = createHash('sha256').update(JSON.stringify({ version: 1, ownerId, shotId, revision, video: identity(video), duration,
    tracks: tracks.map(t => ({ ...t, file: identity(t.path) })) })).digest('hex').slice(0, 24);
  const name = `scene-audition-${ownerId}-${shotId}-${hash}.mp4`, output = join(directory, name);
  if (existsSync(output)) return name;
  if (pending.has(output)) return pending.get(output);
  if (pending.size >= 2) throw new Error('Zwei Tonvorschauen werden gerade erstellt. Bitte gleich erneut versuchen.');
  const work = (async () => {
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `scene-audition-${randomUUID()}.tmp.mp4`);
    try {
      const args = scenePreviewArgs(video, temporary, duration, tracks);
      await new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args, { windowsHide: true });
        let errors = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('Tonvorschau hat das Zeitlimit erreicht.')); }, 120_000);
        child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-1000); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Tonvorschau fehlgeschlagen: ${errors}`)); });
      });
      await rename(temporary, output);
      return name;
    } finally { await rm(temporary, { force: true }); }
  })();
  pending.set(output, work);
  try { return await work; } finally { pending.delete(output); }
}
