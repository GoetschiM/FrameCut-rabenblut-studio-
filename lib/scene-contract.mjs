import { createHash } from 'node:crypto';

// v5 uses photos ONLY to compose a new scene keyframe. The final I2V pass
// receives that scene, never a portrait or character sheet as its first frame.
export const SCENE_PIPELINE_VERSION = 5;
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
  const look = /\b(animation|animated|style|look|shaded|shading|cel|hand-drawn|illustration|palette|render(?:ing)?|comic|cartoon|aesthetic|medium|light|lighting|textures?|matte-painted|colou?rs?|accents?|shadows?)\b/i;
  const kept = [], excluded = [];
  for (const sentence of sentences) {
    if (!content.test(sentence)) { kept.push(sentence); continue; }
    if (!look.test(sentence)) { excluded.push(sentence); continue; }
    // Retain visual treatment, without importing a set from a global style.
    // The author's saved text is not changed; warnings show excluded fragments.
    const withoutSet = sentence.replace(/\b(?:in|inside|at|on)\s+(?:(?:a|an|the|vast|large|swiss|red|old|city)\s+)*(?:bus\s+workshop|workshop|werkstatt|city\s+buses|buses|bus|garage|restaurant|tesla)\b/gi, match => { excluded.push(match); return ''; });
    const parts = withoutSet.split(',').map(s => s.trim()).filter(Boolean).filter(part => {
      if (content.test(part) && !look.test(part)) { excluded.push(part); return false; }
      return true;
    });
    const result = parts.join(', ').replace(/\s+([.!?])/g, '$1').trim();
    if (result) kept.push(result);
  }
  return { text: kept.join(' '), excluded };
}

// Art-style words in a subject's tags override the episode style (a comic-style reference
// caption turned a 3D episode into a comic); the style is applied once, from the episode.
const TAG_STYLE_WORDS = /\b(comic|cartoon|anime|manga|pixar|ghibli|disney|3d|2d|cgi|render(?:ed|ing)?|illustrat\w*|vector\w*|outlines?|ink|flat colou?rs?|gradients?|cel[- ]?shad\w*|style|stylized|painted|matte|photoreal\w*|vibrant colou?rs?|8k)\b/i;
export function stripStyleTags(tags) {
  return String(tags || '').split(',').map(tag => tag.trim()).filter(tag => tag && !TAG_STYLE_WORDS.test(tag)).join(', ');
}

// German shot texts inflect names: "den Fokus" for the asset "Der Fokus", "Nanis" for "Nani".
// The name counts without a leading article and with an inflection ending; for a multi-word
// name its last word alone also counts ("ihr Smartphone" mentions "Nanis Smartphone").
const LEADING_ARTICLE = /^(der|die|das|den|dem|des|ein|eine|einen|einem|the|a|an)\s+/i;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function mentionsAsset(name, text) {
  const core = String(name || '').trim().replace(LEADING_ARTICLE, '');
  if (!core) return false;
  const words = core.split(/\s+/);
  const variants = [core];
  if (words.length > 1 && words[words.length - 1].length >= 5) variants.push(words[words.length - 1]);
  return variants.some(variant => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(variant)}(?:s|es|n|en)?(?![\\p{L}\\p{N}])`, 'iu').test(String(text || '')));
}

export function referenceKeyframePlan(references, shot, style, negative = '') {
  if (!references.length) return null;
  let picture = 0;
  const bindings = references.map(asset => {
    const pictures = asset.photos.map(() => `<Picture ${++picture}>`).join(' and ');
    if (asset.role === 'style') return `${pictures}: ${asset.name || 'style'}, visual treatment ONLY. Never copy depicted subjects, objects or composition.`;
    if (asset.kind === 'location') return `${pictures}: ${asset.name}, the SAME location. Rebuild its environment, no unrelated people or vehicles from the photos.`;
    if (asset.kind === 'source') return `${pictures}: scene composition guidance only, not an image to display or a separate panel.`;
    const dimensions = [asset.age_years != null ? `age ${asset.age_years} years` : '', asset.height_cm != null ? `height ${asset.height_cm} cm` : ''].filter(Boolean).join(', ');
    return `${pictures}: ${asset.name}, exactly ONE ${asset.kind}. All these views belong to this SAME subject, never additional copies. Preserve face, hair, outfit, build, shape and distinguishing details from the photographs. ${dimensions}. ${stripStyleTags(asset.visual_tags) || asset.visual_notes || ''}`;
  });
  return {
    mode: 'h3-reference-keyframe-v1', frames: 22, width: 608, height: 352, steps: 4,
    prompt: [
      'Compose one full-bleed cinematic scene inside the described environment. Static camera, no cuts or transitions. Never show source images, white studio backdrops, panels or contact sheets.',
      ...bindings,
      `SCENE: ${shot.prompt_en || shot.prompt}. CAMERA: ${shot.camera || 'natural cinematic framing'}.`,
      `EPISODE VISUAL STYLE: ${style || 'consistent visual style'}. Adapt the sources to this shared visual style without changing identity. Style must not add subjects or objects.`,
      'Each named subject appears exactly once. Adult and child proportions stay distinct. Nothing from previous scenes. No extra cast, vehicles or props from reference backgrounds. Mouths closed for this still composition; no text, music, speech or narration.',
      negative ? `USER EXCLUSIONS: ${negative}` : ''
    ].filter(Boolean).join('\n')
  };
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
  // location into this shot.  The asset name must be mentioned in the shot
  // title/prompt/dialogue; style references are an intentional exception.
  const relevant = asset => asset.role === 'style' || asset.kind === 'source' || mentionsAsset(asset.name, evidence);
  const refs = allRefs.filter(relevant).map(a => a.visual_tags ? { ...a, visual_tags: stripStyleTags(a.visual_tags) } : a);
  const excluded = allRefs.filter(asset => !relevant(asset));
  const missing = refs.filter(a => !a.photos.length);
  if (missing.length) throw new Error(`Referenzfotos fehlen: ${missing.map(a => a.name).join(', ')}. Bitte Fotos hinzufügen.`);
  const count = refs.reduce((n, a) => n + a.photos.length, 0);
  if (count > 9) throw new Error(`${count} Referenzfotos ausgewählt; MiniMax unterstützt hier höchstens 9. Bitte die Szene aufteilen oder Fotos reduzieren. Es werden keine Fotos stillschweigend verworfen.`);
  const directives = refs.map(a => {
    // The final animation prompt has no <Picture N> tokens. Source photos only
    // enter the separate keyframe plan, never the final I2V graph.
    if (a.role === 'style') return `${a.name}: style reference ONLY. Use palette, medium and lighting; do not import depicted people, objects, background or composition.`;
    if (a.kind === 'source') return `${a.name}: shot-specific composition reference. Rebuild a full scene; no white reference backdrop or sheet.`;
    const physical = [a.age_years != null ? `age ${a.age_years} years` : '', a.height_cm != null ? `height ${a.height_cm} cm` : ''].filter(Boolean).join(', ');
    const rule = a.kind === 'character' ? 'Preserve face, hair, outfit, body proportions and distinguishing features. Different views depict the SAME individual, not extra people.' : a.kind === 'location' ? 'Preserve architecture, landscape, materials and spatial layout. Do not import unrelated figures or vehicles from the reference.' : 'Preserve shape, materials, colors and distinguishing features. Different views depict the SAME object.';
    // The story summary is narrative prose; MiniMax H3 speaks such prose aloud in shots
    // without dialogue. Only the visual description belongs in the video prompt.
    return `${a.name}, exactly ONE ${a.kind}. ${rule} ${physical}. ${stripStyleTags(a.visual_tags) || a.visual_notes || a.summary || ''}`;
  });
  const prompt = [
    'One full-bleed continuous scene, never a contact sheet or collage. Reference pictures are conditioning only, never display them as opening cards.',
    ...directives,
    shot.prompt_en ? `SCENE ACTION (authoritative content): ${shot.prompt_en}` : `SCENE ACTION (authoritative content): ${shot.prompt}. Camera: ${shot.camera || ''}.`,
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
    'Referenzfotos steuern nur die Erstellung des Szenenbildes. Das Video animiert ausschließlich dieses neue Szenenbild, niemals ein Porträt oder Referenzblatt.'
  ];
  return { version: SCENE_PIPELINE_VERSION, fingerprint, references: refs, keyframe: referenceKeyframePlan(refs, shot, cleaned.text, negative), prompt, style: cleaned.text, audioDirection, dialogueLines, nativeAudio: false, rawReferenceImages: false, warnings, reviewRequired: true };
}

export function reviewIsCurrent(shot, contract) {
  return Boolean(shot.output_video_path && shot.render_fingerprint === contract.fingerprint && shot.review_fingerprint === contract.fingerprint && shot.review_video_path === shot.output_video_path);
}
