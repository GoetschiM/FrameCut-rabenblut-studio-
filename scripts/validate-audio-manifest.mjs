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
import { isSafeRelativePath, validateAudioManifest } from '../lib/audio-manifest.mjs';

// Keep this named export stable for scripts and CI that already import it.
export const validateManifest = validateAudioManifest;

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
