import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';

test('selected shots stay episode-scoped and episode stop preserves other queues', async () => {
  const dir=mkdtempSync(join(tmpdir(),'framecut-queue-test-'));
  const port='14380';
  const proc=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,FRAMECUT_DATA_DIR:dir,RABENBLUT_STUDIO_PORT:port,RABENBLUT_STUDIO_HOST:'127.0.0.1',FRAMECUT_WORKER_TOKEN:'queue-test-worker'}});
  let logs=''; proc.stdout.on('data',v=>logs+=v); proc.stderr.on('data',v=>logs+=v);
  let db;
  try {
    for(let i=0;i<100&&!logs.includes('FrameCut:');i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.match(logs,/FrameCut:/,logs);
    db=new DatabaseSync(join(dir,'studio.db'));
    const stamp=new Date().toISOString();
    db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (1,?,?,?,?)').run('test','Test','unused',stamp);
    db.prepare('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES (?,1,?,?)').run('queue-session',new Date(Date.now()+60000).toISOString(),stamp);
    db.prepare('INSERT INTO projects(id,slug,title,source_path,created_at) VALUES (1,?,?,?,?)').run('queue','Queue Test','',stamp);
    db.prepare('INSERT INTO episodes(id,project_id,number,title,created_at) VALUES (1,1,1,?,?),(2,1,2,?,?)').run('Episode A',stamp,'Episode B',stamp);
    for(const [id,episode,sequence] of [[1,1,1],[2,1,2],[3,1,3],[4,2,1]]) {
      db.prepare('INSERT INTO shots(id,episode_id,sequence,title,prompt,camera,seed,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,episode,sequence,`Shot ${id}`,id===4?'Prompt mit Schritten':`Prompt ${id}`,'Static',100+id,stamp);
    }
    const headers={cookie:'rabenblut_session=queue-session','content-type':'application/json'};
    const request=(path,options={})=>fetch(`http://127.0.0.1:${port}${path}`,options);

    const selected=await request('/api/jobs/batch',{method:'POST',headers,body:JSON.stringify({episodeId:1,shotIds:[1,2],tier:'Vorschau'})});
    assert.equal(selected.status,201);
    assert.deepEqual(await selected.json(),{ok:true,queued:2,total:2,skipped:0,photosQueued:0});
    const crossEpisode=await request('/api/jobs/batch',{method:'POST',headers,body:JSON.stringify({episodeId:1,shotIds:[3,4]})});
    assert.equal(crossEpisode.status,400);

    db.prepare("INSERT INTO jobs(episode_id,shot_id,kind,label,state,created_at) VALUES (2,4,'minimax_h3','Episode B','wartet',?)").run(stamp);
    const stopped=await request('/api/episodes/1/jobs/cancel',{method:'POST',headers,body:'{}'});
    assert.equal(stopped.status,200);
    assert.equal((await stopped.json()).canceled,2);
    assert.equal(db.prepare("SELECT count(*) count FROM jobs WHERE episode_id=1 AND state='abgebrochen'").get().count,2);
    assert.equal(db.prepare("SELECT count(*) count FROM jobs WHERE episode_id=2 AND state='wartet'").get().count,1);

    db.prepare('INSERT INTO shot_dialogue(id,shot_id,asset_id,sequence,text,created_at) VALUES (1,4,NULL,1,?,?)').run('Eine kurze Testzeile.',stamp);
    const selectedCue=await request('/api/episodes/2/audio-cues/render',{method:'POST',headers,body:JSON.stringify({cueIds:['dialogue-4-1']})});
    assert.equal(selectedCue.status,201);
    assert.deepEqual((await selectedCue.json()).selected,['dialogue-4-1']);
    assert.equal(db.prepare("SELECT count(*) count FROM jobs WHERE episode_id=2 AND kind='audio_cue' AND state='wartet'").get().count,1);
    const cueJob=db.prepare("SELECT id FROM jobs WHERE episode_id=2 AND kind='audio_cue' ORDER BY id DESC LIMIT 1").get();
    const failedCue=await request(`/api/worker/jobs/${cueJob.id}/fail`,{method:'POST',headers:{'x-framecut-worker':'queue-test-worker','content-type':'application/json'},body:JSON.stringify({detail:'synthetic audio failure'})});
    assert.equal(failedCue.status,200);
    const savedManifest=JSON.parse(db.prepare('SELECT manifest_json FROM episode_audio_manifests WHERE episode_id=2').get().manifest_json);
    const failedManifestCue=savedManifest.cues.find(cue=>cue.id==='dialogue-4-1');
    assert.equal(failedManifestCue.state,'failed');
    assert.equal(failedManifestCue.error,'synthetic audio failure');
    const retryCue=await request('/api/episodes/2/audio-cues/render',{method:'POST',headers,body:JSON.stringify({cueIds:['dialogue-4-1']})});
    assert.equal(retryCue.status,201);
    assert.equal(db.prepare("SELECT count(*) count FROM jobs WHERE episode_id=2 AND kind='audio_cue' AND state='wartet'").get().count,1);
    const foreignCue=await request('/api/episodes/2/audio-cues/render',{method:'POST',headers,body:JSON.stringify({cueIds:['dialogue-1-999']})});
    assert.equal(foreignCue.status,400);
    const soundtrack=await request('/api/episodes/2/audio-auto-soundtrack',{method:'POST',headers,body:'{}'});
    assert.equal(soundtrack.status,200);
    const soundtrackData=await soundtrack.json();
    assert.ok(soundtrackData.added.includes('music'));
    assert.ok(soundtrackData.added.includes('ambience'));
    assert.ok(soundtrackData.added.includes('sfx'));

    const production=await request('/api/episodes/2/audio-production',{method:'POST',headers,body:JSON.stringify({refineWithAi:false,allowUnreviewed:true})});
    assert.equal(production.status,202);
    const productionData=await production.json();
    assert.ok(productionData.cues >= 3);
    assert.equal(productionData.automation.auto_mix,true);
    assert.equal(productionData.automation.auto_export,true);
    const productionManifest=JSON.parse(db.prepare('SELECT manifest_json FROM episode_audio_manifests WHERE episode_id=2').get().manifest_json);
    assert.equal(productionManifest.audio_pipeline_version,2);
    assert.ok(productionManifest.cues.some(cue=>cue.id==='auto-music-bed'));
    assert.ok(productionManifest.cues.some(cue=>cue.id==='auto-ambience-bed'));
    assert.equal(productionManifest.automation.state,'rendering_tracks');
  } finally {
    db?.close(); proc.kill(); await once(proc,'exit'); rmSync(dir,{recursive:true,force:true});
  }
});
