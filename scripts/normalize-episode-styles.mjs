// One-time, user-authorized cleanup of the known legacy style bibles.
// Preserve every story, shot and reference; queued jobs read the updated style.
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const data=process.env.FRAMECUT_DATA_DIR;
if(!data||process.env.FRAMECUT_STYLE_CONFIRM!=='NORMALIZE_LEGACY_STYLES')throw new Error('Explicit data path and style-cleanup confirmation required.');
const db=new DatabaseSync(join(data,'studio.db'));db.exec('PRAGMA busy_timeout=5000');
if(db.prepare("SELECT id FROM jobs WHERE kind='minimax_h3' AND state='läuft' LIMIT 1").get())throw new Error('Wait for active video rendering before changing style.');
const styles={
 leo:'Modern European feature-film 3D animation. Consistent softly sculpted stylized characters, warm cinematic storytelling, expressive faces, soft volumetric lighting, tactile matte materials, restrained warm color palette, cinematic depth of field and family-friendly atmosphere. One coherent 3D rendering medium across the episode, with identical character proportions and materials. Reference photos define identity and outfit only, not a competing art medium. Full-frame 16:9 composition. No change to flat 2D illustration, no collage, no white studio background, no text, logos or watermarks. Locations and props come exclusively from the current scene.',
 noir:'Dark fantasy comic-book illustration with a consistent 1990s ink-noir aesthetic. Heavy dramatic black inking, high-contrast chiaroscuro, deep shadows, intricate cross-hatching, restrained red and toxic-green color accents, matte newsprint texture and expressive drawn anatomy. Keep one hand-drawn comic medium throughout, never glossy 3D or photorealism. Full-frame cinematic 16:9. No text, logos, watermarks or reference-sheet backgrounds. Characters, costumes, poses, locations and props come exclusively from the current scene and its selected references.',
 cartoon:'Single full-frame animated scene in the visual style of Rick and Morty: consistent classic 2D adult animation, clean bold black outlines, flat saturated colors, expressive cartoon proportions and simple cel shading. Maintain identical line weight, palette and flat rendering across the episode. No 3D rendering or photorealism, no text, logos, collage or reference-sheet backgrounds. Full-frame 16:9. Characters, actions, locations and objects come exclusively from the scene and its selected references.'
};
const episodes=db.prepare('SELECT e.*,p.title project_title FROM episodes e JOIN projects p ON p.id=e.project_id ORDER BY e.id').all();
const stamp=new Date().toISOString().replace(/[:.]/g,'-');await mkdir(join(data,'backups'),{recursive:true});
const snapshot=join(data,'backups',`before-style-cleanup-${stamp}.db`);await backup(db,snapshot);
const report={checkedAt:new Date().toISOString(),backup:snapshot,episodes:[]};
db.exec('BEGIN IMMEDIATE');try{
 for(const e of episodes){
  const current=e.style_profile||'';
  const next=e.project_title==='Leos Abenteuer'&&/Modern European 3D animation/.test(current)?styles.leo:e.project_title==='Rabenblut'&&/1990s Image Comics/.test(current)?styles.noir:e.project_title==='Testing'&&/unhinged mad scientist/.test(current)?styles.cartoon:current;
  if(next!==current)db.prepare('UPDATE episodes SET style_profile=? WHERE id=?').run(next,e.id);
  const shots=db.prepare('SELECT count(*) total,sum(CASE WHEN output_video_path IS NOT NULL THEN 1 ELSE 0 END) rendered,min(created_at) oldest,max(created_at) newest FROM shots WHERE episode_id=?').get(e.id);
  report.episodes.push({id:e.id,project:e.project_title,title:e.title,changed:next!==current,before:current,after:next,shots});
 }
 for(const p of db.prepare('SELECT id,title,style_profile FROM projects').all()){
  if(p.title==='Leos Abenteuer'&&/Modern European 3D animation/.test(p.style_profile||''))db.prepare('UPDATE projects SET style_profile=? WHERE id=?').run(styles.leo,p.id);
  if(p.title==='Rabenblut'&&/1990s Image Comics/.test(p.style_profile||''))db.prepare('UPDATE projects SET style_profile=? WHERE id=?').run(styles.noir,p.id);
 }
 db.exec('COMMIT');
}catch(error){db.exec('ROLLBACK');throw error;}
await writeFile(join(data,`style-audit-${stamp}.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify({backup:snapshot,episodes:report.episodes.map(({before,after,...e})=>e)}));db.close();
