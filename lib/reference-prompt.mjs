const PERSON_WORD = /\b(antihero|hero|villain|character|figure|man|woman|person|people|protagonist|human|face|portrait|he|she|his|her)\b/i;

function nonCharacterDetails(value) {
  return String(value || '')
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .filter(sentence => !PERSON_WORD.test(sentence))
    .join(' ')
    .trim();
}

function nonCharacterStyle(projectStyle) {
  const style = String(projectStyle || '').trim();
  const match = PERSON_WORD.exec(style);
  if (!match) return style;
  const cutoff = style.lastIndexOf('.', match.index);
  return cutoff > 0 ? style.slice(0, cutoff + 1).trim() : '';
}

export function buildReferencePrompt(asset, projectStyle = '') {
  const isCharacter = asset.kind === 'character';
  const type = isCharacter
    ? 'one consistent character shown once in a single full-body three-quarter view'
    : asset.kind === 'location'
      ? 'a still, uninhabited environment study of architecture, landscape or interior only, wide static composition focused purely on structure, materials, weather and atmosphere'
      : 'an extreme close-up production reference photograph of a single object, filling most of the frame, isolated against a dark neutral backdrop';

  // For locations and props, a style bible or a user note such as "no character" can
  // accidentally introduce the very concept the image model should avoid. Turbo workflows
  // give negative prompts little weight, so remove person-containing sentences entirely.
  const details = isCharacter
    ? `${asset.summary || ''} ${asset.visual_notes || ''}`
    : `${nonCharacterDetails(asset.summary)} ${nonCharacterDetails(asset.visual_notes)}`;
  const styleForPrompt = isCharacter ? projectStyle : nonCharacterStyle(projectStyle);
  const style = styleForPrompt
    ? `Project style bible: ${styleForPrompt}.`
    : 'grounded cinematic reference illustration, natural materials and controlled lighting.';
  const identity = isCharacter
    ? `Identity lock: this is exactly one person, never a pair, clone, reflection or character sheet. Preserve the same face, body proportions, age${asset.age_years != null && Number.isFinite(Number(asset.age_years)) ? ` (${Math.round(Number(asset.age_years))} years old)` : ''}${asset.height_cm != null && Number.isFinite(Number(asset.height_cm)) ? ` and relative height (${Math.round(Number(asset.height_cm))} cm)` : ''}, hairstyle, clothing and scale in every future scene.`
    : 'Show exactly one instance of this asset, never a duplicate, collage or alternate design.';

  return `${type}. ${asset.name}. ${details} ${identity} ${style} Consistent proportions and identity, unlettered, no logos, no watermark, no typography.`
    .replace(/\s+/g, ' ')
    .trim();
}
