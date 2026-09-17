#!/usr/bin/env node
/**
 * Validate the versioned, project-neutral audio cue-manifest contract.
 *
 * This helper is intentionally dependency-free and read-only. It validates
 * shape, timeline safety, and (optionally) existing artifact paths. It does
 * not invoke an audio provider, FFmpeg, or write media.
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KINDS = new Set(['dialogue', 'narration', 'sfx', 'music', 'ambience']);
const STATES = new Set(['pending', 'rendering', 'ready', 'failed', 'skipped']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validId(value) {
  return nonEmptyString(value) && ID_RE.test(value);
}

function integerAtLeast(value, minimum) {
  return Number.isInteger(value) && value >= minimum;
}

function isSafeRelativePath(value) {
  if (!nonEmptyString(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.replaceAll('\\', '/').split('/');
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function validateManifest(manifest) {
  const errors = [];
  const add = (location, message) => errors.push(`${location}: ${message}`);
  if (!isObject(manifest)) return ['root: must be a JSON object'];

  if (manifest.schema_version !== 1) add('schema_version', 'must be 1');
  for (const key of ['owner_id', 'project_id', 'episode_id']) {
    if (!validId(manifest[key])) add(key, 'must be a non-empty opaque identifier');
  }

  const timeline = manifest.timeline;
  if (!isObject(timeline)) {
    add('timeline', 'must be an object');
  } else {
    if (!integerAtLeast(timeline.duration_ms, 1)) add('timeline.duration_ms', 'must be a positive integer');
    if (timeline.sample_rate_hz !== 48000) add('timeline.sample_rate_hz', 'must be 48000');
    if (timeline.channels !== 2) add('timeline.channels', 'must be 2 (stereo)');
  }

  if (!Array.isArray(manifest.cues)) {
    add('cues', 'must be an array');
    return errors;
  }

  const cueIds = new Set();
  manifest.cues.forEach((cue, index) => {
    const location = `cues[${index}]`;
    if (!isObject(cue)) {
      add(location, 'must be an object');
      return;
    }
    if (!validId(cue.id)) add(`${location}.id`, 'must be a non-empty identifier');
    else if (cueIds.has(cue.id)) add(`${location}.id`, 'must be unique');
    else cueIds.add(cue.id);

    if (!KINDS.has(cue.kind)) add(`${location}.kind`, `must be one of ${[...KINDS].join(', ')}`);
    if (!STATES.has(cue.state)) add(`${location}.state`, `must be one of ${[...STATES].join(', ')}`);
    if (!integerAtLeast(cue.start_ms, 0)) add(`${location}.start_ms`, 'must be an integer >= 0');
    if (!integerAtLeast(cue.target_duration_ms, 1)) add(`${location}.target_duration_ms`, 'must be a positive integer');
    if (cue.gain_db !== undefined && (typeof cue.gain_db !== 'number' || !Number.isFinite(cue.gain_db))) {
      add(`${location}.gain_db`, 'must be a finite number when supplied');
    }
    if (timeline?.duration_ms && integerAtLeast(cue.start_ms, 0) && integerAtLeast(cue.target_duration_ms, 1)
      && cue.start_ms + cue.target_duration_ms > timeline.duration_ms) {
      add(location, 'must fit inside timeline.duration_ms');
    }

    const isSpeech = cue.kind === 'dialogue' || cue.kind === 'narration';
    if (isSpeech && !nonEmptyString(cue.text)) add(`${location}.text`, 'is required for dialogue and narration');
    if (isSpeech && !validId(cue.speaker_role)) add(`${location}.speaker_role`, 'is required for dialogue and narration');
    const needsSource = cue.kind === 'sfx' || cue.kind === 'music' || cue.kind === 'ambience';
    if (needsSource && !nonEmptyString(cue.prompt) && !isObject(cue.artifact)) {
      add(location, 'requires prompt or artifact for sfx, music, or ambience');
    }

    if (cue.artifact !== undefined) {
      if (!isObject(cue.artifact)) add(`${location}.artifact`, 'must be an object');
      else {
        if (!isSafeRelativePath(cue.artifact.path)) add(`${location}.artifact.path`, 'must be a safe relative path');
        if (cue.artifact.sha256 !== undefined && (!nonEmptyString(cue.artifact.sha256) || !SHA256_RE.test(cue.artifact.sha256))) {
          add(`${location}.artifact.sha256`, 'must be a lowercase SHA-256 hex digest when supplied');
        }
      }
    }
    if (cue.state === 'ready' && (!isObject(cue.artifact) || !isSafeRelativePath(cue.artifact.path))) {
      add(`${location}.artifact`, 'is required for a ready cue');
    }
  });
  return errors;
}

async function checkArtifactPaths(manifest, baseDir) {
  const errors = [];
  for (const [index, cue] of manifest.cues.entries()) {
    const artifactPath = cue?.artifact?.path;
    if (cue?.state !== 'ready' || !isSafeRelativePath(artifactPath)) continue;
    try {
      await access(path.resolve(baseDir, artifactPath));
    } catch {
      errors.push(`cues[${index}].artifact.path: ready artifact does not exist below manifest directory`);
    }
  }
  return errors;
}

function sampleManifest() {
  return {
    schema_version: 1,
    owner_id: 'owner-1',
    project_id: 'project-1',
    episode_id: 'episode-1',
    timeline: { duration_ms: 10_000, sample_rate_hz: 48_000, channels: 2 },
    cues: [{
      id: 'cue-1', kind: 'narration', state: 'ready', start_ms: 500,
      target_duration_ms: 1_000, gain_db: 0, speaker_role: 'narrator', text: 'Example.',
      artifact: { path: 'audio/cue-1.wav' },
    }],
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function selfTest() {
  assert(validateManifest(sampleManifest()).length === 0, 'valid manifest must pass');
  const traversal = sampleManifest();
  traversal.cues[0].artifact.path = '../outside.wav';
  assert(validateManifest(traversal).some(error => error.includes('safe relative path')), 'path traversal must fail');
  const overflow = sampleManifest();
  overflow.cues[0].start_ms = 9_500;
  overflow.cues[0].target_duration_ms = 1_000;
  assert(validateManifest(overflow).some(error => error.includes('fit inside')), 'timeline overflow must fail');
  const speech = sampleManifest();
  speech.cues[0].text = '';
  assert(validateManifest(speech).some(error => error.includes('.text')), 'speech without text must fail');
  const duplicate = sampleManifest();
  duplicate.cues.push({ ...duplicate.cues[0] });
  assert(validateManifest(duplicate).some(error => error.includes('unique')), 'duplicate cue ID must fail');
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') {
    await selfTest();
    console.log('Audio manifest validator self-test passed.');
    return 0;
  }
  const checkArtifacts = argv[0] === '--check-artifacts';
  const manifestPath = checkArtifacts ? argv[1] : argv[0];
  if (!manifestPath || argv.length !== (checkArtifacts ? 2 : 1)) {
    console.error('Usage: node scripts/validate-audio-manifest.mjs [--check-artifacts] <manifest.json>');
    return 2;
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`Cannot read JSON manifest: ${error.message}`);
    return 2;
  }
  const errors = validateManifest(manifest);
  if (checkArtifacts && errors.length === 0) {
    errors.push(...await checkArtifactPaths(manifest, path.dirname(path.resolve(manifestPath))));
  }
  if (errors.length > 0) {
    console.error(`Audio manifest invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):`);
    errors.forEach(error => console.error(`- ${error}`));
    return 1;
  }
  console.log(`Audio manifest valid: ${manifest.cues.length} cue(s), ${manifest.timeline.duration_ms} ms timeline.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
