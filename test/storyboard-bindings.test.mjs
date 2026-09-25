import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('storyboard bindings derive visible shot ids inside bindDynamic', () => {
  const bindingStart = source.indexOf('function bindDynamic()');
  const bindingEnd = source.indexOf('\nfunction renderJobPhase', bindingStart);
  const bindings = source.slice(bindingStart, bindingEnd);

  assert.match(bindings, /const visibleShotIds = \(\) =>/);
  assert.doesNotMatch(bindings, /\bvisibleShots\b/);
  assert.doesNotMatch(bindings, /\bopenCount\b/);
  assert.match(bindings, /visibleShotIds\(\)\.forEach/);
});
