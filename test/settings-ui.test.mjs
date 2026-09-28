import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const sandbox={window:{}};runInNewContext(readFileSync(new URL('../public/settings-ui.js',import.meta.url),'utf8'),sandbox);
const {matchesVoice,voiceLabel}=sandbox.window.FrameCutSettings;
test('voice language filters describe native labels, not generic multilingual support',()=>{
  const german={name:'Helmut',labels:{language:'de',accent:'standard',age:'old'}};
  const swiss={name:'Test',labels:{language:'de',accent:'Swiss'}};
  const english={name:'Roger',labels:{language:'en',accent:'american'}};
  assert.equal(matchesVoice(german,'de'),true);assert.equal(matchesVoice(german,'ch'),false);
  assert.equal(matchesVoice(swiss,'ch'),true);assert.equal(matchesVoice(english,'de'),false);
  assert.equal(matchesVoice(english,'all'),true);assert.equal(matchesVoice(german,'de','HEL'),true);
  assert.equal(matchesVoice(german,'de','Leo'),false);assert.match(voiceLabel(german),/Deutsch/);
});
