const $ = s => document.querySelector(s);
let data = {}, currentProject, currentEpisode, assetFilter = 'all', shotFilter = 'all', currentView = 'overview', renderQualityTier = 'Fertig', shotSearch = '', shotAssetFilter = 'all';

function syncUrl() {
  const params = new URLSearchParams();
  if (currentProject) params.set('projectId', currentProject);
  if (currentEpisode) params.set('episodeId', currentEpisode);
  if (currentView && currentView !== 'overview') params.set('view', currentView);
  const query = params.toString();
  const newUrl = window.location.pathname + (query ? `?${query}` : '');
  if (newUrl !== window.location.pathname + window.location.search) {
    history.replaceState({ view: currentView, projectId: currentProject, episodeId: currentEpisode }, '', newUrl);
  }
}

async function api(path, options = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Etwas ist schiefgelaufen.');
  return d;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const fields = f => Object.fromEntries(new FormData(f));

function notice(message) {
  const n = $('#notice');
  n.textContent = message;
  n.classList.remove('hidden');
  setTimeout(() => n.classList.add('hidden'), 5000);
}

function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-content').innerHTML = '';
}

function showModal(html, submit) {
  $('#modal-content').innerHTML = html;
  $('#modal').classList.remove('hidden');
  const f = $('#modal form');
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    try { await submit(f); closeModal(); } catch (x) { $('#modal-error').textContent = x.message; }
  };
}

$('#modal-close').onclick = closeModal;
$('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };

async function init() {
  const b = await api('/api/bootstrap');
  $('#setup-form').classList.toggle('hidden', !b.setup);
  $('#login-container').classList.toggle('hidden', b.setup);
  $('#gate-copy').textContent = b.setup ? 'Lege das erste lokale Administrator-Konto an.' : 'Melde dich an und entwickle deine nächste Geschichte.';
  const p = new URLSearchParams(window.location.search);
  if (p.has('error')) {
    $('#auth-error').textContent = 'Anmeldung fehlgeschlagen: ' + p.get('error');
    history.replaceState({}, document.title, window.location.pathname);
  }
}

$('#setup-form').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/setup', { method: 'POST', body: JSON.stringify(fields(e.target)) });
    notice('Studio eingerichtet. Bitte anmelden.');
    await init();
  } catch (x) { $('#auth-error').textContent = x.message; }
};

$('#login-form').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify(fields(e.target)) });
    await openStudio();
  } catch (x) { $('#auth-error').textContent = x.message; }
};

async function openStudio() {
  const me = await api('/api/me');
  if (!me.user) return init();
  $('#auth').classList.add('hidden');
  $('#studio').classList.remove('hidden');
  $('#user').textContent = me.user.displayName;
  if ($('#user-avatar')) $('#user-avatar').textContent = (me.user.displayName || 'M').charAt(0).toUpperCase();
  const restoreParams = new URLSearchParams(window.location.search);
  if (restoreParams.has('projectId')) currentProject = Number(restoreParams.get('projectId'));
  if (restoreParams.has('episodeId')) currentEpisode = Number(restoreParams.get('episodeId'));
  await load();
  openView(restoreParams.get('view') || 'overview');
  startQueuePolling();
}

async function load() {
  const q = new URLSearchParams();
  if (currentProject) q.set('projectId', currentProject);
  if (currentEpisode) q.set('episodeId', currentEpisode);
  data = await api('/api/dashboard?' + q);
  if (data.selected) {
    currentProject = data.selected.project.id;
    currentEpisode = data.selected.episode.id;
  }
  render();
  syncUrl();
}

function renderProjectSwitcher() {
  const slots = document.querySelectorAll('.project-switcher-slot, #project-switcher-mobile');
  if (!slots.length) return;
  const html = `<div class="project-switcher">${data.projects.map(p => {
    const isActiveProject = p.id === currentProject;
    const episodesHtml = isActiveProject ? (data.selected?.episodes || []).map(e => `
      <button class="ps-episode ${e.id === currentEpisode ? 'active' : ''}" data-switch-episode="${e.id}">EP ${String(e.number).padStart(2, '0')} · ${esc(e.title)}</button>
    `).join('') : '';
    return `
      <div class="ps-project">
        <button class="ps-project-name ${isActiveProject ? 'active' : ''}" data-switch-project="${p.id}">${esc(p.title)}</button>
        ${isActiveProject ? `<div class="ps-episodes">${episodesHtml}</div>` : ''}
      </div>
    `;
  }).join('')}</div>`;
  slots.forEach(el => { el.innerHTML = html; });
  document.querySelectorAll('[data-switch-project]').forEach(btn => btn.onclick = () => {
    const id = Number(btn.dataset.switchProject);
    if (id === currentProject) return;
    currentProject = id; currentEpisode = null; load();
  });
  document.querySelectorAll('[data-switch-episode]').forEach(btn => btn.onclick = () => {
    const id = Number(btn.dataset.switchEpisode);
    if (id === currentEpisode) return;
    currentEpisode = id; load();
  });
}

function projectOptions() {
  const s = $('#project-switch');
  s.innerHTML = data.projects.map(p => `<option value="${p.id}" ${p.id === currentProject ? 'selected' : ''}>${esc(p.title)}</option>`).join('');
  $('#episode-switch').innerHTML = (data.selected?.episodes || []).map(e => `<option value="${e.id}" ${e.id === currentEpisode ? 'selected' : ''}>EP ${String(e.number).padStart(2, '0')} · ${esc(e.title)}</option>`).join('');
}

// SHOT CARD (Matches Mockup 1 & 2)
function shotCard(s) {
  const hasVideo = Boolean(s.video);
  const isRunning = s.status === 'läuft';
  const isQueued = s.status === 'in Warteschlange' || s.status === 'V2-Warteschlange' || s.status === 'wartet';
  const isDone = hasVideo && !isRunning && !isQueued;

  let badge = `<div class="shot-badge open">OFFEN</div>`;
  if (isRunning) {
    badge = `<div class="shot-badge running"><span class="pulse" style="width:6px;height:6px;margin:0;"></span> ${hasVideo ? 'RENDERT NEU' : 'RENDERT'}</div>`;
  } else if (isQueued) {
    badge = `<div class="shot-badge queued">⏳ ${hasVideo ? 'NEU IN QUEUE' : 'QUEUE'}</div>`;
  } else if (isDone) {
    badge = `<div class="shot-badge done"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> ${s.render_tier === 'Vorschau' ? 'VORSCHAU' : 'FERTIG'}</div>`;
  }

  const media = hasVideo
    ? `<video src="${s.video}" controls playsinline preload="metadata"></video>`
    : `<div class="shot-media-placeholder">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.4;margin-bottom:6px;"><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>
        <span>${isQueued ? 'In der GPU-Render-Queue' : 'Bereit für Renderlauf'}</span>
      </div>`;

  const refs = [...new Map((s.references || []).map(r => [r.id, r])).values()].map(r => `<span class="shot-tag">${esc(r.name)}</span>`).join('');

  return `<article class="shot-card ${isDone ? 'is-done' : ''}">
    <div class="shot-card-media">
      ${badge}
      ${media}
    </div>
    <div class="shot-card-content">
      <div class="shot-meta-top">
        <span class="shot-num">#${String(s.sequence || s.id).padStart(2, '0')}</span>
        <span class="shot-timing">${Number(s.duration_seconds || s.frames / 24).toFixed(1)}s · Seed ${s.seed || 'auto'}</span>
      </div>
      <div class="shot-title">${s.kind === 'intro' ? '<span class="shot-tag" style="background:rgba(255,183,3,0.15);color:#ffb703;border-color:rgba(255,183,3,0.3);margin-right:6px;">🎬 INTRO</span>' : s.kind === 'outro' ? '<span class="shot-tag" style="background:rgba(255,183,3,0.15);color:#ffb703;border-color:rgba(255,183,3,0.3);margin-right:6px;">🎬 OUTRO</span>' : ''}${esc(s.title.replace(/^\d+[_–-]/, '').replaceAll('_', ' '))}</div>
      <p class="shot-prompt-preview">${esc(s.prompt || 'Noch kein Prompt hinterlegt.')}</p>
      <div class="shot-tags">${refs || '<span class="shot-tag" style="opacity:0.5;">Keine Referenzen</span>'}</div>
      <div class="shot-actions">
        <button class="shot-btn" data-edit-shot="${s.id}">✏️ Bearbeiten</button>
        <button class="shot-btn render ${isDone ? 'is-done' : ''}" data-render-shot="${s.id}" ${(isQueued || isRunning) ? 'disabled' : ''}>${(isQueued || isRunning) ? '⏳ läuft bereits' : (hasVideo ? '🔄 Neu' : '🎬 Rendern')}</button>
        <button class="shot-btn danger" data-delete-shot="${s.id}" title="Shot löschen">🗑️</button>
      </div>
    </div>
  </article>`;
}

function render() {
  const d = data.selected;
  if (!d) return;
  const { project, episode, shots, assets, story, episodes, finals } = d;
  projectOptions();
  $('#crumb').textContent = `${project.title.toUpperCase()} / EPISODE ${String(episode.number).padStart(2, '0')}`;
  $('#title').textContent = episode.title;

  const doneCount = shots.filter(s => Boolean(s.output_video_path)).length;
  const totalCount = shots.length;
  const openCount = totalCount - doneCount;
  const percent = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
  const strokeOffset = 251.2 - (251.2 * percent / 100);

  // 1. ÜBERSICHT (HERO PROGRESS WIDGET)
  const heroHtml = totalCount === 0 ? `
    <div class="hero-progress-card hero-onboarding-card">
      <div style="font-size:36px;display:grid;place-items:center;background:rgba(0,229,153,0.1);width:64px;height:64px;border-radius:50%;border:1px solid rgba(0,229,153,0.25);">✦</div>
      <div class="progress-details">
        <div class="eyebrow" style="color:var(--emerald);">BEREIT ZUM STARTEN · EPISODE ${String(episode.number).padStart(2, '0')}</div>
        <h3>Noch keine Szenen & Shots angelegt</h3>
        <p>${story && story.trim().length > 30 ? `Deine Handlung umfasst ${story.trim().length} Zeichen. Starte jetzt den KI-Auto-Planer, um daraus automatisch Szenen und Prompt-Shots zu generieren.` : 'Schreibe zuerst eine Story oder starte direkt den KI-Auto-Planer für diese Folge.'}</p>
      </div>
      <div class="hero-actions">
        <button class="emerald-btn" id="hero-start-autoplan" style="font-weight:700;">✦ KI-Auto-Modus planen</button>
        <button class="icon-btn" style="width:100%;height:38px;font-size:12px;font-weight:600;" data-go="story">Story bearbeiten</button>
      </div>
    </div>
  ` : `
    <div class="hero-progress-card">
      <div class="circular-progress">
        <svg viewBox="0 0 100 100">
          <circle class="bg-ring" cx="50" cy="50" r="40"></circle>
          <circle class="fg-ring" cx="50" cy="50" r="40" style="stroke-dashoffset:${strokeOffset};"></circle>
        </svg>
        <div class="circular-progress-text">${percent}%</div>
      </div>
      <div class="progress-details">
        <div class="eyebrow">PROJECT DASHBOARD · EPISODE ${String(episode.number).padStart(2, '0')}</div>
        <h3>${doneCount}/${totalCount} Shots gerendert (${percent}%)</h3>
        <p>${openCount === 0 ? 'Alle Shots vollständig mit HD-Video & Foley gerendert!' : `${openCount} Shots warten noch auf die Render-Pipeline.`}</p>
        <div class="progress-bar-linear">
          <div class="fill" style="width:${percent}%;"></div>
        </div>
      </div>
      <div class="hero-actions">
        <button class="emerald-btn" id="hero-batch-render">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Render Pipeline starten</span>
        </button>
        <div style="display:flex;gap:8px;">
          <button class="icon-btn" style="flex:1;height:38px;font-size:12px;font-weight:600;" data-go="shots">Storyboard</button>
          <button class="icon-btn hero-btn-stop" style="flex:1;height:38px;font-size:12px;font-weight:600;" id="hero-stop-queue">🛑 Queue Stop</button>
        </div>
      </div>
    </div>
  `;

  $('#view-overview').innerHTML = `
    <button class="create-side" id="new-project-mobile">+ Neues Projekt</button>
    <div id="project-switcher-mobile"></div>
    ${heroHtml}

    <div id="queue-status"></div>

    <div class="production-flow" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:24px;">
      <button data-go="story" class="shot-card" style="padding:14px;cursor:pointer;text-align:left;border-color:${story ? 'var(--emerald)' : 'var(--line)'};">
        <div class="eyebrow">01 · HANDLUNG</div>
        <div style="font-weight:700;font-size:15px;margin:4px 0;">Storyline</div>
        <small style="color:var(--text-muted);">${story ? 'Text ausgearbeitet' : 'Noch leer'}</small>
      </button>
      <button data-go="assets" class="shot-card" style="padding:14px;cursor:pointer;text-align:left;border-color:${assets.length ? 'var(--emerald)' : 'var(--line)'};">
        <div class="eyebrow">02 · BESETZUNG</div>
        <div style="font-weight:700;font-size:15px;margin:4px 0;">Figuren & Welten</div>
        <small style="color:var(--text-muted);">${assets.length} Elemente in Folge</small>
      </button>
      <button data-go="shots" class="shot-card" style="padding:14px;cursor:pointer;text-align:left;border-color:${doneCount > 0 ? 'var(--emerald)' : 'var(--line)'};">
        <div class="eyebrow">03 · STORYBOARD</div>
        <div style="font-weight:700;font-size:15px;margin:4px 0;">Szenen & Shots</div>
        <small style="color:var(--text-muted);">${doneCount}/${totalCount} fertig (${percent}%)</small>
      </button>
      <button data-go="comic" class="shot-card" style="padding:14px;cursor:pointer;text-align:left;">
        <div class="eyebrow">04 · COMIC-PANELS</div>
        <div style="font-weight:700;font-size:15px;margin:4px 0;">Comic & Print</div>
        <small style="color:var(--text-muted);">4-Panel Seitenansicht</small>
      </button>
      <button data-go="exports" class="shot-card" style="padding:14px;cursor:pointer;text-align:left;border-color:${finals.length ? 'var(--emerald)' : 'var(--line)'};">
        <div class="eyebrow">05 · FINALE</div>
        <div style="font-weight:700;font-size:15px;margin:4px 0;">Film-Master</div>
        <small style="color:var(--text-muted);">${finals.length} Zusammenschnitt(e)</small>
      </button>
    </div>

    <div class="section-headline">
      <h3>Letzte Aktivitäten</h3>
    </div>
    <div style="background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden;">
      ${data.activity.slice(0, 6).map(a => `
        <div style="padding:12px 16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;">
          <b style="font-size:13px;color:var(--text-main);">${esc(a.label)}</b>
          <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);">${new Date(a.created_at).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}</span>
        </div>
      `).join('') || '<div style="padding:16px;color:var(--text-dim);text-align:center;">Bereit für deine erste Produktion.</div>'}
    </div>
  `;

  // 2. STORY VIEW
  $('#view-story').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
      <div class="section-headline" style="margin:0;">
        <h3>Handlung & Script</h3>
        <p>Entwickle den Text für Episode ${String(episode.number).padStart(2, '0')}.</p>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="icon-btn" id="new-episode" style="width:auto;padding:0 12px;font-size:12px;font-weight:600;">+ Neue Folge</button>
        <button class="icon-btn" id="story-versions-btn" style="width:auto;padding:0 12px;font-size:12px;font-weight:600;" title="Frühere Fassungen dieser Story ansehen und wiederherstellen">🕘 Frühere Fassungen</button>
        <button class="emerald-btn" id="save-story">Story speichern</button>
      </div>
    </div>
    <textarea id="story-editor" style="width:100%;min-height:360px;background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);padding:18px;color:var(--text-main);font-family:var(--font-mono);font-size:13px;line-height:1.6;resize:vertical;" placeholder="# Episode 01\n\nSchreibe hier die Handlung...">${esc(story)}</textarea>
    <details style="margin-top:16px;">
      <summary style="cursor:pointer;color:var(--text-dim);font-size:12px;font-family:var(--font-mono);">⚙️ Nur für diese Episode: Stil & Qualität überschreiben (sonst gilt der Projekt-Standard)</summary>
      <form id="episode-settings-form" style="margin-top:12px;padding:14px;background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);">
        <label>Style-Prompt für diese Episode<textarea name="styleProfile" placeholder="Leer lassen = Projekt-Stil übernehmen">${esc(episode.style_profile || '')}</textarea></label>
        <label>Negativ-Prompt für diese Episode<textarea name="negativePrompt" maxlength="2400" placeholder="Leer lassen = Projekt-Negativ-Prompt übernehmen">${esc(episode.negative_prompt || '')}</textarea><small>Zusätzliche Ausschlüsse für Keyframes und Videos, z. B. keine Schrift oder keine Fahrzeuge.</small></label>
        <div class="shot-modal-grid">
          <label>Foto-Steps<input name="photoSteps" type="number" min="1" max="40" placeholder="Projekt: ${project.photo_steps ?? 8}" value="${episode.photo_steps ?? ''}"></label>
          <label>Video-Steps<input name="videoSteps" type="number" min="1" max="40" placeholder="Projekt: ${project.video_steps ?? 4}" value="${episode.video_steps ?? ''}"></label>
        </div>
        <div class="shot-modal-grid">
          <label>Vorschau-Breite<input name="previewWidth" type="number" min="160" max="2048" step="32" placeholder="Projekt: ${project.preview_width ?? 384}" value="${episode.preview_width ?? ''}"></label>
          <label>Vorschau-Höhe<input name="previewHeight" type="number" min="160" max="2048" step="32" placeholder="Projekt: ${project.preview_height ?? 224}" value="${episode.preview_height ?? ''}"></label>
        </div>
        <div class="shot-modal-grid">
          <label>Fertig-Breite<input name="finalWidth" type="number" min="160" max="2048" step="32" placeholder="Projekt: ${project.final_width ?? 768}" value="${episode.final_width ?? ''}"></label>
          <label>Fertig-Höhe<input name="finalHeight" type="number" min="160" max="2048" step="32" placeholder="Projekt: ${project.final_height ?? 448}" value="${episode.final_height ?? ''}"></label>
        </div>
        <p class="upload-note">Leere Felder = Projekt-Standard wird verwendet. Werte hier gelten nur für diese Episode.</p>
        <p id="episode-settings-notice" class="upload-note"></p>
        <div style="display:flex;gap:8px;">
          <button class="form-button" type="submit">Speichern</button>
          <button class="ghost" type="button" id="episode-settings-reset">Alle auf Projekt-Standard zurücksetzen</button>
        </div>
      </form>
    </details>
    <details style="margin-top:10px;">
      <summary style="cursor:pointer;color:var(--text-dim);font-size:12px;font-family:var(--font-mono);">🗄️ Folgen-Verwaltung</summary>
      <div style="margin-top:12px;padding:14px;background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);">
        <p class="upload-note" style="margin-bottom:10px;">Archivierte Folgen verschwinden aus der Auswahl, bleiben aber vollständig erhalten und wiederherstellbar.</p>
        <button class="ghost" type="button" id="archive-episode">Diese Episode archivieren</button>
        <div id="archived-episodes-panel" style="margin-top:12px;"></div>
      </div>
    </details>
  `;

  // 3. STORYBOARD (MATCHING MOCKUP 1 & 2)
  let visibleShots = shots;
  if (shotFilter === 'done') visibleShots = visibleShots.filter(s => Boolean(s.output_video_path));
  if (shotFilter === 'pending') visibleShots = visibleShots.filter(s => !s.output_video_path);
  if (shotAssetFilter !== 'all') visibleShots = visibleShots.filter(s => (s.references || []).some(r => r.id === Number(shotAssetFilter)));
  if (shotSearch.trim()) { const q = shotSearch.trim().toLowerCase(); visibleShots = visibleShots.filter(s => (s.title || '').toLowerCase().includes(q) || (s.prompt || '').toLowerCase().includes(q)); }
  const shotAssetOptions = [...new Map(shots.flatMap(s => s.references || []).map(a => [a.id, a])).values()].sort((a, b) => a.name.localeCompare(b.name));

  $('#view-shots').innerHTML = `
    <div class="storyboard-toolbar">
      <div class="section-headline" style="margin:0;">
        <h3>Storyboard & Szenen</h3>
        <p>${doneCount} von ${totalCount} Shots gerendert (${percent}%)</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <div class="filter-tabs" id="quality-tier-toggle" style="margin-right:4px;" title="Vorschau: kleinere Auflösung, deutlich schneller. Fertig: volle Qualität.">
          <button class="filter-tab ${renderQualityTier === 'Vorschau' ? 'active' : ''}" data-quality-tier="Vorschau">🔍 Vorschau</button>
          <button class="filter-tab ${renderQualityTier === 'Fertig' ? 'active' : ''}" data-quality-tier="Fertig">✨ Fertig</button>
        </div>
        <button class="icon-btn hero-btn-stop" id="shots-stop-queue" style="width:auto;padding:0 12px;font-size:12px;font-weight:700;">🛑 Queue stoppen</button>
        <button class="icon-btn" id="assemble-episode" style="width:auto;padding:0 14px;border-color:var(--emerald);color:var(--emerald);font-weight:700;font-size:12px;">🎞️ Film schneiden</button>
        <button class="emerald-btn" id="shots-batch-render">⚡ Alle Rendern (${openCount})</button>
        <button class="icon-btn" id="shots-force-rerender" style="width:auto;padding:0 12px;font-size:12px;font-weight:600;" title="Rendert wirklich ALLE Shots dieser Folge neu, auch bereits fertige">🔁 Alles neu rendern</button>
        <button class="icon-btn" id="new-shot" style="width:auto;padding:0 12px;font-size:12px;font-weight:600;">+ Shot</button>
        <button class="icon-btn" id="generate-intro" style="width:auto;padding:0 12px;font-size:12px;font-weight:600;" title="Lässt die KI eine eigenständige Titel-/Stimmungseinstellung vor der Handlung erzeugen">🎬 Intro</button>
        <button class="icon-btn" id="generate-outro" style="width:auto;padding:0 12px;font-size:12px;font-weight:600;" title="Lässt die KI eine eigenständige Abschluss-Einstellung nach der Handlung erzeugen">🎬 Outro</button>
      </div>
    </div>

    <div style="margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
      <div class="filter-tabs">
        <button class="filter-tab ${shotFilter === 'all' ? 'active' : ''}" data-shot-filter="all">Alle (${totalCount})</button>
        <button class="filter-tab ${shotFilter === 'done' ? 'active' : ''}" data-shot-filter="done">✓ Fertig (${doneCount})</button>
        <button class="filter-tab ${shotFilter === 'pending' ? 'active' : ''}" data-shot-filter="pending">⏳ Offen (${openCount})</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input type="search" id="shot-search" placeholder="Shots durchsuchen…" value="${esc(shotSearch)}" style="background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);padding:6px 12px;color:var(--text-main);font-size:12px;min-width:160px;">
        <select id="shot-asset-filter" style="background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);padding:6px 10px;color:var(--text-main);font-size:12px;">
          <option value="all">Alle Figuren/Orte/Requisiten</option>
          ${shotAssetOptions.map(a => `<option value="${a.id}" ${String(shotAssetFilter) === String(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
        ${(shotSearch || shotAssetFilter !== 'all') ? `<button class="icon-btn" id="shot-filter-clear" style="width:auto;padding:0 10px;font-size:12px;">Filter zurücksetzen</button>` : ''}
      </div>
    </div>
    ${(shotSearch || shotAssetFilter !== 'all') ? `<p class="upload-note" style="margin:-8px 0 12px;">${visibleShots.length} von ${totalCount} Shots entsprechen dem Filter.</p>` : ''}

    <div class="shots-grid">
      ${visibleShots.map(shotCard).join('') || '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-dim);border:1px dashed var(--line);border-radius:var(--radius-md);">Keine Shots in dieser Ansicht vorhanden.</div>'}
    </div>
  `;

  // 4. BESETZUNG & WELTEN (CASTING & WORLDS MATCHING MOCKUP 2)
  const missingPhotoCount = assets.filter(a => !a.url).length;
  const visibleAssets = assetFilter === 'missing' ? assets.filter(a => !a.url) : assets;
  const characters = visibleAssets.filter(a => a.kind === 'character');
  const locations = visibleAssets.filter(a => a.kind === 'location');
  const props = visibleAssets.filter(a => a.kind === 'prop' || a.kind === 'style');

  $('#view-assets').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
      <div class="section-headline" style="margin:0;">
        <h3>Casting & Welten</h3>
        <p>Konsistente Figuren, Gesichter und Schauplätze für deine KI-Generierung.</p>
      </div>
      <button class="emerald-btn" id="new-asset">+ Material hinzufügen</button>
    </div>
    ${missingPhotoCount ? `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;margin-bottom:20px;background:var(--amber-dim);border:1px solid rgba(255,152,0,0.3);border-radius:var(--radius-md);">
        <span style="font-size:13px;color:var(--amber);">⚠️ ${missingPhotoCount} von ${assets.length} Materialien ${missingPhotoCount === 1 ? 'hat' : 'haben'} noch kein Referenzfoto - ohne Foto rendert die KI nur aus dem Text-Prompt.</span>
        <button class="ghost" id="toggle-missing-photo-filter" style="flex-shrink:0;">${assetFilter === 'missing' ? 'Alle zeigen' : 'Nur diese zeigen'}</button>
      </div>
    ` : ''}

    <!-- CHARAKTERE (Avatare / Portraits wie Mockup 2) -->
    <div class="section-headline">
      <div class="eyebrow">HAUPTFIGUREN & DARSTELLER</div>
      <h3>Figuren (${characters.length})</h3>
    </div>
    <div class="characters-grid">
      ${characters.map(c => `
        <div class="character-card" data-edit-asset="${c.id}">
          <div class="character-portrait">
            ${c.url ? `<img src="${c.url}" alt="${esc(c.name)}">` : `<div class="character-placeholder">👤</div>`}
          </div>
          <div class="character-info">
            <div class="character-name">${esc(c.name)}</div>
            <div class="character-sub">${c.url ? '✓ Foto aktiv' : 'Kein Foto'}</div>
          </div>
        </div>
      `).join('') || '<div style="color:var(--text-dim);font-size:13px;grid-column:1/-1;padding:16px;border:1px dashed var(--line);border-radius:var(--radius-md);">Noch keine Figuren angelegt. Klicke auf „+ Material hinzufügen“.</div>'}
    </div>

    <!-- WELTEN / ORTE (16:9 Landschaftskarten wie Mockup 2) -->
    <div class="section-headline">
      <div class="eyebrow">SCHAUPLÄTZE & UMGEBUNGEN</div>
      <h3>Orte & Welten (${locations.length})</h3>
    </div>
    <div class="locations-grid">
      ${locations.map(l => `
        <div class="location-card" data-edit-asset="${l.id}">
          <div class="location-thumb">
            ${l.url ? `<img src="${l.url}" alt="${esc(l.name)}">` : `<div style="width:100%;height:100%;display:grid;place-items:center;color:var(--text-dim);font-size:24px;">🏔️</div>`}
          </div>
          <div class="location-info">
            <div class="location-name">${esc(l.name)}</div>
            <div class="location-summary">${esc(l.summary || l.visual_notes || 'Schauplatz für Szenen')}</div>
          </div>
        </div>
      `).join('') || '<div style="color:var(--text-dim);font-size:13px;grid-column:1/-1;padding:16px;border:1px dashed var(--line);border-radius:var(--radius-md);">Noch keine Drehorte angelegt.</div>'}
    </div>

    <!-- REQUISITEN, FAHRZEUGE & STILREFERENZEN -->
    <div class="section-headline">
      <div class="eyebrow">REQUISITEN, FAHRZEUGE & STIL</div>
      <h3>Requisiten (${props.length})</h3>
    </div>
    <div class="locations-grid">
      ${props.map(p => `
        <div class="location-card" data-edit-asset="${p.id}">
          <div class="location-thumb">
            ${p.url ? `<img src="${p.url}" alt="${esc(p.name)}">` : `<div style="width:100%;height:100%;display:grid;place-items:center;color:var(--text-dim);font-size:24px;">🧩</div>`}
          </div>
          <div class="location-info">
            <div class="location-name">${esc(p.name)}</div>
            <div class="location-summary">${esc(p.summary || p.visual_notes || 'Requisite für Szenen')}</div>
          </div>
        </div>
      `).join('') || '<div style="color:var(--text-dim);font-size:13px;grid-column:1/-1;padding:16px;border:1px dashed var(--line);border-radius:var(--radius-md);">Noch keine Requisiten, Fahrzeuge oder Stilreferenzen angelegt.</div>'}
    </div>
  `;

  // 5. COMIC / PANELS VIEW (THE MICKY MAUS COMIC SYSTEM) — disabled for now, video pipeline first
  const renderedShots = shots.filter(s => Boolean(s.output_video_path));
  const comicPages = [];
  for (let i = 0; i < renderedShots.length; i += 4) {
    comicPages.push(renderedShots.slice(i, i + 4));
  }

  $('#view-comic').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
      <div class="section-headline" style="margin:0;">
        <h3>Comic & Print Master</h3>
        <p>Micky-Maus-Stil: 4 Panels pro Seite für Print- und PDF-Export.</p>
      </div>
      <button class="emerald-btn" onclick="window.print()">🖨️ Comic als PDF drucken</button>
    </div>

    ${comicPages.length ? comicPages.map((pageShots, pageIdx) => `
      <div class="comic-page">
        <div class="comic-page-header">
          <span>${esc(project.title)} · EPISODE ${String(episode.number).padStart(2, '0')}</span>
          <span>SEITE ${pageIdx + 1}</span>
        </div>
        <div class="comic-grid-4">
          ${pageShots.map((s, idx) => `
            <div class="comic-panel">
              <video src="${s.video}" playsinline muted loop autoplay></video>
              <div class="comic-bubble ${idx % 2 === 0 ? 'top-left' : 'bottom-right'}">
                „${esc(s.prompt.slice(0, 70))}...“
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('') : `
      <div style="padding:48px;background:var(--bg-card);border:1px dashed var(--line);border-radius:var(--radius-lg);text-align:center;">
        <div style="font-size:32px;margin-bottom:12px;">📖</div>
        <h3>Noch keine Comic-Panels bereit</h3>
        <p style="color:var(--text-muted);max-width:440px;margin:8px auto 0;">Sobald Szenen im Storyboard gerendert sind, werden sie automatisch in 4-Panel Comic-Seiten mit Sprechblasen arrangiert.</p>
      </div>
    `}
  `;

  // 6. AUDIO VIEW
  $('#view-audio').innerHTML = `
    <div class="section-headline">
      <h3>Audio, Ton & Stimmen</h3>
      <p>Audio-Plan prüfen, bevor ein Film-Master entsteht.</p>
    </div>
    <div style="display:grid;gap:14px;max-width:800px;">
      <div id="audio-preflight" style="background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);padding:18px;color:var(--text-muted);font-size:13px;">
        Audio-Plan wird geprüft …
      </div>
      <div style="background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);padding:18px;">
        <div class="eyebrow" style="color:var(--emerald);">VERBINDLICHE REIHENFOLGE</div>
        <h4 style="margin:6px 0 8px;">Plan → Stimmen/Sound → Mix → Master</h4>
        <p style="color:var(--text-muted);font-size:13px;line-height:1.5;margin:0;">FrameCut erstellt aus den Dialogen einen versionierten Cue-Plan. Erst wenn ein Audio-Worker die Sprach-, Musik- und Effektdateien erzeugt und gemischt hat, darf ein Audio-Master entstehen. Ein Bildschnitt ohne Ton ist weiterhin möglich, aber nur nach einer bewussten Bestätigung.</p>
      </div>
    </div>
  `;

  // 7. EXPORTS VIEW
  $('#view-exports').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
      <div class="section-headline" style="margin:0;">
        <h3>Ergebnisse & Master-Filme</h3>
        <p>Zusammenschnitt aller fertigen Szenen zu einem durchgehenden Film.</p>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="emerald-btn" id="exports-assemble-btn">🎞️ Episode jetzt schneiden (${doneCount}/${totalCount})</button>
        <a href="/api/projects/${project.id}/export" class="icon-btn" style="width:auto;padding:0 14px;text-decoration:none;display:inline-flex;align-items:center;" title="Ganzes Projekt inkl. Story, Prompts, Figuren, Orte und aller Mediendateien als Archiv sichern">📦 Projekt exportieren</a>
        <button class="icon-btn" id="import-project-btn" style="width:auto;padding:0 14px;" title="Ein zuvor exportiertes Archiv als neues Projekt einspielen">📥 Projekt importieren</button>
        <input type="file" id="import-project-file" accept=".gz,.tgz,application/gzip" style="display:none;">
        <a href="/api/episodes/${episode.id}/export" class="icon-btn" style="width:auto;padding:0 14px;text-decoration:none;display:inline-flex;align-items:center;" title="Nur diese Folge inkl. Story, Figuren, Orte und Mediendateien als Archiv sichern">📦 Folge exportieren</a>
        <button class="icon-btn" id="import-episode-btn" style="width:auto;padding:0 14px;" title="Ein zuvor exportiertes Folgen-Archiv als neue Folge in dieses Projekt einspielen">📥 Folge importieren</button>
        <input type="file" id="import-episode-file" accept=".gz,.tgz,application/gzip" style="display:none;">
      </div>
    </div>
    <div style="display:grid;gap:16px;">
      ${finals.map(x => `
        <div style="background:var(--bg-card);border:1px solid var(--line);border-radius:var(--radius-md);padding:18px;display:grid;grid-template-columns:min(320px, 100%) 1fr;gap:20px;">
          ${x.type === 'mp4' ? `<video controls preload="metadata" src="${x.url}" style="width:100%;border-radius:var(--radius-sm);background:#000;aspect-ratio:16/9;"></video>` : ''}
          <div>
            <div class="eyebrow">FINAL CUT MASTER</div>
            <h4 style="font-size:18px;margin:4px 0 8px;">${esc(x.name)}</h4>
            <p style="color:var(--text-muted);font-size:12px;font-family:var(--font-mono);margin-bottom:14px;">Fertiger Film-Export mit Video & Audio</p>
            <a href="${x.url}" download class="emerald-btn" style="display:inline-flex;text-decoration:none;">Film herunterladen (MP4)</a>
          </div>
        </div>
      `).join('') || '<div style="padding:32px;text-align:center;color:var(--text-dim);border:1px dashed var(--line);border-radius:var(--radius-md);">Noch kein Film-Export erstellt. Klicke oben auf „Episode jetzt schneiden“.</div>'}
    </div>
  `;

  renderProjectSwitcher();
  bindDynamic();
}

async function refreshAudioPreflight() {
  const target = $('#audio-preflight');
  if (!target || !currentEpisode) return;
  try {
    const audio = await api(`/api/episodes/${currentEpisode}/audio-preflight`);
    const cue = audio.cues || {};
    const blockers = (audio.blockers || []).map(item => `<li>${esc(item)}</li>`).join('') || '<li>Keine Blocker erkannt.</li>';
    const validation = (audio.validationErrors || []).map(item => `<li>${esc(item)}</li>`).join('');
    const stateColor = audio.readyForMaster ? 'var(--emerald)' : '#ffb703';
    const settings = audio.settings || {};
    const mode = settings.mode || 'narrator_and_characters';
    const cueList = Array.isArray(audio.manifest?.cues) ? audio.manifest.cues : [];
    const renderableCount = cueList.filter(item => item.state === 'pending' && (
      ((item.kind === 'dialogue' || item.kind === 'narration') && String(item.text || '').trim()) ||
      (!['dialogue', 'narration'].includes(item.kind) && String(item.prompt || '').trim())
    )).length;
    const fallbackNotice = audio.manifest?.auto_narration_fallback
      ? '<p style="margin:10px 0 0;color:var(--text-muted);font-size:12px;line-height:1.45;">Für diese visuelle Story gab es keine Dialogzeilen. FrameCut hat deshalb einen editierbaren Erzähler-Entwurf aus den Shot-Titeln erstellt. Prüfe die Texte vor dem Rendern im Storyboard.</p>'
      : '';
    const emptyCueNotice = !cueList.length
      ? `<div style="margin-top:12px;padding:11px;border:1px dashed var(--line);border-radius:8px;color:var(--text-muted);font-size:12px;line-height:1.5;">${mode === 'characters_only' ? 'Der Modus „Nur Figuren“ erzeugt bewusst keine Erzählerstimme. Ergänze Dialogzeilen in den betreffenden Shots oder wechsle zu einem Erzähler-Modus.' : 'Noch keine sprachfähigen Shot-Titel oder Dialogzeilen vorhanden. Ergänze zuerst Text im Storyboard.'}<br><button type="button" class="ghost" id="audio-open-shots" style="margin-top:8px;">Storyboard öffnen</button></div>`
      : '';
    target.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
        <div>
          <div class="eyebrow" style="color:${stateColor};">AUDIO-PREFLIGHT</div>
          <h4 style="margin:6px 0 7px;">${audio.readyForMaster ? 'Bereit für Audio-Master' : 'Audio-Master noch blockiert'}</h4>
          <p style="margin:0;color:var(--text-muted);font-size:12px;">Quelle: ${esc(audio.source)}${audio.updatedAt ? ` · aktualisiert ${esc(new Date(audio.updatedAt).toLocaleString('de-CH'))}` : ''}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="ghost" id="audio-preflight-refresh">↻ Aktualisieren</button>
          <button type="button" class="ghost" id="audio-manifest-download">↓ Audio-Plan JSON</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:14px 0;">
        <div style="padding:9px;border:1px solid var(--line);border-radius:8px;"><b>${cue.total || 0}</b><br><span style="font-size:11px;color:var(--text-muted);">Cues geplant</span></div>
        <div style="padding:9px;border:1px solid var(--line);border-radius:8px;"><b>${cue.speech || 0}</b><br><span style="font-size:11px;color:var(--text-muted);">Dialog / Off</span></div>
        <div style="padding:9px;border:1px solid var(--line);border-radius:8px;"><b>${cue.ready || 0}</b><br><span style="font-size:11px;color:var(--text-muted);">fertig</span></div>
        <div style="padding:9px;border:1px solid var(--line);border-radius:8px;"><b>${cue.pending || 0}</b><br><span style="font-size:11px;color:var(--text-muted);">offen</span></div>
      </div>
      <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:15px;">
        <div class="eyebrow" style="color:var(--emerald);">SPRACHREGIE</div>
        <p style="margin:5px 0 11px;color:var(--text-muted);font-size:12px;line-height:1.5;">Entscheidet, welche Stimme die vorhandenen Text-Cues trägt. Figuren-Stimmprofile bearbeitest und testest du unter <b>Besetzung & Welten</b>.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end;">
          <label style="font-size:12px;display:grid;gap:5px;">Regiemodus
            <select id="audio-direction-mode">
              <option value="narrator_and_characters" ${mode === 'narrator_and_characters' ? 'selected' : ''}>Erzähler + Figuren</option>
              <option value="narrator_only" ${mode === 'narrator_only' ? 'selected' : ''}>Nur Erzähler</option>
              <option value="characters_only" ${mode === 'characters_only' ? 'selected' : ''}>Nur Figuren</option>
            </select>
          </label>
          <label style="font-size:12px;display:grid;gap:5px;">Erzähler-Stimmprofil
            <input id="audio-narrator-voice" value="${esc(settings.narrator_voice || '')}" placeholder="z. B. warm, ruhig, kinoreif, Deutsch">
          </label>
          <label style="font-size:12px;display:grid;gap:5px;">Sprache
            <select id="audio-language"><option value="German" ${(settings.language || 'German') === 'German' ? 'selected' : ''}>Deutsch</option><option value="English" ${settings.language === 'English' ? 'selected' : ''}>English</option></select>
          </label>
          <button type="button" class="ghost" id="audio-direction-save">Regie speichern</button>
        </div>
      </div>
      <div style="font-size:12px;line-height:1.55;color:${audio.readyForMaster ? 'var(--emerald)' : '#ffca63'};">${audio.readyForMaster ? 'Der Mix-Worker hat alle erforderlichen Cues bestätigt.' : `<b>Noch nicht exportierbar als Audio-Master:</b><ul style="margin:6px 0 0;padding-left:18px;">${blockers}</ul>`}</div>
      <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:15px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
          <div><h4 style="margin:0 0 4px;">Spuren auf der Timeline</h4><p style="margin:0;color:var(--text-muted);font-size:12px;line-height:1.45;">Dialoge und Off-Texte kommen aus den Shots. Musik, Atmosphäre und Effekte kannst du gezielt ergänzen. Jede Spur wird separat erzeugt und bleibt vor dem Mix nachvollziehbar.</p></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;"><button type="button" class="ghost" id="audio-add-sfx">SFX / Atmosphäre hinzufügen</button><button type="button" class="ghost" id="audio-add-music">Musik hinzufügen</button></div>
        </div>
        <div style="display:grid;gap:8px;margin-top:12px;">
          ${(audio.manifest?.cues || []).map(c => {
            const detail = c.kind === 'dialogue' || c.kind === 'narration' ? c.text : c.prompt;
            const kind = c.kind === 'dialogue' ? 'Dialog' : c.kind === 'narration' ? 'Off / Erzähler' : c.kind === 'music' ? 'Musik' : c.kind === 'ambience' ? 'Atmosphäre' : 'SFX';
            const state = c.state === 'ready' ? 'fertig' : c.state === 'rendering' ? 'in Queue' : c.state === 'skipped' ? 'übersprungen' : 'offen';
            return `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg-elevated);"><div style="min-width:0;"><b style="font-size:12px;">${esc(kind)} · ${esc(state)}</b><span style="display:block;margin-top:3px;color:var(--text-muted);font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(detail || 'Kein Inhalt')}</span><small style="color:var(--text-dim);font-family:var(--font-mono);">${(Number(c.start_ms || 0) / 1000).toFixed(1)}s · ${(Number(c.target_duration_ms || 0) / 1000).toFixed(1)}s · ${Number(c.gain_db || 0).toFixed(1)} dB</small></div><div style="display:flex;gap:6px;align-items:center;">${c.artifact?.path ? `<audio controls preload="none" src="/media/${encodeURIComponent(c.artifact.path)}" style="width:150px;height:30px;"></audio>` : ''}${['music','ambience','sfx'].includes(c.kind) ? `<button type="button" class="ghost" data-delete-audio-cue="${esc(c.id)}">Entfernen</button>` : ''}</div></div>`;
          }).join('') || '<p style="margin:0;color:var(--text-dim);font-size:12px;">Noch keine Audio-Spuren geplant.</p>'}
        </div>
        ${fallbackNotice}
        ${emptyCueNotice}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
        <button type="button" class="form-button" id="audio-render-tracks" ${renderableCount ? '' : 'disabled'} title="${renderableCount ? `${renderableCount} offene Spur(en) einreihen` : 'Es gibt keine offenen Spuren mit Text oder Audio-Prompt'}">Alle offenen Spuren rendern${renderableCount ? ` (${renderableCount})` : ''}</button>
        <button type="button" class="ghost" id="audio-render" ${(!audio.cuesReady || audio.readyForMaster) ? 'disabled' : ''}>Audio-Master mischen</button>
        <span style="font-size:11px;color:var(--text-dim);align-self:center;">1. Spuren lokal erzeugen · 2. automatisch oder manuell mischen · 3. MP4-Master mit verständlicher Sprache herunterladen.</span>
      </div>
      ${validation ? `<details style="margin-top:10px;font-size:12px;color:#ff8a80;"><summary>Manifest-Fehler anzeigen</summary><ul style="margin:6px 0 0;padding-left:18px;">${validation}</ul></details>` : ''}
    `;
    $('#audio-preflight-refresh').onclick = refreshAudioPreflight;
    $('#audio-manifest-download').onclick = () => {
      const blob = new Blob([JSON.stringify(audio.generatedManifest || audio.manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `framecut-episode-${currentEpisode}-audio-plan.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    $('#audio-direction-save').onclick = async () => {
      try {
        await api(`/api/episodes/${currentEpisode}/audio-settings`, { method: 'PUT', body: JSON.stringify({ mode: $('#audio-direction-mode').value, narratorVoice: $('#audio-narrator-voice').value, language: $('#audio-language').value }) });
        notice('Sprachregie gespeichert. Ein vorhandener Audio-Master wird dadurch bewusst ungültig.');
        await refreshAudioPreflight();
      } catch (err) { notice(`Sprachregie konnte nicht gespeichert werden: ${err.message}`); }
    };
    const openShots = $('#audio-open-shots'); if (openShots) openShots.onclick = () => openView('shots');
    const addCue = kind => showModal(`
      <h3>${kind === 'music' ? 'Musikspur ergänzen' : 'SFX oder Atmosphäre ergänzen'}</h3>
      <form>${kind === 'music' ? '' : '<label>Spurtyp<select name="cueKind"><option value="sfx">Soundeffekt</option><option value="ambience">Atmosphäre / Raumklang</option></select></label>'}<label>Audio-Prompt<textarea name="prompt" required placeholder="${kind === 'music' ? 'z. B. instrumentaler, warmer Neo-Noir-Score, keine Stimmen, subtil, für eine durchgehende Filmszene' : 'z. B. leises nächtliches Stadtambiente, vereinzelter Wind, entfernte Schritte, keine Musik, keine Sprache'}"></textarea></label>
      <div class="shot-modal-grid"><label>Start in Sekunden<input name="startSeconds" type="number" min="0" step="0.1" value="0"></label><label>Dauer in Sekunden<input name="durationSeconds" type="number" min="1" max="${Math.max(1, Math.ceil(Number(audio.manifest?.timeline?.duration_ms || 1000) / 1000))}" step="1" value="${kind === 'music' ? Math.max(10, Math.ceil(Number(audio.manifest?.timeline?.duration_ms || 10000) / 1000)) : 5}"></label></div>
      <label>Lautstärke in dB<input name="gainDb" type="number" min="-40" max="12" step="0.5" value="${kind === 'music' ? -20 : -8}"></label><p id="modal-error" class="error"></p><button class="form-button">Spur planen</button></form>`, async form => {
        const values = fields(form), manifest = structuredClone(audio.manifest), actualKind = kind === 'music' ? 'music' : (values.cueKind === 'ambience' ? 'ambience' : 'sfx'), start = Math.max(0, Math.round(Number(values.startSeconds || 0) * 1000)), duration = Math.max(1000, Math.round(Number(values.durationSeconds || 1) * 1000));
        if (start + duration > Number(manifest.timeline.duration_ms)) throw new Error('Die Spur muss innerhalb der Episoden-Timeline liegen.');
        manifest.cues.push({ id: `${actualKind}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, kind:actualKind, state:'pending', start_ms:start, target_duration_ms:duration, gain_db:Number(values.gainDb || 0), prompt:String(values.prompt || '').trim() });
        delete manifest.mix;
        await api(`/api/episodes/${currentEpisode}/audio-manifest`, { method:'POST', body:JSON.stringify({ manifest }) });
        await load(); notice('Audio-Spur geplant. Sie wird erst nach „Alle offenen Spuren rendern“ erzeugt.');
      });
    const addSfx = $('#audio-add-sfx'); if (addSfx) addSfx.onclick = () => addCue('sfx');
    const addMusic = $('#audio-add-music'); if (addMusic) addMusic.onclick = () => addCue('music');
    document.querySelectorAll('[data-delete-audio-cue]').forEach(btn => btn.onclick = async () => {
      if (!confirm('Diese zusätzliche Audio-Spur wirklich aus dem Plan entfernen?')) return;
      try { const manifest = structuredClone(audio.manifest); manifest.cues = manifest.cues.filter(c => c.id !== btn.dataset.deleteAudioCue); delete manifest.mix; await api(`/api/episodes/${currentEpisode}/audio-manifest`, { method:'POST', body:JSON.stringify({ manifest }) }); await load(); notice('Audio-Spur entfernt.'); } catch (err) { notice(`Audio-Spur konnte nicht entfernt werden: ${err.message}`); }
    });
    const renderTracks = $('#audio-render-tracks'); if (renderTracks) renderTracks.onclick = async () => {
      try {
        await api(`/api/episodes/${currentEpisode}/audio-cues/render`, { method: 'POST', body: '{}' });
        notice('Audio-Spuren sind eingereiht. Sprache wird mit Qwen TTS erstellt, Musik/SFX mit Stable Audio 3; nach der letzten Spur wird der Mix automatisch vorbereitet.');
        await load();
      } catch (err) { notice(`Audio-Spuren konnten nicht eingereiht werden: ${err.message}`); }
    };
    const renderAudio = $('#audio-render'); if (renderAudio) renderAudio.onclick = async () => {
      try {
        await api(`/api/episodes/${currentEpisode}/audio-render`, { method: 'POST', body: '{}' });
        notice('Audio-Mix ist eingereiht. Alle bestätigten Spuren werden auf den Bildschnitt gelegt.');
        await load();
      } catch (err) { notice(`Audio-Mix konnte nicht eingereiht werden: ${err.message}`); }
    };
  } catch (error) {
    target.innerHTML = `<span style="color:#ff8a80;">Audio-Prefight konnte nicht geladen werden: ${esc(error.message)}</span>`;
  }
}

function bindDynamic() {
  const npMobile = $('#new-project-mobile'); if (npMobile) npMobile.onclick = newProject;
  if ($('#audio-preflight')) refreshAudioPreflight();
  const missingPhotoToggle = $('#toggle-missing-photo-filter'); if (missingPhotoToggle) missingPhotoToggle.onclick = () => { assetFilter = assetFilter === 'missing' ? 'all' : 'missing'; render(); };
  document.querySelectorAll('[data-go]').forEach(x => x.onclick = () => openView(x.dataset.go));
  document.querySelectorAll('.filter-tab').forEach(x => x.onclick = () => { if (x.dataset.shotFilter) { shotFilter = x.dataset.shotFilter; render(); } });

  const shotSearchInput = $('#shot-search');
  if (shotSearchInput) {
    let searchDebounce;
    shotSearchInput.oninput = () => {
      const cursor = shotSearchInput.selectionStart;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        shotSearch = shotSearchInput.value;
        render();
        const refocused = $('#shot-search');
        if (refocused) { refocused.focus(); refocused.setSelectionRange(cursor, cursor); }
      }, 250);
    };
  }
  const shotAssetSelect = $('#shot-asset-filter');
  if (shotAssetSelect) shotAssetSelect.onchange = () => { shotAssetFilter = shotAssetSelect.value; render(); };
  const shotFilterClear = $('#shot-filter-clear');
  if (shotFilterClear) shotFilterClear.onclick = () => { shotSearch = ''; shotAssetFilter = 'all'; render(); };

  // Batch rendering handlers
  const triggerBatch = async () => {
    try {
      notice('Starte Render-Pipeline für alle noch offenen Szenen...');
      const res = await api('/api/jobs/batch', { method: 'POST', body: JSON.stringify({ episodeId: currentEpisode, tier: renderQualityTier }) });
      notice(`Erfolg: ${res.queued} Shots wurden zur Render-Queue hinzugefügt!`);
      await load();
      openView('shots');
    } catch (err) {
      notice(err.message);
    }
  };

  const topBatchBtn = $('#batch-render-btn'); if (topBatchBtn) topBatchBtn.onclick = triggerBatch;
  const heroBatchBtn = $('#hero-batch-render'); if (heroBatchBtn) heroBatchBtn.onclick = triggerBatch;
  const shotsBatchBtn = $('#shots-batch-render'); if (shotsBatchBtn) shotsBatchBtn.onclick = triggerBatch;
  const forceBtn = $('#shots-force-rerender');
  if (forceBtn) forceBtn.onclick = async () => {
    if (!confirm('Wirklich ALLE Shots dieser Folge neu rendern - auch die bereits fertigen? Bestehende Clips werden dadurch ersetzt.')) return;
    try {
      const res = await api('/api/jobs/batch', { method: 'POST', body: JSON.stringify({ episodeId: currentEpisode, force: true, tier: renderQualityTier }) });
      notice(`${res.queued} Shots komplett neu eingereiht.`);
      await load();
    } catch (err) { notice(err.message); }
  };

  // Stop Render Queue handlers
  const triggerStopQueue = async () => {
    if (!confirm('Möchtest du alle laufenden und wartenden Render-Aufträge wirklich sofort abbrechen?')) return;
    try {
      notice('Breche alle Render-Aufträge ab...');
      const res = await api('/api/jobs/cancel-all', { method: 'POST' });
      notice(`Render-Queue gestoppt: ${res.canceled} Jobs abgebrochen.`);
      await load();
    } catch (err) {
      notice(`Fehler: ${err.message}`);
    }
  };

  document.querySelectorAll('[data-quality-tier]').forEach(btn => btn.onclick = () => {
    renderQualityTier = btn.dataset.qualityTier;
    render();
  });
  const heroStopBtn = $('#hero-stop-queue'); if (heroStopBtn) heroStopBtn.onclick = triggerStopQueue;
  const shotsStopBtn = $('#shots-stop-queue'); if (shotsStopBtn) shotsStopBtn.onclick = triggerStopQueue;
  const heroAutoplanBtn = $('#hero-start-autoplan');
  if (heroAutoplanBtn) {
    heroAutoplanBtn.onclick = () => {
      if (window.triggerAutoPlan) window.triggerAutoPlan();
      else { openView('story'); setTimeout(() => $('#auto-plan')?.click(), 100); }
    };
  }

  // Single shot render, edit & delete
  document.querySelectorAll('[data-render-shot]').forEach(x => x.onclick = async e => {
    e.stopPropagation();
    const shotId = Number(x.dataset.renderShot);
    try {
      await api('/api/jobs', { method: 'POST', body: JSON.stringify({ episodeId: currentEpisode, shotId, tier: renderQualityTier }) });
      notice('Renderauftrag eingereiht! Worker verarbeitet ihn jetzt.');
      await load();
    } catch (err) { notice(err.message); }
  });

  document.querySelectorAll('[data-delete-shot]').forEach(x => x.onclick = async e => {
    e.stopPropagation();
    const shotId = Number(x.dataset.deleteShot);
    if (!confirm(`Diesen Shot #${shotId} in den Papierkorb verschieben? Kann in den Einstellungen wiederhergestellt werden.`)) return;
    try {
      await api(`/api/shots/${shotId}`, { method: 'DELETE' });
      notice('Shot gelöscht.');
      await load();
    } catch (err) { notice(`Fehler beim Löschen: ${err.message}`); }
  });

  document.querySelectorAll('[data-edit-shot]').forEach(x => x.onclick = e => {
    e.stopPropagation();
    editShot(data.selected.shots.find(s => s.id === Number(x.dataset.editShot)));
  });

  // Asset edit & upload
  document.querySelectorAll('[data-edit-asset]').forEach(x => x.onclick = () => {
    editAsset(data.selected.assets.find(a => a.id === Number(x.dataset.editAsset)));
  });

  // Assemble episode with sound check modal
  const assembleHandler = async () => {
    const d = data.selected;
    let audio;
    try { audio = await api(`/api/episodes/${currentEpisode}/audio-preflight`); }
    catch (err) { notice(`Audio-Preflight konnte nicht geladen werden: ${err.message}`); return; }
    const totalShots = (d?.shots || []).length;
    const doneShots = (d?.shots || []).filter(s => s.output_video_path).length;
    const openShots = totalShots - doneShots;
    const incompleteWarning = openShots > 0 ? `
      <div style="background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.35);border-radius:var(--radius-sm);padding:12px;margin-bottom:14px;font-size:12px;color:#ffc107;">
        ⚠️ ${openShots} von ${totalShots} Shots sind noch nicht fertig gerendert. Diese fehlen im Zusammenschnitt, wenn du jetzt fortfährst.
      </div>
    ` : '';
    showModal(`
      <h3>🎞️ Film-Master Zusammenschnitt</h3>
      <p style="color:var(--text-muted);font-size:13px;line-height:1.5;margin-bottom:14px;">
        Alle fertig gerenderten Video-Clips werden nahtlos zu einem finalen MP4 zusammengefügt (reiner Schnitt, keine erneute Kodierung).
      </p>
      ${incompleteWarning}
      <div style="background:var(--bg-card);border:1px solid ${audio.readyForMaster ? 'var(--emerald)' : 'rgba(255,193,7,0.45)'};border-radius:var(--radius-sm);padding:12px;margin-bottom:16px;font-size:12px;">
        <div style="color:${audio.readyForMaster ? 'var(--emerald)' : '#ffc107'};font-weight:700;margin-bottom:4px;">Audio-Status: ${audio.readyForMaster ? 'Audio-Master bereit' : 'Audio-Master blockiert'}</div>
        ${audio.readyForMaster ? '<div>Alle Cue-Dateien wurden vom Mix-Worker bestätigt.</div>' : `<div>${esc((audio.blockers || []).join(' · ') || 'Audio-Plan ist noch nicht vollständig.')}</div><div style="margin-top:5px;color:var(--text-muted);">Ein Bildschnitt entfernt Tonspuren bewusst und wird klar so bezeichnet.</div>`}
      </div>
      <div style="display:flex;gap:10px;">
        ${audio.readyForMaster ? `<button type="button" id="confirm-assemble-btn" class="form-button" style="flex:1;">${openShots > 0 ? `Trotzdem mit ${doneShots}/${totalShots} Shots mischen` : 'Audio-Master jetzt erstellen'}</button>` : `<button type="button" id="confirm-picture-only-btn" class="form-button" style="background:var(--bg-elevated);border:1px solid var(--line);color:#fff;flex:1;">Bildschnitt ohne Ton erstellen</button>`}
        <button type="button" class="form-button" style="background:var(--bg-elevated);border:1px solid var(--line);color:#fff;flex:1;" onclick="closeModal()">Abbrechen</button>
      </div>
    `, () => {});

    const assemble = async pictureOnly => {
      closeModal();
      try {
        notice(pictureOnly ? 'Erstelle ausdrücklich einen Bildschnitt ohne Ton …' : 'Mische alle Szenen zu einem Audio-Master …');
        const res = await api(`/api/episodes/${currentEpisode}/assemble`, { method: 'POST', body: JSON.stringify({ pictureOnly }) });
        notice(`${pictureOnly ? 'Bildschnitt' : 'Film'} fertiggestellt: ${res.name}!`);
        await load();
        openView('exports');
      } catch (err) { notice(err.message); }
    };
    const audioBtn = $('#confirm-assemble-btn'); if (audioBtn) audioBtn.onclick = () => assemble(false);
    const pictureBtn = $('#confirm-picture-only-btn'); if (pictureBtn) pictureBtn.onclick = () => assemble(true);
  };
  const aBtn = $('#assemble-episode'); if (aBtn) aBtn.onclick = assembleHandler;
  const eBtn = $('#exports-assemble-btn'); if (eBtn) eBtn.onclick = assembleHandler;

  const importBtn = $('#import-project-btn');
  const importInput = $('#import-project-file');
  if (importBtn && importInput) {
    importBtn.onclick = () => importInput.click();
    importInput.onchange = async () => {
      const chosen = importInput.files?.[0];
      if (!chosen) return;
      importInput.value = '';
      if (!confirm(`Archiv "${chosen.name}" als NEUES Projekt importieren? Bestehende Projekte bleiben unverändert.`)) return;
      const previousLabel = importBtn.textContent;
      importBtn.disabled = true;
      importBtn.textContent = '📥 Importiere …';
      try {
        notice('Archiv wird hochgeladen und eingelesen. Das kann bei großen Projekten dauern …');
        const response = await fetch('/api/projects/import', { method: 'POST', body: chosen });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Import fehlgeschlagen.');
        notice(`Import fertig: "${result.title}" mit ${result.episodes} Folgen, ${result.shots} Shots und ${result.media} Dateien.`);
        currentProject = result.projectId; currentEpisode = null;
        await load();
      } catch (err) {
        notice(`Import fehlgeschlagen: ${err.message}`);
      } finally {
        importBtn.disabled = false;
        importBtn.textContent = previousLabel;
      }
    };
  }

  const importEpisodeBtn = $('#import-episode-btn');
  const importEpisodeInput = $('#import-episode-file');
  if (importEpisodeBtn && importEpisodeInput) {
    importEpisodeBtn.onclick = () => importEpisodeInput.click();
    importEpisodeInput.onchange = async () => {
      const chosen = importEpisodeInput.files?.[0];
      if (!chosen) return;
      importEpisodeInput.value = '';
      if (!confirm(`Archiv "${chosen.name}" als NEUE Folge in "${data.selected.project.title}" importieren?`)) return;
      const previousLabel = importEpisodeBtn.textContent;
      importEpisodeBtn.disabled = true;
      importEpisodeBtn.textContent = '📥 Importiere …';
      try {
        notice('Archiv wird hochgeladen und eingelesen …');
        const response = await fetch(`/api/episodes/import?projectId=${currentProject}`, { method: 'POST', body: chosen });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Import fehlgeschlagen.');
        notice(`Import fertig: "${result.title}" mit ${result.shots} Shots und ${result.media} Dateien.`);
        currentEpisode = result.episodeId;
        await load();
      } catch (err) {
        notice(`Import fehlgeschlagen: ${err.message}`);
      } finally {
        importEpisodeBtn.disabled = false;
        importEpisodeBtn.textContent = previousLabel;
      }
    };
  }

  $('#new-project').onclick = newProject;
  const neBtn = $('#new-episode'); if (neBtn) neBtn.onclick = newEpisode;
  const ssBtn = $('#save-story'); if (ssBtn) ssBtn.onclick = saveStory;
  const versionsBtn = $('#story-versions-btn');
  if (versionsBtn) versionsBtn.onclick = showStoryVersions;
  const nsBtn = $('#new-shot'); if (nsBtn) nsBtn.onclick = newShot;
  const naBtn = $('#new-asset'); if (naBtn) naBtn.onclick = newAsset;
  const generateIntroOutro = async (kind, btn) => {
    const label = kind === 'intro' ? 'Intro' : 'Outro';
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = `⏳ ${label} wird erzeugt…`;
    try {
      await api(`/api/episodes/${currentEpisode}/${kind}`, { method: 'POST', body: JSON.stringify({}) });
      notice(`${label} wurde erstellt.`);
      await load();
      openView('shots');
    } catch (err) {
      notice(`Fehler: ${err.message}`);
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  };
  const introBtn = $('#generate-intro'); if (introBtn) introBtn.onclick = () => generateIntroOutro('intro', introBtn);
  const outroBtn = $('#generate-outro'); if (outroBtn) outroBtn.onclick = () => generateIntroOutro('outro', outroBtn);

  const episodeSettingsForm = $('#episode-settings-form');
  if (episodeSettingsForm) episodeSettingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    const noticeEl = $('#episode-settings-notice');
    const values = Object.fromEntries(new FormData(episodeSettingsForm));
    try {
      await api(`/api/episodes/${currentEpisode}/settings`, { method: 'PATCH', body: JSON.stringify(values) });
      await load();
      notice('Episoden-Einstellungen gespeichert.');
    } catch (err) {
      if (noticeEl) noticeEl.textContent = `Fehler: ${err.message}`;
    }
  });
  const episodeSettingsReset = $('#episode-settings-reset');
  if (episodeSettingsReset) episodeSettingsReset.onclick = async () => {
    if (!confirm('Alle Episode-Überschreibungen entfernen? Diese Episode nutzt danach wieder die Projekt-Standardwerte.')) return;
    try {
      await api(`/api/episodes/${currentEpisode}/settings`, { method: 'PATCH', body: JSON.stringify({ styleProfile: '', negativePrompt: '', videoSteps: '', photoSteps: '', previewWidth: '', previewHeight: '', finalWidth: '', finalHeight: '' }) });
      await load();
      notice('Auf Projekt-Standard zurückgesetzt.');
    } catch (err) { notice(`Fehler: ${err.message}`); }
  };

  const archiveEpisodeBtn = $('#archive-episode');
  if (archiveEpisodeBtn) archiveEpisodeBtn.onclick = async () => {
    if (!confirm(`Diese Episode archivieren? Sie verschwindet aus der Auswahl, bleibt aber erhalten und ist unter "Folgen-Verwaltung" wiederherstellbar.`)) return;
    try {
      await api(`/api/episodes/${currentEpisode}/archive`, { method: 'POST' });
      currentEpisode = null;
      await load();
      notice('Episode archiviert.');
    } catch (err) { notice(`Fehler: ${err.message}`); }
  };
  renderArchivedEpisodes();
}

async function renderArchivedEpisodes() {
  const panel = $('#archived-episodes-panel'); if (!panel) return;
  try {
    const all = await api(`/api/projects/${currentProject}/episodes-all`);
    const archived = (all.episodes || []).filter(e => e.archived_at);
    if (!archived.length) { panel.innerHTML = '<p class="upload-note">Keine archivierten Folgen.</p>'; return; }
    panel.innerHTML = archived.map(e => `
      <div class="service">
        <span><b>${esc(e.title)}</b><br><small>Archiviert am ${new Date(e.archived_at).toLocaleString('de-CH',{dateStyle:'short',timeStyle:'short'})}</small></span>
        <button class="ghost" data-unarchive-episode="${e.id}">Wiederherstellen</button>
      </div>
    `).join('');
    panel.querySelectorAll('[data-unarchive-episode]').forEach(btn => btn.onclick = async () => {
      try {
        await api(`/api/episodes/${btn.dataset.unarchiveEpisode}/unarchive`, { method: 'POST' });
        notice('Folge wiederhergestellt.');
        await load();
      } catch (err) { notice(`Fehler: ${err.message}`); }
    });
  } catch { panel.innerHTML = '<p class="upload-note">Konnte nicht geladen werden.</p>'; }
}

// SHARED RENDER QUEUE — everyone renders through the same serial worker, so make that visible.
let queuePollHandle = null;
const selectedQueueJobIds = new Set();

function queueRowLabel(item) {
  const place = [item.project_title, item.episode_title ? `EP ${String(item.episode_number).padStart(2, '0')} · ${item.episode_title}` : null].filter(Boolean).join(' · ');
  return item.label || place || 'Unbenannter Renderauftrag';
}

function queueRowContext(item) {
  return [item.project_title, item.episode_title ? `EP ${String(item.episode_number).padStart(2, '0')} · ${item.episode_title}` : null].filter(Boolean).join(' · ');
}

function renderJobPhase(item) {
  if (item.kind === 'comfyui_reference_preview') {
    return {
      label: 'Referenzbild',
      text: item.state === 'läuft'
        ? 'ComfyUI erzeugt gerade das Referenzbild für eine konsistente Szene.'
        : 'Wird vor dem Video gerendert, damit Figuren und Orte wiedererkennbar bleiben.',
    };
  }
  if (item.kind === 'caption_asset') {
    return {
      label: 'Bildanalyse',
      text: item.state === 'läuft'
        ? 'Die Referenz wird analysiert und als nutzbarer Bildprompt beschrieben.'
        : 'Wird vor der Szenenplanung in die Materialbibliothek übernommen.',
    };
  }
  if (item.kind === 'minimax_h3') {
    return {
      label: 'Video',
      text: item.state === 'läuft'
        ? 'Der Worker bereitet Schlüsselbild und MiniMax-H3-Clip nacheinander vor. Der erste Keyframe nach einem Modellstart kann einige Minuten dauern.'
        : 'Startet automatisch, sobald alle verknüpften Referenzbilder fertig sind und die GPU frei ist.',
    };
  }
  if (item.kind === 'audio_cue') {
    return {
      label: 'Audio-Spur',
      text: item.state === 'läuft'
        ? 'Der Worker erzeugt diese einzelne Stimme, Musik- oder Effektspur und bestätigt sie vor dem Mix.'
        : 'Wartet als eigene, bearbeitbare Spur auf den lokalen Audio-Worker.',
    };
  }
  if (item.kind === 'audio_mix') {
    return {
      label: 'Audio-Mix',
      text: item.state === 'läuft'
        ? 'Bestätigte Spuren werden zeitlich gemischt, Sprache über Musik geduckt und als MP4-Master gespeichert.'
        : 'Startet erst, wenn alle vorgesehenen Audio-Spuren bestätigt sind.',
    };
  }
  return { label: 'Auftrag', text: item.state === 'läuft' ? 'Der lokale Worker verarbeitet diesen Auftrag.' : 'Wartet auf den lokalen Worker.' };
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '< 1 Min';
  if (mins < 60) return `~${mins} Min`;
  return `~${Math.floor(mins / 60)}h ${mins % 60}min`;
}

function formatElapsed(startedAt, avgSeconds) {
  if (!startedAt) return { text: '', overdue: false };
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  const overdue = Boolean(avgSeconds) && elapsedSeconds > avgSeconds * 2;
  return { text: `${formatEta(elapsedSeconds) || '< 1 Min'} seit Start`, overdue };
}

async function cancelQueueItem(jobId) {
  if (!confirm('Diesen einen Auftrag abbrechen?')) return;
  try {
    await api(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    notice('Auftrag abgebrochen.');
    await pollQueueStatus();
    await load();
  } catch (err) { notice(err.message); }
}
window.cancelQueueItem = cancelQueueItem;

function updateQueueBulkUi(queue) {
  const selected = queue.filter(item => selectedQueueJobIds.has(item.id));
  // Browsers may restore checked controls after a reload. Reapply our in-memory selection on
  // every queue refresh so a destructive bulk action can only target deliberate clicks made in
  // this FrameCut session.
  document.querySelectorAll('[data-queue-select]').forEach(input => {
    input.checked = selectedQueueJobIds.has(Number(input.dataset.queueSelect));
  });
  const toggle = $('#queue-select-all');
  const cancel = $('#queue-cancel-selected');
  const count = $('#queue-selection-count');
  if (toggle) {
    toggle.checked = queue.length > 0 && selected.length === queue.length;
    toggle.indeterminate = selected.length > 0 && selected.length < queue.length;
  }
  if (count) count.textContent = selected.length ? `${selected.length} ausgewählt` : 'Nichts ausgewählt';
  if (cancel) {
    cancel.disabled = selected.length === 0;
    cancel.textContent = selected.length ? `Auswahl abbrechen · ${selected.length}` : 'Auswahl abbrechen';
  }
}

async function cancelSelectedQueueItems(queue) {
  const selected = queue.filter(item => selectedQueueJobIds.has(item.id));
  if (!selected.length) return;
  const hasRunning = selected.some(item => item.state === 'läuft');
  const warning = hasRunning ? '\nDer aktuell laufende Auftrag wird beim nächsten Worker-Kontakt abgebrochen.' : '';
  if (!confirm(`${selected.length} ausgewählte Aufträge aus der Warteschlange entfernen? Bereits fertige Clips bleiben unverändert im Projekt.${warning}`)) return;
  try {
    const result = await api('/api/jobs/cancel', { method: 'POST', body: JSON.stringify({ ids: selected.map(item => item.id) }) });
    selectedQueueJobIds.clear();
    notice(`${result.canceled} Auftrag/Aufträge abgebrochen. Fertige Ergebnisse wurden nicht gelöscht.`);
    await pollQueueStatus();
    await load();
  } catch (err) { notice(err.message); }
}

function updateWorkerPill(worker, queueLength) {
  const runner = document.querySelector('.runner');
  if (!runner) return;
  const label = runner.querySelector('b');
  const detail = runner.querySelector('small');
  const pulse = runner.querySelector('.pulse');
  const online = Boolean(worker && worker.online);
  if (label) label.textContent = online ? 'RENDER-WORKER AKTIV' : 'KEIN WORKER VERBUNDEN';
  if (detail) {
    detail.textContent = online
      ? (queueLength ? `${queueLength} Auftrag/Aufträge in Arbeit` : 'Bereit, wartet auf Aufträge')
      : 'FrameCut-Worker.bat auf dem Render-PC starten';
  }
  if (pulse) pulse.style.background = online ? 'var(--emerald)' : '#ff5252';
  runner.style.borderColor = online ? '' : 'rgba(255,82,82,0.4)';
}

function toggleStopButtons(visible) {
  document.querySelectorAll('#hero-stop-queue, #shots-stop-queue').forEach(btn => { btn.classList.toggle('hidden', !visible); });
}

async function pollQueueStatus() {
  const el = $('#queue-status');
  if (!el) return;
  try {
    const { queue, avgSeconds, worker, runningCount = 0, waitingCount = 0 } = await api('/api/queue');
    for (const id of [...selectedQueueJobIds]) if (!queue.some(item => item.id === id)) selectedQueueJobIds.delete(id);
    toggleStopButtons(queue.length > 0);
    updateWorkerPill(worker, queue.length);
    if (!queue.length) { el.innerHTML = ''; return; }
    const workerWarning = (worker && !worker.online)
      ? `<div style="background:rgba(255,82,82,0.12);border:1px solid rgba(255,82,82,0.35);color:#ff8a80;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12.5px;line-height:1.5;">
          ⚠️ <b>Kein Render-Worker verbunden.</b> Die Aufträge bleiben liegen, bis auf dem Render-PC <code>FrameCut-Worker.bat</code> läuft.
          ${worker.secondsSinceSeen !== null ? `Zuletzt gesehen vor ${formatEta(worker.secondsSinceSeen) || 'wenigen Sekunden'}.` : 'Es hat sich noch nie ein Worker gemeldet.'}
        </div>`
      : '';
    const activeJob = queue.find(item => item.state === 'läuft');
    const activePhase = activeJob ? renderJobPhase(activeJob) : null;
    el.innerHTML = `
      <section class="render-queue-panel" aria-live="polite" aria-label="Renderstatus">
        <div class="render-queue-heading">
          <div>
            <h3>Renderstatus</h3>
            <p>Eine GPU verarbeitet immer genau einen Auftrag. Neue Videos bleiben sicher in der Reihenfolge.</p>
          </div>
          <div class="render-queue-metrics">
            <span class="render-metric ${runningCount ? 'is-active' : ''}">${runningCount ? `${runningCount} aktiv` : 'bereit'}</span>
            <span class="render-metric">${waitingCount} wartet</span>
          </div>
        </div>
        ${workerWarning}
        ${activeJob ? `
          <div class="render-now">
            <div class="render-now-indicator"><span class="pulse"></span><span>Jetzt auf der GPU</span></div>
            <div class="render-now-copy">
              <strong>${esc(queueRowLabel(activeJob))}</strong>
              <span>${esc(queueRowContext(activeJob))}</span>
              <p><b>${esc(activePhase.label)}:</b> ${esc(activePhase.text)}</p>
            </div>
            <div class="render-now-time">${formatElapsed(activeJob.started_at, avgSeconds).text}</div>
          </div>
        ` : `
          <div class="render-idle-note">Der Worker ist verbunden und übernimmt den nächsten Auftrag automatisch.</div>
        `}
        <div class="render-queue-bulk" aria-label="Sammelaktionen für die Warteschlange">
          <label class="queue-select-all"><input id="queue-select-all" type="checkbox"> <span>Alle sichtbaren markieren</span></label>
          <span id="queue-selection-count" class="queue-selection-count">Nichts ausgewählt</span>
          <button id="queue-cancel-selected" class="queue-bulk-cancel" type="button" disabled>Auswahl abbrechen</button>
        </div>
        <div class="render-queue-list" aria-label="Wartende und laufende Aufträge">
        ${queue.map(item => {
          const running = item.state === 'läuft';
          const elapsed = running ? formatElapsed(item.started_at, avgSeconds) : null;
          const phase = renderJobPhase(item);
          return `
          <div class="render-queue-row ${running ? 'is-running' : ''}">
            <label class="queue-row-select"><input type="checkbox" data-queue-select="${item.id}" aria-label="${esc(queueRowLabel(item))} auswählen" ${selectedQueueJobIds.has(item.id) ? 'checked' : ''}></label>
            ${running
              ? '<span class="shot-badge running" style="position:static;"><span class="pulse" style="width:6px;height:6px;margin:0;"></span> RENDERT</span>'
              : `<span class="shot-badge queued" style="position:static;">#${item.position}</span>`}
            <div class="render-queue-item-copy">
              <strong>${esc(queueRowLabel(item))}</strong>
              <span>${esc(phase.label)} · ${esc(queueRowContext(item) || 'Projekt wird zugeordnet')}</span>
            </div>
            <div class="render-queue-eta">
              ${running
                ? `<span class="${elapsed.overdue ? 'is-overdue' : ''}">${elapsed.overdue ? 'Prüfe Laufzeit · ' : ''}${elapsed.text}</span>`
                : (item.etaSeconds ? `<span>frühestens ${formatEta(item.etaSeconds)}</span>` : '<span>wartet auf GPU</span>')}
              <small>${esc(item.owner_display_name || item.owner_username || 'unbekannt')}</small>
            </div>
            <button class="render-queue-cancel" onclick="cancelQueueItem(${item.id})" title="Diesen Auftrag abbrechen" aria-label="${esc(queueRowLabel(item))} abbrechen">×</button>
          </div>
        `;
        }).join('')}
        </div>
        ${avgSeconds ? `<p class="render-queue-footnote">Vergleichswert: durchschnittlich ${formatEta(avgSeconds)} pro fertigem Video. Referenzbilder und ein frischer Modellstart können länger dauern.</p>` : '<p class="render-queue-footnote">Nach den ersten fertigen Videos zeigt FrameCut hier eine realistische durchschnittliche Dauer.</p>'}
      </section>
    `;
    document.querySelectorAll('[data-queue-select]').forEach(input => input.onchange = () => {
      const id = Number(input.dataset.queueSelect);
      if (input.checked) selectedQueueJobIds.add(id); else selectedQueueJobIds.delete(id);
      updateQueueBulkUi(queue);
    });
    $('#queue-select-all').onchange = event => {
      if (event.target.checked) queue.forEach(item => selectedQueueJobIds.add(item.id));
      else queue.forEach(item => selectedQueueJobIds.delete(item.id));
      document.querySelectorAll('[data-queue-select]').forEach(input => { input.checked = event.target.checked; });
      updateQueueBulkUi(queue);
    };
    $('#queue-cancel-selected').onclick = () => cancelSelectedQueueItems(queue);
    updateQueueBulkUi(queue);
  } catch (e) { /* transient — keep the last known state on screen */ }
}

function startQueuePolling() {
  if (queuePollHandle) return;
  pollQueueStatus();
  queuePollHandle = setInterval(pollQueueStatus, 6000);
}

function openView(name) {
  currentView = name;
  document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  document.querySelectorAll('.tab-item').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('hidden', x.id !== `view-${name}`));
  syncUrl();
}

// ASSET UPLOAD & EDIT
async function uploadFrom(form) {
  const fileInput = form.querySelector('[name=file]');
  if (!fileInput || !fileInput.files || !fileInput.files[0]) return '';
  const file = fileInput.files[0];
  const d = await new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = no;
    r.readAsDataURL(file);
  });
  const res = await api('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ name: file.name, data: d })
  });
  return res.path;
}

function newAsset() {
  showModal(`
    <h3>Neues Material</h3>
    <form>
      <label>Kategorie
        <select name="kind">
          <option value="character">Figur / Gesicht</option>
          <option value="location">Ort / Schauplatz</option>
          <option value="prop">Requisite</option>
          <option value="style">Stilreferenz</option>
        </select>
      </label>
      <label>Name
        <input name="name" required placeholder="z. B. Michel, Tesla, Solothurn">
      </label>
      <label>Beschreibung
        <textarea name="summary" placeholder="Wer oder was ist das?"></textarea>
      </label>
      <label>Visuelle Details / Leitplanken
        <textarea name="visualNotes" placeholder="Aussehen, Kleidung, Beleuchtung, Farben..."></textarea>
      </label>
      <label>Foto hochladen (Direkt vom Handy oder PC)
        <input name="file" type="file" accept="image/png,image/jpeg,image/webp">
      </label>
      <p style="font-size:11px;color:var(--text-dim);">PNG, JPG oder WebP · bis zu 25 MB.</p>
      <label class="check-row" style="flex-direction:row;align-items:center;gap:8px;">
        <input name="attach" type="checkbox" checked style="width:auto;"> In der aktuellen Episode verwenden
      </label>
      <p id="modal-error" class="error"></p>
      <button class="form-button">Material speichern</button>
    </form>
  `, async f => {
    const d = fields(f);
    d.filePath = await uploadFrom(f);
    d.episodeId = f.elements.attach.checked ? currentEpisode : null;
    await api(`/api/projects/${currentProject}/assets`, { method: 'POST', body: JSON.stringify(d) });
    await load();
    notice('Material erfolgreich gespeichert.');
  });
}

async function editAsset(a) {
  let photos = [];
  try { photos = (await api(`/api/assets/${a.id}/photos`)).photos; } catch { photos = []; }

  const galleryHtml = photos.length ? `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
      ${photos.map(p => `
        <div class="asset-photo-tile" data-photo-id="${p.id}" style="position:relative;width:84px;">
          <img src="${p.url}" style="width:84px;height:84px;object-fit:cover;border-radius:var(--radius-sm);border:1px solid ${p.isPrimary ? 'var(--emerald)' : 'var(--line)'};">
          ${p.isPrimary ? '<div style="position:absolute;top:2px;left:2px;background:var(--emerald);color:#061a0f;font-size:9px;font-weight:700;padding:1px 4px;border-radius:4px;">★</div>' : ''}
          <div style="display:flex;gap:2px;margin-top:2px;">
            ${p.isPrimary ? '' : `<button type="button" class="asset-photo-primary" data-photo-id="${p.id}" style="flex:1;font-size:9px;padding:2px;background:var(--bg-elevated);color:var(--text-muted);border:1px solid var(--line);border-radius:4px;cursor:pointer;">Haupt</button>`}
            <button type="button" class="asset-photo-delete" data-photo-id="${p.id}" style="flex:1;font-size:9px;padding:2px;background:rgba(255,82,82,0.1);color:#ff5252;border:1px solid rgba(255,82,82,0.25);border-radius:4px;cursor:pointer;">✕</button>
          </div>
        </div>
      `).join('')}
    </div>
    <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">${photos.length} Referenzfoto${photos.length === 1 ? '' : 's'} · ★ = wird beim Rendern als Hauptansicht genutzt.</p>
  ` : '';

  showModal(`
    <h3>${esc(a.name)} anpassen</h3>
    <form>
      ${galleryHtml}
      <label>Name
        <input name="name" required value="${esc(a.name)}">
      </label>
      <label>Beschreibung
        <textarea name="summary">${esc(a.summary || '')}</textarea>
      </label>
      <label>Visuelle Leitplanken / Prompt
        <textarea name="visualNotes">${esc(a.visual_notes || '')}</textarea>
      </label>
      ${a.kind === 'character' ? `
      <label>Stimmprofil
        <textarea name="voice" placeholder="z. B. junge, helle Schweizerdeutsche Kinderstimme; neugierig, warm, klar und natürlich">${esc(a.voice || '')}</textarea>
        <span style="display:block;margin-top:4px;color:var(--text-dim);font-size:11px;">Diese Beschreibung wird nur an den lokalen Qwen-TTS-Adapter übergeben. Kein Klonen einer echten Stimme ohne Referenzton.</span>
      </label>
      ` : ''}
      <label>${photos.length ? 'Weiteres Foto zur Galerie hinzufügen' : 'Foto hochladen'}
        <input name="file" id="asset-photo-input" type="file" accept="image/png,image/jpeg,image/webp">
      </label>
      <p id="modal-error" class="error"></p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button type="submit" class="form-button" style="flex:2;">Änderungen speichern</button>
        <button type="button" id="modal-create-preview" class="form-button" style="background:var(--bg-elevated);color:#fff;border:1px solid var(--line);flex:2;">Foto per KI erstellen</button>
        ${a.url ? '<button type="button" id="modal-caption-asset" class="form-button" style="background:var(--bg-elevated);color:#fff;border:1px solid var(--line);flex:2;">Beschreibung per KI erstellen</button>' : ''}
        ${a.kind === 'character' ? '<button type="button" id="modal-voice-preview" class="form-button" style="background:var(--bg-elevated);color:#fff;border:1px solid var(--line);flex:2;">Stimmprobe erzeugen</button>' : ''}
        <button type="button" id="modal-delete-asset" class="form-button" style="background:rgba(255,82,82,0.15);color:#ff5252;border:1px solid rgba(255,82,82,0.3);flex:1;">Löschen</button>
      </div>
    </form>
  `, async f => {
    const d = fields(f);
    delete d.file;
    const uploaded = await uploadFrom(f);
    if (uploaded) await api(`/api/assets/${a.id}/photos`, { method: 'POST', body: JSON.stringify({ path: uploaded }) });
    await api(`/api/assets/${a.id}`, { method: 'PATCH', body: JSON.stringify(d) });
    await load();
    notice('Material aktualisiert.');
  });

  document.querySelectorAll('.asset-photo-primary').forEach(btn => btn.onclick = async () => {
    try {
      await api(`/api/assets/${a.id}/photos/${btn.dataset.photoId}`, { method: 'PATCH', body: JSON.stringify({ primary: true }) });
      const fresh = { ...a, ...(await api(`/api/projects/${currentProject}/assets`)).assets.find(x => x.id === a.id) };
      await editAsset(fresh);
    } catch (err) { $('#modal-error').textContent = `Fehler: ${err.message}`; }
  });

  document.querySelectorAll('.asset-photo-delete').forEach(btn => btn.onclick = async () => {
    if (!confirm('Dieses Foto wirklich löschen?')) return;
    try {
      await api(`/api/assets/${a.id}/photos/${btn.dataset.photoId}`, { method: 'DELETE' });
      const fresh = { ...a, ...(await api(`/api/projects/${currentProject}/assets`)).assets.find(x => x.id === a.id) };
      await editAsset(fresh);
      await load();
    } catch (err) { $('#modal-error').textContent = `Fehler: ${err.message}`; }
  });

  const delBtn = $('#modal-delete-asset');
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm(`"${a.name}" in den Papierkorb verschieben? Kann in den Einstellungen wiederhergestellt werden.`)) return;
      try {
        await api(`/api/assets/${a.id}`, { method: 'DELETE' });
        closeModal();
        notice(`Material "${a.name}" gelöscht.`);
        await load();
      } catch (err) {
        $('#modal-error').textContent = `Fehler: ${err.message}`;
      }
    };
  }

  const previewBtn = $('#modal-create-preview');
  if (previewBtn) {
    previewBtn.onclick = async () => {
      try {
        notice('Starte ComfyUI zur KI-Bildgenerierung...');
        await api(`/api/assets/${a.id}/preview`, { method: 'POST', body: JSON.stringify({ episodeId: currentEpisode }) });
        closeModal();
        notice('Auftrag an ComfyUI übergeben. Bild wird erzeugt!');
        await load();
      } catch (err) {
        $('#modal-error').textContent = err.message;
      }
    };
  }

  const captionBtn = $('#modal-caption-asset');
  if (captionBtn) {
    captionBtn.onclick = async () => {
      try {
        await api(`/api/assets/${a.id}/caption`, { method: 'POST' });
        closeModal();
        notice('Beschreibung wird lokal erzeugt (Qwen2.5-VL). Öffne das Material nach ein paar Sekunden erneut, um sie zu sehen.');
      } catch (err) {
        $('#modal-error').textContent = err.message;
      }
    };
  }

  const voiceBtn = $('#modal-voice-preview');
  if (voiceBtn) {
    voiceBtn.onclick = async () => {
      try {
        const form = voiceBtn.closest('form');
        const voice = String(form.elements.voice?.value || '').trim();
        await api(`/api/assets/${a.id}/voice-preview`, { method: 'POST', body: JSON.stringify({ episodeId: currentEpisode, voice, text: `Hallo, ich bin ${a.name}. Das ist meine Stimmprobe.`, language: 'German' }) });
        closeModal();
        notice('Stimmprobe ist eingereiht. Der lokale Worker erzeugt sie, sobald die GPU frei ist.');
        await load();
      } catch (err) { $('#modal-error').textContent = err.message; }
    };
  }
}

function assetChooser(selected = []) {
  return `<div style="background:var(--bg-input);padding:12px;border-radius:var(--radius-sm);border:1px solid var(--line);margin:6px 0;">
    <b style="font-size:13px;display:block;margin-bottom:8px;">Referenzen für diesen Shot zuweisen</b>
    ${data.selected.assets.map(a => `
      <label style="display:flex;flex-direction:row;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--line);font-size:12px;cursor:pointer;">
        <input type="checkbox" name="assetIds" value="${a.id}" ${selected.includes(a.id) ? 'checked' : ''} style="width:auto;">
        <span>${esc(a.name)}</span>
        <small style="margin-left:auto;color:var(--text-dim);">${a.kind === 'character' ? 'Figur' : 'Ort'}</small>
      </label>
    `).join('') || '<p style="color:var(--text-dim);font-size:12px;">Kein Material vorhanden.</p>'}
  </div>`;
}

function newShot() {
  showModal(`
    <h3>Neuen Shot anlegen</h3>
    <form>
      <label>Titel
        <input name="title" required placeholder="z. B. 001 – Nächtliche Fahrt">
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <label>Dauer in Sekunden
          <input name="durationSeconds" type="number" min="1" max="15" value="5">
        </label>
        <label style="grid-column:1/-1;font-size:11px;color:var(--text-dim);font-weight:400;">Der lokale Render-Worker begrenzt einen einzelnen Shot technisch auf maximal 15 Sekunden.
        </label>
        <label>Seed (optional)
          <input name="seed" type="number" placeholder="z. B. 1042">
        </label>
      </div>
      ${assetChooser()}
      <label>Kameraführung
        <textarea name="camera" placeholder="z. B. Frontale Totale, Verfolgungskamera"></textarea>
      </label>
      <label>Video-Prompt
        <textarea name="prompt" placeholder="Beschreibe die visuelle Bewegung und Szene..."></textarea>
      </label>
      <p id="modal-error" class="error"></p>
      <button class="form-button">Shot speichern</button>
    </form>
  `, async f => {
    const r = await api(`/api/episodes/${currentEpisode}/shots`, { method: 'POST', body: JSON.stringify(fields(f)) });
    const ids = [...f.querySelectorAll('[name=assetIds]:checked')].map(x => Number(x.value));
    await api(`/api/shots/${r.shot.id}/assets`, { method: 'PUT', body: JSON.stringify({ assetIds: ids }) });
    await load();
    openView('shots');
    notice('Neuer Shot gespeichert.');
  });
}

async function editShot(s) {
  const isDone = Boolean(s.video);
  let dialogueLines = [];
  try { dialogueLines = (await api(`/api/shots/${s.id}/dialogue`)).lines; } catch { dialogueLines = []; }
  const characters = (data.selected?.assets || data.assets || []).filter(a => a.kind === 'character');

  const dialogueHtml = `
    <label>Dialog (für spätere Sprachausgabe – wird nie aus dem Video-Modell übernommen)</label>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">
      ${dialogueLines.map(l => `
        <div style="display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;">
          <span style="flex:1;"><b>${l.asset_name ? esc(l.asset_name) : 'Erzähler/Off'}:</b> ${esc(l.text)}</span>
          <button type="button" class="dialogue-delete" data-line-id="${l.id}" style="background:transparent;border:none;color:#ff5252;cursor:pointer;font-size:11px;">✕</button>
        </div>
      `).join('') || '<p class="upload-note">Noch keine Dialogzeilen.</p>'}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <select id="dialogue-asset" style="flex:0 0 140px;">
        <option value="">Erzähler/Off</option>
        ${characters.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
      <input id="dialogue-text" placeholder="Dialogzeile eintippen..." style="flex:1;">
      <button type="button" id="dialogue-add" class="ghost">+ Hinzufügen</button>
    </div>
  `;

  showModal(`
    <h3>Shot #${String(s.sequence || s.id).padStart(2, '0')} anpassen</h3>
    <form>
      ${isDone ? `
        <div style="margin-bottom:14px;background:#000;border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--line);">
          <video src="${s.video}" controls playsinline style="width:100%;max-height:220px;display:block;"></video>
        </div>
      ` : ''}
      <label>Titel
        <input name="title" value="${esc(s.title)}" required>
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <label>Dauer in Sekunden
          <input name="durationSeconds" type="number" value="${s.duration_seconds}" min="1" max="15">
        </label>
        <label>Seed (optional)
          <input name="seed" type="number" value="${s.seed || ''}">
        </label>
      </div>
      ${assetChooser((s.references || []).map(a => a.id))}
      <label>Kameraführung
        <textarea name="camera">${esc(s.camera || '')}</textarea>
      </label>
      <label>Video-Prompt
        <textarea name="prompt" style="min-height:90px;">${esc(s.prompt || '')}</textarea>
      </label>
      ${dialogueHtml}
      <p id="modal-error" class="error"></p>
      <div style="display:flex;gap:10px;">
        <button type="submit" class="form-button" style="flex:1;">Änderungen speichern</button>
        <button type="button" id="modal-save-and-render" class="form-button" style="background:var(--red);color:#fff;flex:1;">🎬 Speichern & Rendern</button>
      </div>
    </form>
  `, async f => {
    await api(`/api/shots/${s.id}`, { method: 'PATCH', body: JSON.stringify(fields(f)) });
    const ids = [...f.querySelectorAll('[name=assetIds]:checked')].map(x => Number(x.value));
    await api(`/api/shots/${s.id}/assets`, { method: 'PUT', body: JSON.stringify({ assetIds: ids }) });
    await load();
    openView('shots');
    notice('Shot gespeichert.');
  });

  const dialogueAddBtn = $('#dialogue-add');
  if (dialogueAddBtn) dialogueAddBtn.onclick = async () => {
    const textEl = $('#dialogue-text');
    const text = textEl.value.trim();
    if (!text) return;
    try {
      await api(`/api/shots/${s.id}/dialogue`, { method: 'POST', body: JSON.stringify({ text, assetId: $('#dialogue-asset').value || null }) });
      await editShot(s);
    } catch (err) { $('#modal-error').textContent = `Fehler: ${err.message}`; }
  };
  document.querySelectorAll('.dialogue-delete').forEach(btn => btn.onclick = async () => {
    try {
      await api(`/api/shots/${s.id}/dialogue/${btn.dataset.lineId}`, { method: 'DELETE' });
      await editShot(s);
    } catch (err) { $('#modal-error').textContent = `Fehler: ${err.message}`; }
  });

  const srBtn = $('#modal-save-and-render');
  if (srBtn) {
    srBtn.onclick = async () => {
      const f = $('#modal form');
      try {
        await api(`/api/shots/${s.id}`, { method: 'PATCH', body: JSON.stringify(fields(f)) });
        const ids = [...f.querySelectorAll('[name=assetIds]:checked')].map(x => Number(x.value));
        await api(`/api/shots/${s.id}/assets`, { method: 'PUT', body: JSON.stringify({ assetIds: ids }) });
        await api('/api/jobs', { method: 'POST', body: JSON.stringify({ episodeId: currentEpisode, shotId: s.id }) });
        closeModal();
        notice(`Shot #${s.sequence} gespeichert und an Worker übergeben.`);
        await load();
        openView('shots');
      } catch (err) {
        $('#modal-error').textContent = err.message;
      }
    };
  }
}

async function showStoryVersions() {
  try {
    const { versions } = await api(`/api/episodes/${currentEpisode}/story/versions`);
    if (!versions.length) { notice('Für diese Folge gibt es noch keine früheren Fassungen.'); return; }
    showModal(`
      <h3>Frühere Fassungen der Story</h3>
      <p class="upload-note">Beim Speichern wird die vorherige Fassung automatisch aufbewahrt (die letzten 10). Ansehen ändert nichts, erst „Wiederherstellen“ ersetzt den Text im Editor.</p>
      <div style="display:flex;flex-direction:column;gap:6px;margin:12px 0;">
        ${versions.map(v => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;">
            <span style="flex:1;font-family:var(--font-mono);">${new Date(v.saved_at).toLocaleString('de-CH',{dateStyle:'short',timeStyle:'short'})}</span>
            <span style="color:var(--text-dim);">${Math.round(v.size/100)/10} k Zeichen</span>
            <button type="button" class="shot-btn" data-restore-version="${v.id}">Wiederherstellen</button>
          </div>
        `).join('')}
      </div>
      <p id="modal-error" class="error"></p>
    `, () => {});
    document.querySelectorAll('[data-restore-version]').forEach(btn => btn.onclick = async () => {
      try {
        const version = await api(`/api/episodes/${currentEpisode}/story/versions/${btn.dataset.restoreVersion}`);
        const editor = $('#story-editor');
        if (editor) editor.value = version.markdown;
        closeModal();
        notice('Fassung in den Editor geladen. Mit „Story speichern“ übernehmen.');
      } catch (err) { $('#modal-error').textContent = err.message; }
    });
  } catch (err) { notice(err.message); }
}

async function saveStory() {
  await api(`/api/episodes/${currentEpisode}/story`, { method: 'PUT', body: JSON.stringify({ markdown: $('#story-editor').value }) });
  notice('Story gespeichert.');
  await load();
}

function newProject() {
  showModal(`
    <h3>Neues Projekt</h3>
    <form>
      <label>Projektname
        <input name="title" required placeholder="z. B. Mein Neuer Film">
      </label>
      <label>Beschreibung
        <textarea name="synopsis" placeholder="Worum geht es in dieser Geschichte?"></textarea>
      </label>
      <p id="modal-error" class="error"></p>
      <button class="form-button">Projekt anlegen</button>
    </form>
  `, async f => {
    const r = await api('/api/projects', { method: 'POST', body: JSON.stringify(fields(f)) });
    currentProject = r.project.id;
    currentEpisode = null;
    await load();
    notice('Projekt erfolgreich angelegt.');
  });
}

function newEpisode() {
  showModal(`
    <h3>Neue Episode</h3>
    <form>
      <label>Episodentitel
        <input name="title" required placeholder="z. B. Episode 02 – Das Erwachen">
      </label>
      <p id="modal-error" class="error"></p>
      <button class="form-button">Episode anlegen</button>
    </form>
  `, async f => {
    const r = await api(`/api/projects/${currentProject}/episodes`, { method: 'POST', body: JSON.stringify(fields(f)) });
    currentEpisode = r.episode.id;
    await load();
    notice('Episode angelegt.');
  });
}

// Nav bindings
document.querySelectorAll('.nav').forEach(b => b.onclick = () => openView(b.dataset.view));
document.querySelectorAll('.tab-item').forEach(b => b.onclick = () => openView(b.dataset.view));
$('#project-switch').onchange = e => { currentProject = Number(e.target.value); currentEpisode = null; load(); };
$('#episode-switch').onchange = e => { currentEpisode = Number(e.target.value); load(); };
$('#refresh').onclick = () => load().then(() => notice('Aktualisiert.')).catch(e => notice(e.message));
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };

// User dropdown
(function () {
  const pill = $('#user-pill');
  const dropdown = $('#user-dropdown');
  if (!pill || !dropdown) return;
  pill.onclick = e => { e.stopPropagation(); dropdown.classList.toggle('open'); };
  document.addEventListener('click', () => dropdown.classList.remove('open'));
  const menuSettings = $('#user-menu-settings');
  const menuLogout = $('#user-menu-logout');
  if (menuSettings) menuSettings.onclick = e => { e.stopPropagation(); dropdown.classList.remove('open'); openView('settings'); };
  if (menuLogout) menuLogout.onclick = async e => { e.stopPropagation(); await api('/api/logout', { method: 'POST' }); location.reload(); };
})();

openStudio().catch(init);
