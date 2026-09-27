import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scenePreviewTracks, scenePreviewArgs, createScenePreview } from '../lib/scene-preview.mjs';

test('scene audition excludes other shots, music, stale and missing artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-audio-scope-'));
  try {
    writeFileSync(join(dir, 'audio.wav'), 'audio');
    const ready = { id: 'line', shot_id: '2', kind: 'dialogue', state: 'ready', start_ms: 5350, target_duration_ms: 1000, artifact: { path: 'audio.wav' } };
    const result = scenePreviewTracks([ready, { ...ready, id: 'other', shot_id: 1 }, { ...ready, id: 'music', kind: 'music' },
      { ...ready, id: 'stale', state: 'pending' }, { ...ready, id: 'lost', artifact: { path: 'lost.wav' } }], 2, 5000, p => join(dir, p));
    assert.deepEqual(result.tracks.map(t => t.id), ['line']);
    assert.equal(result.tracks[0].offsetMs, 350);
    assert.deepEqual(result.missing, ['stale', 'lost']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scene mix keeps video and explicitly maps external audio only', () => {
  const args = scenePreviewArgs('input.mp4', 'output.mp4', 3, [{ path: 'dialogue.wav', offsetMs: 350, durationMs: 1500, gainDb: 0 }]);
  assert.ok(args.includes('0:v:0'));
  assert.ok(args.includes('[mix]'));
  assert.ok(!args.includes('0:a:0'));
  assert.match(args[args.indexOf('-filter_complex') + 1], /adelay=350:all=1/);
  assert.throws(() => scenePreviewArgs('x', 'y', NaN, []));
  assert.throws(() => scenePreviewArgs('x', 'y', 3, [{ path: 'x', offsetMs: NaN, durationMs: 1, gainDb: 0 }]));
});

test('real ffmpeg scene preview is audible, cached and invalidated by timing changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-audio-ffmpeg-'));
  const run = (exe, args) => {
    const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result;
  };
  try {
    const video = join(dir, 'input.mp4'), voice = join(dir, 'voice.wav');
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x96:r=24:d=2', '-c:v', 'libx264', video]);
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', voice]);
    const options = { video, tracks: [{ id: '1', path: voice, offsetMs: 350, durationMs: 1000, gainDb: 0 }], duration: 2, directory: dir, ownerId: 1, shotId: 2, revision: 'a' };
    const [first, duplicate] = await Promise.all([createScenePreview(options), createScenePreview(options)]);
    assert.equal(first, duplicate);
    assert.equal(await createScenePreview(options), first);
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(dir, first)]).stdout);
    assert.ok(probe.streams.some(s => s.codec_type === 'audio'));
    assert.equal(Number(probe.format.duration), 2);
    const volume = run('ffmpeg', ['-i', join(dir, first), '-vn', '-af', 'volumedetect', '-f', 'null', '-']).stderr;
    assert.ok(Number(volume.match(/max_volume: ([\d.-]+)/)?.[1]) > -40, volume);
    const changed = await createScenePreview({ ...options, tracks: [{ ...options.tracks[0], offsetMs: 0 }] });
    assert.notEqual(first, changed);
    assert.ok(existsSync(join(dir, changed)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
