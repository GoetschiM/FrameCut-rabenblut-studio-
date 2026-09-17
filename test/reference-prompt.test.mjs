import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReferencePrompt } from '../lib/reference-prompt.mjs';

const characterTerms = /\b(antihero|hero|villain|character|figure|man|woman|person|people|protagonist|human|face|portrait)\b/i;
const styleWithHero = 'Dark 1990s inked comic illustration. A brooding antihero in a red cape with chains and glowing eyes.';

test('location prompt removes person language from style and user notes', () => {
  const prompt = buildReferencePrompt({
    kind: 'location',
    name: 'Dach & Glockenwerk',
    summary: 'Nasse Dächer, ein rotes Tor und schwarze Türme im Regen.',
    visual_notes: 'Bitte keinen Charakter einbauen. Dampf zieht durch enge Gassen.'
  }, styleWithHero);
  assert.match(prompt, /Nasse Dächer/i);
  assert.match(prompt, /Dampf zieht/i);
  assert.doesNotMatch(prompt, characterTerms);
});

test('prop prompt is isolated and does not inherit a character style bible', () => {
  const prompt = buildReferencePrompt({
    kind: 'prop',
    name: 'Pergament mit dunkelrotem Wachssiegel',
    summary: 'Vergilbtes Papier, feine Fasern und ein gebrochenes Siegel.',
    visual_notes: 'Keine Person im Bild, Fokus auf Material und Siegel.'
  }, styleWithHero);
  assert.match(prompt, /extreme close-up/i);
  assert.match(prompt, /Vergilbtes Papier/i);
  assert.doesNotMatch(prompt, characterTerms);
});

test('character prompt retains character-specific details', () => {
  const prompt = buildReferencePrompt({
    kind: 'character',
    name: 'Baron von Rabenblut',
    summary: 'Großer Antiheld mit schwarzer Rüstung.',
    visual_notes: 'Zerrissener roter Umhang und grüne Augen.'
  }, styleWithHero);
  assert.match(prompt, /consistent character/i);
  assert.match(prompt, /Antiheld/i);
  assert.match(prompt, /antihero/i);
});
