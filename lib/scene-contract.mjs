import { createHash } from 'node:crypto';

// v4 deliberately separates a reference's *metadata* from raw image inputs.
// MiniMax H3 has shown that raw reference pictures can become frame zero or be
// interpreted as extra cast.  Until the keyframe stage has a real FaceID/LoRA
// conditioner, the video model only sees the freshly generated scene guide.
export const SCENE_PIPELINE_VERSION = 4;
export const REVIEW_CHECKS = ['identity', 'count', 'scale', 'style', 'story'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function inferLegacyAudioDirection(shot, hasDialogue) {
  const text = `${shot.title || ''} ${shot.prompt || ''}`.toLowerCase();
  const emotion = /panik|katastroph|alarm|schrei|hekt|flieh|angst|notfall/.test(text)
    ? 'panicked, urgent, loud, hectic and slightly breathless'
    : /traurig|abschied|weint|verzweif/.test(text) ? 'sad, restrained and emotionally affected'
      : /freu|lacht|glücklich|begeistert/.test(text) ? 'warm, lively and genuinely excited'
        : /wüt|zorn|droh|streit/.test(text) ? 'angry, forceful and tense'
          : 'natural and appropriate to the scene';
  const ambience = /bus|verkehr|ampel|straße|kreuzung|hup/.test(text)
    ? 'busy city traffic, bus engines, tire noise and occasional horns matching the visible action'
    : /bau|bagger|werkstatt|maschine|metall/.test(text) ? 'construction and workshop machinery, metal movement and mechanical impacts'
      : /restaurant|essen|terrasse/.test(text) ? 'subtle restaurant room tone, dishes and distant conversation without intelligible extra speech'
        : /nacht|stern|garage/.test(text) ? 'quiet night ambience, distant traffic and natural room or garage reverberation'
          : 'natural environmental sounds matching the visible scene';
  return { mode: 'external', emotion, delivery: hasDialogue ? 'clear Standard German, emotionally acted and naturally paced' : 'clear and natural', ambience };
}

// Legacy free-text style bibles sometimes include actual sets and props. Keep
// removed sentences visible as warnings; never mutate the author's saved text.
export function separateStyle(text) {
  const content = /\b(tesla|bus(?:es)?|workshop|werkstatt|excavator|bagger|gears?|zahnräder|zahnrad|steampunk gears|restaurant|garage|city buses)\b/i;
  const sentences = String(text || '').split(/(?<=[.!?])\s+|[\r\n]+/).filter(Boolean);
  // A sentence that describes the look (medium, shading, palette, light) stays even if it
  // names a set such as "garage light"; dropping it left H3 without any style at all.
  const look = /\b(animation|animated|style|look|shaded|shading|cel|hand-drawn|illustration|palette|render(?:ing)?|comic|cartoon|aesthetic|medium)\b/i;
  const isContent = s => content.test(s) && !look.test(s);
  return { text: sentences.filter(s => !isContent(s)).join(' '), excluded: sentences.filter(isContent) };
}

export function buildSceneContract({ shot, style, negative = '', story = '', references, settings = {} }) {
  const cleaned = separateStyle(style);
  let audioDirection = {};
  try { audioDirection = JSON.parse(shot.audio_direction_json || '{}'); } catch {}
  const dialogueLines = Array.isArray(shot.dialogue_lines) ? shot.dialogue_lines : [];
  // Backward compatibility: old plans used "native" MiniMax sound. Treat it as
  // external production audio because exact language and absence of music cannot
  // be guaranteed by the video model.
  if (!['native', 'external', 'none'].includes(audioDirection.mode)) {
    audioDirection = inferLegacyAudioDirection(shot, dialogueLines.length > 0);
  }
  if (audioDirection.mode === 'native') audioDirection = { ...audioDirection, mode: 'external' };
  const evidence = [shot.title, shot.prompt, ...dialogueLines.map(line => line.assetName || '')].filter(Boolean).join('\n');
  const allRefs = references.map(asset => ({ ...asset, photos: [...new Map((asset.photos || []).map(p => [p.sha256, p])).values()] }));
  // An automated plan may occasionally return an assetNames entry copied from a
  // neighbouring scene.  Never let that stale link inject a person, vehicle or
  // location into this shot.  The exact asset name must be present in the shot
  // title/prompt/dialogue; style references are an intentional exception.
  const relevant = asset => asset.role === 'style' || asset.kind === 'source' || new RegExp(`\\b${String(asset.name || '').trim().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(evidence);
  const refs = allRefs.filter(relevant);
  const excluded = allRefs.filter(asset => !relevant(asset));
  const missing = refs.filter(a => !a.photos.length);
  if (missing.length) throw new Error(`Referenzfotos fehlen: ${missing.map(a => a.name).join(', ')}. Bitte Fotos hinzufügen.`);
  const count = refs.reduce((n, a) => n + a.photos.length, 0);
  if (count > 9) throw new Error(`${count} Referenzfotos ausgewählt; MiniMax unterstützt hier höchstens 9. Bitte die Szene aufteilen oder Fotos reduzieren. Es werden keine Fotos stillschweigend verworfen.`);
  const directives = refs.map(a => {
    // This text deliberately contains no <Picture N> tokens: raw source photos
    // are not sent to MiniMax H3, so it cannot turn them into an opening card.
    if (a.role === 'style') return `${a.name}: style reference ONLY. Use palette, medium and lighting; do not import depicted people, objects, background or composition.`;
    if (a.kind === 'source') return `${a.name}: shot-specific composition reference. Rebuild a full scene; no white reference backdrop or sheet.`;
    const physical = [a.age_years != null ? `age ${a.age_years} years` : '', a.height_cm != null ? `height ${a.height_cm} cm` : ''].filter(Boolean).join(', ');
    const rule = a.kind === 'character' ? 'Preserve face, hair, outfit, body proportions and distinguishing features. Different views depict the SAME individual, not extra people.' : a.kind === 'location' ? 'Preserve architecture, landscape, materials and spatial layout. Do not import unrelated figures or vehicles from the reference.' : 'Preserve shape, materials, colors and distinguishing features. Different views depict the SAME object.';
    // The story summary is narrative prose; MiniMax H3 speaks such prose aloud in shots
    // without dialogue. Only the visual description belongs in the video prompt.
    return `${a.name}, exactly ONE ${a.kind}. ${rule} ${physical}. ${a.visual_tags || a.visual_notes || a.summary || ''}`;
  });
  const prompt = [
    'One full-bleed continuous scene, never a contact sheet or collage. Reference pictures are conditioning only, never display them as opening cards.',
    ...directives,
    `SCENE ACTION (authoritative content): ${shot.prompt}. Camera: ${shot.camera || ''}.`,
    `VISUAL STYLE ONLY: ${cleaned.text || 'Consistent visual medium and palette of the selected references'}. Style must not add actors, props or locations.`,
    'Each selected subject appears once. No clones or merged identities. Respect the specified relative ages and sizes. Keep the same identity and style throughout the clip.',
    negative ? `USER EXCLUSIONS: ${negative}` : '',
    'One continuous shot; no cuts. Do not generate dialogue, narration or music. Production audio is created and quality-checked separately.'
  ].filter(Boolean).join('\n');
  // Generated appearance tags only rephrase the saved description; they must not invalidate reviews.
  const refsForFingerprint = refs.map(({ visual_tags, ...rest }) => rest);
  const fingerprint = digest({ version: SCENE_PIPELINE_VERSION, shot: { id: shot.id, prompt: shot.prompt, camera: shot.camera, seed: shot.seed, duration: shot.duration_seconds, audio_direction_json: shot.audio_direction_json || '{}', dialogue_lines: shot.dialogue_lines || [] }, style, negative, story, settings, refs: refsForFingerprint });
  const warnings = [
    ...cleaned.excluded.map(s => `Nicht als globaler Stil verwendet (Szeneninhalt): ${s}`),
    ...excluded.map(a => `Nicht für diesen Shot verwendet (im Szenentext nicht erwähnt): ${a.name}`),
    'Roh-Referenzbilder werden nicht an MiniMax H3 übergeben; das verhindert Referenzfoto-Startbilder und falsche Zusatzfiguren. Die Szene wird aus dem separaten, vollflächigen Szenenguide animiert.'
  ];
  return { version: SCENE_PIPELINE_VERSION, fingerprint, references: refs, prompt, style: cleaned.text, audioDirection, dialogueLines, nativeAudio: false, rawReferenceImages: false, warnings, reviewRequired: true };
}

export function reviewIsCurrent(shot, contract) {
  return Boolean(shot.output_video_path && shot.render_fingerprint === contract.fingerprint && shot.review_fingerprint === contract.fingerprint && shot.review_video_path === shot.output_video_path);
}
