/**
 * Provider-neutral audio cue manifest helpers.
 *
 * This module intentionally contains no renderer URL, filesystem path or secret.
 * The server uses it to make audio work visible before a final cut is attempted;
 * a future TTS/SFX/mix worker can consume the exact same manifest.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';

const KINDS = new Set(['dialogue', 'narration', 'sfx', 'music', 'ambience']);
const STATES = new Set(['pending', 'rendering', 'ready', 'failed', 'skipped']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
export const AUDIO_PIPELINE_VERSION = 2;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const validId = value => nonEmptyString(value) && ID_RE.test(value);
const integerAtLeast = (value, minimum) => Number.isInteger(value) && value >= minimum;

export function isSafeRelativePath(value) {
  if (!nonEmptyString(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return value.replaceAll('\\', '/').split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function validateAudioManifest(manifest) {
  const errors = [];
  const add = (location, message) => errors.push(`${location}: ${message}`);
  if (!isObject(manifest)) return ['root: must be a JSON object'];
  if (manifest.schema_version !== 1) add('schema_version', 'must be 1');
  for (const key of ['owner_id', 'project_id', 'episode_id']) if (!validId(manifest[key])) add(key, 'must be a non-empty opaque identifier');

  const timeline = manifest.timeline;
  if (!isObject(timeline)) add('timeline', 'must be an object');
  else {
    if (!integerAtLeast(timeline.duration_ms, 1)) add('timeline.duration_ms', 'must be a positive integer');
    if (timeline.sample_rate_hz !== 48000) add('timeline.sample_rate_hz', 'must be 48000');
    if (timeline.channels !== 2) add('timeline.channels', 'must be 2 (stereo)');
  }
  if (!Array.isArray(manifest.cues)) { add('cues', 'must be an array'); return errors; }

  const cueIds = new Set();
  manifest.cues.forEach((cue, index) => {
    const location = `cues[${index}]`;
    if (!isObject(cue)) { add(location, 'must be an object'); return; }
    if (!validId(cue.id)) add(`${location}.id`, 'must be a non-empty identifier');
    else if (cueIds.has(cue.id)) add(`${location}.id`, 'must be unique');
    else cueIds.add(cue.id);
    if (!KINDS.has(cue.kind)) add(`${location}.kind`, `must be one of ${[...KINDS].join(', ')}`);
    if (!STATES.has(cue.state)) add(`${location}.state`, `must be one of ${[...STATES].join(', ')}`);
    if (!integerAtLeast(cue.start_ms, 0)) add(`${location}.start_ms`, 'must be an integer >= 0');
    if (!integerAtLeast(cue.target_duration_ms, 1)) add(`${location}.target_duration_ms`, 'must be a positive integer');
    if (cue.gain_db !== undefined && (typeof cue.gain_db !== 'number' || !Number.isFinite(cue.gain_db))) add(`${location}.gain_db`, 'must be a finite number when supplied');
    if (timeline?.duration_ms && integerAtLeast(cue.start_ms, 0) && integerAtLeast(cue.target_duration_ms, 1) && cue.start_ms + cue.target_duration_ms > timeline.duration_ms) add(location, 'must fit inside timeline.duration_ms');
    const speech = cue.kind === 'dialogue' || cue.kind === 'narration';
    if (speech && !nonEmptyString(cue.text)) add(`${location}.text`, 'is required for dialogue and narration');
    if (speech && !validId(cue.speaker_role)) add(`${location}.speaker_role`, 'is required for dialogue and narration');
    if ((cue.kind === 'sfx' || cue.kind === 'music' || cue.kind === 'ambience') && !nonEmptyString(cue.prompt) && !isObject(cue.artifact)) add(location, 'requires prompt or artifact for sfx, music, or ambience');
    if (cue.artifact !== undefined) {
      if (!isObject(cue.artifact)) add(`${location}.artifact`, 'must be an object');
      else {
        if (!isSafeRelativePath(cue.artifact.path)) add(`${location}.artifact.path`, 'must be a safe relative path');
        if (cue.artifact.sha256 !== undefined && (!nonEmptyString(cue.artifact.sha256) || !SHA256_RE.test(cue.artifact.sha256))) add(`${location}.artifact.sha256`, 'must be a lowercase SHA-256 hex digest when supplied');
      }
    }
    if (cue.state === 'ready' && (!isObject(cue.artifact) || !isSafeRelativePath(cue.artifact.path))) add(`${location}.artifact`, 'is required for a ready cue');
  });
  return errors;
}

function sourceRevision(shots, dialogue, includeNarrationFallback) {
  const source = {
    audio_pipeline_version: AUDIO_PIPELINE_VERSION,
    shots: shots.map(s => [s.id, s.sequence, s.duration_seconds, s.audio_direction_json || '{}', includeNarrationFallback ? String(s.title || '').trim() : '']),
    dialogue: dialogue.map(d => [d.id, d.shot_id, d.sequence, d.asset_id, d.text, d.voice || '']),
  };
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

function speechDurationMs(text, ceiling) {
  // Deliberately conservative: the value is a scheduling target, not a fake audio duration.
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(650, Math.min(ceiling, 320 + words * 420));
}

/** Build a deterministic, editable draft from the current shot timeline and dialogue. */
export function createEpisodeAudioManifest({ ownerId, projectId, episodeId, shots, dialogue, includeNarrationFallback = false }) {
  let cursor = 0;
  const starts = new Map();
  for (const shot of shots) { starts.set(Number(shot.id), cursor); cursor += Math.max(1, Math.round(Number(shot.duration_seconds || 0) * 1000)); }
  const directionFor = shot => { try { return JSON.parse(shot?.audio_direction_json || '{}'); } catch { return {}; } };
  const orderedDialogue = [...dialogue]
    .sort((a, b) => (Number(shots.findIndex(s => Number(s.id) === Number(a.shot_id))) - Number(shots.findIndex(s => Number(s.id) === Number(b.shot_id)))) || Number(a.sequence) - Number(b.sequence) || Number(a.id) - Number(b.id));
  const cues = orderedDialogue.map(line => {
    const shot = shots.find(s => Number(s.id) === Number(line.shot_id));
    const direction = directionFor(shot);
    const start = starts.get(Number(line.shot_id)) || 0;
    const shotMs = Math.max(1000, Math.round(Number(shot?.duration_seconds || 1) * 1000));
    const localOffset = Math.min(350, Math.max(0, shotMs - 650));
    return {
      id: `dialogue-${line.shot_id}-${line.id}`,
      kind: 'dialogue', state: 'pending', start_ms: start + localOffset,
      target_duration_ms: speechDurationMs(line.text, Math.max(650, shotMs - localOffset)), gain_db: 0,
      speaker_role: line.asset_id ? `character-${line.asset_id}` : 'narrator',
      text: String(line.text || '').trim(), shot_id: String(line.shot_id), asset_id: line.asset_id ? String(line.asset_id) : undefined,
      voice_profile_id: line.voice ? String(line.voice) : undefined,
      performance_direction: [direction.emotion, direction.delivery].map(value => String(value || '').trim()).filter(Boolean).join('; '),
    };
  });
  // A visual-only auto-plan has no `shot_dialogue` records by design.  In an
  // narrator mode, leaving its audio plan empty makes the next actionable step
  // disappear.  Create short, plainly labelled drafts from the already editable
  // shot titles; this never invents story facts and users can still change every
  // line in the shot editor before rendering.
  // Only create title narration for a genuinely dialogue-free plan.
  if (includeNarrationFallback && dialogue.length === 0) {
    for (const shot of shots) {
      const title = String(shot.title || '').trim().replace(/\s+/g, ' ');
      if (!title) continue;
      const shotMs = Math.max(1000, Math.round(Number(shot.duration_seconds || 1) * 1000));
      const localOffset = Math.min(300, Math.max(0, shotMs - 650));
      const words = title.split(/\s+/).filter(Boolean).length;
      cues.push({
        id: `narration-${shot.id}-title`, kind: 'narration', state: 'pending',
        start_ms: (starts.get(Number(shot.id)) || 0) + localOffset,
        target_duration_ms: Math.min(shotMs - localOffset, Math.max(650, 320 + words * 420)),
        gain_db: 0, speaker_role: 'narrator', text: title, shot_id: String(shot.id),
        generated_from: 'shot_title_fallback',
      });
    }
  }
  // Every shot receives separately reviewable audio. Legacy "native" directions are
  // deliberately treated like external audio because MiniMax can introduce music,
  // fantasy speech or the wrong language. Music remains episode-wide.
  for (const shot of shots) {
    const direction = directionFor(shot);
    if (direction.mode === 'none') continue;
    const ambience = String(direction.ambience || '').trim();
    if (!ambience) continue;
    const shotMs = Math.max(1000, Math.round(Number(shot.duration_seconds || 1) * 1000));
    cues.push({
      id: `ambience-shot-${shot.id}`, kind: 'sfx', state: 'pending',
      start_ms: starts.get(Number(shot.id)) || 0, target_duration_ms: Math.min(8000, shotMs), gain_db: -14,
      shot_id: String(shot.id), language: 'German', auto_direction: true,
      prompt: `Clean diegetic scene ambience only: ${ambience}. Mood: ${String(direction.emotion || 'natural')}. No dialogue, no voices, no music, no narration. Match the visible action in shot: ${String(shot.title || '').trim()}.`,
    });
  }
  for (const cue of cues) { if (!cue.asset_id) delete cue.asset_id; if (!cue.voice_profile_id) delete cue.voice_profile_id; }
  return {
    schema_version: 1, audio_pipeline_version: AUDIO_PIPELINE_VERSION,
    owner_id: `owner-${ownerId}`, project_id: `project-${projectId}`, episode_id: `episode-${episodeId}`,
    source_revision: sourceRevision(shots, dialogue, includeNarrationFallback),
    auto_narration_fallback: includeNarrationFallback && dialogue.length === 0 && cues.some(cue => cue.generated_from === 'shot_title_fallback'),
    timeline: { duration_ms: Math.max(1, cursor), sample_rate_hz: 48000, channels: 2 }, cues,
  };
}

function sameCueDefinition(left, right) {
  return ['id', 'kind', 'start_ms', 'target_duration_ms', 'speaker_role', 'text', 'prompt', 'voice_profile_id', 'performance_direction']
    .every(key => String(left?.[key] ?? '') === String(right?.[key] ?? ''));
}
// Lip-synced dialogue shots are trimmed to the spoken line after rendering, which moves
// every later cue. Timing alone never changes what a cue sounds like, so a rendered
// artifact stays valid as long as its audible definition is identical.
function sameAudibleDefinition(left, right) {
  return ['id', 'kind', 'speaker_role', 'text', 'prompt', 'voice_profile_id', 'performance_direction']
    .every(key => String(left?.[key] ?? '') === String(right?.[key] ?? ''));
}

/**
 * Upgrade an older saved plan without throwing away expensive, still-valid WAVs.
 * Deterministic timeline cues come from `generated`; manually added music/SFX are
 * retained when they still fit. A ready artifact is only reused when every audible
 * input field is identical, so changed dialogue can never keep yesterday's voice.
 */
export function reconcileAudioManifest(generated, saved) {
  if (!saved || !Array.isArray(saved.cues)) return structuredClone(generated);
  const oldById = new Map(saved.cues.map(cue => [String(cue.id), cue]));
  const deterministicIds = new Set(generated.cues.map(cue => String(cue.id)));
  const cues = generated.cues.map(cue => {
    const old = oldById.get(String(cue.id));
    if (!old) return cue;
    if (old.state === 'ready' && old.artifact?.path && sameAudibleDefinition(cue, old)) {
      // Keep the rendered length of a speech line: the lip-synced picture was generated from it.
      const oldDuration = Number(old.target_duration_ms);
      const keepDuration = (cue.kind === 'dialogue' || cue.kind === 'narration') && Number.isInteger(oldDuration) && oldDuration > 0
        && cue.start_ms + oldDuration <= generated.timeline.duration_ms;
      return { ...cue, target_duration_ms: keepDuration ? oldDuration : cue.target_duration_ms, state: 'ready', artifact: old.artifact, rendered_at: old.rendered_at };
    }
    if (!sameCueDefinition(cue, old)) return cue;
    if (old.state !== 'ready' || !old.artifact?.path) return { ...cue, state: old.state === 'rendering' ? 'failed' : old.state, error: old.error };
    return { ...cue, state: 'ready', artifact: old.artifact, rendered_at: old.rendered_at };
  });
  for (const old of saved.cues) {
    if (deterministicIds.has(String(old.id))) continue;
    if (!['music', 'ambience', 'sfx'].includes(old.kind)) continue;
    const start = Number(old.start_ms), duration = Number(old.target_duration_ms);
    if (!Number.isInteger(start) || !Number.isInteger(duration) || start < 0 || duration < 1) continue;
    const room = generated.timeline.duration_ms - start;
    if (start + duration <= generated.timeline.duration_ms) { cues.push(structuredClone(old)); continue; }
    // A shorter timeline trims an episode-wide music/ambience bed instead of discarding it.
    if (['music', 'ambience'].includes(old.kind) && room >= 1000) cues.push({ ...structuredClone(old), target_duration_ms: room });
  }
  const result = {
    ...structuredClone(generated), cues,
    automation: saved.automation && typeof saved.automation === 'object' ? structuredClone(saved.automation) : undefined,
  };
  if (!result.automation) delete result.automation;
  return result;
}

export function audioPreflight(manifest, { expectedSourceRevision = null, mixingWorkerAvailable = false } = {}) {
  const errors = validateAudioManifest(manifest);
  const cues = Array.isArray(manifest?.cues) ? manifest.cues : [];
  const count = state => cues.filter(cue => cue.state === state).length;
  const speech = cues.filter(cue => cue.kind === 'dialogue' || cue.kind === 'narration');
  const pending = count('pending') + count('rendering');
  const failed = count('failed');
  const stale = Boolean(expectedSourceRevision && manifest?.source_revision !== expectedSourceRevision);
  const cuesReady = errors.length === 0 && !stale && pending === 0 && failed === 0
    && cues.length > 0 && cues.every(cue => cue.state === 'ready' || cue.state === 'skipped');
  const blockers = [];
  if (errors.length) blockers.push(`${errors.length} Manifest-Fehler`);
  if (stale) blockers.push('Die Dialog- oder Shot-Timeline wurde nach dem Audio-Plan geändert');
  if (!cues.length) blockers.push('Es sind noch keine Audio-Cues geplant');
  if (pending) blockers.push(`${pending} Audio-Cue(s) sind noch offen`);
  if (failed) blockers.push(`${failed} Audio-Cue(s) sind fehlgeschlagen`);
  if (cuesReady && !mixingWorkerAvailable) blockers.push('Die fertigen Audio-Spuren warten noch auf den Audio-Master-Mix');
  return {
    manifestValid: errors.length === 0, validationErrors: errors, sourceCurrent: !stale,
    cues: { total: cues.length, speech: speech.length, ready: count('ready'), pending, failed, skipped: count('skipped') },
    cuesReady, readyForMaster: cuesReady && mixingWorkerAvailable, mixingWorkerAvailable, blockers,
  };
}
