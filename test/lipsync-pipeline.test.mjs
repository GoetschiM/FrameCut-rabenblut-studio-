import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSceneContract, separateStyle } from '../lib/scene-contract.mjs';
import { createEpisodeAudioManifest, reconcileAudioManifest, validateAudioManifest } from '../lib/audio-manifest.mjs';

const shot = { id: 263, title: 'Portal schliesst', prompt: 'Rick zieht den Hebel und erklärt Morty etwas.', camera: 'Totale', seed: 1, duration_seconds: 5, audio_direction_json: '{}', dialogue_lines: [] };
const rick = { id: 152, name: 'Rick', kind: 'character', summary: 'Wahnsinniger Wissenschaftler, der Morty instrumentalisiert.', visual_notes: 'Rick hat zerzaustes blaues Haar.', photos: [{ sha256: 'a', downloadUrl: '/a' }] };

test('generated English tags and action text never change the review fingerprint', () => {
  const plain = buildSceneContract({ shot, style: 'cel-shaded', references: [rick] });
  const tagged = buildSceneContract({ shot: { ...shot, prompt_en: 'Rick pulls the lever; everyone keeps their mouth closed.' }, style: 'cel-shaded', references: [{ ...rick, visual_tags: 'elderly scientist, spiky light-blue hair' }] });
  assert.equal(tagged.fingerprint, plain.fingerprint);
});

test('video prompt prefers English action and tags over German prose and story summaries', () => {
  const contract = buildSceneContract({ shot: { ...shot, prompt_en: 'Rick pulls the lever.' }, style: 'cel-shaded', references: [{ ...rick, visual_tags: 'spiky light-blue hair, white lab coat' }] });
  assert.match(contract.prompt, /Rick pulls the lever\./);
  assert.match(contract.prompt, /spiky light-blue hair/);
  assert.doesNotMatch(contract.prompt, /erklärt Morty/);
  assert.doesNotMatch(contract.prompt, /instrumentalisiert/);
  assert.equal(contract.references[0].visual_tags, 'spiky light-blue hair, white lab coat');
});

test('story summary stays out of the video prompt even without tags', () => {
  const contract = buildSceneContract({ shot, style: 'cel-shaded', references: [rick] });
  assert.match(contract.prompt, /zerzaustes blaues Haar/);
  assert.doesNotMatch(contract.prompt, /instrumentalisiert/);
});

test('style sentences describing the look survive a set word; pure set sentences are removed', () => {
  const kept = separateStyle('Cinematic animation, cel-shaded look and warm tungsten garage light. A red Tesla parks in the garage.');
  assert.match(kept.text, /cel-shaded look/);
  assert.deepEqual(kept.excluded, ['A red Tesla parks in the garage.']);
});

const shots = firstDuration => [
  { id: 1, sequence: 1, duration_seconds: firstDuration, audio_direction_json: '{"mode":"external","ambience":"Summen"}' },
  { id: 2, sequence: 2, duration_seconds: 6 },
];
const dialogue = [
  { id: 10, shot_id: 1, sequence: 1, asset_id: 5, text: 'Der Würfel reagiert nur auf ehrliche Antworten.', voice: 'Rick' },
  { id: 11, shot_id: 2, sequence: 1, asset_id: 6, text: 'Ich habe Angst.', voice: 'Morty' },
];
const rendered = firstDuration => {
  const manifest = createEpisodeAudioManifest({ ownerId: 1, projectId: 1, episodeId: 1, shots: shots(firstDuration), dialogue });
  for (const cue of manifest.cues) { cue.state = 'ready'; cue.artifact = { path: `data/uploads/${cue.id}.wav` }; }
  manifest.cues.push({ id: 'auto-music-bed', kind: 'music', state: 'ready', start_ms: 0, target_duration_ms: manifest.timeline.duration_ms, gain_db: -22, prompt: 'music', artifact: { path: 'data/uploads/music.wav' } });
  return manifest;
};

test('a lip-sync trim keeps every rendered cue, moves later lines and keeps spoken length', () => {
  const saved = rendered(6);
  const result = reconcileAudioManifest(createEpisodeAudioManifest({ ownerId: 1, projectId: 1, episodeId: 1, shots: shots(4.5), dialogue }), saved);
  for (const cue of result.cues) assert.equal(cue.state, 'ready', cue.id);
  const before = saved.cues.find(c => c.id === 'dialogue-2-11'), after = result.cues.find(c => c.id === 'dialogue-2-11');
  assert.equal(after.start_ms, before.start_ms - 1500);
  assert.equal(after.target_duration_ms, before.target_duration_ms);
  assert.equal(result.cues.find(c => c.id === 'auto-music-bed').target_duration_ms, result.timeline.duration_ms);
  assert.deepEqual(validateAudioManifest(result), []);
});

test('changed dialogue text still forces a new voice recording', () => {
  const saved = rendered(6);
  const changed = dialogue.map(line => line.id === 10 ? { ...line, text: 'Ein ganz anderer Satz.' } : line);
  const result = reconcileAudioManifest(createEpisodeAudioManifest({ ownerId: 1, projectId: 1, episodeId: 1, shots: shots(6), dialogue: changed }), saved);
  assert.notEqual(result.cues.find(c => c.id === 'dialogue-1-10').state, 'ready');
  assert.equal(result.cues.find(c => c.id === 'dialogue-2-11').state, 'ready');
});
