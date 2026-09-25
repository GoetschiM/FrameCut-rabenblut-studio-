import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';

test('real HTTP claim/download/upload/review and stale-reference rejection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'framecut-scene-test-'));
  const proc=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,FRAMECUT_DATA_DIR:dir,RABENBLUT_STUDIO_PORT:'14379',RABENBLUT_STUDIO_HOST:'127.0.0.1',FRAMECUT_WORKER_TOKEN:'test-worker-only'}});
  let logs='';proc.stdout.on('data',v=>logs+=v);proc.stderr.on('data',v=>logs+=v);
  let db;
  try {
    for(let i=0;i<100&&!logs.includes('FrameCut:');i++)await new Promise(r=>setTimeout(r,50));
    assert.match(logs,/FrameCut:/,logs);
    db=new DatabaseSync(join(dir,'studio.db'));
    const now=new Date().toISOString();
    db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (1,?,?,?,?)').run('test','Test','unused',now);
    db.prepare('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES (?,1,?,?)').run('test-session',new Date(Date.now()+60000).toISOString(),now);
    db.prepare('INSERT INTO projects(id,slug,title,source_path,created_at,style_profile) VALUES (1,?,?,?,?,?)').run('test','Test','',now,'Warm animation. Red city buses in a workshop.');
    db.prepare('INSERT INTO episodes(id,project_id,number,title,created_at) VALUES (1,1,1,?,?)').run('Test',now);
    db.prepare('INSERT INTO shots(id,episode_id,sequence,title,prompt,camera,seed,created_at) VALUES (1,1,1,?,?,?,?,?)').run('Walk','Leo läuft.','Dolly',42,now);
    mkdirSync(join(dir,'uploads'));writeFileSync(join(dir,'uploads','a.png'),'reference-a');writeFileSync(join(dir,'uploads','b.png'),'reference-b');
    db.prepare('INSERT INTO assets(id,project_id,kind,name,file_path,created_at) VALUES (1,1,?,?,?,?)').run('character','Leo','data/uploads/a.png',now);
    db.prepare('INSERT INTO asset_photos(asset_id,file_path,is_primary,created_at) VALUES (1,?,0,?)').run('data/uploads/b.png',now);
    db.exec("INSERT INTO shot_assets(shot_id,asset_id,role) VALUES (1,1,'reference')");
    db.prepare('INSERT INTO jobs(id,episode_id,shot_id,kind,label,state,created_at) VALUES (1,1,1,?,?,?,?)').run('minimax_h3','Test','wartet',now);
    const worker={'x-framecut-worker':'test-worker-only'},user={cookie:'rabenblut_session=test-session','content-type':'application/json'};
    const req=(path,options={})=>fetch('http://127.0.0.1:14379'+path,options);
    const claim=await req('/api/worker/next',{headers:worker});assert.equal(claim.status,200);const payload=await claim.json();
    assert.equal(payload.sceneContract.references[0].photos.length,2);
    assert.doesNotMatch(payload.sceneContract.prompt,/Red city buses/);
    assert.doesNotMatch(payload.sceneContract.prompt,/<Picture/);
    assert.equal(payload.sceneContract.rawReferenceImages,false);
    const download=await req(payload.sceneContract.references[0].photos[1].downloadUrl,{headers:worker});assert.equal(await download.text(),'reference-b');
    const upload=()=>req('/api/worker/jobs/1/video',{method:'POST',headers:{...worker,'content-type':'video/mp4','x-framecut-scene-fingerprint':payload.sceneContract.fingerprint},body:'test-video'});
    assert.equal((await upload()).status,201);
    const shot=db.prepare('SELECT * FROM shots WHERE id=1').get();
    const review=checks=>req('/api/shots/1/visual-review',{method:'POST',headers:user,body:JSON.stringify({videoPath:shot.output_video_path,checks})});
    assert.equal((await review({identity:true})).status,400);
    assert.equal((await review(Object.fromEntries(['identity','count','scale','style','story'].map(k=>[k,true])))).status,200);
    writeFileSync(join(dir,'uploads','a.png'),'changed-reference');
    assert.equal((await upload()).status,409);
    assert.equal((await req('/api/episodes/1/assemble',{method:'POST',headers:user,body:JSON.stringify({pictureOnly:true})})).status,409);
  } finally {
    db?.close();proc.kill();await once(proc,'exit');rmSync(dir,{recursive:true,force:true});
  }
});
