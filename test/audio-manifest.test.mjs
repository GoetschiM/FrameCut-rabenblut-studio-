import assert from 'node:assert/strict';
import test from 'node:test';
import { audioPreflight, createEpisodeAudioManifest, validateAudioManifest } from '../lib/audio-manifest.mjs';

const shots = [
  { id: 10, sequence: 1, duration_seconds: 4 },
  { id: 11, sequence: 2, duration_seconds: 6 },
];
const dialogue = [
  { id: 3, shot_id: 11, asset_id: 7, sequence: 1, text: 'Wir müssen jetzt los.', voice: 'calm-male' },
  { id: 2, shot_id: 10, asset_id: null, sequence: 1, text: 'Ein neuer Morgen beginnt.' },
];

test('builds deterministic dialogue cues on the episode timeline', () => {
  const manifest = createEpisodeAudioManifest({ ownerId: 1, projectId: 2, episodeId: 3, shots, dialogue });
  assert.equal(manifest.timeline.duration_ms, 10_000);
  assert.equal(manifest.cues.length, 2);
  assert.equal(manifest.cues[0].id, 'dialogue-10-2');
  assert.equal(manifest.cues[0].speaker_role, 'narrator');
  assert.equal(manifest.cues[1].start_ms, 4_350);
  assert.equal(manifest.cues[1].voice_profile_id, 'calm-male');
  assert.deepEqual(validateAudioManifest(manifest), []);
});

test('reports a draft as blocked instead of silently accepting it as a master', () => {
  const manifest = createEpisodeAudioManifest({ ownerId: 1, projectId: 2, episodeId: 3, shots, dialogue });
  const report = audioPreflight(manifest, { expectedSourceRevision: manifest.source_revision, mixingWorkerAvailable: false });
  assert.equal(report.cuesReady, false);
  assert.equal(report.readyForMaster, false);
  assert.match(report.blockers.join(' '), /offen/);
});

test('detects a changed shot or dialogue source revision', () => {
  const manifest = createEpisodeAudioManifest({ ownerId: 1, projectId: 2, episodeId: 3, shots, dialogue });
  const report = audioPreflight(manifest, { expectedSourceRevision: 'different', mixingWorkerAvailable: true });
  assert.equal(report.sourceCurrent, false);
  assert.equal(report.readyForMaster, false);
  assert.match(report.blockers.join(' '), /geändert/);
});
