import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
test('speech settings encrypt keys, isolate users and require owned active worker jobs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'framecut-speech-test-'));
  const proc=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,FRAMECUT_DATA_DIR:dir,RABENBLUT_STUDIO_PORT:'14388',RABENBLUT_STUDIO_HOST:'127.0.0.1',FRAMECUT_WORKER_TOKEN:'test-worker',FRAMECUT_KEY_ENCRYPTION_KEY:'test-only-encryption-key-not-production'}});
  let logs='',db;proc.stdout.on('data',v=>logs+=v);proc.stderr.on('data',v=>logs+=v);
  try{
    for(let i=0;i<100&&!logs.includes('FrameCut:');i++)await new Promise(r=>setTimeout(r,50));assert.match(logs,/FrameCut:/,logs);
    db=new DatabaseSync(join(dir,'studio.db'));const now=new Date().toISOString();
    for(const id of [1,2]){
      db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(id,'user'+id,'Test','unused',now);
      db.prepare('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES (?,?,?,?)').run('session'+id,id,new Date(Date.now()+60000).toISOString(),now);
    }
    const req=(path,options={})=>fetch('http://127.0.0.1:14388'+path,options);
    const user=id=>({cookie:'rabenblut_session=session'+id,'content-type':'application/json'});
    assert.equal((await req('/api/settings/speech')).status,401);
    const key='test-secret-key-long-enough';
    const saved=await req('/api/settings/speech',{method:'PUT',headers:user(1),body:JSON.stringify({key,provider:'elevenlabs',voices:{1:'voice_123'},fallbackOnQuota:true})});assert.equal(saved.status,200,await saved.text());
    const encrypted=db.prepare('SELECT encrypted_key FROM user_speech_settings WHERE user_id=1').get().encrypted_key;assert.ok(!encrypted.includes(key));
    const own=await(await req('/api/settings/speech',{headers:user(1)})).json();assert.equal(own.configured,true);assert.equal(own.key,undefined);assert.equal(own.fallbackOnQuota,true);
    const other=await(await req('/api/settings/speech',{headers:user(2)})).json();assert.equal(other.configured,false);assert.equal(other.provider,'local');assert.deepEqual(other.voices,{});
    assert.equal((await req('/api/worker/jobs/123/speech',{method:'POST',headers:{'x-framecut-worker':'test-worker'}})).status,409);
    assert.equal((await req('/api/production-rebuild')).status,401);
    assert.equal((await(await req('/api/production-rebuild',{headers:user(1)})).json()).state,'not_started');
    assert.equal((await req('/api/settings/speech',{method:'PUT',headers:user(1),body:JSON.stringify({provider:'local'})})).status,200);
    assert.equal(db.prepare('SELECT encrypted_key FROM user_speech_settings WHERE user_id=1').get().encrypted_key,encrypted);
  }finally{db?.close();proc.kill();await once(proc,'exit');rmSync(dir,{recursive:true,force:true});}
});
