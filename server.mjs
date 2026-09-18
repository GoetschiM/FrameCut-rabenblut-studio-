import http from 'node:http';
import { readFile, stat, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { buildReferencePrompt } from './lib/reference-prompt.mjs';
import { audioPreflight, createEpisodeAudioManifest, validateAudioManifest } from './lib/audio-manifest.mjs';

const APP = resolve(import.meta.dirname);
const WORKSPACE = resolve(APP, '..');
// On the laptop this remains ./data.  The LXC sets FRAMECUT_DATA_DIR so
// database, uploads and retained project data survive application updates.
const DATA = resolve(process.env.FRAMECUT_DATA_DIR || join(APP, 'data'));
const UPLOADS = join(DATA, 'uploads');
const db = new DatabaseSync(join(DATA, 'studio.db'));
const PORT = Number(process.env.RABENBLUT_STUDIO_PORT || 4317);
const HOST = process.env.RABENBLUT_STUDIO_HOST || '127.0.0.1';
const WORKER_TOKEN = process.env.FRAMECUT_WORKER_TOKEN || '';
const KEY_ENCRYPTION = process.env.FRAMECUT_KEY_ENCRYPTION_KEY || '';
const OIDC_ISSUER = process.env.FRAMECUT_OIDC_ISSUER || 'https://auth.rebelone.ch/application/o/framecut/';
const OIDC_CLIENT_ID = process.env.FRAMECUT_OIDC_CLIENT_ID || '';
const OIDC_CLIENT_SECRET = process.env.FRAMECUT_OIDC_CLIENT_SECRET || '';
const OIDC_REDIRECT_URI = process.env.FRAMECUT_OIDC_REDIRECT_URI || 'https://framecut.rebelone.ch/api/auth/oidc/callback';
const oidcStates = new Map();
const sessions = new Map();
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.mp4':'video/mp4', '.wav':'audio/wav', '.mp3':'audio/mpeg', '.srt':'text/plain; charset=utf-8', '.md':'text/markdown; charset=utf-8' };
function mediaPath(relative) {
  const value = String(relative || '').replaceAll('\\', '/');
  // New uploads deliberately use a portable data/ prefix instead of a host path.
  return value.startsWith('data/') ? resolve(DATA, value.slice(5)) : resolve(WORKSPACE, value);
}
function permittedMediaPath(target) {
  return [WORKSPACE, DATA].some(root => target === root || target.startsWith(root + sep));
}

db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, synopsis TEXT, source_path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS episodes (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, duration_seconds REAL, manifest_path TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, episode_id INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, label TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS story_documents (episode_id INTEGER PRIMARY KEY, markdown TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assets (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', visual_notes TEXT NOT NULL DEFAULT '', file_path TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS episode_assets (episode_id INTEGER NOT NULL, asset_id INTEGER NOT NULL, PRIMARY KEY(episode_id,asset_id));
CREATE TABLE IF NOT EXISTS shot_assets (shot_id INTEGER NOT NULL, asset_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'reference', PRIMARY KEY(shot_id,asset_id,role));
CREATE TABLE IF NOT EXISTS shots (id INTEGER PRIMARY KEY, episode_id INTEGER NOT NULL, sequence INTEGER NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', camera TEXT NOT NULL DEFAULT '', duration_seconds REAL NOT NULL DEFAULT 5, seed INTEGER, status TEXT NOT NULL DEFAULT 'Entwurf', source_image_path TEXT, output_video_path TEXT, created_at TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS user_provider_keys (user_id INTEGER NOT NULL, provider TEXT NOT NULL, encrypted_key TEXT NOT NULL, model TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,provider));
CREATE TABLE IF NOT EXISTS auto_plan_drafts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, episode_id INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT, target_seconds REAL NOT NULL, recommended_seconds REAL NOT NULL, style_profile TEXT NOT NULL DEFAULT '', adaptation_mode TEXT NOT NULL DEFAULT 'cinematic', reference_asset_ids TEXT NOT NULL DEFAULT '[]', analysis_json TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT);`);
db.exec(`CREATE TABLE IF NOT EXISTS episode_exports (id INTEGER PRIMARY KEY,episode_id INTEGER NOT NULL,name TEXT NOT NULL,file_path TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'mp4',created_at TEXT NOT NULL);`);
// Stores a reviewed cue plan only. Media artifacts and provider configuration remain
// on the audio worker, never in the web server database.
db.exec(`CREATE TABLE IF NOT EXISTS episode_audio_manifests (episode_id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, manifest_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, last_seen TEXT NOT NULL, first_seen TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS story_versions (id INTEGER PRIMARY KEY, episode_id INTEGER NOT NULL, markdown TEXT NOT NULL, saved_at TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS trash (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, payload TEXT NOT NULL, deleted_at TEXT NOT NULL, deleted_by INTEGER);`);
db.exec(`CREATE TABLE IF NOT EXISTS prompt_overrides (purpose TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER);`);
db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '', prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_story_versions_ep ON story_versions(episode_id, id DESC);`);
// Every query above ran as a full table scan until now.
db.exec(`CREATE INDEX IF NOT EXISTS idx_shots_episode ON shots(episode_id, sequence);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, id);
CREATE INDEX IF NOT EXISTS idx_jobs_shot ON jobs(shot_id, state);
CREATE INDEX IF NOT EXISTS idx_jobs_episode ON jobs(episode_id);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
CREATE INDEX IF NOT EXISTS idx_episode_assets_ep ON episode_assets(episode_id);
CREATE INDEX IF NOT EXISTS idx_shot_assets_shot ON shot_assets(shot_id);
CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project_id, number);
CREATE INDEX IF NOT EXISTS idx_exports_episode ON episode_exports(episode_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);`);
try { db.exec("ALTER TABLE shots ADD COLUMN render_tier TEXT NOT NULL DEFAULT 'Vorschau'"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE shots ADD COLUMN kind TEXT NOT NULL DEFAULT 'scene'"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE episodes ADD COLUMN style_profile TEXT"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE episodes ADD COLUMN video_steps INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE episodes ADD COLUMN photo_steps INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE episodes ADD COLUMN preview_width INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE episodes ADD COLUMN preview_height INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE episodes ADD COLUMN final_width INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE episodes ADD COLUMN final_height INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE jobs ADD COLUMN owner_id INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE jobs ADD COLUMN worker_id TEXT"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE jobs ADD COLUMN shot_id INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE jobs ADD COLUMN asset_id INTEGER"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN style_profile TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
// A project can define a default exclusion list; an episode may override it.  Keep the
// episode column nullable so an empty episode setting means "inherit", rather than an
// accidental global empty override.
try { db.exec("ALTER TABLE projects ADD COLUMN negative_prompt TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE episodes ADD COLUMN negative_prompt TEXT"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN video_steps INTEGER NOT NULL DEFAULT 4"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN photo_steps INTEGER NOT NULL DEFAULT 8"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN preview_width INTEGER NOT NULL DEFAULT 384"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN preview_height INTEGER NOT NULL DEFAULT 224"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN final_width INTEGER NOT NULL DEFAULT 768"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN final_height INTEGER NOT NULL DEFAULT 448"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE auto_plan_drafts ADD COLUMN reference_asset_ids TEXT NOT NULL DEFAULT '[]'"); } catch { /* column already exists */ }
db.exec(`CREATE TABLE IF NOT EXISTS asset_photos (id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL, file_path TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
db.exec(`INSERT INTO asset_photos (asset_id, file_path, is_primary, created_at)
  SELECT id, file_path, 1, created_at FROM assets
  WHERE file_path IS NOT NULL AND id NOT IN (SELECT asset_id FROM asset_photos)`);
// `assets.file_path` is the worker-facing primary reference. Older projects can have
// an asset_photos primary that differs from this legacy column, which otherwise makes
// the editor and the worker use different images for the same asset.
db.exec(`UPDATE assets
  SET file_path = (SELECT p.file_path FROM asset_photos p WHERE p.asset_id=assets.id AND p.is_primary=1 ORDER BY p.id DESC LIMIT 1)
  WHERE EXISTS (SELECT 1 FROM asset_photos p WHERE p.asset_id=assets.id AND p.is_primary=1)`);
try { db.exec("ALTER TABLE assets ADD COLUMN voice TEXT"); } catch { /* column already exists */ }
db.exec(`CREATE TABLE IF NOT EXISTS shot_dialogue (id INTEGER PRIMARY KEY, shot_id INTEGER NOT NULL, asset_id INTEGER, sequence INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, created_at TEXT NOT NULL)`);
try { db.exec("ALTER TABLE episodes ADD COLUMN archived_at TEXT"); } catch { /* column already exists */ }

const now = () => new Date().toISOString();
const row = (query, ...params) => db.prepare(query).get(...params);
const rows = (query, ...params) => db.prepare(query).all(...params);
const run = (query, ...params) => db.prepare(query).run(...params);

function audioContextForEpisode(episodeId, ownerId) {
  const episode = row('SELECT e.*,p.id project_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=?', episodeId);
  if (!episode) return null;
  const shots = rows('SELECT id,sequence,duration_seconds FROM shots WHERE episode_id=? ORDER BY sequence,id', episodeId);
  const dialogue = shots.length ? rows(`SELECT d.id,d.shot_id,d.asset_id,d.sequence,d.text,a.voice
    FROM shot_dialogue d LEFT JOIN assets a ON a.id=d.asset_id
    WHERE d.shot_id IN (${shots.map(() => '?').join(',')}) ORDER BY d.shot_id,d.sequence,d.id`, ...shots.map(shot => shot.id)) : [];
  const generated = createEpisodeAudioManifest({ ownerId, projectId: episode.project_id, episodeId, shots, dialogue });
  const saved = row('SELECT manifest_json,updated_at FROM episode_audio_manifests WHERE episode_id=? AND owner_id=?', episodeId, ownerId);
  let manifest = generated, source = 'automatisch aus Shot-Timeline und Dialogen erstellt', updatedAt = null;
  if (saved) {
    try { manifest = JSON.parse(saved.manifest_json); source = 'gespeicherter Audio-Plan'; updatedAt = saved.updated_at; }
    catch { source = 'beschädigter gespeicherter Audio-Plan'; }
  }
  const preflight = audioPreflight(manifest, { expectedSourceRevision: generated.source_revision, mixingWorkerAvailable: false });
  return { episode, generated, manifest, source, updatedAt, ...preflight };
}

function expectedAudioIdentity(account, episode) {
  return { owner_id: `owner-${account.id}`, project_id: `project-${episode.project_id}`, episode_id: `episode-${episode.id}` };
}

// Negative prompts become part of a model request, so keep them bounded and textual.
// Returning `undefined` lets PATCH routes distinguish "not touched" from "clear it".
function optionalNegativePrompt(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error('Der Negativ-Prompt muss Text sein.');
  const text = value.replaceAll('\u0000', '').trim();
  if (text.length > 2400) throw new Error('Der Negativ-Prompt darf höchstens 2400 Zeichen haben.');
  return text;
}
function event(label, detail = '') { run('INSERT INTO activity(label,detail,created_at) VALUES (?,?,?)', label, detail, now()); }
function missingReferenceAssets(shotIds) {
  if (!shotIds.length) return [];
  const marks = shotIds.map(() => '?').join(',');
  return rows(`SELECT DISTINCT a.*
    FROM shot_assets sa JOIN assets a ON a.id=sa.asset_id
    WHERE sa.shot_id IN (${marks}) AND (a.file_path IS NULL OR a.file_path='')
    ORDER BY a.kind,a.name`, ...shotIds);
}
function queueMissingReferencePreviews(episode, ownerId, shotIds) {
  const missing = missingReferenceAssets(shotIds);
  let queued = 0;
  for (const asset of missing) {
    // A failed reference requires an intentional retry from the editor; silently
    // creating it over and over would hide a real ComfyUI or prompt problem.
    if (row("SELECT id FROM jobs WHERE asset_id=? AND kind='comfyui_reference_preview' AND state IN ('wartet','läuft','fehlgeschlagen')", asset.id)) continue;
    const prompt = buildReferencePrompt(asset, episode.style_profile || '');
    run('INSERT INTO jobs(episode_id,kind,label,state,detail,created_at,owner_id,asset_id) VALUES (?,?,?,?,?,?,?,?)', episode.id, 'comfyui_reference_preview', `ComfyUI · Referenz: ${asset.name}`, 'wartet', prompt, now(), ownerId || null, asset.id);
    queued++;
  }
  return { queued, missing: missing.length };
}
function recoverQueuedReferenceGaps() {
  // Covers jobs that were queued before the prerequisite system existed.  Reference
  // jobs are always selected before video jobs, and the selector below refuses to
  // hand a video to the worker until every linked reference has a primary image.
  const episodes = rows(`SELECT DISTINCT e.id,e.project_id,COALESCE(e.style_profile,p.style_profile) style_profile,j.owner_id
    FROM jobs j JOIN episodes e ON e.id=j.episode_id JOIN projects p ON p.id=e.project_id
    WHERE j.kind='minimax_h3' AND j.state='wartet'
      AND EXISTS (SELECT 1 FROM shot_assets sa JOIN assets a ON a.id=sa.asset_id WHERE sa.shot_id=j.shot_id AND (a.file_path IS NULL OR a.file_path=''))`);
  for (const episode of episodes) {
    const shotIds = rows("SELECT shot_id FROM jobs WHERE episode_id=? AND kind='minimax_h3' AND state='wartet' AND shot_id IS NOT NULL", episode.id).map(j => j.shot_id);
    queueMissingReferencePreviews(episode, episode.owner_id, shotIds);
  }
}
function assertText(value, label, limit = 8000) { const result = String(value || '').trim(); if (!result) throw new Error(`${label} darf nicht leer sein.`); if (result.length > limit) throw new Error(`${label} ist zu lang.`); return result; }
function hash(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function validPassword(password, saved) {
  try {
    const [salt, value] = String(saved || '').split(':');
    if (!salt || !value) return false;
    const expected = Buffer.from(value, 'hex');
    const candidate = scryptSync(password, salt, 64);
    return expected.length === candidate.length && timingSafeEqual(candidate, expected);
  } catch { return false; }
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
function createSession(account) {
  const token = randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES (?,?,?,?)', token, account.id, new Date(Date.now() + SESSION_TTL_MS).toISOString(), now());
  return token;
}

// Simple in-memory throttle so the local password login cannot be brute forced.
const loginAttempts = new Map();
function loginBlocked(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > 15 * 60 * 1000) { loginAttempts.delete(key); return false; }
  return entry.count >= 10;
}
function noteLoginFailure(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.first > 15 * 60 * 1000) loginAttempts.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
}
function encryptionKey() { if (!KEY_ENCRYPTION) throw new Error('Die sichere Schlüsselablage ist noch nicht eingerichtet. Bitte den Serveradministrator informieren.'); return createHash('sha256').update(KEY_ENCRYPTION).digest(); }
function encryptSecret(value) { const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv); const payload=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]); return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${payload.toString('base64')}`; }
function decryptSecret(value) { const [iv,tag,payload]=String(value||'').split('.'); if(!iv||!tag||!payload) throw new Error('Gespeicherter API-Schlüssel ist ungültig.'); const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'base64')); decipher.setAuthTag(Buffer.from(tag,'base64')); return Buffer.concat([decipher.update(Buffer.from(payload,'base64')),decipher.final()]).toString('utf8'); }
function providerKey(accountId, provider) { const saved=row('SELECT * FROM user_provider_keys WHERE user_id=? AND provider=?',accountId,provider); return saved ? {...saved,key:decryptSecret(saved.encrypted_key)} : null; }
function cleanDialogue(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 10).map(line => ({
    assetName: String(line?.assetName || '').trim().slice(0, 100),
    text: String(line?.text || '').trim().slice(0, 1000),
  })).filter(line => line.text);
}
function cleanPlan(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Die KI lieferte keinen lesbaren Produktionsplan.');
  const assets=(Array.isArray(raw.assets)?raw.assets:[]).slice(0,30).map(x=>({kind:['character','location','prop'].includes(x?.kind)?x.kind:'prop',name:String(x?.name||'').trim().slice(0,100),summary:String(x?.summary||'').trim().slice(0,1400),visualNotes:String(x?.visualNotes||'').trim().slice(0,2200)})).filter(x=>x.name);
  const shots=(Array.isArray(raw.shots)?raw.shots:[]).slice(0,80).map((x,index)=>({title:String(x?.title||`Shot ${index+1}`).trim().slice(0,120),durationSeconds:Math.max(1,Math.min(15,Number(x?.durationSeconds)||5)),camera:String(x?.camera||'Stabile filmische Einstellung.').trim().slice(0,1400),prompt:String(x?.prompt||'').trim().slice(0,5000),assetNames:Array.isArray(x?.assetNames)?x.assetNames.map(v=>String(v).trim()).filter(Boolean).slice(0,10):[],dialogue:cleanDialogue(x?.dialogue)}));
  if (!shots.length) throw new Error('Die KI hat keine Shots vorgeschlagen. Bitte die Story etwas konkreter beschreiben.');
  return {summary:String(raw.summary||'').trim().slice(0,1600),assets,shots};
}
function saveDialogue(shotId, dialogueArr, byName) {
  if (!Array.isArray(dialogueArr)) return;
  let sequence = 0;
  for (const line of dialogueArr.slice(0, 10)) {
    const text = String(line?.text || '').trim().slice(0, 1000);
    if (!text) continue;
    const assetName = String(line?.assetName || '').trim();
    const asset = assetName ? byName.get(assetName.toLowerCase()) : null;
    run('INSERT INTO shot_dialogue(shot_id,asset_id,sequence,text,created_at) VALUES (?,?,?,?,?)', shotId, asset ? asset.id : null, ++sequence, text, now());
  }
}
function mentionsAsset(text, name) {
  const escaped = String(name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped ? new RegExp(`\\b${escaped}\\b`, 'i').test(String(text || '')) : false;
}
function cleanSingleShot(x, fallbackTitle) {
  if (!x || typeof x !== 'object') throw new Error('Die KI lieferte keinen lesbaren Shot.');
  const shot = {title:String(x?.title||fallbackTitle).trim().slice(0,120),durationSeconds:Math.max(1,Math.min(15,Number(x?.durationSeconds)||5)),camera:String(x?.camera||'Stabile filmische Einstellung.').trim().slice(0,1400),prompt:String(x?.prompt||'').trim().slice(0,5000),assetNames:Array.isArray(x?.assetNames)?x.assetNames.map(v=>String(v).trim()).filter(Boolean).slice(0,10):[]};
  if (!shot.prompt) throw new Error('Die KI hat keinen Video-Prompt geliefert.');
  return shot;
}
function cleanAnalysis(raw, requestedSeconds) {
  if (!raw || typeof raw !== 'object') throw new Error('Die KI lieferte keine lesbare Analyse.');
  const assets=(Array.isArray(raw.assets)?raw.assets:[]).slice(0,40).map(x=>({kind:['character','location','prop'].includes(x?.kind)?x.kind:'prop',name:String(x?.name||'').trim().slice(0,100),summary:String(x?.summary||'').trim().slice(0,1400),visualNotes:String(x?.visualNotes||'').trim().slice(0,2200)})).filter(x=>x.name);
  const scenes=(Array.isArray(raw.scenes)?raw.scenes:[]).slice(0,48).map((x,index)=>({title:String(x?.title||`Szene ${index+1}`).trim().slice(0,120),summary:String(x?.summary||'').trim().slice(0,2600),weight:Math.max(1,Math.min(10,Number(x?.weight)||5)),assetNames:Array.isArray(x?.assetNames)?x.assetNames.map(v=>String(v).trim()).filter(Boolean).slice(0,12):[]})).filter(x=>x.summary);
  if (!scenes.length) throw new Error('Die KI konnte keine zusammenhängenden Szenen erkennen.');
  const recommendedSeconds=Math.max(15,Math.min(900,Number(raw.recommendedSeconds)||requestedSeconds));
  return {summary:String(raw.summary||'').trim().slice(0,2400),wordCount:Number(raw.wordCount)||0,feasible:raw.feasible!==false,recommendedSeconds,reason:String(raw.reason||'').trim().slice(0,1600),assets,scenes};
}
const PROMPT_PURPOSES = {
  analysis: 'Story-Analyse (Umfang, Laufzeit, Figuren/Orte erkennen)',
  shot_batch: 'Shot-Generierung (Auto-Modus, pro Szenen-Abschnitt)',
  planner: 'Alter Einzelschritt-Planer (weniger genutzt)',
  intro: 'Intro-Shot (Titel/Stimmungsbild vor der eigentlichen Handlung)',
  outro: 'Outro-Shot (Abschluss, z.B. Figuren-Rückblick)',
};
function promptOverride(purpose, fallback) { const saved = row('SELECT text FROM prompt_overrides WHERE purpose=?', purpose); return saved?.text || fallback; }
const DEFAULT_ANALYSIS_GUIDANCE = `Bewerte ehrlich, ob das Material die Zieldauer trägt. Empfehle bei zu wenig Material eine kürzere Dauer; empfehle bei sehr viel Material entweder starke Verdichtung oder eine sinnvolle Dauer bis maximal 900 Sekunden. Extrahiere alle wiederkehrenden Figuren, Orte und wichtigen Gegenstände mit stabilen visuellen Merkmalen. Zerlege die Handlung chronologisch in 4 bis 48 zusammenhängende Szenen. Erfinde keine Marken, Logos oder urheberrechtlich geschützten Figuren hinzu. Bewahre ausdrücklich vom Benutzer genannte reale Gegenstände und Marken als sichtbares Kontinuitätsmerkmal, ohne zusätzliche Markenwerbung oder erfundene Logos. Füge selbst KEINE zusätzlichen Fahrzeuge, Marken oder Gegenstände hinzu, die nicht explizit in der Story erwähnt werden. WICHTIGE REGEL zu assetNames pro Szene: Trage bei jeder Szene in 'assetNames' NUR die Figuren/Orte/Requisiten ein, die in DIESER KONKRETEN Szene tatsächlich vorkommen - nicht alle Assets, die irgendwo in der gesamten Story auftauchen. Ein Fahrzeug gehört nur in Szenen, die im oder am Fahrzeug spielen, niemals in Innenräume, Büros oder zu Fuß stattfindende Szenen.

WICHTIG zu recommendedSeconds: Das ist eine Beispielstruktur, keine Vorlage für den Wert. Berechne die Zahl individuell aus Wortzahl und Handlungsdichte DIESER Story. Übernimm niemals die Beispielzahl unverändert - wenn deine berechnete Empfehlung zufällig genau der Beispielzahl entspricht, prüfe deine Rechnung noch einmal.`;
const DEFAULT_SHOT_BATCH_GUIDANCE = `Nutze ausschließlich die angegebenen Figuren, Orte, Requisiten und Handlungsereignisse. WICHTIGE REGEL: Ordne Requisiten oder Fahrzeuge und Figuren NUR DANN einem Shot zu ('assetNames'), wenn die Handlung DIESES KONKRETEN Shots das Fahrzeug oder die Figur explizit erfordert. Ignoriere dabei Formulierungen wie "durchgehend sichtbar" oder "immer dabei" in der Asset-Beschreibung - diese Beschreibung erklärt nur, WAS das Objekt in der Geschichte insgesamt ist, sie ist KEINE Anweisung, es in jeden Shot einzufügen. Ein Auto gehört nur in Shots, die tatsächlich im oder am Fahrzeug spielen. Platziere NIEMALS ein Fahrzeug in Innenräume, Büros, Schlafzimmer oder zu Fuß stattfindende Szenen. Erfinde kein Fahrzeug, das im Story-Text für diese Szene nicht vorkommt.

BEISPIEL für die geforderte Prompt-Dichte (Orientierung, nicht wörtlich übernehmen):
Zu dünn (NICHT so): "Karin and the narrator talk while watching Leo. Karin smiles and gestures."
Falsch, weil es Aussehen beschreibt (NICHT so): "Karin, mid-30s with shoulder-length brown hair and a grey cardigan, sits in an armchair..."
Richtig (SO): "Karin sits forward on the edge of a worn leather armchair, elbows resting on her knees, hands moving expressively as she talks. Her expression is warm but tired, her gaze drifting between the narrator and Leo playing on the rug in front of her. Late-afternoon light slants through half-closed blinds behind her, striping the wall in soft gold bars. A muted television flickers in the background, and a mug of tea sits cooling on the side table beside her."

IDENTITÄTS-REGEL (wichtig): Figuren, Fahrzeuge und Requisiten aus der Asset-Liste werden dem Renderer als echte Referenzfotos mitgegeben. Beschreibe deshalb NIEMALS ihr dauerhaftes Aussehen (Alter, Haare, Bart, Statur, Kleidung, Automodell, Farbe). Nenne sie ausschließlich bei ihrem exakten Asset-Namen und beschreibe nur, WAS sie tun.
Falsch: "Der Erzähler, ein Mann mittleren Alters mit kurzen dunklen Haaren und leichtem Bart, trägt Jeans und Pullover, sitzt am Steuer seines dunklen Tesla."
Richtig: "Michel sitzt am Steuer des Tesla, beide Hände locker am Lenkrad, den Blick auf die Einfahrt gerichtet."
Beschreibe dagegen ausführlich: Handlung, Körperhaltung, Bewegung, Gesichtsausdruck, Blickrichtung, Interaktion mit Objekten, Hintergrundgeschehen und Lichtstimmung. Kleidung nur dann, wenn sie sich in dieser Szene ausdrücklich ändert (nass, zerrissen, Jacke ausgezogen).`;
const DEFAULT_PLANNER_GUIDANCE = `Plane abwechslungsreiche Perspektiven: Totale zur Orientierung, Medium, Close-up, Insert und nur bei Bedarf eine dynamische Kamerafahrt. Ein Shot enthält genau eine verständliche Aktion. Wiederkehrende Personen, Orte und Requisiten müssen exakt gleich benannt werden.

WICHTIGE REGEL zu assetNames: Ordne einem Shot in 'assetNames' NUR die Figuren/Orte/Requisiten zu, die in GENAU DIESEM Shot tatsächlich sichtbar sind oder konkret erwähnt werden - nicht alle Assets, die irgendwo in der Geschichte vorkommen. Ein Fahrzeug gehört nur in Shots, die im oder am Fahrzeug spielen, niemals in Innenräume, Büros oder zu Fuß stattfindende Szenen. Jeder Asset-Name in 'assetNames' MUSS auch wörtlich im 'prompt'-Text dieses Shots vorkommen, sonst wird er ignoriert.

BEISPIEL für die geforderte Prompt-Dichte (Orientierung, nicht wörtlich übernehmen):
Zu dünn (NICHT so): "Karin and the narrator talk while watching Leo. Karin smiles and gestures."
Falsch, weil es Aussehen beschreibt (NICHT so): "Karin, mid-30s with shoulder-length brown hair and a grey cardigan, sits in an armchair..."
Richtig (SO): "Karin sits forward on the edge of a worn leather armchair, elbows resting on her knees, hands moving expressively as she talks. Her expression is warm but tired, her gaze drifting between the narrator and Leo playing on the rug in front of her. Late-afternoon light slants through half-closed blinds behind her, striping the wall in soft gold bars. A muted television flickers in the background, and a mug of tea sits cooling on the side table beside her."

IDENTITÄTS-REGEL (wichtig): Figuren, Fahrzeuge und Requisiten aus der Asset-Liste werden dem Renderer als echte Referenzfotos mitgegeben. Beschreibe deshalb NIEMALS ihr dauerhaftes Aussehen (Alter, Haare, Bart, Statur, Kleidung, Automodell, Farbe). Nenne sie ausschließlich bei ihrem exakten Asset-Namen und beschreibe nur, WAS sie tun.
Falsch: "Der Erzähler, ein Mann mittleren Alters mit kurzen dunklen Haaren und leichtem Bart, trägt Jeans und Pullover, sitzt am Steuer seines dunklen Tesla."
Richtig: "Michel sitzt am Steuer des Tesla, beide Hände locker am Lenkrad, den Blick auf die Einfahrt gerichtet."
Beschreibe dagegen ausführlich: Handlung, Körperhaltung, Bewegung, Gesichtsausdruck, Blickrichtung, Interaktion mit Objekten, Hintergrundgeschehen und Lichtstimmung. Kleidung nur dann, wenn sie sich in dieser Szene ausdrücklich ändert (nass, zerrissen, Jacke ausgezogen).`;
function analysisInstruction(story, targetSeconds, styleProfile, adaptationMode, existingAssets=[]) { const targetShots=Math.max(4,Math.round(targetSeconds/6));
  const existingBlock = existingAssets.length ? `

IM PROJEKT BEREITS VORHANDENE FIGUREN, ORTE UND REQUISITEN - das sind reale, oft schon mit echten Fotos hinterlegte Einträge:
${existingAssets.map(a=>`- "${a.name}" (${a.kind})${a.summary?': '+a.summary:''}`).join('\n')}

KRITISCHE REGEL: Kommt eine dieser Figuren/Orte/Requisiten in der Story vor, verwende in deiner Antwort EXAKT denselben Namen, Zeichen für Zeichen identisch (inklusive Klammern, Schreibweise, Groß-/Kleinschreibung). Erstelle NIEMALS eine neue, leicht abgewandelte Variante eines bereits vorhandenen Namens (z.B. nicht "Zuhause" wenn bereits "Wohnung des Erzählers" existiert, nicht "Michel" wenn bereits "Michel (ich)" existiert) - das würde ein Duplikat ohne Referenzfoto erzeugen und die Bild-/Videoqualität für diese Figur zerstören. Nur wenn etwas WIRKLICH neu ist, das keinem vorhandenen Eintrag entspricht, darfst du einen neuen Namen vergeben.` : '';
  return `Du analysierst eine vom Benutzer geschriebene Geschichte für eine KI-Videoproduktion. Gewünscht sind ${targetSeconds} Sekunden und ungefähr ${targetShots} kurze Shots. Stil: ${styleProfile || 'kinematografisch und visuell konsistent'}. Bearbeitungsmodus: ${adaptationMode==='faithful'?'streng werkgetreu verdichten; nichts Neues erfinden':'filmisch ausbauen; Übergänge, Reaktionen und visuelle Zwischenmomente ergänzen, aber keine neuen Hauptfiguren, Wendungen oder Enden erfinden'}.${existingBlock}

${promptOverride('analysis', DEFAULT_ANALYSIS_GUIDANCE)}

Antworte ausschließlich als valides JSON:
{"summary":"kompakte Inhaltsangabe","wordCount":123,"feasible":true,"recommendedSeconds":245,"reason":"klare Begründung zur Laufzeit, die die tatsächliche Wortzahl/Szenenzahl dieser Story nennt","assets":[{"kind":"character|location|prop","name":"eindeutiger Name","summary":"Rolle und Funktion","visualNotes":"AUSFÜHRLICHER Bildprompt in ganzen Sätzen (nicht nur Stichworte), der als Grundlage für ein KI-Referenzbild dient: für Figuren Statur, Gesicht, Haare, typische Kleidung; für Orte die räumliche Anordnung, Materialien, Lichtstimmung, Atmosphäre; für Requisiten Form, Material, Farbe, Zustand. Mindestens 2-3 vollständige Sätze."}],"scenes":[{"title":"Szenentitel","summary":"AUSFÜHRLICHER Inhalt dieser Szene (mind. 3-4 Sätze): was konkret passiert, wer was tut, wie sich Personen bewegen und verhalten, welche Stimmung herrscht, was im Raum/Ort zu sehen ist. Kein Kurzsatz.","weight":5,"assetNames":["exakte Namen aus assets"]}]}

BENUTZER-STORY:
${story}`; }
function shotBatchInstruction(analysis, scenes, seconds, styleProfile, adaptationMode) { const expected=Math.max(scenes.length,Math.round(seconds/6)); return `Du erstellst aus bereits analysierten Szenen einen editierbaren KI-Video-Shotplan. Gesamter Stil: ${styleProfile || 'kinematografisch und visuell konsistent'}. Bearbeitungsmodus: ${adaptationMode}. Plane für diesen Abschnitt ungefähr ${seconds} Sekunden und ${expected} Shots.

${promptOverride('shot_batch', DEFAULT_SHOT_BATCH_GUIDANCE)}

PFLICHTFELD 'dialogue' bei jedem Shot: Prüfe für jeden Shot, ob die Handlung an dieser Stelle ein Gespräch oder eine Aussage impliziert (z.B. "sagt", "fragt", "antwortet", "ruft" o.ä. im Story-Text). Falls ja, formuliere dafür 1-3 kurze deutsche Dialogzeilen im Feld 'dialogue'. Falls nicht, setze 'dialogue' auf ein leeres Array [] - das Feld muss trotzdem immer vorhanden sein. Erfinde dabei keine neuen Handlungsinhalte, nur plausible Sätze zu dem, was laut Story ohnehin gerade passiert.

Antworte ausschließlich als valides JSON: {"summary":"Abschnitt","assets":[],"shots":[{"title":"kurzer Shotname","durationSeconds":5,"camera":"konkrete Bildgröße, Optik und Kamerabewegung","prompt":"präziser englischer Video-Prompt mit GENAU EINER Handlung, aber ausführlich beschrieben (mindestens 3-4 Sätze): Körperhaltung und Bewegung, Gesichtsausdruck und Blickrichtung, konkrete Interaktion mit Objekten/Umgebung, Hintergrundgeschehen, Lichtstimmung. Figuren/Fahrzeuge NUR beim exakten Asset-Namen nennen, ihr Aussehen NICHT beschreiben (dafür gibt es Referenzfotos). no text, no logo, no watermark","assetNames":["exakter Assetname"],"dialogue":[{"assetName":"exakter Name aus VERFÜGBARE ASSETS oder leer für Erzähler/Off","text":"kurze deutsche Dialogzeile"}]}]}. Wechsle sinnvoll zwischen Establishing, Medium, Close-up, Insert und dynamischer Bewegung. Kein Shot über 12 Sekunden.

VERFÜGBARE ASSETS:
${analysis.assets.map(a=>`${a.name} (${a.kind}): ${a.summary}; ${a.visualNotes}`).join('\n')}

SZENEN DIESES ABSCHNITTS:
${scenes.map((s,i)=>`${i+1}. ${s.title}: ${s.summary} [Assets: ${s.assetNames.join(', ')}]`).join('\n')}`; }
function plannerInstruction(story, targetSeconds, styleProfile) { return `Du bist ein Produktionsplaner für originale KI-Videos. Die Geschichte stammt vollständig vom Benutzer. Erfinde keine neue Haupthandlung, keine neuen Ereignisse oder Wendungen. Extrahiere daraus nur einen konkreten, editierbaren Filmplan. Ziel: ungefähr ${targetSeconds} Sekunden. Stil: ${styleProfile || 'kinematografisch, erwachsen, präzise, ohne Marken oder Logos'}.

PFLICHTFELD 'dialogue' bei jedem Shot: Prüfe für jeden Shot, ob die Story an dieser Stelle ein Gespräch oder eine Aussage impliziert (z.B. "sagt", "fragt", "antwortet", "ruft" o.ä. im Story-Text). Falls ja, formuliere dafür 1-3 kurze deutsche Dialogzeilen im Feld 'dialogue'. Falls nicht, setze 'dialogue' auf ein leeres Array [] - das Feld muss trotzdem immer vorhanden sein. Erfinde dabei keine neuen Handlungsinhalte, nur plausible Sätze zu dem, was laut Story ohnehin gerade passiert.

Erstelle ausschließlich valides JSON ohne Markdown in diesem Schema:
{"summary":"kurz","assets":[{"kind":"character|location|prop","name":"eindeutiger Name","summary":"Funktion und Erkennungsmerkmale","visualNotes":"Aussehen, Kleidung, Farben, Material, wiederkehrende Details"}],"shots":[{"title":"kurzer Shotname","durationSeconds":5,"camera":"konkrete Kamerabewegung / Bildgröße / Optik","prompt":"englischer Video-Prompt mit GENAU EINER Handlung, aber ausführlich (mindestens 3-4 Sätze): Körperhaltung/Bewegung, Gesichtsausdruck, Blickrichtung, Interaktion mit Objekten/Umgebung, Hintergrundaktivität, Lichtstimmung. Figuren/Fahrzeuge NUR beim exakten Asset-Namen nennen, ihr Aussehen NICHT beschreiben (dafür gibt es Referenzfotos). Keine Schrift oder Logos","assetNames":["Name aus assets"],"dialogue":[{"assetName":"Julia","text":"Beispiel: Wie war dein Tag?"}]}]}

BEISPIEL für 'dialogue' (zeigt das Format, nicht den Inhalt - nutze die Story, nicht dieses Beispiel): Enthält der Shot-Prompt sinngemäß "Julia fragt, wie sein Tag war", dann: "dialogue":[{"assetName":"Julia","text":"Wie war dein Tag?"}]. Kommt in einem Shot kein Sprechen vor, dann: "dialogue":[].

${promptOverride('planner', DEFAULT_PLANNER_GUIDANCE)}

BENUTZER-STORY:
${story}`; }
const DEFAULT_INTRO_GUIDANCE = `Das ist KEINE Szene aus der Handlung, sondern eine eigenständige Eröffnungseinstellung, die VOR der eigentlichen Geschichte läuft - vergleichbar mit einem Filmvorspann oder Titelkarte. Erfasse Stimmung, Thema und visuellen Stil der Geschichte, ohne ein konkretes Handlungsereignis vorwegzunehmen oder Figuren in einer Aktion aus der Story zu zeigen. Geeignet sind z.B. ein symbolträchtiges Bild, eine Landschaft/ein Ort aus der Geschichte in besonderer Lichtstimmung, ein Objekt von Bedeutung, oder eine abstrakte Einstellung, die zum Ton der Geschichte passt (düster, warmherzig, spannend, etc. - je nach Story). Kurz halten: 3 bis 6 Sekunden. Nenne Figuren nur über assetNames, falls überhaupt eine gebraucht wird - meist reicht Ort/Stimmung/Objekt allein.`;
const DEFAULT_OUTRO_GUIDANCE = `Das ist KEINE Szene aus der Handlung, sondern eine eigenständige Abschluss-Einstellung, die NACH dem Ende der eigentlichen Geschichte läuft - vergleichbar mit einem Abspann-Moment. Blicke auf die Geschichte zurück: zeige z.B. die wichtigsten Figuren noch einmal (ruhig, ohne neue Handlung), oder einen Ort/ein Objekt, das die Geschichte thematisch abschliesst. Erfinde keine neue Handlung und keinen neuen Konflikt. Kurz halten: 3 bis 6 Sekunden. Nutze bei Bedarf 1 bis 3 der VERFÜGBAREN FIGUREN über assetNames, aber nur wenn es zur Geschichte passt.`;
function introOutroInstruction(kind, story, styleProfile, existingAssets=[]) {
  const isIntro = kind === 'intro';
  const assetsBlock = existingAssets.length ? `\n\nVERFÜGBARE FIGUREN/ORTE/REQUISITEN (nur diese exakten Namen in assetNames verwenden):\n${existingAssets.map(a=>`- "${a.name}" (${a.kind})`).join('\n')}` : '';
  return `Du erstellst GENAU EINEN ${isIntro ? 'Intro' : 'Outro'}-Shot für ein KI-generiertes Video, basierend auf folgender Geschichte.

${promptOverride(kind, isIntro ? DEFAULT_INTRO_GUIDANCE : DEFAULT_OUTRO_GUIDANCE)}

Stil: ${styleProfile || 'kinematografisch und visuell konsistent'}.${assetsBlock}

WICHTIG für assetNames: Jede Figur/jeder Ort/jede Requisite, die im prompt-Text vorkommt (auch nur namentlich erwähnt), MUSS mit ihrem exakten Namen in assetNames aufgeführt werden. Das Video-Model bekommt nur für dort gelistete Namen ein echtes Referenzfoto - fehlt der Name in assetNames, sieht die Figur im Video falsch/generisch aus, selbst wenn sie im Prompt-Text genannt wird. assetNames ist also nicht optional, sondern die Voraussetzung dafür, dass die Figur korrekt aussieht.

Antworte ausschließlich als valides JSON: {"title":"kurzer Name","durationSeconds":5,"camera":"konkrete Bildgröße, Optik und Kamerabewegung","prompt":"englischer Video-Prompt, ausführlich (mindestens 2-3 Sätze): Bildkomposition, Bewegung, Lichtstimmung. Figuren NUR beim exakten Asset-Namen nennen, ihr Aussehen NICHT beschreiben. no text, no logo, no watermark","assetNames":["jede im prompt genannte Figur/Ort/Requisite, exakter Name"]}

GESCHICHTE (nur zur Orientierung, NICHT als Handlung dieses Shots verwenden):
${story}`;
}
function recordAiUsage(userId, provider, model, purpose, usage) {
  if (!userId || !usage) return;
  try {
    run('INSERT INTO ai_usage(user_id,provider,model,purpose,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?)',
      userId, provider, model || '', purpose || '', usage.promptTokens||0, usage.completionTokens||0, usage.totalTokens||0, now());
  } catch (error) { console.error('AI usage logging failed:', error.message); }
}
async function callProviderJson(provider, key, model, instruction, meta = {}) {
  let response, data, text;
  try {
  if (provider === 'gemini') {
    const selected=model || 'gemini-2.5-flash';
    response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selected)}:generateContent`,{method:'POST',signal:AbortSignal.timeout(120000),headers:{'content-type':'application/json','x-goog-api-key':key},body:JSON.stringify({contents:[{role:'user',parts:[{text:instruction}]}],generationConfig:{response_mime_type:'application/json',temperature:0.35}})});
    data=await response.json(); text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('');
    if(response.ok && data?.usageMetadata) recordAiUsage(meta.userId,provider,selected,meta.purpose,{promptTokens:data.usageMetadata.promptTokenCount,completionTokens:data.usageMetadata.candidatesTokenCount,totalTokens:data.usageMetadata.totalTokenCount});
  } else {
    const isDeepseek=provider==='deepseek'; const endpoint=isDeepseek?'https://api.deepseek.com/chat/completions':'https://api.openai.com/v1/chat/completions'; const selected=model || (isDeepseek?'deepseek-chat':'gpt-4.1-mini');
    response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(120000),headers:{'content-type':'application/json','authorization':`Bearer ${key}`},body:JSON.stringify({model:selected,messages:[{role:'system',content:'Return only valid JSON.'},{role:'user',content:instruction}],response_format:{type:'json_object'},temperature:0.35})});
    data=await response.json(); text=data?.choices?.[0]?.message?.content;
    if(response.ok && data?.usage) recordAiUsage(meta.userId,provider,selected,meta.purpose,{promptTokens:data.usage.prompt_tokens,completionTokens:data.usage.completion_tokens,totalTokens:data.usage.total_tokens});
  }
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('Der KI-Anbieter hat nicht innerhalb von 2 Minuten geantwortet. Bitte erneut versuchen.');
    throw error;
  }
  if(!response.ok) throw new Error(`KI-Anbieter: ${data?.error?.message || `HTTP ${response.status}`}`);
  try { return JSON.parse(String(text||'').replace(/^```json\s*|\s*```$/g,'')); } catch { throw new Error('Die KI-Antwort war kein gültiges JSON. Bitte erneut versuchen.'); }
}
async function callPlanner(provider,key,model,instruction,meta={}){return cleanPlan(await callProviderJson(provider,key,model,instruction,meta));}
function savePlanToEpisode(episode, plan, styleProfile, styleReferenceIds=[], replaceExisting=false) {
  if(styleProfile)run('UPDATE projects SET style_profile=? WHERE id=?',styleProfile,episode.project_id);
  if (replaceExisting) {
    run('DELETE FROM shot_assets WHERE shot_id IN (SELECT id FROM shots WHERE episode_id=?)', episode.id);
    run('DELETE FROM shots WHERE episode_id=?', episode.id);
  }
  const known=new Map(rows('SELECT * FROM assets WHERE project_id=?',episode.project_id).map(a=>[a.name.trim().toLowerCase(),a])); let createdAssets=0;
  for(const item of plan.assets){const key=item.name.toLowerCase();let asset=known.get(key);if(!asset){const result=run('INSERT INTO assets(project_id,kind,name,summary,visual_notes,created_at) VALUES (?,?,?,?,?,?)',episode.project_id,item.kind,item.name,item.summary,item.visualNotes,now());asset=row('SELECT * FROM assets WHERE id=?',Number(result.lastInsertRowid));known.set(key,asset);createdAssets++;}else{run(`UPDATE assets SET summary=CASE WHEN summary='' THEN ? ELSE summary END,visual_notes=CASE WHEN visual_notes='' THEN ? ELSE visual_notes END WHERE id=?`,item.summary,item.visualNotes,asset.id);}run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)',episode.id,asset.id);}
  const start=(row('SELECT MAX(sequence) max FROM shots WHERE episode_id=?',episode.id)?.max||0); const byName=new Map([...known.values()].map(a=>[a.name.trim().toLowerCase(),a])); const styleRefs=styleReferenceIds.map(Number).filter(id=>row('SELECT id FROM assets WHERE id=? AND project_id=?',id,episode.project_id)); let index=0;
  for(const item of plan.shots){const result=run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',episode.id,start+(++index),item.title,item.prompt,item.camera,item.durationSeconds,Math.floor(Math.random()*9000000)+1000000,'Entwurf',now());const shotId=Number(result.lastInsertRowid);const usedAssetIds=new Set();for(const assetName of item.assetNames){const asset=byName.get(assetName.toLowerCase());if(asset && mentionsAsset(item.prompt,assetName)){run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)',shotId,asset.id,'reference');usedAssetIds.add(asset.id);}}for(const assetId of styleRefs){if(!usedAssetIds.has(assetId))run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)',shotId,assetId,'style');}saveDialogue(shotId,item.dialogue,byName);}
  run('UPDATE episodes SET duration_seconds=? WHERE id=?',rows('SELECT duration_seconds FROM shots WHERE episode_id=?',episode.id).reduce((sum,s)=>sum+Number(s.duration_seconds||0),0),episode.id);
  return {createdAssets,createdShots:index};
}
async function smokePlanExistingProject() {
  const projectName=String(process.env.FRAMECUT_SMOKE_PROJECT||'Michel Tagebuch').trim();
  const project=row('SELECT * FROM projects WHERE lower(title)=lower(?)',projectName);
  if(!project) throw new Error(`Projekt „${projectName}“ wurde nicht gefunden.`);
  const episode=row('SELECT * FROM episodes WHERE project_id=? ORDER BY number LIMIT 1',project.id);
  const story=row('SELECT markdown FROM story_documents WHERE episode_id=?',episode.id)?.markdown?.trim();
  if(!story || story.length<30) throw new Error('Im gewählten Projekt ist keine ausreichende Story gespeichert.');
  if(row('SELECT count(*) count FROM shots WHERE episode_id=?',episode.id).count>0) throw new Error('Die Episode enthält bereits Shots; der Smoke-Test legt deshalb keine Duplikate an.');
  const account=row('SELECT * FROM users ORDER BY id LIMIT 1');
  const available=rows("SELECT provider FROM user_provider_keys WHERE user_id=? ORDER BY CASE provider WHEN 'gemini' THEN 1 WHEN 'deepseek' THEN 2 ELSE 3 END",account.id);
  if(!available.length) throw new Error('Für den Benutzer ist noch kein KI-Anbieter eingerichtet.');
  const provider=String(process.env.FRAMECUT_SMOKE_PROVIDER||available[0].provider);
  const stored=providerKey(account.id,provider);
  if(!stored) throw new Error(`Für ${provider} ist kein Schlüssel gespeichert.`);
  const targetSeconds=Math.max(150,Math.min(600,Number(process.env.FRAMECUT_SMOKE_SECONDS)||300));
  const styleProfile=String(process.env.FRAMECUT_SMOKE_STYLE||'Original cinematic Swiss neo-cyberpunk. Night sequences use deep indigo, black glass, magenta and cyan practical light; daylight family scenes remain warm, humane and believable while preserving subtle cyberpunk production design. Any vehicle that appears must remain visually consistent across scenes, matching its established silhouette and details. Grounded real Swiss roads, homes and restaurant environments. Consistent faces, clothing, vehicle and geography. Dynamic but readable camera language: establishing shots, inserts, reaction close-ups, gentle dolly moves, occasional fast cuts and one restrained dolly zoom. 16:9 widescreen, cinematic contrast, natural motion, no captions, no watermarks, no invented logos.').slice(0,2400);
  const analysis=cleanAnalysis(await callProviderJson(provider,stored.key,stored.model||'',analysisInstruction(story,targetSeconds,styleProfile,'cinematic'),{userId:account.id,purpose:'analysis'}),targetSeconds);
  analysis.wordCount=story.split(/\s+/).filter(Boolean).length;
  const recommended=Math.max(150,Math.min(300,analysis.recommendedSeconds||targetSeconds));
  const draft=run('INSERT INTO auto_plan_drafts(user_id,episode_id,provider,model,target_seconds,recommended_seconds,style_profile,adaptation_mode,reference_asset_ids,analysis_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',account.id,episode.id,provider,stored.model||'',targetSeconds,recommended,styleProfile,'cinematic','[]',JSON.stringify(analysis),now());
  const totalWeight=analysis.scenes.reduce((sum,s)=>sum+s.weight,0)||analysis.scenes.length;
  const shots=[];
  for(let offset=0;offset<analysis.scenes.length;offset+=3){
    const sceneBatch=analysis.scenes.slice(offset,offset+3),weight=sceneBatch.reduce((sum,s)=>sum+s.weight,0);
    const batchSeconds=Math.max(sceneBatch.length*3,Math.round(recommended*weight/totalWeight));
    const batch=await callPlanner(provider,stored.key,stored.model||'',shotBatchInstruction(analysis,sceneBatch,batchSeconds,styleProfile,'cinematic'),{userId:account.id,purpose:'shot_batch'});
    shots.push(...batch.shots);
  }
  const plan={summary:analysis.summary,assets:analysis.assets,shots:shots.slice(0,140)};
  const saved=savePlanToEpisode({...episode,project_title:project.title},plan,styleProfile,[]);
  run('UPDATE auto_plan_drafts SET committed_at=? WHERE id=?',now(),Number(draft.lastInsertRowid));
  event('Auto-Smoke-Test fertig',`${project.title} · ${analysis.scenes.length} Szenen, ${saved.createdShots} Shots.`);
  return {project:project.title,episode:episode.title,provider,targetSeconds,recommendedSeconds:recommended,scenes:analysis.scenes.length,assets:analysis.assets.length,shots:saved.createdShots};
}
function cookie(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x[0])); }
function user(req) {
  const token = cookie(req).rabenblut_session;
  if (!token) return null;
  const found = row('SELECT s.expires_at, u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token);
  if (!found) return null;
  if (new Date(found.expires_at).getTime() < Date.now()) { run('DELETE FROM sessions WHERE token=?', token); return null; }
  return { id: found.id, username: found.username, displayName: found.display_name };
}
function json(res, status, data, headers = {}) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data)); }
async function body(req, limit=2_000_000) { let text = ''; for await (const chunk of req) { text += chunk; if(text.length>limit) throw new Error('Die Eingabe ist zu groß.'); } try { return JSON.parse(text || '{}'); } catch { throw new Error('Ungültige Daten.'); } }
function guard(req, res) { const account = user(req); if (!account) { json(res, 401, { error:'Bitte zuerst anmelden.' }); return null; } return account; }
function workerGuard(req, res) { if (!WORKER_TOKEN || req.headers['x-framecut-worker'] !== WORKER_TOKEN) { json(res, 401, { error:'Worker nicht autorisiert.' }); return false; } return true; }
function hydrateRabenblut(project) {
  const episode=row('SELECT * FROM episodes WHERE project_id=? ORDER BY number LIMIT 1',project.id); const manifest=join(WORKSPACE,'assets','ravenblood-comic','episode-v4','production-manifest.json');
  if(!episode || !existsSync(manifest) || row('SELECT COUNT(*) count FROM assets WHERE project_id=?',project.id).count) return project;
  const library=[
    ['character','Baron von Rabenblut','Der Held. Stille Wucht, schwarze Rabenrüstung und smaragdgrüne Energie.','assets/ravenblood-comic/characters-v2/01-baron-reference-front.png'],['character','Michel','Der Gegenspieler. Kaltes Lächeln, rotes Maschinenlicht und eine okkulte Ring-Aura.','assets/ravenblood-comic/characters-v2/02-michel-reference-front.png'],['character','Botenrabe','Lebender Rabe, Bote und Verbündeter.','assets/ravenblood-comic/characters-v2/03-botenrabe-reference.png'],['character','Maschinenwächter','Metallener Vollstrecker mit rotem Sehschlitz.','assets/ravenblood-comic/characters-v2/04-waechter-reference-front.png'],['location','Dach & Glockenwerk','Nasse Dächer, Regen, rote Tür und schwarze Stadt.','assets/ravenblood-comic/locations-final-v2/01-dach-master.png'],['location','Eiserner Zugang','Brücke, Geländer, Dampf und die rote Schwelle.','assets/ravenblood-comic/locations-final-v2/02-zugang-detail.png'],['location','Maschinenhalle','Glocken, Dampf, Leitungen und der rote Herz-Kern.','assets/ravenblood-comic/locations-final-v2/03-maschinenhalle-master.png'],['location','Maschinenkern','Der dunkle Kern hinter Eisenstäben.','assets/ravenblood-comic/locations-final-v2/04-maschinenkern-detail.png']];
  for(const [kind,name,summary,filePath] of library){const a=run('INSERT INTO assets(project_id,kind,name,summary,file_path,created_at) VALUES (?,?,?,?,?,?)',project.id,kind,name,summary,filePath,now());run('INSERT INTO episode_assets(episode_id,asset_id) VALUES (?,?)',episode.id,Number(a.lastInsertRowid))}
  run('INSERT OR IGNORE INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?)',episode.id,'# Der letzte Herzschlag\n\nÜber der schwarzen Stadt erhält Baron von Rabenblut eine blutgezeichnete Botschaft. Im Glockenwerk der Maschinenhalle setzt Michel den Herz-Kern in Bewegung.',now());
  const plan=JSON.parse(requireText(manifest)); for(const [i,s] of plan.shots.entries()){const prompt=existsSync(join(WORKSPACE,s.prompt_file))?requireText(join(WORKSPACE,s.prompt_file)).trim():'';run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,source_image_path,output_video_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',episode.id,i+1,s.name,prompt,'',Number(s.frames||124)/24,s.seed,'bereit',s.image,`assets/ravenblood-comic/episode-v4/shots/${s.name}.mp4`,now())}
  event('Rabenblut-Material ergänzt','Figuren, Orte, Prompt-Daten und Shots sind jetzt editierbar.');return project;
}
function hydrateShotAssetLinks() {
  const project=row('SELECT * FROM projects WHERE slug=?','rabenblut'); if(!project || row('SELECT COUNT(*) count FROM shot_assets').count) return;
  const episode=row('SELECT * FROM episodes WHERE project_id=? AND number=1',project.id); const manifest=episode?.manifest_path; if(!episode || !manifest || !existsSync(manifest)) return;
  const byPath=new Map(rows('SELECT id,file_path FROM assets WHERE project_id=?',project.id).map(a=>[a.file_path,a.id])); const plan=JSON.parse(requireText(manifest)); const shots=rows('SELECT * FROM shots WHERE episode_id=? ORDER BY sequence',episode.id); const link=run;
  for(const [index,item] of plan.shots.entries()){const shot=shots[index];if(!shot)continue;for(const path of [item.image,...(item.reference_images||[])]){const assetId=byPath.get(path);if(assetId)link('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)',shot.id,assetId,item.image===path?'anchor':'reference')}}
}
function importRabenblut() {
  const existing = row('SELECT * FROM projects WHERE slug=?', 'rabenblut'); if (existing) return hydrateRabenblut(existing);
  const source = join(WORKSPACE, 'assets', 'ravenblood-comic');
  const manifest = join(source, 'episode-v4', 'production-manifest.json');
  if (!existsSync(manifest)) throw new Error('Das Rabenblut-Manifest wurde nicht gefunden.');
  const project = run('INSERT INTO projects(slug,title,synopsis,source_path,created_at) VALUES (?,?,?,?,?)', 'rabenblut', 'Rabenblut', 'Baron von Rabenblut gegen Michel – Der letzte Herzschlag.', source, now());
  const projectId = Number(project.lastInsertRowid);
  const episodeInsert = run('INSERT INTO episodes(project_id,number,title,duration_seconds,manifest_path,created_at) VALUES (?,?,?,?,?,?)', projectId, 1, 'Der letzte Herzschlag', 361.7, manifest, now());
  const episodeId = Number(episodeInsert.lastInsertRowid);
  const library = [
    ['character','Baron von Rabenblut','Der Held. Stille Wucht, schwarze Rabenrüstung und smaragdgrüne Energie.','assets/ravenblood-comic/characters-v2/01-baron-reference-front.png'],
    ['character','Michel','Der Gegenspieler. Kaltes Lächeln, rotes Maschinenlicht und eine okkulte Ring-Aura.','assets/ravenblood-comic/characters-v2/02-michel-reference-front.png'],
    ['character','Botenrabe','Lebender Rabe, Bote und Verbündeter.','assets/ravenblood-comic/characters-v2/03-botenrabe-reference.png'],
    ['character','Maschinenwächter','Metallener Vollstrecker mit rotem Sehschlitz.','assets/ravenblood-comic/characters-v2/04-waechter-reference-front.png'],
    ['location','Dach & Glockenwerk','Nasse Dächer, Regen, rote Tür und schwarze Stadt.','assets/ravenblood-comic/locations-final-v2/01-dach-master.png'],
    ['location','Eiserner Zugang','Brücke, Geländer, Dampf und die rote Schwelle.','assets/ravenblood-comic/locations-final-v2/02-zugang-detail.png'],
    ['location','Maschinenhalle','Glocken, Dampf, Leitungen und der rote Herz-Kern.','assets/ravenblood-comic/locations-final-v2/03-maschinenhalle-master.png'],
    ['location','Maschinenkern','Der dunkle Kern hinter Eisenstäben.','assets/ravenblood-comic/locations-final-v2/04-maschinenkern-detail.png']
  ];
  for (const [kind,name,summary,filePath] of library) { const asset=run('INSERT INTO assets(project_id,kind,name,summary,file_path,created_at) VALUES (?,?,?,?,?,?)',projectId,kind,name,summary,filePath,now()); run('INSERT INTO episode_assets(episode_id,asset_id) VALUES (?,?)',episodeId,Number(asset.lastInsertRowid)); }
  const outline = `# Der letzte Herzschlag\n\nÜber der schwarzen Stadt erhält Baron von Rabenblut eine blutgezeichnete Botschaft. Im Glockenwerk der Maschinenhalle setzt Michel den Herz-Kern in Bewegung. Der Baron folgt dem Botenraben durch Regen, Eisen und Dampf, bis nur ein einziges Zeitfenster zwischen ihm und dem Kern bleibt.`;
  run('INSERT INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?)',episodeId,outline,now());
  const plan = JSON.parse(requireText(manifest));
  for (const [index, shot] of plan.shots.entries()) { const prompt=existsSync(join(WORKSPACE,shot.prompt_file)) ? requireText(join(WORKSPACE,shot.prompt_file)).trim() : ''; run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,source_image_path,output_video_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',episodeId,index+1,shot.name,prompt,'',Number(shot.frames||124)/24,shot.seed,'bereit',shot.image,`assets/ravenblood-comic/episode-v4/shots/${shot.name}.mp4`,now()); }
  event('Episode 01 importiert', '70 geplante Shots, Audio, Untertitel und Master-Datei verknüpft.');
  return row('SELECT * FROM projects WHERE id=?', Number(project.lastInsertRowid));
}
function episodeData(projectId, episodeId) {
  const project = projectId ? row('SELECT * FROM projects WHERE id=?',projectId) : (row('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY id LIMIT 1') || row('SELECT * FROM projects ORDER BY id LIMIT 1'));
  if (!project) return null;
  const episode = episodeId ? row('SELECT e.*, p.title project_title, p.slug, p.source_path FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=? AND e.project_id=?',episodeId,project.id) : (row('SELECT e.*, p.title project_title, p.slug, p.source_path FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.project_id=? AND e.archived_at IS NULL ORDER BY e.number LIMIT 1',project.id) || row('SELECT e.*, p.title project_title, p.slug, p.source_path FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.project_id=? ORDER BY e.number LIMIT 1',project.id));
  if (!episode) return null;
  const asset = relative => relative && existsSync(mediaPath(relative)) ? `/media/${encodeURIComponent(relative.replaceAll('\\','/'))}` : null;
  const shotRefs=rows('SELECT sa.shot_id,a.id,a.name,a.kind,a.file_path FROM shot_assets sa JOIN assets a ON a.id=sa.asset_id WHERE sa.shot_id IN (SELECT id FROM shots WHERE episode_id=?)',episode.id); const refMap=new Map(); for(const ref of shotRefs){if(!refMap.has(ref.shot_id))refMap.set(ref.shot_id,[]);refMap.get(ref.shot_id).push({...ref,url:asset(ref.file_path)});}
  const shots=rows('SELECT * FROM shots WHERE episode_id=? ORDER BY sequence',episode.id).map(s=>({...s, code:s.title, frames:Math.round(s.duration_seconds*24), image:asset(s.source_image_path), video:asset(s.output_video_path), references:refMap.get(s.id)||[]}));
  const assets=rows('SELECT a.* FROM assets a JOIN episode_assets ea ON ea.asset_id=a.id WHERE ea.episode_id=? ORDER BY a.kind,a.name',episode.id).map(a=>({...a,url:asset(a.file_path)}));
  const story=row('SELECT markdown,updated_at FROM story_documents WHERE episode_id=?',episode.id)?.markdown || '';
  const storedFinals=rows('SELECT name,file_path,type FROM episode_exports WHERE episode_id=? ORDER BY id DESC',episode.id).filter(x=>existsSync(mediaPath(x.file_path))).map(x=>({name:x.name,url:asset(x.file_path),type:x.type}));
  const legacyFinals = [
    'assets/ravenblood-comic/episode-v4/RABENBLUT-Episode-01-Final-HD.mp4',
    'assets/ravenblood-comic/episode-v4/audio/RABENBLUT-Episode-01-Finalmix.wav',
    'assets/ravenblood-comic/episode-v4/audio/RABENBLUT-Episode-01-Deutsch.srt'
  ].filter(p => project.slug==='rabenblut' && existsSync(join(WORKSPACE,p))).map(path => ({ name:basename(path), url:asset(path), type:extname(path).slice(1) }));
  const finals=[...storedFinals,...legacyFinals];
  return { project, episode, shots, assets, story, finals, episodes:rows('SELECT * FROM episodes WHERE project_id=? AND (archived_at IS NULL OR id=?) ORDER BY number',project.id,episode.id) };
}
function requireText(file) { return readFileSyncCompat(file); }
function readFileSyncCompat(file) { const fs = process.getBuiltinModule('node:fs'); return fs.readFileSync(file, 'utf8'); }
// startRender() removed: it shelled out to a laptop-only python script that does not exist on the server.
async function serveFile(res, file, cacheable = false) { try { const info = await stat(file); if (!info.isFile()) throw new Error(); const ext = extname(file).toLowerCase(); res.writeHead(200, { 'content-type':MIME[ext] || 'application/octet-stream', 'content-length':info.size, 'cache-control': cacheable ? 'private, max-age=604800' : 'no-cache, no-store, must-revalidate' }); (await import('node:fs')).createReadStream(file).pipe(res); } catch { json(res,404,{error:'Datei nicht gefunden.'}); } }

setInterval(() => {
  try {
    const orphaned = rows(`SELECT j.id, j.shot_id FROM jobs j WHERE j.state='läuft' AND j.worker_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM jobs newer WHERE newer.worker_id = j.worker_id AND newer.started_at > j.started_at)`);
    const timedOut = rows(`SELECT id, shot_id FROM jobs WHERE state='läuft' AND started_at IS NOT NULL AND started_at < ?`,
      new Date(Date.now() - 90 * 60 * 1000).toISOString());
    const seen = new Set();
    for (const job of [...orphaned, ...timedOut]) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      run("UPDATE jobs SET state='fehlgeschlagen', detail=?, completed_at=? WHERE id=? AND state='läuft'",
        'Automatisch freigegeben: der Worker hat diesen Auftrag nicht abgeschlossen.', now(), job.id);
      if (job.shot_id) {
        const shot = row('SELECT output_video_path FROM shots WHERE id=?', job.shot_id);
        run('UPDATE shots SET status=? WHERE id=?', shot?.output_video_path ? 'Gerendert' : 'Entwurf', job.shot_id);
      }
      event('Hängender Auftrag freigegeben', `Job ${job.id}`);
    }
    // Transient infra hiccups (worker unreachable mid-swap, H3/ComfyUI not yet ready) look
    // identical from here to a genuinely broken job - retry a bounded number of times before
    // asking a human to look, instead of leaving every blip as a permanent failure.
    const TRANSIENT_PATTERN = /nicht bereit|Verbindung|hängt|pinokio haengt|timeout|zeitüberschreitung/i;
    const retryable = rows(`SELECT id, shot_id, asset_id, detail, retry_count FROM jobs
      WHERE state='fehlgeschlagen' AND retry_count < 2 AND completed_at > datetime('now','-10 minutes')`);
    for (const job of retryable) {
      if (!TRANSIENT_PATTERN.test(job.detail || '')) continue;
      const nextAttempt = job.retry_count + 1;
      run("UPDATE jobs SET state='wartet', started_at=NULL, worker_id=NULL, completed_at=NULL, retry_count=?, detail=? WHERE id=? AND state='fehlgeschlagen'",
        nextAttempt, `Automatischer Neuversuch ${nextAttempt}/2 nach: ${job.detail}`, job.id);
      if (job.shot_id) run("UPDATE shots SET status='in Warteschlange' WHERE id=?", job.shot_id);
      event('Auftrag automatisch erneut versucht', `Job ${job.id} · Versuch ${nextAttempt}/2`);
    }
  } catch (error) { console.error('Stale job sweep failed:', error.message); }
}, 2 * 60 * 1000).unref();

setInterval(() => {
  try {
    run('DELETE FROM sessions WHERE expires_at < ?', now());
    run('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 2000)');
    run('DELETE FROM trash WHERE deleted_at < ?', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
  } catch (error) { console.error('Housekeeping failed:', error.message); }
}, 60 * 60 * 1000).unref();

const existingRabenblut = row('SELECT * FROM projects WHERE slug=?', 'rabenblut'); if (existingRabenblut) hydrateRabenblut(existingRabenblut); hydrateShotAssetLinks();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`); const path = url.pathname;
  try {
    if (path === '/api/bootstrap' && req.method === 'GET') return json(res,200,{setup:!row('SELECT id FROM users LIMIT 1')});
    if (path === '/api/setup' && req.method === 'POST') { if (row('SELECT id FROM users LIMIT 1')) return json(res,409,{error:'Studio ist bereits eingerichtet.'}); const data = await body(req); if (!data.username || !data.password || data.password.length < 10) return json(res,400,{error:'Name und ein Passwort mit mindestens 10 Zeichen sind nötig.'}); run('INSERT INTO users(username,display_name,password_hash,created_at) VALUES (?,?,?,?)', data.username.trim(), (data.displayName || data.username).trim(), hash(data.password), now()); importRabenblut(); event('Studio eingerichtet', `Administrator ${data.username} angelegt.`); return json(res,201,{ok:true}); }
    if (path === '/api/login' && req.method === 'POST') {
      const data = await body(req);
      const username = (data.username || '').trim();
      const throttleKey = `${req.socket.remoteAddress || 'unknown'}|${username.toLowerCase()}`;
      if (loginBlocked(throttleKey)) return json(res, 429, { error: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
      const account = row('SELECT * FROM users WHERE username=?', username);
      if (!account || !validPassword(data.password || '', account.password_hash)) { noteLoginFailure(throttleKey); return json(res, 401, { error: 'Anmeldung nicht möglich.' }); }
      loginAttempts.delete(throttleKey);
      const token = createSession(account);
      const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.headers['host']?.includes('rebelone.ch');
      return json(res, 200, { ok: true }, { 'set-cookie': `rabenblut_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${isSecure ? '; Secure' : ''}` });
    }
    if (path === '/api/logout' && req.method === 'POST') {
      run('DELETE FROM sessions WHERE token=?', cookie(req).rabenblut_session || '');
      const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.headers['host']?.includes('rebelone.ch');
      return json(res, 200, { ok: true }, { 'set-cookie': `rabenblut_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isSecure ? '; Secure' : ''}` });
    }
    if (path === '/api/auth/oidc/login' && req.method === 'GET') {
      const state = randomBytes(16).toString('hex');
      oidcStates.set(state, Date.now());
      for (const [k, v] of oidcStates) { if (Date.now() - v > 600000) oidcStates.delete(k); }
      const authUrl = `https://auth.rebelone.ch/application/o/authorize/?client_id=${encodeURIComponent(OIDC_CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(OIDC_REDIRECT_URI)}&scope=openid+profile+email&state=${state}`;
      res.writeHead(302, { 'Location': authUrl });
      return res.end();
    }
    if (path === '/api/auth/oidc/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const authError = url.searchParams.get('error');
      if (authError) {
        console.error('Authentik returned error:', authError, url.searchParams.get('error_description'));
        res.writeHead(302, { 'Location': `/?error=${encodeURIComponent(authError)}` });
        return res.end();
      }
      if (!state || !oidcStates.has(state)) {
        res.writeHead(302, { 'Location': '/?error=ungueltiger_state' });
        return res.end();
      }
      oidcStates.delete(state);
      if (!code) {
        res.writeHead(302, { 'Location': '/?error=kein_code' });
        return res.end();
      }
      try {
        const tokenParams = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: OIDC_REDIRECT_URI,
          client_id: OIDC_CLIENT_ID,
          client_secret: OIDC_CLIENT_SECRET
        });
        const tokenRes = await fetch('https://auth.rebelone.ch/application/o/token/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString()
        });
        if (!tokenRes.ok) {
          const errTxt = await tokenRes.text();
          console.error('Authentik token exchange failed:', tokenRes.status, errTxt);
          res.writeHead(302, { 'Location': '/?error=token_austausch_fehlgeschlagen' });
          return res.end();
        }
        const tokenData = await tokenRes.json();
        const userRes = await fetch('https://auth.rebelone.ch/application/o/userinfo/', {
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        if (!userRes.ok) {
          const errTxt = await userRes.text();
          console.error('Authentik userinfo failed:', userRes.status, errTxt);
          res.writeHead(302, { 'Location': '/?error=benutzer_abruf_fehlgeschlagen' });
          return res.end();
        }
        const uinfo = await userRes.json();
        const username = (uinfo.preferred_username || uinfo.nickname || uinfo.email?.split('@')[0] || 'authentik-user').trim().toLowerCase();
        const displayName = (uinfo.name || uinfo.given_name || username).trim();

        let account = row('SELECT * FROM users WHERE username=?', username);
        if (!account) {
          run('INSERT INTO users(username,display_name,password_hash,created_at) VALUES (?,?,?,?)', username, displayName, hash(randomBytes(32).toString('hex')), now());
          account = row('SELECT * FROM users WHERE username=?', username);
          event('Neuer Benutzer über Authentik', `${displayName} (@${username})`);
        }
        const token = createSession(account);
        const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.headers['host']?.includes('rebelone.ch');
        res.writeHead(302, {
          'Location': '/',
          'Set-Cookie': `rabenblut_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${isSecure ? '; Secure' : ''}`
        });
        return res.end();
      } catch (err) {
        console.error('OIDC Callback exception:', err);
        res.writeHead(302, { 'Location': '/?error=oidc_fehler' });
        return res.end();
      }
    }
    if (path === '/api/me' && req.method === 'GET') return json(res,200,{user:user(req)});
    if (path === '/api/settings/providers' && req.method === 'GET') { const account=guard(req,res); if(!account)return; const userRows=rows('SELECT provider,model,updated_at FROM user_provider_keys WHERE user_id=?',account.id); const configured=new Map(userRows.map(r=>[r.provider,r])); return json(res,200,{providers:['gemini','openai','deepseek'].map(provider=>({provider,configured:configured.has(provider),model:configured.get(provider)?.model||'',updatedAt:configured.get(provider)?.updated_at||null}))}); }
    if (path === '/api/settings/prompts' && req.method === 'GET') { const account=guard(req,res); if(!account)return; const defaults={analysis:DEFAULT_ANALYSIS_GUIDANCE,shot_batch:DEFAULT_SHOT_BATCH_GUIDANCE,planner:DEFAULT_PLANNER_GUIDANCE,intro:DEFAULT_INTRO_GUIDANCE,outro:DEFAULT_OUTRO_GUIDANCE}; return json(res,200,{prompts:Object.entries(PROMPT_PURPOSES).map(([purpose,label])=>{const saved=row('SELECT text,updated_at FROM prompt_overrides WHERE purpose=?',purpose); return {purpose,label,default:defaults[purpose],current:saved?.text||defaults[purpose],isOverridden:Boolean(saved),updatedAt:saved?.updated_at||null};})}); }
    if (/^\/api\/settings\/prompts\/(analysis|shot_batch|planner|intro|outro)$/.test(path) && req.method === 'PUT') { const account=guard(req,res); if(!account)return; const purpose=path.split('/').pop(),d=await body(req),text=String(d.text||'').trim(); if(!text)return json(res,400,{error:'Der Prompt-Text darf nicht leer sein. Zum Zurücksetzen die Löschen-Funktion nutzen.'}); if(text.length>6000)return json(res,400,{error:'Prompt ist länger als 6000 Zeichen.'}); run('INSERT INTO prompt_overrides(purpose,text,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(purpose) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at,updated_by=excluded.updated_by',purpose,text,now(),account.id); event('KI-Prompt angepasst',`${account.username} · ${PROMPT_PURPOSES[purpose]}`); return json(res,200,{ok:true}); }
    if (/^\/api\/settings\/prompts\/(analysis|shot_batch|planner|intro|outro)$/.test(path) && req.method === 'DELETE') { const account=guard(req,res); if(!account)return; const purpose=path.split('/').pop(); run('DELETE FROM prompt_overrides WHERE purpose=?',purpose); event('KI-Prompt zurückgesetzt',`${account.username} · ${PROMPT_PURPOSES[purpose]}`); return json(res,200,{ok:true}); }
    if (/^\/api\/settings\/providers\/(gemini|openai|deepseek)$/.test(path) && req.method === 'PUT') { const account=guard(req,res); if(!account)return; const provider=path.split('/').pop(),d=await body(req),key=assertText(d.key,'API-Schlüssel',1000); if(key.length<12)return json(res,400,{error:'Der API-Schlüssel scheint zu kurz zu sein.'}); const model=String(d.model||'').trim().slice(0,120); run('INSERT INTO user_provider_keys(user_id,provider,encrypted_key,model,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET encrypted_key=excluded.encrypted_key,model=excluded.model,updated_at=excluded.updated_at',account.id,provider,encryptSecret(key),model,now()); event('KI-Anbieter eingerichtet',`${account.username} · ${provider}`); return json(res,200,{ok:true,provider,configured:true,model}); }
    if (/^\/api\/settings\/providers\/(gemini|openai|deepseek)$/.test(path) && req.method === 'DELETE') { const account=guard(req,res); if(!account)return; run('DELETE FROM user_provider_keys WHERE user_id=? AND provider=?',account.id,path.split('/').pop()); return json(res,200,{ok:true}); }
    if (path === '/api/uploads' && req.method === 'POST') { if (!guard(req,res)) return; const d=await body(req, 25_000_000); const match=String(d.data||'').match(/^data:([\w/+.-]+);base64,(.+)$/); if(!match)return json(res,400,{error:'Die Bilddatei konnte nicht gelesen werden.'}); const allowed=new Set(['image/png','image/jpeg','image/webp']); if(!allowed.has(match[1]))return json(res,400,{error:'Erlaubt sind PNG, JPG und WebP.'}); const bytes=Buffer.from(match[2],'base64'); if(bytes.length>25*1024*1024)return json(res,400,{error:'Datei ist größer als 25 MB.'}); await mkdir(UPLOADS,{recursive:true}); const safe=String(d.name||'referenz').replace(/[^a-zA-Z0-9._-]/g,'-').slice(-80); const file=`${Date.now()}-${randomBytes(5).toString('hex')}-${safe}`; await writeFile(join(UPLOADS,file),bytes); return json(res,201,{path:`data/uploads/${file}`,name:safe}); }
    if (path.startsWith('/media/') && req.method === 'GET') { if (!guard(req,res)) return; const target = mediaPath(decodeURIComponent(path.slice(7))); if (!permittedMediaPath(target) || !existsSync(target)) return json(res,403,{error:'Kein Zugriff auf diese Datei.'}); return serveFile(res,target,true); }
    if (path === '/api/queue' && req.method === 'GET') {
      if (!guard(req,res)) return;
      const items = rows(`SELECT j.id, j.kind, j.label, j.state, j.created_at, j.started_at, j.worker_id, j.owner_id,
        u.username AS owner_username, u.display_name AS owner_display_name,
        e.title AS episode_title, e.number AS episode_number, p.title AS project_title
        FROM jobs j
        LEFT JOIN users u ON u.id = j.owner_id
        LEFT JOIN episodes e ON e.id = j.episode_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE j.state IN ('wartet','läuft')
        ORDER BY CASE j.state WHEN 'läuft' THEN 0 ELSE 1 END, j.id ASC`);
      const avgRow = row(`SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400) AS avgSeconds
        FROM jobs WHERE kind='minimax_h3' AND state='fertig' AND started_at IS NOT NULL AND completed_at IS NOT NULL
        AND completed_at > datetime('now','-7 days')`);
      const avgSeconds = Math.round(avgRow?.avgSeconds || 0) || null;
      let waitingPosition = 0;
      const queue = items.map(item => {
        const isRunning = item.state === 'läuft';
        if (!isRunning) waitingPosition += 1;
        const etaSeconds = (!isRunning && avgSeconds) ? avgSeconds * waitingPosition : null;
        return { ...item, position: isRunning ? 0 : waitingPosition, etaSeconds };
      });
      const lastWorker = row('SELECT id, last_seen FROM workers ORDER BY last_seen DESC LIMIT 1');
      const secondsSinceSeen = lastWorker ? Math.round((Date.now() - new Date(lastWorker.last_seen).getTime()) / 1000) : null;
      const runningCount = queue.filter(q => q.state === 'läuft').length;
      // An idle worker polls every few seconds; a busy one stays silent for the whole
      // render, so a running job counts as proof of life too.
      const workerOnline = runningCount > 0 || (secondsSinceSeen !== null && secondsSinceSeen < 90);
      return json(res, 200, { queue, runningCount, waitingCount: queue.filter(q => q.state === 'wartet').length, avgSeconds, worker: { id: lastWorker?.id || null, secondsSinceSeen, online: workerOnline } });
    }
    // Restore a project from an export archive. Always creates a NEW project rather than
    // merging into an existing one, so an import can never silently overwrite live work.
    if (path === '/api/projects/import' && req.method === 'POST') {
      if (!guard(req,res)) return;
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > 2 * 1024 * 1024 * 1024) return json(res, 413, { error: 'Archiv ist größer als 2 GB.' });
      const workDir = join(DATA, `import-${randomBytes(6).toString('hex')}`);
      const archivePath = `${workDir}.tar.gz`;
      await mkdir(workDir, { recursive: true });
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024 * 1024) throw new Error('Archiv ist zu groß.'); chunks.push(chunk); }
        if (!size) return json(res, 400, { error: 'Archiv ist leer.' });
        await writeFile(archivePath, Buffer.concat(chunks));
        await new Promise((ok, fail) => {
          const proc = spawn('tar', ['-xzf', archivePath, '-C', workDir]);
          let err = ''; proc.stderr.on('data', d => err += d.toString());
          proc.on('close', code => code === 0 ? ok() : fail(new Error('tar: ' + err.slice(-300))));
          proc.on('error', fail);
        });
        const manifestPath = join(workDir, 'project.json');
        if (!existsSync(manifestPath)) return json(res, 400, { error: 'Im Archiv fehlt project.json - ist das wirklich ein FrameCut-Export?' });
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (!manifest?.project) return json(res, 400, { error: 'Das Archiv enthält kein gültiges Projekt.' });

        // Media first: copy every file in and remember the new portable path per old path.
        const mediaMap = existsSync(join(workDir, 'media-map.json'))
          ? JSON.parse(await readFile(join(workDir, 'media-map.json'), 'utf8')) : {};
        await mkdir(UPLOADS, { recursive: true });
        const remapped = {};
        for (const [originalPath, archiveRelative] of Object.entries(mediaMap)) {
          const source = join(workDir, archiveRelative);
          if (!existsSync(source)) continue;
          const fresh = `import-${randomBytes(5).toString('hex')}-${basename(archiveRelative)}`;
          await copyFile(source, join(UPLOADS, fresh));
          remapped[originalPath] = `data/uploads/${fresh}`;
        }
        const remap = value => (value && remapped[value]) ? remapped[value] : null;

        const baseTitle = String(manifest.project.title || 'Importiertes Projekt').slice(0, 90);
        let title = `${baseTitle} (Import)`;
        for (let n = 2; row('SELECT id FROM projects WHERE title=?', title); n++) title = `${baseTitle} (Import ${n})`;
        const slug = createHash('sha1').update(`${title}-${now()}`).digest('hex').slice(0, 10);
        const createdProject = run('INSERT INTO projects(slug,title,synopsis,source_path,style_profile,created_at) VALUES (?,?,?,?,?,?)',
          slug, title, String(manifest.project.synopsis || ''), join('rabenblut-studio','projects',slug), String(manifest.project.style_profile || ''), now());
        const projectId = Number(createdProject.lastInsertRowid);

        const assetIdMap = new Map();
        for (const asset of manifest.assets || []) {
          const inserted = run('INSERT INTO assets(project_id,kind,name,summary,visual_notes,file_path,created_at) VALUES (?,?,?,?,?,?,?)',
            projectId, asset.kind, asset.name, asset.summary || '', asset.visual_notes || '', remap(asset.file_path), now());
          assetIdMap.set(asset.id, Number(inserted.lastInsertRowid));
        }

        const episodeIdMap = new Map();
        for (const episode of manifest.episodes || []) {
          const inserted = run('INSERT INTO episodes(project_id,number,title,duration_seconds,manifest_path,created_at) VALUES (?,?,?,?,?,?)',
            projectId, episode.number, episode.title, episode.duration_seconds || 0, '', now());
          episodeIdMap.set(episode.id, Number(inserted.lastInsertRowid));
        }
        for (const story of manifest.stories || []) {
          const episodeId = episodeIdMap.get(story.episode_id);
          if (episodeId) run('INSERT INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?)', episodeId, story.markdown || '', now());
        }
        for (const link of manifest.episodeAssets || []) {
          const episodeId = episodeIdMap.get(link.episode_id), assetId = assetIdMap.get(link.asset_id);
          if (episodeId && assetId) run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)', episodeId, assetId);
        }

        const shotIdMap = new Map();
        for (const shot of manifest.shots || []) {
          const episodeId = episodeIdMap.get(shot.episode_id);
          if (!episodeId) continue;
          const inserted = run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,source_image_path,output_video_path,render_tier,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            episodeId, shot.sequence, shot.title, shot.prompt || '', shot.camera || '', shot.duration_seconds || 5, shot.seed || null,
            shot.output_video_path ? 'Gerendert' : 'Entwurf', remap(shot.source_image_path), remap(shot.output_video_path), shot.render_tier || 'Vorschau', now());
          shotIdMap.set(shot.id, Number(inserted.lastInsertRowid));
        }
        for (const link of manifest.shotAssets || []) {
          const shotId = shotIdMap.get(link.shot_id), assetId = assetIdMap.get(link.asset_id);
          if (shotId && assetId) run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)', shotId, assetId, link.role || 'reference');
        }
        for (const final of manifest.finals || []) {
          const episodeId = episodeIdMap.get(final.episode_id), path = remap(final.file_path);
          if (episodeId && path) run('INSERT INTO episode_exports(episode_id,name,file_path,type,created_at) VALUES (?,?,?,?,?)', episodeId, final.name, path, final.type || 'mp4', now());
        }

        event('Projekt importiert', `${title} · ${episodeIdMap.size} Folgen, ${shotIdMap.size} Shots, ${Object.keys(remapped).length} Dateien.`);
        return json(res, 201, { ok: true, projectId, title, episodes: episodeIdMap.size, shots: shotIdMap.size, assets: assetIdMap.size, media: Object.keys(remapped).length });
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
        await rm(archivePath, { force: true }).catch(() => {});
      }
    }
    if (/^\/api\/projects\/\d+\/export$/.test(path) && req.method === 'GET') {
      if (!guard(req,res)) return;
      const projectId = Number(path.split('/')[3]);
      const project = row('SELECT * FROM projects WHERE id=?', projectId);
      if (!project) return json(res, 404, { error: 'Projekt nicht gefunden.' });
      const episodes = rows('SELECT * FROM episodes WHERE project_id=? ORDER BY number', projectId);
      const assets = rows('SELECT * FROM assets WHERE project_id=?', projectId);
      const episodeIds = episodes.map(e => e.id);
      const inClause = ids => ids.length ? `(${ids.map(() => '?').join(',')})` : '(-1)';
      const stories = rows(`SELECT * FROM story_documents WHERE episode_id IN ${inClause(episodeIds)}`, ...episodeIds);
      const shots = rows(`SELECT * FROM shots WHERE episode_id IN ${inClause(episodeIds)} ORDER BY episode_id, sequence`, ...episodeIds);
      const shotIds = shots.map(s => s.id);
      const shotAssets = rows(`SELECT * FROM shot_assets WHERE shot_id IN ${inClause(shotIds)}`, ...shotIds);
      const episodeAssets = rows(`SELECT * FROM episode_assets WHERE episode_id IN ${inClause(episodeIds)}`, ...episodeIds);
      const finals = rows(`SELECT * FROM episode_exports WHERE episode_id IN ${inClause(episodeIds)}`, ...episodeIds);
      const manifest = { formatVersion: 1, exportedAt: now(), project, episodes, assets, stories, shots, shotAssets, episodeAssets, finals };
      const mediaPaths = new Set();
      for (const a of assets) if (a.file_path) mediaPaths.add(a.file_path);
      for (const s of shots) { if (s.source_image_path) mediaPaths.add(s.source_image_path); if (s.output_video_path) mediaPaths.add(s.output_video_path); }
      for (const f of finals) mediaPaths.add(f.file_path);
      const workDir = join(DATA, `export-${projectId}-${randomBytes(6).toString('hex')}`);
      await mkdir(join(workDir, 'media'), { recursive: true });
      await writeFile(join(workDir, 'project.json'), JSON.stringify(manifest, null, 2), 'utf8');
      const mediaMap = {};
      for (const p of mediaPaths) {
        const src = mediaPath(p);
        if (!existsSync(src)) continue;
        const destName = basename(p);
        await copyFile(src, join(workDir, 'media', destName));
        mediaMap[p] = `media/${destName}`;
      }
      await writeFile(join(workDir, 'media-map.json'), JSON.stringify(mediaMap, null, 2), 'utf8');
      const archiveName = `${project.slug || 'projekt'}-export-${Date.now()}.tar.gz`;
      const archivePath = join(DATA, archiveName);
      await new Promise((resolveTar, rejectTar) => {
        const tarProc = spawn('tar', ['-czf', archivePath, '-C', workDir, '.']);
        let err = '';
        tarProc.stderr.on('data', d => err += d.toString());
        tarProc.on('close', code => code === 0 ? resolveTar() : rejectTar(new Error('tar exit ' + code + ': ' + err.slice(-500))));
        tarProc.on('error', rejectTar);
      });
      await rm(workDir, { recursive: true, force: true });
      const info = await stat(archivePath);
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': info.size, 'content-disposition': `attachment; filename="${archiveName}"` });
      const readStream = (await import('node:fs')).createReadStream(archivePath);
      readStream.pipe(res);
      readStream.on('close', () => { rm(archivePath, { force: true }).catch(() => {}); });
      event('Projekt exportiert', `${project.title} · ${mediaPaths.size} Mediendateien.`);
      return;
    }
    if (path === '/api/usage' && req.method === 'GET') {
      const account=guard(req,res); if(!account)return;
      // Rough, hand-maintained USD/1M-token estimates so the user has a sense of proportion -
      // not a billing-accurate figure, provider pricing changes independently of this file.
      const RATES = {
        gemini: { input: 0.10, output: 0.40 },
        deepseek: { input: 0.28, output: 0.42 },
        openai: { input: 0.40, output: 1.60 },
      };
      const cost = (provider, promptTokens, completionTokens) => { const r = RATES[provider]; if (!r) return 0; return (promptTokens/1e6)*r.input + (completionTokens/1e6)*r.output; };
      const summarize = (since) => {
        const grouped = rows(`SELECT provider, SUM(prompt_tokens) promptTokens, SUM(completion_tokens) completionTokens, SUM(total_tokens) totalTokens, COUNT(*) calls
          FROM ai_usage WHERE user_id=? AND created_at > ? GROUP BY provider`, account.id, since);
        return grouped.map(g => ({...g, estimatedCostUsd: Math.round(cost(g.provider, g.promptTokens, g.completionTokens) * 10000) / 10000}));
      };
      const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
      const monthAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();
      return json(res,200,{ week: summarize(weekAgo), month: summarize(monthAgo), allTime: summarize('1970-01-01'), ratesNote: 'Grob geschätzt (USD pro 1 Mio. Token) - keine offizielle Abrechnung, echte Kosten können abweichen.' });
    }
    if (path === '/api/dashboard' && req.method === 'GET') { if (!guard(req,res)) return; const includeArchived=url.searchParams.get('includeArchived')==='1'; const data=episodeData(Number(url.searchParams.get('projectId'))||null,Number(url.searchParams.get('episodeId'))||null); return json(res,200,{projects:rows(`SELECT * FROM projects ${includeArchived?'':'WHERE archived_at IS NULL'} ORDER BY created_at`), selected:data, episode:data?.episode, shots:data?.shots || [], finals:data?.finals || [], jobs:rows('SELECT * FROM jobs ORDER BY id DESC LIMIT 12'), activity:rows('SELECT * FROM activity ORDER BY id DESC LIMIT 10')}); }
    if (/^\/api\/projects\/\d+\/archive$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const id=Number(path.split('/')[3]),p=row('SELECT * FROM projects WHERE id=?',id); if(!p)return json(res,404,{error:'Projekt nicht gefunden.'}); run('UPDATE projects SET archived_at=? WHERE id=?',now(),id); event('Projekt archiviert',p.title); return json(res,200,{ok:true}); }
    if (/^\/api\/projects\/\d+\/unarchive$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const id=Number(path.split('/')[3]),p=row('SELECT * FROM projects WHERE id=?',id); if(!p)return json(res,404,{error:'Projekt nicht gefunden.'}); run('UPDATE projects SET archived_at=NULL WHERE id=?',id); event('Projekt wiederhergestellt',p.title); return json(res,200,{ok:true}); }
    if (/^\/api\/episodes\/\d+\/archive$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const id=Number(path.split('/')[3]),ep=row('SELECT * FROM episodes WHERE id=?',id); if(!ep)return json(res,404,{error:'Episode nicht gefunden.'}); const visibleCount=row('SELECT COUNT(*) c FROM episodes WHERE project_id=? AND archived_at IS NULL',ep.project_id).c; if(visibleCount<=1)return json(res,409,{error:'Die letzte sichtbare Folge eines Projekts kann nicht archiviert werden.'}); run('UPDATE episodes SET archived_at=? WHERE id=?',now(),id); event('Folge archiviert',ep.title); return json(res,200,{ok:true}); }
    if (/^\/api\/episodes\/\d+\/unarchive$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const id=Number(path.split('/')[3]),ep=row('SELECT * FROM episodes WHERE id=?',id); if(!ep)return json(res,404,{error:'Episode nicht gefunden.'}); run('UPDATE episodes SET archived_at=NULL WHERE id=?',id); event('Folge wiederhergestellt',ep.title); return json(res,200,{ok:true}); }
    if (/^\/api\/projects\/\d+\/episodes-all$/.test(path) && req.method === 'GET') { if (!guard(req,res)) return; const projectId=Number(path.split('/')[3]); return json(res,200,{episodes:rows('SELECT * FROM episodes WHERE project_id=? ORDER BY number',projectId)}); }
    if (/^\/api\/episodes\/\d+\/export$/.test(path) && req.method === 'GET') {
      if (!guard(req,res)) return;
      const episodeId = Number(path.split('/')[3]);
      const episode = row('SELECT * FROM episodes WHERE id=?', episodeId);
      if (!episode) return json(res, 404, { error: 'Episode nicht gefunden.' });
      const project = row('SELECT * FROM projects WHERE id=?', episode.project_id);
      const assets = rows('SELECT a.* FROM assets a JOIN episode_assets ea ON ea.asset_id=a.id WHERE ea.episode_id=?', episodeId);
      const story = row('SELECT * FROM story_documents WHERE episode_id=?', episodeId);
      const shots = rows('SELECT * FROM shots WHERE episode_id=? ORDER BY sequence', episodeId);
      const shotIds = shots.map(s => s.id);
      const inClause = ids => ids.length ? `(${ids.map(() => '?').join(',')})` : '(-1)';
      const shotAssets = rows(`SELECT * FROM shot_assets WHERE shot_id IN ${inClause(shotIds)}`, ...shotIds);
      const dialogue = rows(`SELECT * FROM shot_dialogue WHERE shot_id IN ${inClause(shotIds)}`, ...shotIds);
      const episodeAssets = rows('SELECT * FROM episode_assets WHERE episode_id=?', episodeId);
      const finals = rows('SELECT * FROM episode_exports WHERE episode_id=?', episodeId);
      const manifest = { formatVersion: 1, exportedAt: now(), episode, projectTitle: project?.title || '', assets, stories: story ? [story] : [], shots, shotAssets, dialogue, episodeAssets, finals };
      const mediaPaths = new Set();
      for (const a of assets) if (a.file_path) mediaPaths.add(a.file_path);
      for (const s of shots) { if (s.source_image_path) mediaPaths.add(s.source_image_path); if (s.output_video_path) mediaPaths.add(s.output_video_path); }
      for (const f of finals) mediaPaths.add(f.file_path);
      const workDir = join(DATA, `export-ep${episodeId}-${randomBytes(6).toString('hex')}`);
      await mkdir(join(workDir, 'media'), { recursive: true });
      await writeFile(join(workDir, 'episode.json'), JSON.stringify(manifest, null, 2), 'utf8');
      const mediaMap = {};
      for (const p of mediaPaths) {
        const src = mediaPath(p);
        if (!existsSync(src)) continue;
        const destName = basename(p);
        await copyFile(src, join(workDir, 'media', destName));
        mediaMap[p] = `media/${destName}`;
      }
      await writeFile(join(workDir, 'media-map.json'), JSON.stringify(mediaMap, null, 2), 'utf8');
      const archiveName = `episode-${episode.number}-export-${Date.now()}.tar.gz`;
      const archivePath = join(DATA, archiveName);
      await new Promise((resolveTar, rejectTar) => {
        const tarProc = spawn('tar', ['-czf', archivePath, '-C', workDir, '.']);
        let err = '';
        tarProc.stderr.on('data', d => err += d.toString());
        tarProc.on('close', code => code === 0 ? resolveTar() : rejectTar(new Error('tar exit ' + code + ': ' + err.slice(-500))));
        tarProc.on('error', rejectTar);
      });
      await rm(workDir, { recursive: true, force: true });
      const info = await stat(archivePath);
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': info.size, 'content-disposition': `attachment; filename="${archiveName}"` });
      const readStream = (await import('node:fs')).createReadStream(archivePath);
      readStream.pipe(res);
      readStream.on('close', () => { rm(archivePath, { force: true }).catch(() => {}); });
      event('Folge exportiert', `${episode.title} · ${mediaPaths.size} Mediendateien.`);
      return;
    }
    if (path === '/api/episodes/import' && req.method === 'POST') {
      const account = guard(req, res); if (!account) return;
      const projectId = Number(url.searchParams.get('projectId'));
      const targetProject = row('SELECT * FROM projects WHERE id=?', projectId);
      if (!targetProject) return json(res, 400, { error: 'Zielprojekt nicht gefunden.' });
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > 2 * 1024 * 1024 * 1024) return json(res, 413, { error: 'Archiv ist größer als 2 GB.' });
      const workDir = join(DATA, `import-ep-${randomBytes(6).toString('hex')}`);
      const archivePath = `${workDir}.tar.gz`;
      await mkdir(workDir, { recursive: true });
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024 * 1024) throw new Error('Archiv ist zu groß.'); chunks.push(chunk); }
        if (!size) return json(res, 400, { error: 'Archiv ist leer.' });
        await writeFile(archivePath, Buffer.concat(chunks));
        await new Promise((ok, fail) => {
          const proc = spawn('tar', ['-xzf', archivePath, '-C', workDir]);
          let err = ''; proc.stderr.on('data', d => err += d.toString());
          proc.on('close', code => code === 0 ? ok() : fail(new Error('tar: ' + err.slice(-300))));
          proc.on('error', fail);
        });
        const manifestPath = join(workDir, 'episode.json');
        if (!existsSync(manifestPath)) return json(res, 400, { error: 'Im Archiv fehlt episode.json - ist das wirklich ein FrameCut-Episoden-Export?' });
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (!manifest?.episode) return json(res, 400, { error: 'Das Archiv enthält keine gültige Episode.' });

        const mediaMap = existsSync(join(workDir, 'media-map.json'))
          ? JSON.parse(await readFile(join(workDir, 'media-map.json'), 'utf8')) : {};
        await mkdir(UPLOADS, { recursive: true });
        const remapped = {};
        for (const [originalPath, archiveRelative] of Object.entries(mediaMap)) {
          const source = join(workDir, archiveRelative);
          if (!existsSync(source)) continue;
          const fresh = `import-ep-${randomBytes(5).toString('hex')}-${basename(archiveRelative)}`;
          await copyFile(source, join(UPLOADS, fresh));
          remapped[originalPath] = `data/uploads/${fresh}`;
        }
        const remap = value => (value && remapped[value]) ? remapped[value] : null;

        const known = new Map(rows('SELECT * FROM assets WHERE project_id=?', projectId).map(a => [a.name.trim().toLowerCase(), a]));
        const assetIdMap = new Map();
        for (const asset of manifest.assets || []) {
          const key = asset.name.trim().toLowerCase();
          let existing = known.get(key);
          if (existing) { assetIdMap.set(asset.id, existing.id); continue; }
          const inserted = run('INSERT INTO assets(project_id,kind,name,summary,visual_notes,file_path,created_at) VALUES (?,?,?,?,?,?,?)',
            projectId, asset.kind, asset.name, asset.summary || '', asset.visual_notes || '', remap(asset.file_path), now());
          const newId = Number(inserted.lastInsertRowid);
          assetIdMap.set(asset.id, newId);
          known.set(key, { id: newId });
        }

        const number = (row('SELECT MAX(number) max FROM episodes WHERE project_id=?', projectId)?.max || 0) + 1;
        const baseTitle = String(manifest.episode.title || 'Importierte Folge').slice(0, 90);
        const insertedEp = run('INSERT INTO episodes(project_id,number,title,duration_seconds,manifest_path,created_at,style_profile,negative_prompt,video_steps,photo_steps,preview_width,preview_height,final_width,final_height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          projectId, number, `${baseTitle} (Import)`, manifest.episode.duration_seconds || 0, '', now(), manifest.episode.style_profile || null, manifest.episode.negative_prompt || null, manifest.episode.video_steps || null, manifest.episode.photo_steps || null, manifest.episode.preview_width || null, manifest.episode.preview_height || null, manifest.episode.final_width || null, manifest.episode.final_height || null);
        const newEpId = Number(insertedEp.lastInsertRowid);
        for (const story of manifest.stories || []) run('INSERT INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?)', newEpId, story.markdown || '', now());
        for (const link of manifest.episodeAssets || []) { const assetId = assetIdMap.get(link.asset_id); if (assetId) run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)', newEpId, assetId); }

        const shotIdMap = new Map();
        for (const shot of manifest.shots || []) {
          const inserted = run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,source_image_path,output_video_path,render_tier,kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            newEpId, shot.sequence, shot.title, shot.prompt || '', shot.camera || '', shot.duration_seconds || 5, shot.seed || null,
            shot.output_video_path ? 'Gerendert' : 'Entwurf', remap(shot.source_image_path), remap(shot.output_video_path), shot.render_tier || 'Vorschau', shot.kind || 'scene', now());
          shotIdMap.set(shot.id, Number(inserted.lastInsertRowid));
        }
        for (const link of manifest.shotAssets || []) { const shotId = shotIdMap.get(link.shot_id), assetId = assetIdMap.get(link.asset_id); if (shotId && assetId) run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)', shotId, assetId, link.role || 'reference'); }
        for (const d of manifest.dialogue || []) { const shotId = shotIdMap.get(d.shot_id); if (!shotId) continue; const assetId = d.asset_id ? assetIdMap.get(d.asset_id) : null; run('INSERT INTO shot_dialogue(shot_id,asset_id,sequence,text,created_at) VALUES (?,?,?,?,?)', shotId, assetId || null, d.sequence || 0, d.text, now()); }
        for (const final of manifest.finals || []) { const path = remap(final.file_path); if (path) run('INSERT INTO episode_exports(episode_id,name,file_path,type,created_at) VALUES (?,?,?,?,?)', newEpId, final.name, path, final.type || 'mp4', now()); }

        event('Folge importiert', `${targetProject.title} · ${baseTitle} · ${shotIdMap.size} Shots.`);
        return json(res, 201, { ok: true, episodeId: newEpId, title: `${baseTitle} (Import)`, shots: shotIdMap.size, assets: assetIdMap.size, media: Object.keys(remapped).length });
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
        await rm(archivePath, { force: true }).catch(() => {});
      }
    }
    if (path === '/api/episode' && req.method === 'GET') { if (!guard(req,res)) return; const data=episodeData(Number(url.searchParams.get('projectId'))||null,Number(url.searchParams.get('episodeId'))||null); if(!data)return json(res,404,{error:'Episode nicht importiert.'}); return json(res,200,data); }
    if (path === '/api/projects' && req.method === 'POST') { if (!guard(req,res)) return; const d=await body(req); const title=assertText(d.title,'Projekttitel',100); const slug=createHash('sha1').update(`${title}-${now()}`).digest('hex').slice(0,10); const created=run('INSERT INTO projects(slug,title,synopsis,source_path,created_at) VALUES (?,?,?,?,?)',slug,title,String(d.synopsis||'').trim(),join('rabenblut-studio','projects',slug),now()); const projectId=Number(created.lastInsertRowid); const ep=run('INSERT INTO episodes(project_id,number,title,duration_seconds,manifest_path,created_at) VALUES (?,?,?,?,?,?)',projectId,1,'Episode 01',0,'',now()); run('INSERT INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?)',Number(ep.lastInsertRowid),'# Neue Geschichte\n\nBeschreibe hier den Anfang deiner Episode.',now()); event('Neues Projekt',title); return json(res,201,{project:row('SELECT * FROM projects WHERE id=?',projectId)}); }
    if (/^\/api\/projects\/\d+$/.test(path) && req.method === 'PATCH') { if (!guard(req,res)) return; const id=Number(path.split('/').pop()),d=await body(req); const p=row('SELECT * FROM projects WHERE id=?',id); if(!p)return json(res,404,{error:'Projekt nicht gefunden.'});
      const clampSteps=(value,fallback)=>{const n=Number(value);return Number.isFinite(n)?Math.max(1,Math.min(40,Math.round(n))):fallback;};
      const clampDimension=(value,fallback)=>{const n=Number(value);if(!Number.isFinite(n))return fallback;return Math.max(160,Math.min(2048,Math.round(n/32)*32));};
      const videoSteps=clampSteps(d.videoSteps,p.video_steps);
      const photoSteps=clampSteps(d.photoSteps,p.photo_steps);
      const previewWidth=clampDimension(d.previewWidth,p.preview_width);
      const previewHeight=clampDimension(d.previewHeight,p.preview_height);
      const finalWidth=clampDimension(d.finalWidth,p.final_width);
      const finalHeight=clampDimension(d.finalHeight,p.final_height);
      const negativePrompt = optionalNegativePrompt(d.negativePrompt);
      run('UPDATE projects SET title=?, synopsis=?, negative_prompt=?, video_steps=?, photo_steps=?, preview_width=?, preview_height=?, final_width=?, final_height=? WHERE id=?',assertText(d.title ?? p.title,'Projekttitel',100),String(d.synopsis ?? p.synopsis ?? '').trim(),negativePrompt ?? p.negative_prompt ?? '',videoSteps,photoSteps,previewWidth,previewHeight,finalWidth,finalHeight,id);
      event('Projekt aktualisiert',p.title); return json(res,200,{ok:true}); }
    if (/^\/api\/projects\/\d+$/.test(path) && req.method === 'DELETE') {
      const account = guard(req, res); if (!account) return;
      const projectId = Number(path.split('/').pop());
      const p = row('SELECT * FROM projects WHERE id=?', projectId);
      if (!p) return json(res, 404, { error: 'Projekt nicht gefunden.' });
      if (row('SELECT COUNT(*) c FROM projects').c <= 1) return json(res, 409, { error: 'Das letzte verbleibende Projekt kann nicht gelöscht werden.' });
      const episodes = rows('SELECT * FROM episodes WHERE project_id=?', projectId);
      const episodeIds = episodes.map(e => e.id);
      const inEp = episodeIds.length ? `(${episodeIds.map(() => '?').join(',')})` : '(NULL)';
      const shots = episodeIds.length ? rows(`SELECT * FROM shots WHERE episode_id IN ${inEp}`, ...episodeIds) : [];
      const shotIds = shots.map(s => s.id);
      const inShot = shotIds.length ? `(${shotIds.map(() => '?').join(',')})` : '(NULL)';
      const shotAssets = shotIds.length ? rows(`SELECT * FROM shot_assets WHERE shot_id IN ${inShot}`, ...shotIds) : [];
      const episodeAssets = episodeIds.length ? rows(`SELECT * FROM episode_assets WHERE episode_id IN ${inEp}`, ...episodeIds) : [];
      const storyDocuments = episodeIds.length ? rows(`SELECT * FROM story_documents WHERE episode_id IN ${inEp}`, ...episodeIds) : [];
      const storyVersions = episodeIds.length ? rows(`SELECT * FROM story_versions WHERE episode_id IN ${inEp}`, ...episodeIds) : [];
      const episodeExports = episodeIds.length ? rows(`SELECT * FROM episode_exports WHERE episode_id IN ${inEp}`, ...episodeIds) : [];
      const autoPlanDrafts = episodeIds.length ? rows(`SELECT * FROM auto_plan_drafts WHERE episode_id IN ${inEp}`, ...episodeIds) : [];
      const assets = rows('SELECT * FROM assets WHERE project_id=?', projectId);
      const assetIds = assets.map(a => a.id);
      const inAsset = assetIds.length ? `(${assetIds.map(() => '?').join(',')})` : '(NULL)';
      const assetPhotos = assetIds.length ? rows(`SELECT * FROM asset_photos WHERE asset_id IN ${inAsset}`, ...assetIds) : [];
      run('INSERT INTO trash(kind,label,payload,deleted_at,deleted_by) VALUES (?,?,?,?,?)', 'project', p.title, JSON.stringify({ project: p, episodes, shots, shotAssets, episodeAssets, storyDocuments, storyVersions, episodeExports, autoPlanDrafts, assets, assetPhotos }), now(), account.id);
      if (shotIds.length) run(`DELETE FROM shot_assets WHERE shot_id IN ${inShot}`, ...shotIds);
      if (assetIds.length) run(`DELETE FROM asset_photos WHERE asset_id IN ${inAsset}`, ...assetIds);
      if (episodeIds.length) run(`DELETE FROM jobs WHERE episode_id IN ${inEp}`, ...episodeIds);
      if (shotIds.length) run(`DELETE FROM shots WHERE id IN ${inShot}`, ...shotIds);
      if (episodeIds.length) {
        run(`DELETE FROM episode_assets WHERE episode_id IN ${inEp}`, ...episodeIds);
        run(`DELETE FROM story_versions WHERE episode_id IN ${inEp}`, ...episodeIds);
        run(`DELETE FROM story_documents WHERE episode_id IN ${inEp}`, ...episodeIds);
        run(`DELETE FROM episode_exports WHERE episode_id IN ${inEp}`, ...episodeIds);
        run(`DELETE FROM auto_plan_drafts WHERE episode_id IN ${inEp}`, ...episodeIds);
        run(`DELETE FROM episodes WHERE id IN ${inEp}`, ...episodeIds);
      }
      run('DELETE FROM assets WHERE project_id=?', projectId);
      run('DELETE FROM projects WHERE id=?', projectId);
      event('Projekt in den Papierkorb verschoben', p.title);
      return json(res, 200, { ok: true });
    }
    if (/^\/api\/episodes\/\d+\/settings$/.test(path) && req.method === 'PATCH') { if (!guard(req,res)) return; const id=Number(path.split('/')[3]),d=await body(req); const ep=row('SELECT * FROM episodes WHERE id=?',id); if(!ep)return json(res,404,{error:'Episode nicht gefunden.'});
      const clampStepsOrNull=(value)=>{if(value===''||value==null)return null;const n=Number(value);return Number.isFinite(n)?Math.max(1,Math.min(40,Math.round(n))):null;};
      const clampDimensionOrNull=(value)=>{if(value===''||value==null)return null;const n=Number(value);return Number.isFinite(n)?Math.max(160,Math.min(2048,Math.round(n/32)*32)):null;};
      const styleProfile=(d.styleProfile===''||d.styleProfile==null)?null:String(d.styleProfile).trim().slice(0,2400);
      const negativePrompt = optionalNegativePrompt(d.negativePrompt);
      // For episodes an empty value intentionally returns to the project default.
      const episodeNegativePrompt = negativePrompt === undefined ? ep.negative_prompt : (negativePrompt || null);
      run('UPDATE episodes SET style_profile=?, negative_prompt=?, video_steps=?, photo_steps=?, preview_width=?, preview_height=?, final_width=?, final_height=? WHERE id=?',
        styleProfile,episodeNegativePrompt,clampStepsOrNull(d.videoSteps),clampStepsOrNull(d.photoSteps),clampDimensionOrNull(d.previewWidth),clampDimensionOrNull(d.previewHeight),clampDimensionOrNull(d.finalWidth),clampDimensionOrNull(d.finalHeight),id);
      event('Episoden-Einstellungen aktualisiert',ep.title); return json(res,200,{ok:true}); }
    if (/^\/api\/projects\/\d+\/episodes$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const projectId=Number(path.split('/')[3]),d=await body(req),p=row('SELECT * FROM projects WHERE id=?',projectId); if(!p)return json(res,404,{error:'Projekt nicht gefunden.'}); const number=(row('SELECT MAX(number) max FROM episodes WHERE project_id=?',projectId)?.max||0)+1; const title=assertText(d.title||`Episode ${number}`,'Episodentitel',100); const ep=run('INSERT INTO episodes(project_id,number,title,duration_seconds,manifest_path,created_at) VALUES (?,?,?,?,?,?)',projectId,number,title,0,'',now()); const newEpisodeId=Number(ep.lastInsertRowid); run('INSERT INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?)',newEpisodeId,'# Neue Episode\n\nWorum geht es in dieser Geschichte?',now()); for(const existingAsset of rows('SELECT id FROM assets WHERE project_id=?',projectId)){run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)',newEpisodeId,existingAsset.id);} event('Neue Episode',`${p.title} · ${title}`); return json(res,201,{episode:row('SELECT * FROM episodes WHERE id=?',newEpisodeId)}); }
    if (/^\/api\/episodes\/\d+$/.test(path) && req.method === 'DELETE') {
      const account = guard(req, res); if (!account) return;
      const episodeId = Number(path.split('/').pop());
      const ep = row('SELECT * FROM episodes WHERE id=?', episodeId);
      if (!ep) return json(res, 404, { error: 'Folge nicht gefunden.' });
      if (ep.number === 1) return json(res, 409, { error: 'Die erste Folge kann nicht in dieser Version gelöscht werden.' });
      const story = row('SELECT markdown FROM story_documents WHERE episode_id=?', episodeId);
      const shots = rows('SELECT * FROM shots WHERE episode_id=?', episodeId);
      const shotIds = shots.map(s => s.id);
      const shotAssets = shotIds.length ? rows(`SELECT * FROM shot_assets WHERE shot_id IN (${shotIds.map(() => '?').join(',')})`, ...shotIds) : [];
      const episodeAssets = rows('SELECT asset_id FROM episode_assets WHERE episode_id=?', episodeId).map(x => x.asset_id);
      const finals = rows('SELECT * FROM episode_exports WHERE episode_id=?', episodeId);
      run('INSERT INTO trash(kind,label,payload,deleted_at,deleted_by) VALUES (?,?,?,?,?)', 'episode', ep.title, JSON.stringify({ episode: ep, story, shots, shotAssets, episodeAssets, finals }), now(), account.id);
      run('DELETE FROM shot_assets WHERE shot_id IN (SELECT id FROM shots WHERE episode_id=?)', episodeId);
      run('DELETE FROM shots WHERE episode_id=?', episodeId);
      run('DELETE FROM episode_assets WHERE episode_id=?', episodeId);
      run('DELETE FROM story_documents WHERE episode_id=?', episodeId);
      run('DELETE FROM jobs WHERE episode_id=?', episodeId);
      run('DELETE FROM episode_exports WHERE episode_id=?', episodeId);
      run('DELETE FROM episodes WHERE id=?', episodeId);
      event('Folge in den Papierkorb verschoben', ep.title);
      return json(res, 200, { ok: true });
    }
    if (/^\/api\/episodes\/\d+\/story$/.test(path) && req.method === 'PUT') { if (!guard(req,res)) return; const episodeId=Number(path.split('/')[3]),d=await body(req); if(!row('SELECT id FROM episodes WHERE id=?',episodeId))return json(res,404,{error:'Episode nicht gefunden.'}); const incoming=String(d.markdown||'');
      const previous=row('SELECT markdown FROM story_documents WHERE episode_id=?',episodeId)?.markdown;
      if (previous && previous.trim() && previous !== incoming) {
        run('INSERT INTO story_versions(episode_id,markdown,saved_at) VALUES (?,?,?)',episodeId,previous,now());
        run('DELETE FROM story_versions WHERE episode_id=? AND id NOT IN (SELECT id FROM story_versions WHERE episode_id=? ORDER BY id DESC LIMIT 10)',episodeId,episodeId);
      }
      run('INSERT INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?) ON CONFLICT(episode_id) DO UPDATE SET markdown=excluded.markdown,updated_at=excluded.updated_at',episodeId,incoming,now()); event('Story gespeichert',`Episode ${episodeId}`); return json(res,200,{ok:true}); }
    if (/^\/api\/episodes\/\d+\/story\/versions$/.test(path) && req.method === 'GET') {
      if (!guard(req,res)) return;
      const episodeId=Number(path.split('/')[3]);
      const versions=rows('SELECT id, saved_at, length(markdown) AS size FROM story_versions WHERE episode_id=? ORDER BY id DESC',episodeId);
      return json(res,200,{versions});
    }
    if (/^\/api\/episodes\/\d+\/story\/versions\/\d+$/.test(path) && req.method === 'GET') {
      if (!guard(req,res)) return;
      const parts=path.split('/');
      const found=row('SELECT markdown, saved_at FROM story_versions WHERE id=? AND episode_id=?',Number(parts[6]),Number(parts[3]));
      if(!found) return json(res,404,{error:'Diese Fassung wurde nicht gefunden.'});
      return json(res,200,found);
    }
    if (/^\/api\/episodes\/\d+\/auto-assess$/.test(path) && req.method === 'POST') { const account=guard(req,res); if(!account)return; const episodeId=Number(path.split('/')[3]),d=await body(req); const episode=row('SELECT e.*,p.title project_title,COALESCE(e.style_profile,p.style_profile) style_profile FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=?',episodeId); if(!episode)return json(res,404,{error:'Episode nicht gefunden.'}); const story=row('SELECT markdown FROM story_documents WHERE episode_id=?',episodeId)?.markdown?.trim(); if(!story || story.length<30)return json(res,400,{error:'Bitte zuerst eine aussagekräftige Story mit mindestens ein paar Sätzen speichern.'}); const provider=['gemini','openai','deepseek'].includes(d.provider)?d.provider:'gemini'; const stored=providerKey(account.id,provider); if(!stored)return json(res,400,{error:`Für ${provider==='gemini'?'Gemini':provider==='openai'?'OpenAI':'DeepSeek'} ist noch kein API-Schlüssel hinterlegt. Öffne zuerst Einstellungen.`}); const targetSeconds=Math.max(15,Math.min(900,Number(d.targetSeconds)||120)); const styleProfile=String(d.styleProfile||episode.style_profile||'').trim().slice(0,2400); const adaptationMode=d.adaptationMode==='faithful'?'faithful':'cinematic'; const model=String(d.model||stored.model||'').trim(); const requestedRefs=Array.isArray(d.styleReferenceIds)?d.styleReferenceIds.map(Number).slice(0,8):[]; const styleRefs=requestedRefs.map(id=>row('SELECT id,name,summary,visual_notes FROM assets WHERE id=? AND project_id=?',id,episode.project_id)).filter(Boolean); const analysisStyle=[styleProfile,styleRefs.length?`Verbindliche Stilreferenzen: ${styleRefs.map(a=>`${a.name}: ${a.summary||''} ${a.visual_notes||''}`).join(' | ')}`:''].filter(Boolean).join('\n'); const existingAssets=rows('SELECT name,kind,summary FROM assets WHERE project_id=? ORDER BY kind,name',episode.project_id); const raw=await callProviderJson(provider,stored.key,model,analysisInstruction(story,targetSeconds,analysisStyle,adaptationMode,existingAssets),{userId:account.id,purpose:'analysis'}); const analysis=cleanAnalysis(raw,targetSeconds); analysis.wordCount=story.split(/\s+/).filter(Boolean).length; const draft=run('INSERT INTO auto_plan_drafts(user_id,episode_id,provider,model,target_seconds,recommended_seconds,style_profile,adaptation_mode,reference_asset_ids,analysis_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',account.id,episodeId,provider,model,targetSeconds,analysis.recommendedSeconds,styleProfile,adaptationMode,JSON.stringify(styleRefs.map(a=>a.id)),JSON.stringify(analysis),now()); event('Story vorgeprüft',`${episode.project_title} · ${analysis.scenes.length} Szenen erkannt.`); return json(res,201,{draftId:Number(draft.lastInsertRowid),analysis,requestedSeconds:targetSeconds,styleReferences:styleRefs.map(a=>({id:a.id,name:a.name})),estimatedCalls:Math.ceil(analysis.scenes.length/6)+1}); }
    if (/^\/api\/episodes\/\d+\/(intro|outro)$/.test(path) && req.method === 'POST') {
      const account=guard(req,res); if(!account)return;
      const parts=path.split('/'); const episodeId=Number(parts[3]); const kind=parts[4]; const d=await body(req);
      const episode=row('SELECT e.*,p.title project_title,p.id project_id,COALESCE(e.style_profile,p.style_profile) style_profile FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=?',episodeId);
      if(!episode) return json(res,404,{error:'Episode nicht gefunden.'});
      const story=row('SELECT markdown FROM story_documents WHERE episode_id=?',episodeId)?.markdown?.trim();
      if(!story || story.length<30) return json(res,400,{error:'Bitte zuerst eine aussagekräftige Story mit mindestens ein paar Sätzen speichern.'});
      const available=rows("SELECT provider FROM user_provider_keys WHERE user_id=? ORDER BY CASE provider WHEN 'deepseek' THEN 1 WHEN 'gemini' THEN 2 ELSE 3 END",account.id);
      const provider=['gemini','openai','deepseek'].includes(d.provider)?d.provider:(available[0]?.provider||'gemini');
      const stored=providerKey(account.id,provider);
      if(!stored) return json(res,400,{error:`Für ${provider==='gemini'?'Gemini':provider==='openai'?'OpenAI':'DeepSeek'} ist noch kein API-Schlüssel hinterlegt. Öffne zuerst Einstellungen.`});
      const styleProfile=String(episode.style_profile||'').trim().slice(0,2400);
      const existingAssets=rows('SELECT id,name,kind FROM assets WHERE project_id=? ORDER BY kind,name',episode.project_id);
      const model=String(d.model||stored.model||'').trim();
      const raw=await callProviderJson(provider,stored.key,model,introOutroInstruction(kind,story,styleProfile,existingAssets),{userId:account.id,purpose:kind});
      const shot=cleanSingleShot(raw,kind==='intro'?'Intro':'Outro');
      const bounds=row('SELECT MIN(sequence) minSeq, MAX(sequence) maxSeq FROM shots WHERE episode_id=?',episodeId);
      const sequence=kind==='intro'?(bounds.minSeq!=null?bounds.minSeq-1:1):(bounds.maxSeq!=null?bounds.maxSeq+1:1);
      const created=run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        episodeId,sequence,shot.title,shot.prompt,shot.camera,shot.durationSeconds,Math.floor(Math.random()*9000000)+1000000,'Entwurf',kind,now());
      const shotId=Number(created.lastInsertRowid);
      const byName=new Map(existingAssets.map(a=>[a.name.trim().toLowerCase(),a]));
      // Nur verlinken, wenn der Assetname tatsächlich im Prompt-Text vorkommt - unabhängig von assetNames, das die KI sowohl vergessen (zu wenig Referenzfotos) als auch überfüllen kann (zu viele/falsche Referenzfotos).
      for(const asset of existingAssets){if(mentionsAsset(shot.prompt,asset.name))run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)',shotId,asset.id,'reference');}
      event(kind==='intro'?'Intro erstellt':'Outro erstellt',`${episode.project_title} · ${episode.title}`);
      return json(res,201,{shot:row('SELECT * FROM shots WHERE id=?',shotId)});
    }
    if (/^\/api\/auto-plans\/\d+\/commit$/.test(path) && req.method === 'POST') { const account=guard(req,res); if(!account)return; const draftId=Number(path.split('/')[3]),d=await body(req),draft=row('SELECT * FROM auto_plan_drafts WHERE id=?',draftId); if(!draft)return json(res,404,{error:'Dieser Planentwurf wurde nicht gefunden.'}); if(draft.committed_at)return json(res,409,{error:'Dieser Plan wurde bereits übernommen.'}); const episode=row('SELECT e.*,p.title project_title FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=?',draft.episode_id); if(!episode)return json(res,404,{error:'Episode nicht gefunden.'}); const stored=providerKey(account.id,draft.provider); if(!stored)return json(res,400,{error:'Der dazugehörige API-Schlüssel ist nicht mehr eingerichtet.'}); const analysis=cleanAnalysis(JSON.parse(draft.analysis_json),draft.target_seconds); const selectedSeconds=d.useRequested===true?draft.target_seconds:draft.recommended_seconds; const totalWeight=analysis.scenes.reduce((sum,s)=>sum+s.weight,0)||analysis.scenes.length; const storedRefIds=JSON.parse(draft.reference_asset_ids||'[]'); const storedRefs=storedRefIds.map(id=>row('SELECT name,summary,visual_notes FROM assets WHERE id=? AND project_id=?',Number(id),episode.project_id)).filter(Boolean); const batchStyle=[draft.style_profile,storedRefs.length?`Verbindliche Stilreferenzen: ${storedRefs.map(a=>`${a.name}: ${a.summary||''} ${a.visual_notes||''}`).join(' | ')}`:''].filter(Boolean).join('\n'); const shots=[];
      for(let offset=0;offset<analysis.scenes.length;offset+=3){const sceneBatch=analysis.scenes.slice(offset,offset+3),weight=sceneBatch.reduce((sum,s)=>sum+s.weight,0),batchSeconds=Math.max(sceneBatch.length*3,Math.round(selectedSeconds*weight/totalWeight)); const batch=await callPlanner(draft.provider,stored.key,draft.model,shotBatchInstruction(analysis,sceneBatch,batchSeconds,batchStyle,draft.adaptation_mode),{userId:account.id,purpose:'shot_batch'}); shots.push(...batch.shots);}
      const plan={summary:analysis.summary,assets:analysis.assets,shots:shots.slice(0,140)}; const saved=savePlanToEpisode(episode,plan,draft.style_profile,storedRefIds,d.replaceExisting===true); run('UPDATE auto_plan_drafts SET committed_at=? WHERE id=?',now(),draftId); event('Auto-Modus übernommen',`${episode.project_title} · ${saved.createdShots} Shots, ${saved.createdAssets} neue Elemente.`); return json(res,201,{plan,selectedSeconds,createdAssets:saved.createdAssets,createdShots:saved.createdShots}); }
    if (/^\/api\/episodes\/\d+\/auto-plan$/.test(path) && req.method === 'POST') { const account=guard(req,res); if(!account)return; const episodeId=Number(path.split('/')[3]),d=await body(req); const episode=row('SELECT e.*,p.title project_title,COALESCE(e.style_profile,p.style_profile) style_profile FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=?',episodeId); if(!episode)return json(res,404,{error:'Episode nicht gefunden.'}); const story=row('SELECT markdown FROM story_documents WHERE episode_id=?',episodeId)?.markdown?.trim(); if(!story || story.length<30)return json(res,400,{error:'Bitte zuerst eine aussagekräftige Story mit mindestens ein paar Sätzen speichern.'}); const provider=['gemini','openai','deepseek'].includes(d.provider)?d.provider:'gemini'; const stored=providerKey(account.id,provider); if(!stored)return json(res,400,{error:`Für ${provider==='gemini'?'Gemini':provider==='openai'?'OpenAI':'DeepSeek'} ist noch kein API-Schlüssel hinterlegt. Öffne zuerst Einstellungen.`}); const targetSeconds=Math.max(15,Math.min(900,Number(d.targetSeconds)||120)); const styleProfile=String(d.styleProfile||episode.style_profile||'').trim().slice(0,2400); const plan=await callPlanner(provider,stored.key,String(d.model||stored.model||'').trim(),plannerInstruction(story,targetSeconds,styleProfile),{userId:account.id,purpose:'auto_plan'});
      if(styleProfile)run('UPDATE projects SET style_profile=? WHERE id=?',styleProfile,episode.project_id);
      const known=new Map(rows('SELECT * FROM assets WHERE project_id=?',episode.project_id).map(a=>[a.name.trim().toLowerCase(),a])); const created=new Map();
      for(const item of plan.assets){const key=item.name.toLowerCase();let asset=known.get(key);if(!asset){const result=run('INSERT INTO assets(project_id,kind,name,summary,visual_notes,created_at) VALUES (?,?,?,?,?,?)',episode.project_id,item.kind,item.name,item.summary,item.visualNotes,now());asset=row('SELECT * FROM assets WHERE id=?',Number(result.lastInsertRowid));known.set(key,asset);created.set(key,asset);}run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)',episodeId,asset.id);}
      const start=(row('SELECT MAX(sequence) max FROM shots WHERE episode_id=?',episodeId)?.max||0); const allAssets=[...known.values()]; const byName=new Map(allAssets.map(a=>[a.name.trim().toLowerCase(),a])); let index=0;
      for(const item of plan.shots){const result=run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',episodeId,start+(++index),item.title,item.prompt,item.camera,item.durationSeconds,Math.floor(Math.random()*9000000)+1000000,'Entwurf',now());const shotId=Number(result.lastInsertRowid);for(const assetName of item.assetNames){const asset=byName.get(assetName.toLowerCase());if(asset && mentionsAsset(item.prompt,assetName))run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)',shotId,asset.id,'reference');}saveDialogue(shotId,item.dialogue,byName);}
      run('UPDATE episodes SET duration_seconds=? WHERE id=?',plan.shots.reduce((sum,s)=>sum+s.durationSeconds,0),episodeId); event('Auto-Modus geplant',`${episode.project_title} · ${plan.shots.length} Shots, ${created.size} neue Elemente.`); return json(res,201,{plan,createdAssets:created.size,createdShots:plan.shots.length}); }
    if (/^\/api\/projects\/\d+\/assets$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const projectId=Number(path.split('/')[3]),d=await body(req); if(!row('SELECT id FROM projects WHERE id=?',projectId))return json(res,404,{error:'Projekt nicht gefunden.'}); const kind=['character','location','prop','style'].includes(d.kind)?d.kind:'character'; const ins=run('INSERT INTO assets(project_id,kind,name,summary,visual_notes,file_path,created_at) VALUES (?,?,?,?,?,?,?)',projectId,kind,assertText(d.name,'Name',100),String(d.summary||'').trim(),String(d.visualNotes||'').trim(),String(d.filePath||'').trim()||null,now()); const epId=Number(d.episodeId); if(epId && row('SELECT id FROM episodes WHERE id=? AND project_id=?',epId,projectId))run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)',epId,Number(ins.lastInsertRowid)); event(kind==='character'?'Neue Figur':'Neues Element',d.name); return json(res,201,{asset:row('SELECT * FROM assets WHERE id=?',Number(ins.lastInsertRowid))}); }
    if (/^\/api\/assets\/\d+$/.test(path) && req.method === 'DELETE') {
      const account = guard(req, res); if (!account) return;
      const id = Number(path.split('/').pop());
      const a = row('SELECT * FROM assets WHERE id=?', id);
      if (!a) return json(res, 404, { error: 'Material nicht gefunden.' });
      const episodeLinks = rows('SELECT episode_id FROM episode_assets WHERE asset_id=?', id).map(x => x.episode_id);
      const shotLinks = rows('SELECT shot_id, role FROM shot_assets WHERE asset_id=?', id);
      run('INSERT INTO trash(kind,label,payload,deleted_at,deleted_by) VALUES (?,?,?,?,?)', 'asset', a.name, JSON.stringify({ asset: a, episodeLinks, shotLinks }), now(), account.id);
      run('DELETE FROM shot_assets WHERE asset_id=?', id);
      run('DELETE FROM episode_assets WHERE asset_id=?', id);
      run('DELETE FROM jobs WHERE asset_id=?', id);
      run('DELETE FROM assets WHERE id=?', id);
      event('Material in den Papierkorb verschoben', a.name);
      return json(res, 200, { ok: true, id });
    }
    if (/^\/api\/shots\/\d+$/.test(path) && req.method === 'DELETE') {
      const account = guard(req, res); if (!account) return;
      const id = Number(path.split('/').pop());
      const s = row('SELECT * FROM shots WHERE id=?', id);
      if (!s) return json(res, 404, { error: 'Shot nicht gefunden.' });
      const links = rows('SELECT asset_id, role FROM shot_assets WHERE shot_id=?', id);
      run('INSERT INTO trash(kind,label,payload,deleted_at,deleted_by) VALUES (?,?,?,?,?)', 'shot', s.title, JSON.stringify({ shot: s, links }), now(), account.id);
      run('DELETE FROM shot_assets WHERE shot_id=?', id);
      run('DELETE FROM jobs WHERE shot_id=?', id);
      run('DELETE FROM shots WHERE id=?', id);
      event('Shot in den Papierkorb verschoben', s.title);
      return json(res, 200, { ok: true, id });
    }
    if (/^\/api\/jobs\/\d+\/cancel$/.test(path) && req.method === 'POST') {
      if (!guard(req, res)) return;
      const id = Number(path.split('/')[3]);
      const job = row("SELECT * FROM jobs WHERE id=? AND state IN ('wartet','läuft')", id);
      if (!job) return json(res, 404, { error: 'Auftrag nicht gefunden oder schon abgeschlossen.' });
      run("UPDATE jobs SET state='abgebrochen', detail='Einzeln vom Benutzer abgebrochen.', completed_at=? WHERE id=?", now(), id);
      if (job.shot_id) {
        const shot = row('SELECT output_video_path FROM shots WHERE id=?', job.shot_id);
        run("UPDATE shots SET status=? WHERE id=?", shot?.output_video_path ? 'Gerendert' : 'Entwurf', job.shot_id);
      }
      event('Auftrag abgebrochen', job.label);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/jobs/cancel' && req.method === 'POST') {
      if (!guard(req, res)) return;
      const d = await body(req);
      const ids = [...new Set((Array.isArray(d.ids) ? d.ids : []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 200);
      if (!ids.length) return json(res, 400, { error: 'Wähle mindestens einen Auftrag aus.' });
      const marks = ids.map(() => '?').join(',');
      const targets = rows(`SELECT id, shot_id, label FROM jobs WHERE id IN (${marks}) AND state IN ('wartet','läuft')`, ...ids);
      if (!targets.length) return json(res, 404, { error: 'Die ausgewählten Aufträge sind nicht mehr aktiv.' });
      for (const job of targets) {
        run("UPDATE jobs SET state='abgebrochen', detail='Aus der Mehrfachauswahl abgebrochen.', completed_at=? WHERE id=?", now(), job.id);
        if (job.shot_id) {
          const shot = row('SELECT output_video_path FROM shots WHERE id=?', job.shot_id);
          run('UPDATE shots SET status=? WHERE id=?', shot?.output_video_path ? 'Gerendert' : 'Entwurf', job.shot_id);
        }
      }
      event('Ausgewählte Aufträge abgebrochen', `${targets.length} von ${ids.length} markierten Aufträgen.`);
      return json(res, 200, { ok: true, canceled: targets.length });
    }
    if (path === '/api/trash' && req.method === 'GET') {
      if (!guard(req, res)) return;
      return json(res, 200, { items: rows('SELECT id, kind, label, deleted_at FROM trash ORDER BY id DESC') });
    }
    if (/^\/api\/trash\/\d+$/.test(path) && req.method === 'DELETE') {
      if (!guard(req, res)) return;
      const id = Number(path.split('/').pop());
      const removed = run('DELETE FROM trash WHERE id=?', id);
      if (!removed.changes) return json(res, 404, { error: 'Eintrag nicht gefunden.' });
      return json(res, 200, { ok: true });
    }
    if (/^\/api\/trash\/\d+\/restore$/.test(path) && req.method === 'POST') {
      if (!guard(req, res)) return;
      const id = Number(path.split('/')[3]);
      const entry = row('SELECT * FROM trash WHERE id=?', id);
      if (!entry) return json(res, 404, { error: 'Eintrag nicht gefunden.' });
      const data = JSON.parse(entry.payload);
      if (entry.kind === 'shot') {
        const { shot, links } = data;
        if (!row('SELECT id FROM episodes WHERE id=?', shot.episode_id)) return json(res, 409, { error: 'Die zugehörige Folge existiert nicht mehr.' });
        const inserted = run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,source_image_path,output_video_path,render_tier,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          shot.episode_id, shot.sequence, shot.title, shot.prompt, shot.camera, shot.duration_seconds, shot.seed, shot.status, shot.source_image_path, shot.output_video_path, shot.render_tier || 'Vorschau', now());
        const newId = Number(inserted.lastInsertRowid);
        for (const link of links || []) { if (row('SELECT id FROM assets WHERE id=?', link.asset_id)) run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)', newId, link.asset_id, link.role); }
        run('DELETE FROM trash WHERE id=?', id);
        event('Shot wiederhergestellt', shot.title);
        return json(res, 200, { ok: true, kind: 'shot' });
      }
      if (entry.kind === 'asset') {
        const { asset, episodeLinks, shotLinks } = data;
        if (!row('SELECT id FROM projects WHERE id=?', asset.project_id)) return json(res, 409, { error: 'Das zugehörige Projekt existiert nicht mehr.' });
        const inserted = run('INSERT INTO assets(project_id,kind,name,summary,visual_notes,file_path,created_at) VALUES (?,?,?,?,?,?,?)',
          asset.project_id, asset.kind, asset.name, asset.summary, asset.visual_notes, asset.file_path, now());
        const newId = Number(inserted.lastInsertRowid);
        for (const epId of episodeLinks || []) { if (row('SELECT id FROM episodes WHERE id=?', epId)) run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)', epId, newId); }
        for (const link of shotLinks || []) { if (row('SELECT id FROM shots WHERE id=?', link.shot_id)) run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)', link.shot_id, newId, link.role); }
        run('DELETE FROM trash WHERE id=?', id);
        event('Material wiederhergestellt', asset.name);
        return json(res, 200, { ok: true, kind: 'asset' });
      }
      if (entry.kind === 'episode') {
        const { episode, story, shots, shotAssets, episodeAssets, finals } = data;
        if (!row('SELECT id FROM projects WHERE id=?', episode.project_id)) return json(res, 409, { error: 'Das zugehörige Projekt existiert nicht mehr.' });
        const insertedEp = run('INSERT INTO episodes(project_id,number,title,duration_seconds,manifest_path,created_at,style_profile,negative_prompt,video_steps,photo_steps,preview_width,preview_height,final_width,final_height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          episode.project_id, episode.number, episode.title, episode.duration_seconds || 0, episode.manifest_path || '', now(), episode.style_profile || null, episode.negative_prompt || null, episode.video_steps || null, episode.photo_steps || null, episode.preview_width || null, episode.preview_height || null, episode.final_width || null, episode.final_height || null);
        const newEpId = Number(insertedEp.lastInsertRowid);
        if (story?.markdown) run('INSERT INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?)', newEpId, story.markdown, now());
        for (const assetId of episodeAssets || []) { if (row('SELECT id FROM assets WHERE id=?', assetId)) run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)', newEpId, assetId); }
        const shotIdMap = new Map();
        for (const shot of shots || []) {
          const inserted = run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,source_image_path,output_video_path,render_tier,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            newEpId, shot.sequence, shot.title, shot.prompt, shot.camera, shot.duration_seconds, shot.seed, shot.status, shot.source_image_path, shot.output_video_path, shot.render_tier || 'Vorschau', now());
          shotIdMap.set(shot.id, Number(inserted.lastInsertRowid));
        }
        for (const link of shotAssets || []) {
          const newShotId = shotIdMap.get(link.shot_id);
          if (newShotId && row('SELECT id FROM assets WHERE id=?', link.asset_id)) run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)', newShotId, link.asset_id, link.role);
        }
        for (const final of finals || []) { run('INSERT INTO episode_exports(episode_id,name,file_path,type,created_at) VALUES (?,?,?,?,?)', newEpId, final.name, final.file_path, final.type || 'mp4', now()); }
        run('DELETE FROM trash WHERE id=?', id);
        event('Folge wiederhergestellt', episode.title);
        return json(res, 200, { ok: true, kind: 'episode' });
      }
      if (entry.kind === 'project') {
        const { project, episodes: oldEpisodes, shots: oldShots, shotAssets: oldShotAssets, episodeAssets: oldEpisodeAssets, storyDocuments, storyVersions, episodeExports, assets: oldAssets, assetPhotos } = data;
        const slug = createHash('sha1').update(`${project.title}-${now()}`).digest('hex').slice(0, 10);
        const insertedProject = run('INSERT INTO projects(slug,title,synopsis,source_path,created_at,style_profile,negative_prompt,video_steps,photo_steps,preview_width,preview_height,final_width,final_height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          slug, project.title, project.synopsis, project.source_path, now(), project.style_profile, project.negative_prompt || '', project.video_steps, project.photo_steps, project.preview_width, project.preview_height, project.final_width, project.final_height);
        const newProjectId = Number(insertedProject.lastInsertRowid);
        const assetIdMap = new Map();
        for (const asset of oldAssets || []) {
          const inserted = run('INSERT INTO assets(project_id,kind,name,summary,visual_notes,file_path,created_at) VALUES (?,?,?,?,?,?,?)',
            newProjectId, asset.kind, asset.name, asset.summary, asset.visual_notes, asset.file_path, now());
          assetIdMap.set(asset.id, Number(inserted.lastInsertRowid));
        }
        for (const photo of assetPhotos || []) {
          const newAssetId = assetIdMap.get(photo.asset_id);
          if (newAssetId) run('INSERT INTO asset_photos(asset_id,file_path,is_primary,created_at) VALUES (?,?,?,?)', newAssetId, photo.file_path, photo.is_primary, photo.created_at);
        }
        const episodeIdMap = new Map();
        for (const episode of oldEpisodes || []) {
          const inserted = run('INSERT INTO episodes(project_id,number,title,duration_seconds,manifest_path,created_at,style_profile,negative_prompt,video_steps,photo_steps,preview_width,preview_height,final_width,final_height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            newProjectId, episode.number, episode.title, episode.duration_seconds || 0, episode.manifest_path || '', now(), episode.style_profile, episode.negative_prompt || null, episode.video_steps, episode.photo_steps, episode.preview_width, episode.preview_height, episode.final_width, episode.final_height);
          episodeIdMap.set(episode.id, Number(inserted.lastInsertRowid));
        }
        for (const doc of storyDocuments || []) { const newEpId = episodeIdMap.get(doc.episode_id); if (newEpId) run('INSERT INTO story_documents(episode_id,markdown,updated_at) VALUES (?,?,?)', newEpId, doc.markdown, now()); }
        for (const v of storyVersions || []) { const newEpId = episodeIdMap.get(v.episode_id); if (newEpId) run('INSERT INTO story_versions(episode_id,markdown,saved_at) VALUES (?,?,?)', newEpId, v.markdown, v.saved_at); }
        for (const exp of episodeExports || []) { const newEpId = episodeIdMap.get(exp.episode_id); if (newEpId) run('INSERT INTO episode_exports(episode_id,name,file_path,type,created_at) VALUES (?,?,?,?,?)', newEpId, exp.name, exp.file_path, exp.type || 'mp4', now()); }
        for (const link of oldEpisodeAssets || []) { const newEpId = episodeIdMap.get(link.episode_id), newAssetId = assetIdMap.get(link.asset_id); if (newEpId && newAssetId) run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)', newEpId, newAssetId); }
        const shotIdMap = new Map();
        for (const shot of oldShots || []) {
          const newEpId = episodeIdMap.get(shot.episode_id); if (!newEpId) continue;
          const inserted = run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,source_image_path,output_video_path,render_tier,kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            newEpId, shot.sequence, shot.title, shot.prompt, shot.camera, shot.duration_seconds, shot.seed, shot.status, shot.source_image_path, shot.output_video_path, shot.render_tier || 'Vorschau', shot.kind || 'scene', now());
          shotIdMap.set(shot.id, Number(inserted.lastInsertRowid));
        }
        for (const link of oldShotAssets || []) { const newShotId = shotIdMap.get(link.shot_id), newAssetId = assetIdMap.get(link.asset_id); if (newShotId && newAssetId) run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)', newShotId, newAssetId, link.role); }
        run('DELETE FROM trash WHERE id=?', id);
        event('Projekt wiederhergestellt', project.title);
        return json(res, 200, { ok: true, kind: 'project' });
      }
      return json(res, 400, { error: 'Unbekannter Papierkorb-Typ.' });
    }
    if (path === '/api/jobs/cancel-all' && req.method === 'POST') {
      if (!guard(req, res)) return;
      const targets = rows("SELECT id, shot_id FROM jobs WHERE state IN ('wartet','läuft')");
      run("UPDATE jobs SET state='abgebrochen', detail='Vom Benutzer gestoppt.', completed_at=? WHERE state IN ('wartet', 'läuft')", now());
      run("UPDATE shots SET status='Entwurf' WHERE status IN ('in Warteschlange', 'läuft', 'V2-Warteschlange')");
      event('Render-Queue gestoppt', `${targets.length} Aufträge abgebrochen.`);
      return json(res, 200, { ok: true, canceled: targets.length });
    }
    if (/^\/api\/assets\/\d+$/.test(path) && req.method === 'PATCH') { if (!guard(req,res)) return; const id=Number(path.split('/').pop()),d=await body(req),a=row('SELECT * FROM assets WHERE id=?',id); if(!a)return json(res,404,{error:'Material nicht gefunden.'}); const newFilePath=String(d.filePath??a.file_path??'')||null; run('UPDATE assets SET name=?,summary=?,visual_notes=?,file_path=?,voice=? WHERE id=?',assertText(d.name??a.name,'Name',100),String(d.summary??a.summary),String(d.visualNotes??a.visual_notes),newFilePath,String(d.voice??a.voice??'').trim().slice(0,60)||null,id);
      if(d.filePath!==undefined){ if(d.filePath){run('UPDATE asset_photos SET is_primary=0 WHERE asset_id=?',id);run('INSERT INTO asset_photos(asset_id,file_path,is_primary,created_at) VALUES (?,?,1,?)',id,String(d.filePath),now());} else {run('DELETE FROM asset_photos WHERE asset_id=? AND is_primary=1',id);} }
      event('Material aktualisiert',a.name);return json(res,200,{ok:true}); }
    if (/^\/api\/assets\/\d+\/photos$/.test(path) && req.method === 'GET') { if (!guard(req,res)) return; const id=Number(path.split('/')[3]); const a=row('SELECT id FROM assets WHERE id=?',id); if(!a)return json(res,404,{error:'Material nicht gefunden.'}); const photos=rows('SELECT id,file_path,is_primary,created_at FROM asset_photos WHERE asset_id=? ORDER BY is_primary DESC,created_at DESC',id).map(p=>({id:p.id,url:`/media/${encodeURIComponent(p.file_path)}`,isPrimary:!!p.is_primary,createdAt:p.created_at})); return json(res,200,{photos}); }
    if (/^\/api\/assets\/\d+\/photos$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const id=Number(path.split('/')[3]),d=await body(req); const a=row('SELECT * FROM assets WHERE id=?',id); if(!a)return json(res,404,{error:'Material nicht gefunden.'}); const filePath=String(d.path||'').trim(); if(!filePath)return json(res,400,{error:'Kein Foto-Pfad übergeben.'}); const existing=row('SELECT COUNT(*) c FROM asset_photos WHERE asset_id=?',id); const makesPrimary=!existing.c; if(makesPrimary){run('UPDATE assets SET file_path=? WHERE id=?',filePath,id);} const ins=run('INSERT INTO asset_photos(asset_id,file_path,is_primary,created_at) VALUES (?,?,?,?)',id,filePath,makesPrimary?1:0,now()); event('Referenzfoto hinzugefügt',a.name); return json(res,201,{photo:{id:Number(ins.lastInsertRowid),url:`/media/${encodeURIComponent(filePath)}`,isPrimary:makesPrimary}}); }
    if (/^\/api\/assets\/\d+\/photos\/\d+$/.test(path) && req.method === 'DELETE') { if (!guard(req,res)) return; const parts=path.split('/'),assetId=Number(parts[3]),photoId=Number(parts[5]); const a=row('SELECT * FROM assets WHERE id=?',assetId); if(!a)return json(res,404,{error:'Material nicht gefunden.'}); const photo=row('SELECT * FROM asset_photos WHERE id=? AND asset_id=?',photoId,assetId); if(!photo)return json(res,404,{error:'Foto nicht gefunden.'}); run('DELETE FROM asset_photos WHERE id=?',photoId); if(photo.is_primary){const next=row('SELECT * FROM asset_photos WHERE asset_id=? ORDER BY created_at DESC LIMIT 1',assetId); if(next){run('UPDATE asset_photos SET is_primary=1 WHERE id=?',next.id);run('UPDATE assets SET file_path=? WHERE id=?',next.file_path,assetId);} else {run('UPDATE assets SET file_path=NULL WHERE id=?',assetId);}} event('Referenzfoto entfernt',a.name); return json(res,200,{ok:true}); }
    if (/^\/api\/assets\/\d+\/photos\/\d+$/.test(path) && req.method === 'PATCH') { if (!guard(req,res)) return; const parts=path.split('/'),assetId=Number(parts[3]),photoId=Number(parts[5]),d=await body(req); const a=row('SELECT * FROM assets WHERE id=?',assetId); if(!a)return json(res,404,{error:'Material nicht gefunden.'}); const photo=row('SELECT * FROM asset_photos WHERE id=? AND asset_id=?',photoId,assetId); if(!photo)return json(res,404,{error:'Foto nicht gefunden.'}); if(d.primary){run('UPDATE asset_photos SET is_primary=0 WHERE asset_id=?',assetId);run('UPDATE asset_photos SET is_primary=1 WHERE id=?',photoId);run('UPDATE assets SET file_path=? WHERE id=?',photo.file_path,assetId);event('Hauptfoto geändert',a.name);} return json(res,200,{ok:true}); }
    if (/^\/api\/assets\/\d+\/caption$/.test(path) && req.method === 'POST') {
      const account = guard(req, res); if (!account) return;
      const id = Number(path.split('/')[3]);
      const a = row('SELECT * FROM assets WHERE id=?', id);
      if (!a) return json(res, 404, { error: 'Material nicht gefunden.' });
      if (!a.file_path) return json(res, 400, { error: 'Dieses Material hat noch kein Foto. Lade zuerst ein Foto hoch.' });
      const ep = row('SELECT id FROM episodes WHERE project_id=? ORDER BY number LIMIT 1', a.project_id);
      const job = run('INSERT INTO jobs(episode_id,kind,label,state,detail,created_at,owner_id,asset_id) VALUES (?,?,?,?,?,?,?,?)', ep.id, 'caption_asset', `KI-Beschreibung · ${a.name}`, 'wartet', '', now(), account.id, a.id);
      event('Beschreibung angefordert', a.name);
      return json(res, 201, { job: row('SELECT * FROM jobs WHERE id=?', Number(job.lastInsertRowid)) });
    }
    if (/^\/api\/assets\/\d+\/preview$/.test(path) && req.method === 'POST') { const account=guard(req,res); if (!account) return; const id=Number(path.split('/')[3]),d=await body(req),a=row('SELECT * FROM assets WHERE id=?',id); if(!a)return json(res,404,{error:'Material nicht gefunden.'}); const ep=row('SELECT id FROM episodes WHERE id=? AND project_id=?',Number(d.episodeId),a.project_id) || row('SELECT id FROM episodes WHERE project_id=? ORDER BY number LIMIT 1',a.project_id); const project=row('SELECT style_profile FROM projects WHERE id=?',a.project_id);const prompt=String(d.prompt||buildReferencePrompt(a,project?.style_profile||'')).trim(); if(!prompt)return json(res,400,{error:'Ein Bildprompt wird benötigt.'}); const job=run('INSERT INTO jobs(episode_id,kind,label,state,detail,created_at,owner_id,asset_id) VALUES (?,?,?,?,?,?,?,?)',ep.id,'comfyui_reference_preview',`ComfyUI · Referenz: ${a.name}`,'wartet',prompt,now(),account.id,a.id); event('Referenzvorschau vorbereitet',a.name); return json(res,201,{job:row('SELECT * FROM jobs WHERE id=?',Number(job.lastInsertRowid)),prompt}); }
    if (/^\/api\/projects\/\d+\/assets$/.test(path) && req.method === 'GET') { if (!guard(req,res)) return; const projectId=Number(path.split('/')[3]); const asset=a=>({...a,url:a.file_path&&existsSync(mediaPath(a.file_path))?`/media/${encodeURIComponent(a.file_path)}`:null}); return json(res,200,{assets:rows('SELECT * FROM assets WHERE project_id=? ORDER BY kind,name',projectId).map(asset)}); }
    if (/^\/api\/episodes\/\d+\/assets$/.test(path) && req.method === 'PUT') { if (!guard(req,res)) return; const episodeId=Number(path.split('/')[3]),d=await body(req); run('DELETE FROM episode_assets WHERE episode_id=?',episodeId); for(const assetId of (d.assetIds||[]))run('INSERT OR IGNORE INTO episode_assets(episode_id,asset_id) VALUES (?,?)',Number(episodeId),Number(assetId)); event('Besetzung aktualisiert',`Episode ${episodeId}`); return json(res,200,{ok:true}); }
    if (/^\/api\/episodes\/\d+\/shots$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const episodeId=Number(path.split('/')[3]),d=await body(req); const sequence=(row('SELECT MAX(sequence) max FROM shots WHERE episode_id=?',episodeId)?.max||0)+1; const ins=run('INSERT INTO shots(episode_id,sequence,title,prompt,camera,duration_seconds,seed,status,source_image_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',episodeId,sequence,assertText(d.title,'Shot-Titel',120),String(d.prompt||'').trim(),String(d.camera||'').trim(),Number(d.durationSeconds)||5,Number(d.seed)||null,'Entwurf',String(d.sourceImagePath||'').trim()||null,now()); event('Neuer Shot',d.title); return json(res,201,{shot:row('SELECT * FROM shots WHERE id=?',Number(ins.lastInsertRowid))}); }
    if (/^\/api\/shots\/\d+$/.test(path) && req.method === 'PATCH') { if (!guard(req,res)) return; const id=Number(path.split('/').pop()),d=await body(req),s=row('SELECT * FROM shots WHERE id=?',id); if(!s)return json(res,404,{error:'Shot nicht gefunden.'}); run('UPDATE shots SET title=?, prompt=?, camera=?, duration_seconds=?, seed=?, status=? WHERE id=?',assertText(d.title??s.title,'Shot-Titel',120),String(d.prompt??s.prompt),String(d.camera??s.camera),Number(d.durationSeconds??s.duration_seconds)||5,Number(d.seed??s.seed)||null,String(d.status??s.status),id); event('Shot aktualisiert',s.title);return json(res,200,{ok:true}); }
    if (/^\/api\/shots\/\d+\/assets$/.test(path) && req.method === 'PUT') { if (!guard(req,res)) return; const shotId=Number(path.split('/')[3]),d=await body(req),shot=row('SELECT s.*,e.project_id FROM shots s JOIN episodes e ON e.id=s.episode_id WHERE s.id=?',shotId); if(!shot)return json(res,404,{error:'Shot nicht gefunden.'});run('DELETE FROM shot_assets WHERE shot_id=?',shotId);for(const assetId of(d.assetIds||[])){if(row('SELECT id FROM assets WHERE id=? AND project_id=?',Number(assetId),shot.project_id))run('INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES (?,?,?)',shotId,Number(assetId),'reference')}event('Shot-Besetzung aktualisiert',shot.title);return json(res,200,{ok:true}); }
    if (/^\/api\/shots\/\d+\/dialogue$/.test(path) && req.method === 'GET') { if (!guard(req,res)) return; const shotId=Number(path.split('/')[3]); if(!row('SELECT id FROM shots WHERE id=?',shotId))return json(res,404,{error:'Shot nicht gefunden.'}); const lines=rows('SELECT d.id,d.asset_id,d.sequence,d.text,a.name asset_name,a.voice FROM shot_dialogue d LEFT JOIN assets a ON a.id=d.asset_id WHERE d.shot_id=? ORDER BY d.sequence,d.id',shotId); return json(res,200,{lines}); }
    if (/^\/api\/shots\/\d+\/dialogue$/.test(path) && req.method === 'POST') { if (!guard(req,res)) return; const shotId=Number(path.split('/')[3]),d=await body(req),shot=row('SELECT s.*,e.project_id FROM shots s JOIN episodes e ON e.id=s.episode_id WHERE s.id=?',shotId); if(!shot)return json(res,404,{error:'Shot nicht gefunden.'}); const text=String(d.text||'').trim(); if(!text)return json(res,400,{error:'Text darf nicht leer sein.'}); const assetId=Number(d.assetId)||null; if(assetId && !row('SELECT id FROM assets WHERE id=? AND project_id=?',assetId,shot.project_id))return json(res,400,{error:'Diese Figur gehört nicht zu diesem Projekt.'}); const seq=(row('SELECT MAX(sequence) max FROM shot_dialogue WHERE shot_id=?',shotId)?.max||0)+1; const ins=run('INSERT INTO shot_dialogue(shot_id,asset_id,sequence,text,created_at) VALUES (?,?,?,?,?)',shotId,assetId,seq,text.slice(0,1000),now()); event('Dialogzeile hinzugefügt',shot.title); return json(res,201,{line:row('SELECT id,asset_id,sequence,text FROM shot_dialogue WHERE id=?',Number(ins.lastInsertRowid))}); }
    if (/^\/api\/shots\/\d+\/dialogue\/\d+$/.test(path) && req.method === 'PATCH') { if (!guard(req,res)) return; const parts=path.split('/'),shotId=Number(parts[3]),lineId=Number(parts[5]),d=await body(req),line=row('SELECT * FROM shot_dialogue WHERE id=? AND shot_id=?',lineId,shotId); if(!line)return json(res,404,{error:'Dialogzeile nicht gefunden.'}); const assetId=d.assetId!==undefined?(Number(d.assetId)||null):line.asset_id; run('UPDATE shot_dialogue SET text=?, asset_id=? WHERE id=?',String(d.text??line.text).trim().slice(0,1000),assetId,lineId); return json(res,200,{ok:true}); }
    if (/^\/api\/shots\/\d+\/dialogue\/\d+$/.test(path) && req.method === 'DELETE') { if (!guard(req,res)) return; const parts=path.split('/'),shotId=Number(parts[3]),lineId=Number(parts[5]); const removed=run('DELETE FROM shot_dialogue WHERE id=? AND shot_id=?',lineId,shotId); if(!removed.changes)return json(res,404,{error:'Dialogzeile nicht gefunden.'}); return json(res,200,{ok:true}); }
    if (path === '/api/jobs/batch' && req.method === 'POST') {
      const account = guard(req, res); if (!account) return;
      const d = await body(req);
      const ep = row('SELECT * FROM episodes WHERE id=?', Number(d.episodeId)) || row('SELECT id FROM episodes WHERE number=1 LIMIT 1');
      const force = d.force === true;
      const openShots = force
        ? rows("SELECT s.* FROM shots s WHERE s.episode_id=? AND s.prompt<>'' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.shot_id=s.id AND j.state IN ('wartet','läuft')) ORDER BY s.sequence", ep.id)
        : rows("SELECT s.* FROM shots s WHERE s.episode_id=? AND (s.output_video_path IS NULL OR s.output_video_path='') AND s.prompt<>'' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.shot_id=s.id AND j.state IN ('wartet','läuft')) ORDER BY s.sequence", ep.id);
      if (!openShots.length) return json(res, 400, { error: force ? 'Alle Shots werden bereits gerendert oder warten schon.' : 'Keine offenen Shots zum Rendern gefunden.' });
      const tier = d.tier === 'Vorschau' ? 'Vorschau' : 'Fertig';
      const project = row('SELECT style_profile FROM projects WHERE id=?', ep.project_id);
      const referenceResult = queueMissingReferencePreviews({...ep,style_profile:ep.style_profile||project?.style_profile||''}, account.id, openShots.map(s => s.id));
      const photosQueued = referenceResult.queued;
      let queued = 0;
      for (const shot of openShots) {
        run("UPDATE shots SET status='in Warteschlange', render_tier=? WHERE id=?", tier, shot.id);
        run('INSERT INTO jobs(episode_id,kind,label,state,detail,created_at,owner_id,shot_id) VALUES (?,?,?,?,?,?,?,?)', ep.id, 'minimax_h3', `MiniMax H3 · ${shot.title}`, 'wartet', 'Video-Job wartet auf einen lokalen FrameCut-Worker.', now(), account.id, shot.id);
        queued++;
      }
      event('Batch-Rendering gestartet', `${queued} Shots für Episode ${ep.id} eingereiht${photosQueued ? `, davor ${photosQueued} fehlende Referenzfotos` : ''}.`);
      return json(res, 201, { ok: true, queued, total: openShots.length, photosQueued });
    }
    if (path === '/api/jobs' && req.method === 'POST') {
      const account = guard(req, res); if (!account) return;
      const d = await body(req);
      const ep = row('SELECT * FROM episodes WHERE id=?', Number(d.episodeId)) || row('SELECT id FROM episodes WHERE number=1 LIMIT 1');
      let shot;
      if (Number(d.shotId)) {
        shot = row('SELECT * FROM shots WHERE id=? AND episode_id=?', Number(d.shotId), ep.id);
        if (shot && row("SELECT id FROM jobs WHERE shot_id=? AND state IN ('wartet','läuft')", shot.id)) {
          return json(res, 409, { error: 'Dieser Shot ist bereits in der Render-Warteschlange.' });
        }
      } else {
        shot = row("SELECT s.* FROM shots s WHERE s.episode_id=? AND s.output_video_path IS NULL AND s.prompt<>'' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.shot_id=s.id AND j.state IN ('wartet','läuft')) ORDER BY s.sequence LIMIT 1", ep.id);
      }
      if (!shot) return json(res, 409, { error: 'Kein renderbarer offener Shot gefunden. Prüfe Shot-Prompt oder bestehende Aufträge.' });
      const tier = d.tier === 'Vorschau' ? 'Vorschau' : 'Fertig';
      const project = row('SELECT style_profile FROM projects WHERE id=?', ep.project_id);
      const referenceResult = queueMissingReferencePreviews({...ep,style_profile:ep.style_profile||project?.style_profile||''}, account.id, [shot.id]);
      run("UPDATE shots SET status='in Warteschlange', render_tier=? WHERE id=?", tier, shot.id);
      const job = run('INSERT INTO jobs(episode_id,kind,label,state,detail,created_at,owner_id,shot_id) VALUES (?,?,?,?,?,?,?,?)', ep.id, 'minimax_h3', `MiniMax H3 · ${shot.title}`, 'wartet', 'Video-Job wartet auf einen lokalen FrameCut-Worker.', now(), account.id, shot.id);
      event('Renderauftrag eingereiht', `${shot.title} (Shot ${shot.sequence})${referenceResult.queued ? `, davor ${referenceResult.queued} fehlende Referenzfotos` : ''}`);
      return json(res, 201, { job: row('SELECT * FROM jobs WHERE id=?', Number(job.lastInsertRowid)), shot, photosQueued:referenceResult.queued });
    }
    if (/^\/api\/episodes\/\d+\/audio-preflight$/.test(path) && req.method === 'GET') {
      const account = guard(req, res); if (!account) return;
      const episodeId = Number(path.split('/')[3]);
      const audio = audioContextForEpisode(episodeId, account.id);
      if (!audio) return json(res, 404, { error: 'Episode nicht gefunden.' });
      return json(res, 200, {
        episodeId, source: audio.source, updatedAt: audio.updatedAt, manifest: audio.manifest,
        generatedManifest: audio.generated, manifestValid: audio.manifestValid, validationErrors: audio.validationErrors,
        sourceCurrent: audio.sourceCurrent, cues: audio.cues, cuesReady: audio.cuesReady,
        readyForMaster: audio.readyForMaster, mixingWorkerAvailable: audio.mixingWorkerAvailable, blockers: audio.blockers,
      });
    }
    if (/^\/api\/episodes\/\d+\/audio-manifest$/.test(path) && req.method === 'POST') {
      const account = guard(req, res); if (!account) return;
      const episodeId = Number(path.split('/')[3]);
      const audio = audioContextForEpisode(episodeId, account.id);
      if (!audio) return json(res, 404, { error: 'Episode nicht gefunden.' });
      const d = await body(req);
      const manifest = d?.manifest;
      const errors = validateAudioManifest(manifest);
      if (errors.length) return json(res, 400, { error: 'Der Audio-Plan ist ungültig.', validationErrors: errors });
      const expected = expectedAudioIdentity(account, audio.episode);
      if (manifest.owner_id !== expected.owner_id || manifest.project_id !== expected.project_id || manifest.episode_id !== expected.episode_id) {
        return json(res, 400, { error: 'Der Audio-Plan gehört nicht zu diesem Benutzer, Projekt und dieser Episode.' });
      }
      if (manifest.source_revision !== audio.generated.source_revision) {
        return json(res, 409, { error: 'Die Shot-Timeline oder Dialoge wurden verändert. Bitte zuerst einen aktuellen Audio-Plan herunterladen.' });
      }
      run(`INSERT INTO episode_audio_manifests(episode_id,owner_id,manifest_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(episode_id) DO UPDATE SET owner_id=excluded.owner_id,manifest_json=excluded.manifest_json,updated_at=excluded.updated_at`, episodeId, account.id, JSON.stringify(manifest), now());
      event('Audio-Plan gespeichert', `${audio.episode.title} · ${manifest.cues.length} Cue(s)`);
      const refreshed = audioContextForEpisode(episodeId, account.id);
      return json(res, 200, { ok: true, source: refreshed.source, updatedAt: refreshed.updatedAt, manifest: refreshed.manifest, cues: refreshed.cues, blockers: refreshed.blockers, readyForMaster: refreshed.readyForMaster });
    }
    if (/^\/api\/episodes\/\d+\/assemble$/.test(path) && req.method === 'POST') {
      const account = guard(req, res); if (!account) return;
      const episodeId = Number(path.split('/')[3]);
      const ep = row('SELECT e.*, p.title project_title FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=?', episodeId);
      if (!ep) return json(res, 404, { error: 'Episode nicht gefunden.' });
      const d = await body(req);
      const audio = audioContextForEpisode(episodeId, account.id);
      const pictureOnly = d.pictureOnly === true;
      // A concat copy used to silently produce an alleged "final film" without the
      // planned dialogue/music. Until an audio mix worker is registered, require an
      // explicit picture-only choice. The returned MP4 then has no accidental audio.
      if (!audio.readyForMaster && !pictureOnly) {
        return json(res, 409, { error: 'Audio-Master ist noch nicht bereit. Erstelle zuerst die Audio-Cues und mische sie mit einem Audio-Worker – oder bestätige bewusst einen Bildschnitt ohne Ton.', audio: { cues: audio.cues, blockers: audio.blockers, validationErrors: audio.validationErrors, sourceCurrent: audio.sourceCurrent } });
      }
      const shots = rows('SELECT * FROM shots WHERE episode_id=? AND output_video_path IS NOT NULL AND length(output_video_path)>0 ORDER BY sequence', episodeId);
      const validShots = shots.filter(s => existsSync(mediaPath(s.output_video_path)));
      if (!validShots.length) return json(res, 400, { error: 'Noch keine gerenderten Clips für diese Episode vorhanden.' });
      await mkdir(UPLOADS, { recursive: true });
      const listFile = join(UPLOADS, `concat-${episodeId}-${Date.now()}.txt`);
      const lines = validShots.map(s => `file '${mediaPath(s.output_video_path).replaceAll("'", "'\\''")}'`);
      await writeFile(listFile, lines.join('\n'), 'utf8');
      const outFile = `final-${episodeId}-${randomBytes(5).toString('hex')}.mp4`;
      const outPath = join(UPLOADS, outFile);
      try {
        await new Promise((resolve, reject) => {
          const ffArgs = pictureOnly
            ? ['-f', 'concat', '-safe', '0', '-i', listFile, '-map', '0:v:0', '-c:v', 'copy', '-an', '-y', outPath]
            : ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outPath];
          const ff = spawn('ffmpeg', ffArgs);
          let err = '';
          ff.stderr.on('data', d => err += d.toString());
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit code ${code}: ${err.slice(-500)}`)));
          ff.on('error', reject);
        });
        const statInfo = await stat(outPath);
        const portable = `data/uploads/${outFile}`;
        const exportName = `${ep.project_title} - ${ep.title}${pictureOnly ? ' [Bildschnitt ohne Ton]' : ''} (${validShots.length} Clips).mp4`;
        run('INSERT INTO episode_exports(episode_id,name,file_path,type,created_at) VALUES (?,?,?,?,?)', episodeId, exportName, portable, 'mp4', now());
        event(pictureOnly ? 'Bildschnitt exportiert' : 'Episode exportiert', `${exportName} · ${Math.round(statInfo.size/1024/1024)} MB`);
        return json(res, 201, { ok: true, name: exportName, path: portable, count: validShots.length, size: statInfo.size, pictureOnly });
      } catch (err) {
        console.error('Assemble error:', err);
        return json(res, 500, { error: 'Export fehlgeschlagen: ' + err.message });
      }
    }
    if (path === '/api/worker/next' && req.method === 'GET') {
      if (!workerGuard(req,res)) return;
      const workerId=String(req.headers['x-framecut-worker-id']||'laptop').slice(0,80);
      run('INSERT INTO workers(id,last_seen,first_seen) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen', workerId, now(), now());
      db.exec('BEGIN IMMEDIATE');
      let job;
      try {
        recoverQueuedReferenceGaps();
        job=row(`SELECT j.*,e.project_id,e.number episode_number,e.title episode_title,p.title project_title,
          COALESCE(e.style_profile,p.style_profile) style_profile,
          COALESCE(NULLIF(e.negative_prompt,''),p.negative_prompt,'') negative_prompt,
          COALESCE(e.video_steps,p.video_steps) video_steps,COALESCE(e.photo_steps,p.photo_steps) photo_steps,
          COALESCE(e.preview_width,p.preview_width) preview_width,COALESCE(e.preview_height,p.preview_height) preview_height,
          COALESCE(e.final_width,p.final_width) final_width,COALESCE(e.final_height,p.final_height) final_height
          FROM jobs j JOIN episodes e ON e.id=j.episode_id JOIN projects p ON p.id=e.project_id
          WHERE j.state='wartet' AND j.kind IN ('comfyui_reference_preview','caption_asset','minimax_h3')
            AND (j.kind<>'minimax_h3' OR NOT EXISTS (
              SELECT 1 FROM shot_assets sa JOIN assets a ON a.id=sa.asset_id
              WHERE sa.shot_id=j.shot_id AND (a.file_path IS NULL OR a.file_path='')
            ))
          -- Captions of user-supplied reference images are a production prerequisite: they
          -- replace unreliable free-text notes before any more generated asset previews consume
          -- the GPU.  Preview jobs remain queued, rather than being cancelled.
          ORDER BY CASE j.kind WHEN 'caption_asset' THEN 1 WHEN 'comfyui_reference_preview' THEN 2 ELSE 3 END,j.id LIMIT 1`);
        if(job){
          const claimed=run("UPDATE jobs SET state='läuft',started_at=?,worker_id=? WHERE id=? AND state='wartet'",now(),workerId,job.id);
          if(!claimed.changes) job=null;
          else if(job.shot_id) run("UPDATE shots SET status='läuft' WHERE id=?",job.shot_id);
        }
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      if(!job) return json(res,204,{});
      if(job.kind==='comfyui_reference_preview'){
        const asset=row('SELECT id,name,kind,summary,visual_notes FROM assets WHERE id=?',job.asset_id);
        if(!asset){run("UPDATE jobs SET state='fehlgeschlagen',detail=?,completed_at=? WHERE id=?",'Das zugehörige Asset fehlt.',now(),job.id);return json(res,204,{});}
        return json(res,200,{job,asset,prompt:job.detail});
      }
      if(job.kind==='caption_asset'){
        const asset=row('SELECT id,name,kind,summary,visual_notes,file_path FROM assets WHERE id=?',job.asset_id);
        if(!asset||!asset.file_path){run("UPDATE jobs SET state='fehlgeschlagen',detail=?,completed_at=? WHERE id=?",'Das zugehörige Asset oder Foto fehlt.',now(),job.id);return json(res,204,{});}
        return json(res,200,{job,asset,downloadUrl:`/api/worker/assets/${asset.id}/file`});
      }
      const shot=row('SELECT * FROM shots WHERE id=?',job.shot_id);
      if(!shot){run("UPDATE jobs SET state='fehlgeschlagen',detail=?,completed_at=? WHERE id=?",'Der zugehörige Shot fehlt.',now(),job.id);return json(res,204,{});}
      const references=rows("SELECT a.id,a.name,a.kind,a.summary,a.visual_notes,a.file_path,sa.role FROM shot_assets sa JOIN assets a ON a.id=sa.asset_id WHERE sa.shot_id=? ORDER BY CASE sa.role WHEN 'reference' THEN 1 ELSE 2 END,a.id",shot.id)
        .filter(a=>a.file_path).map(a=>({...a,file_path:undefined,downloadUrl:`/api/worker/assets/${a.id}/file`}));
      const source=shot.source_image_path?{name:'Shot-Startbild',kind:'source',role:'source',downloadUrl:`/api/worker/shots/${shot.id}/source`}:null;
      return json(res,200,{job,shot:{...shot,source_image_path:undefined,output_video_path:undefined,references:source?[source,...references]:references}});
    }
    if (/^\/api\/worker\/jobs\/\d+\/image$/.test(path) && req.method === 'POST') { if(!workerGuard(req,res))return; const id=Number(path.split('/')[4]),job=row('SELECT * FROM jobs WHERE id=?',id),d=await body(req,9_000_000); if(!job?.asset_id)return json(res,404,{error:'Bildauftrag nicht gefunden.'}); const match=String(d.data||'').match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/); if(!match)return json(res,400,{error:'Bilddaten sind ungültig.'}); const bytes=Buffer.from(match[2],'base64');if(bytes.length>6*1024*1024)return json(res,400,{error:'Vorschaubild ist größer als 6 MB.'});await mkdir(UPLOADS,{recursive:true});const ext=match[1]==='image/png'?'png':match[1]==='image/webp'?'webp':'jpg',file=`worker-${id}-${randomBytes(5).toString('hex')}.${ext}`;await writeFile(join(UPLOADS,file),bytes);const portable=`data/uploads/${file}`;run('UPDATE assets SET file_path=? WHERE id=?',portable,job.asset_id);run("UPDATE jobs SET state='fertig',detail=?,completed_at=? WHERE id=?",'Referenzbild lokal erzeugt und hochgeladen.',now(),id);event('Referenzbild fertig',`Job ${id} · Benutzer ${job.owner_id||'unbekannt'}`);return json(res,201,{ok:true,path:portable}); }
    if (/^\/api\/worker\/jobs\/\d+\/caption$/.test(path) && req.method === 'POST') {
      if (!workerGuard(req, res)) return;
      const id = Number(path.split('/')[4]);
      const job = row('SELECT * FROM jobs WHERE id=?', id);
      if (!job || !job.asset_id) return json(res, 404, { error: 'Beschreibungsauftrag nicht gefunden.' });
      const d = await body(req);
      const text = String(d.text || '').trim().slice(0, 2200);
      if (!text) return json(res, 400, { error: 'Leere Beschreibung erhalten.' });
      run('UPDATE assets SET visual_notes=? WHERE id=?', text, job.asset_id);
      run("UPDATE jobs SET state='fertig',detail=?,completed_at=? WHERE id=?", 'Beschreibung von der KI übernommen.', now(), id);
      event('Beschreibung erzeugt', `Job ${id}`);
      return json(res, 201, { ok: true });
    }
    if (/^\/api\/worker\/jobs\/\d+\/video$/.test(path) && req.method === 'POST') { if(!workerGuard(req,res))return; const id=Number(path.split('/')[4]),job=row('SELECT * FROM jobs WHERE id=?',id);if(!job?.shot_id)return json(res,404,{error:'Videoauftrag nicht gefunden.'});if(job.state==='abgebrochen')return json(res,409,{error:'Dieser Auftrag wurde bereits abgebrochen.'});const declared=Number(req.headers['content-length']||0);if(declared>100*1024*1024)return json(res,413,{error:'Clip ist größer als 100 MB.'});const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>100*1024*1024)throw new Error('Clip ist größer als 100 MB.');chunks.push(chunk)}if(!size)return json(res,400,{error:'Clip ist leer.'});await mkdir(UPLOADS,{recursive:true});const file=`clip-${job.episode_id}-${job.shot_id}-${randomBytes(5).toString('hex')}.mp4`;await writeFile(join(UPLOADS,file),Buffer.concat(chunks));const portable=`data/uploads/${file}`;run("UPDATE jobs SET state='fertig',detail=?,completed_at=? WHERE id=?",'Clip lokal gerendert und ins Projekt hochgeladen.',now(),id);run('UPDATE shots SET status=?,output_video_path=? WHERE id=?','Gerendert',portable,job.shot_id);event('Video-Job fertig',`Job ${id} · Benutzer ${job.owner_id||'unbekannt'}`);return json(res,201,{ok:true,path:portable,size}); }
    if (/^\/api\/worker\/episodes\/\d+\/final$/.test(path) && req.method === 'POST') { if(!workerGuard(req,res))return;const episodeId=Number(path.split('/')[4]);if(!row('SELECT id FROM episodes WHERE id=?',episodeId))return json(res,404,{error:'Episode nicht gefunden.'});const declared=Number(req.headers['content-length']||0);if(declared>1024*1024*1024)return json(res,413,{error:'Export ist größer als 1 GB.'});const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024*1024)throw new Error('Export ist größer als 1 GB.');chunks.push(chunk)}if(!size)return json(res,400,{error:'Export ist leer.'});await mkdir(UPLOADS,{recursive:true});const requested=decodeURIComponent(String(req.headers['x-framecut-name']||'FrameCut-Final.mp4')).replace(/[^a-zA-Z0-9._ -]/g,'').slice(0,120)||'FrameCut-Final.mp4';const file=`final-${episodeId}-${randomBytes(5).toString('hex')}.mp4`;await writeFile(join(UPLOADS,file),Buffer.concat(chunks));const portable=`data/uploads/${file}`;run('INSERT INTO episode_exports(episode_id,name,file_path,type,created_at) VALUES (?,?,?,?,?)',episodeId,requested,portable,'mp4',now());event('Episode exportiert',`${requested} · ${Math.round(size/1024/1024)} MB`);return json(res,201,{ok:true,path:portable,size}); }
    if (/^\/api\/worker\/assets\/\d+\/file$/.test(path) && req.method === 'GET') { if(!workerGuard(req,res))return; const asset=row('SELECT * FROM assets WHERE id=?',Number(path.split('/')[4])); if(!asset?.file_path)return json(res,404,{error:'Referenzdatei fehlt.'}); const target=mediaPath(asset.file_path); if(!permittedMediaPath(target)||!existsSync(target))return json(res,404,{error:'Referenzdatei fehlt.'}); return serveFile(res,target); }
    if (/^\/api\/worker\/episodes\/\d+\/status$/.test(path) && req.method === 'GET') { if(!workerGuard(req,res))return;const episodeId=Number(path.split('/')[4]);const counts=rows('SELECT kind,state,count(*) count FROM jobs WHERE episode_id=? GROUP BY kind,state',episodeId);const shots=row('SELECT count(*) total,sum(CASE WHEN output_video_path IS NOT NULL THEN 1 ELSE 0 END) finished FROM shots WHERE episode_id=?',episodeId);return json(res,200,{episodeId,counts,shots}); }
    if (/^\/api\/worker\/shots\/\d+\/source$/.test(path) && req.method === 'GET') { if(!workerGuard(req,res))return; const shot=row('SELECT * FROM shots WHERE id=?',Number(path.split('/')[4])); if(!shot?.source_image_path)return json(res,404,{error:'Startbild fehlt.'}); const target=mediaPath(shot.source_image_path); if(!permittedMediaPath(target)||!existsSync(target))return json(res,404,{error:'Startbild fehlt.'}); return serveFile(res,target); }
    if (/^\/api\/worker\/jobs\/\d+\/(complete|fail)$/.test(path) && req.method === 'POST') { if (!workerGuard(req,res)) return; const id=Number(path.split('/')[4]),action=path.split('/')[5],d=await body(req),job=row('SELECT * FROM jobs WHERE id=?',id); if(!job)return json(res,404,{error:'Job nicht gefunden.'}); if(job.state==='abgebrochen')return json(res,409,{error:'Dieser Auftrag wurde bereits abgebrochen.'}); const state=action==='complete'?'fertig':'fehlgeschlagen'; run('UPDATE jobs SET state=?,detail=?,completed_at=? WHERE id=?',state,String(d.detail||'').slice(0,4000),now(),id); if(action==='complete'&&job.shot_id){run('UPDATE shots SET status=?,output_video_path=COALESCE(?,output_video_path) WHERE id=?','Gerendert',String(d.outputPath||'').trim()||null,job.shot_id);} if(action==='fail'&&job.shot_id){const shot=row('SELECT output_video_path FROM shots WHERE id=?',job.shot_id);run('UPDATE shots SET status=? WHERE id=?',shot?.output_video_path?'Gerendert':'Entwurf',job.shot_id);} event(action==='complete'?'Video-Job fertig':'Video-Job fehlgeschlagen',`Job ${id} · Benutzer ${job.owner_id||'unbekannt'}`); return json(res,200,{ok:true}); }
    if (path === '/api/import-rabenblut' && req.method === 'POST') { if (!guard(req,res)) return; return json(res,200,{project:importRabenblut()}); }
    if (path === '/api/runtime' && req.method === 'GET') { if (!guard(req,res)) return; return json(res,200,{status:'bereit',message:'Render-Aufträge werden seriell an die vorhandenen lokalen Worker übergeben.',services:[['ComfyUI','Bildreferenzen','bereit'],['MiniMax H3','Video','bereit'],['Qwen TTS','Sprache','bei Bedarf'],['Audio Studio','Musik & SFX','bei Bedarf']]}); }
    if (path === '/' || path === '/index.html') return serveFile(res,join(APP,'public','index.html'));
    if (path === '/app.css') return serveFile(res,join(APP,'public','app.css'));
    if (path === '/guided.css') return serveFile(res,join(APP,'public','guided.css'));
    if (path === '/app.js') return serveFile(res,join(APP,'public','app.js'));
    if (path === '/auto-mode.js') return serveFile(res,join(APP,'public','auto-mode.js'));
    if (path === '/pwa.js') return serveFile(res,join(APP,'public','pwa.js'));
    if (path === '/sw.js') return serveFile(res,join(APP,'public','sw.js'));
    if (path === '/manifest.webmanifest') return serveFile(res,join(APP,'public','manifest.webmanifest'));
    if (path === '/framecut-icon.svg') return serveFile(res,join(APP,'public','framecut-icon.svg'));
    json(res,404,{error:'Nicht gefunden.'});
  } catch (error) { console.error(error); json(res,500,{error:error.message || 'Interner Fehler.'}); }
  if(path === '/api/jobs/bulk-delete' && req.method === 'POST') { if (!guard(req,res)) return; const d=await body(req); const ids=(d.jobIds||[]).filter(id=>Number.isInteger(Number(id))); if(ids.length===0) { json(res,400,{error:'Mindestens eine Job-ID erforderlich.'}); } else { const placeholders=ids.map(()=>'?').join(','); const deleted=run(`DELETE FROM jobs WHERE id IN (${placeholders})`,...ids); json(res,200,{deleted:deleted.changes,remaining:row('SELECT COUNT(*) as count FROM jobs').count}); } }
});
  if(process.argv.includes('--smoke-plan-existing')){
  smokePlanExistingProject().then(result=>{console.log(JSON.stringify(result));db.close();}).catch(error=>{console.error(error.message);db.close();process.exitCode=1;});
}else{
  server.listen(PORT,HOST,()=>console.log(`FrameCut: http://${HOST}:${PORT}`));
}
