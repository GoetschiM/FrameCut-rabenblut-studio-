import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSceneContract, reviewIsCurrent, separateStyle } from '../lib/scene-contract.mjs';
const photo = n => ({sha256:String(n),downloadUrl:`/photo/${n}`});
const base = () => ({shot:{id:1,prompt:'Leo läuft zum Brunnen.',camera:'Dolly',seed:4,duration_seconds:5},style:'Warm animation.',story:'Leo visits the fountain.',references:[{id:7,name:'Leo',kind:'character',role:'reference',age_years:6,height_cm:115,photos:[photo(1),photo(2),photo(1)]},{id:8,name:'Brunnen',kind:'location',photos:[photo(3)]}]});
test('multiple photos belong to one identity, pronouns do not discard cast',()=>{
  const c=buildSceneContract(base());
  assert.equal(c.references[0].photos.length,2);
  assert.match(c.prompt,/Leo, exactly ONE character/);
  assert.match(c.prompt,/Brunnen, exactly ONE location/);
  assert.doesNotMatch(c.prompt,/<Picture/);
  assert.match(c.prompt,/age 6 years, height 115 cm/);
});
test('missing photos and overflow fail rather than silently omit references',()=>{
  const b=base();b.references[0].photos=[];assert.throws(()=>buildSceneContract(b),/fehlen/);
  b.references[0].photos=Array.from({length:10},(_,i)=>photo(i));assert.throws(()=>buildSceneContract(b),/höchstens 9/);
});
test('style references never become extra cast; scene objects are separated from style',()=>{
  const b=base();b.references.push({id:9,role:'style',photos:[photo(4)]});
  b.style='Warm animation. Red city buses in a workshop. Gold steampunk gears.';
  const c=buildSceneContract(b);assert.equal(c.style,'Warm animation.');assert.ok(c.warnings.length >= 3);
  assert.match(c.prompt,/style reference ONLY/);assert.doesNotMatch(c.prompt,/city buses/);
});
test('every content revision invalidates previous approval and render provenance',()=>{
  const b=base(),c=buildSceneContract(b);
  const shot={output_video_path:'clip.mp4',render_fingerprint:c.fingerprint,review_fingerprint:c.fingerprint,review_video_path:'clip.mp4'};
  assert.equal(reviewIsCurrent(shot,c),true);
  for(const change of [x=>x.shot.prompt+=' Stop.',x=>x.style+=' Noir.',x=>x.story+=' Next.',x=>x.references[0].photos[0].sha256='changed',x=>x.references[0].height_cm=130]){
    const next=base();change(next);assert.equal(reviewIsCurrent(shot,buildSceneContract(next)),false);
  }
  assert.equal(reviewIsCurrent({...shot,output_video_path:'new.mp4'},c),false);
});
test('contracts are isolated and deterministic',()=>{
  const b=base();assert.equal(buildSceneContract(b).fingerprint,buildSceneContract(b).fingerprint);
  const next=base();next.references=[];assert.doesNotMatch(buildSceneContract(next).prompt,/<Picture/);
  assert.equal(separateStyle('Watercolor, soft light.').text,'Watercolor, soft light.');
});
test('stale automated asset links are excluded before they can reach the video model',()=>{
  const b=base();b.references.push({id:9,name:'Tesla',kind:'prop',role:'reference',photos:[photo(4)]});
  const c=buildSceneContract(b);
  assert.deepEqual(c.references.map(x=>x.name),['Leo','Brunnen']);
  assert.match(c.warnings.join('\n'),/Tesla/);
  assert.doesNotMatch(c.prompt,/Tesla/);
});
