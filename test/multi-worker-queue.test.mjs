import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('two workers atomically claim different jobs and queue exposes both assignments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'framecut-multi-worker-'));
  const port = 14382;
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd:new URL('..', import.meta.url),
    env:{ ...process.env, FRAMECUT_DATA_DIR:dir, RABENBLUT_STUDIO_PORT:String(port), RABENBLUT_STUDIO_HOST:'127.0.0.1', FRAMECUT_WORKER_TOKEN:'test-fleet-token' }
  });
  let logs = '';
  proc.stdout.on('data', value => logs += value);
  proc.stderr.on('data', value => logs += value);
  let db;
  try {
    for (let index=0; index<100 && !logs.includes('FrameCut:'); index += 1) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(logs, /FrameCut:/, logs);
    db = new DatabaseSync(join(dir, 'studio.db'));
    const now = new Date().toISOString();
    db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (1,?,?,?,?)').run('test','Test','unused',now);
    db.prepare('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES (?,1,?,?)').run('test-session',new Date(Date.now()+60_000).toISOString(),now);
    db.prepare('INSERT INTO projects(id,slug,title,source_path,created_at,style_profile) VALUES (1,?,?,?,?,?)').run('fleet','Fleet','',now,'Cinematic animation.');
    db.prepare('INSERT INTO episodes(id,project_id,number,title,created_at) VALUES (1,1,1,?,?)').run('Parallel',now);
    for (let id=1; id<=2; id += 1) {
      db.prepare('INSERT INTO shots(id,episode_id,sequence,title,prompt,camera,seed,created_at) VALUES (?,1,?,?,?,?,?,?)').run(id,id,`Shot ${id}`,`Scene ${id}`,'Wide',100+id,now);
      db.prepare('INSERT INTO jobs(id,episode_id,shot_id,kind,label,state,created_at) VALUES (?,1,?,?,?, ?,?)').run(id,id,'minimax_h3',`Job ${id}`,'wartet',now);
    }
    const base = `http://127.0.0.1:${port}`;
    const userHeaders = {cookie:'rabenblut_session=test-session','content-type':'application/json'};
    const codeResponse = await fetch(base + '/api/workers/join-codes', {method:'POST',headers:userHeaders,body:'{}'});
    assert.equal(codeResponse.status, 201);
    const invitation = await codeResponse.json();
    const registrationResponse = await fetch(base + '/api/worker/register', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({joinCode:invitation.code,name:'Old Worker',installerVersion:'old-version'})});
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json();
    const incompatibleHeaders = {'x-framecut-worker':registration.workerToken,'x-framecut-worker-id':registration.workerId,'content-type':'application/json'};
    const heartbeatResponse = await fetch(base + '/api/worker/heartbeat', {method:'POST',headers:incompatibleHeaders,body:JSON.stringify({status:'ready'})});
    assert.equal(heartbeatResponse.status, 200);
    assert.equal((await heartbeatResponse.json()).status, 'awaiting_runtime');
    assert.equal((await fetch(base + '/api/worker/next', {headers:incompatibleHeaders})).status, 409);
    const claim = workerId => fetch(base + '/api/worker/next', { headers:{'x-framecut-worker':'test-fleet-token','x-framecut-worker-id':workerId} });
    const [firstResponse, secondResponse] = await Promise.all([claim('worker-a'), claim('worker-b')]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const [first, second] = await Promise.all([firstResponse.json(), secondResponse.json()]);
    assert.notEqual(first.job.id, second.job.id);
    const running = db.prepare("SELECT id,worker_id FROM jobs WHERE state='läuft' ORDER BY id").all();
    assert.deepEqual(running.map(item => item.worker_id).sort(), ['worker-a','worker-b']);
    const queueResponse = await fetch(base + '/api/queue', { headers:{cookie:'rabenblut_session=test-session'} });
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json();
    assert.equal(queue.runningCount, 2);
    assert.equal(queue.onlineWorkerCount, 2);
    assert.equal(queue.workers.filter(item => item.activeJob).length, 2);
    assert.equal(new Set(queue.queue.map(item => item.worker_id)).size, 2);
  } finally {
    db?.close();
    proc.kill();
    await once(proc, 'exit');
    rmSync(dir, { recursive:true, force:true });
  }
});
