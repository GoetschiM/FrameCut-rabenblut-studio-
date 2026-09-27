import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Windows updater replaces adapter files in-place, keeps data and backs up old code', {skip:process.platform !== 'win32'}, () => {
  const temp = mkdtempSync(join(tmpdir(), 'fc-updater-test-'));
  try {
    const stage=join(temp,'stage'), root=join(temp,'worker');
    for(const p of [join(stage,'adapters','test'),join(stage,'data'),join(root,'adapters','test'),join(root,'data','updates')])mkdirSync(p,{recursive:true});
    writeFileSync(join(stage,'adapters','test','client.py'),'new adapter');
    writeFileSync(join(root,'adapters','test','client.py'),'old adapter');
    writeFileSync(join(stage,'data','settings.json'),'must not copy');
    writeFileSync(join(root,'data','settings.json'),'preserve me');
    const source=readFileSync(new URL('../worker/FrameCut-Worker-Update.ps1',import.meta.url),'utf8');
    const block=source.slice(source.indexOf('    $stagePrefix='),source.indexOf('    Log "Update auf Version'));
    assert.ok(block.includes('Copy-Item'));
    const q=s=>"'"+s.replaceAll("'","''")+"'";
    const script=`$ErrorActionPreference='Stop'; $stage=${q(stage)}; $WorkerRoot=${q(root)}; $updateRoot=Join-Path $WorkerRoot 'data/updates'; ${block}; Write-Output $backup`;
    const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    assert.equal(readFileSync(join(root,'adapters','test','client.py'),'utf8'),'new adapter');
    assert.equal(readFileSync(join(root,'data','settings.json'),'utf8'),'preserve me');
    assert.equal(existsSync(join(root,'adapters','adapters')),false);
    assert.equal(readFileSync(join(result.stdout.trim(),'adapters','test','client.py'),'utf8'),'old adapter');
  } finally {rmSync(temp,{recursive:true,force:true});}
});
