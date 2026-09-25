import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson, parseProviderHttpResponse } from '../lib/provider-response.mjs';

test('accepts JSON, fences and DeepSeek thinking before a scene plan', () => {
  assert.deepEqual(parseProviderHttpResponse('gemini',200,'application/json','{"ok":true}'),{ok:true});
  assert.deepEqual(parseModelJson('deepseek','<think>reasoning</think>\n```json\n{"scenes":[]}\n```'),{scenes:[]});
  assert.deepEqual(parseModelJson('openai','Here is the plan:\n{"scenes":[1]}'),{scenes:[1]});
});
test('reports HTML provider pages without leaking their content', () => {
  assert.throws(()=>parseProviderHttpResponse('deepseek',403,'text/html','<!DOCTYPE html><html>blocked</html>'),/HTML-Seite.*HTTP 403/);
  assert.throws(()=>parseProviderHttpResponse('gemini',200,'application/json','not json'),/keine lesbare JSON-Antwort/);
});
