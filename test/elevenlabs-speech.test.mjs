import test from 'node:test';
import assert from 'node:assert/strict';
import {speechSettings,elevenSpeech,elevenQuota} from '../lib/elevenlabs-speech.mjs';
const input={key:'secret-test',text:'Hallo Leo.',voiceId:'voice_123',performance:'hektisch, Panik'};
const quota=(count=0,tier='free')=>Response.json({character_count:count,character_limit:100,tier});
test('speech settings default to local, require explicit quota fallback and fixed voice IDs',()=>{
  assert.equal(speechSettings().provider,'local');assert.equal(speechSettings().fallbackOnQuota,false);
  assert.throws(()=>speechSettings({voices:{'../user':'abcde'}}));
  assert.throws(()=>speechSettings({voices:{1:'https://evil'}}));
  assert.deepEqual(speechSettings({voices:{1:'voice_123'}}).voices,{'1':'voice_123'});
});
test('free speech checks quota first, sends expressive settings and returns only audio',async()=>{
  const calls=[];const audio=await elevenSpeech(input,async(url,options)=>{
    calls.push({url,options});if(calls.length===1)return quota();
    const body=JSON.parse(options.body);assert.equal(body.model_id,'eleven_multilingual_v2');assert.equal(body.voice_settings.stability,.35);
    assert.equal(body.language_code,undefined);assert.equal(options.headers['xi-api-key'],'secret-test');
    return new Response(Buffer.alloc(256),{headers:{'content-type':'audio/mpeg'}});
  });assert.equal(audio.length,256);assert.equal(calls.length,2);assert.match(calls[0].url,/subscription$/);
});
test('insufficient free credits and paid accounts never invoke synthesis',async()=>{
  for(const [count,tier,code] of [[99,'free','quota'],[0,'creator','paid_plan']]){
    let calls=0;await assert.rejects(elevenSpeech(input,async()=>{calls++;return quota(count,tier);}),e=>e.code===code);assert.equal(calls,1);
  }
});
test('quota errors are distinguishable from bad keys; provider body never leaks',async()=>{
  for(const [status,code] of [['quota_exceeded','quota'],['invalid_api_key','provider']]){
    await assert.rejects(elevenQuota('secret',async()=>Response.json({detail:{status,message:'secret'}},{status:401})),e=>e.code===code&&!e.message.includes('secret'));
  }
});
test('malformed quota and non-audio output fail closed',async()=>{
  await assert.rejects(elevenQuota('secret',async()=>Response.json({tier:'free'})),e=>e.code==='quota_unknown');
  let calls=0;await assert.rejects(elevenSpeech(input,async()=>++calls===1?quota():new Response('<html>error</html>')),e=>e.code==='audio');
});
