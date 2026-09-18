/* FrameCut Auto-Mode UI. Kept separate so the planning feature stays easy to evolve. */
(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

  function decorateStory() {
    const actions = $('#view-story .section-lead > div:last-child') || $('#view-story div[style*="display:flex"] > div:last-child');
    if (!actions || $('#auto-plan')) return;
    const button = document.createElement('button');
    button.id = 'auto-plan'; button.className = 'emerald-btn'; button.style.cssText = 'font-weight:700;padding:0 14px;'; button.textContent = '✦ KI-Auto-Modus planen';
    button.addEventListener('click', () => autoPlan().catch(showFailure));
    const saveBtn = $('#save-story');
    if (saveBtn) actions.insertBefore(button, saveBtn);
    else actions.appendChild(button);
  }

  function decorateOverview() {
    // Hook for overview auto planning if needed
  }

  function renderSettings() {
    const view = $('#view-settings'); if (!view) return;
    const project = data?.selected?.project;
    const renderPanel = project ? `<div class="section-lead" style="margin-top:24px;"><div><p class="eyebrow">${esc(project.title)}</p><h3>Render-Einstellungen</h3><small>Steps und Auflösung gelten für dieses Projekt. Höhere Werte dauern länger, mehr Steps können die Bildqualität verbessern — am besten erst an einer einzelnen Szene ausprobieren.</small></div></div><div class="panel"><form id="render-settings-form"><label>Negativ-Prompt für dieses Projekt<textarea name="negativePrompt" maxlength="2400" placeholder="z. B. keine Schrift, keine Logos, keine Fahrzeuge, keine zusätzlichen Personen">${esc(project.negative_prompt || '')}</textarea><small>Was in keinem Render erscheinen soll. Gilt für Keyframes und MiniMax-Videos; kann pro Episode überschrieben werden.</small></label><div class="shot-modal-grid"><label>Foto-Steps (Referenzen & Keyframes)<input name="photoSteps" type="number" min="1" max="40" value="${project.photo_steps ?? 8}"></label><label>Video-Steps (MiniMax H3)<input name="videoSteps" type="number" min="1" max="40" value="${project.video_steps ?? 4}"></label></div><div class="shot-modal-grid"><label>Vorschau-Breite<input name="previewWidth" type="number" min="160" max="2048" step="32" value="${project.preview_width ?? 384}"></label><label>Vorschau-Höhe<input name="previewHeight" type="number" min="160" max="2048" step="32" value="${project.preview_height ?? 224}"></label></div><div class="shot-modal-grid"><label>Fertig-Breite<input name="finalWidth" type="number" min="160" max="2048" step="32" value="${project.final_width ?? 768}"></label><label>Fertig-Höhe<input name="finalHeight" type="number" min="160" max="2048" step="32" value="${project.final_height ?? 448}"></label></div><p class="upload-note">Breite/Höhe werden automatisch auf Vielfache von 32 gerundet (Anforderung des Video-Modells).</p><p id="render-settings-notice" class="upload-note"></p><button class="form-button" type="submit">Render-Einstellungen speichern</button></form></div>` : '';
    const projectPanel = project ? `<div class="section-lead" style="margin-top:24px;"><div><p class="eyebrow">${esc(project.title)}</p><h3>Projekt-Verwaltung</h3><small>Archivierte Projekte verschwinden aus der Seitenleiste, bleiben aber vollständig erhalten und lassen sich jederzeit wiederherstellen.</small></div><div style="display:flex;gap:10px;flex-wrap:wrap;"><button class="form-button" id="archive-project" style="background:rgba(255,255,255,0.08);">Dieses Projekt archivieren</button><button class="form-button" id="delete-project" style="background:rgba(255,82,82,0.12);color:#ff5252;">Dieses Projekt löschen</button></div></div><div class="panel" id="archived-projects-panel"><p class="upload-note">Lade …</p></div>` : '';
    view.innerHTML = `<div class="section-lead"><div><p class="eyebrow">DEIN ARBEITSPLATZ</p><h3>KI & API-Schlüssel</h3><small>Jeder Benutzer verwaltet seine eigenen Schlüssel. Sie werden verschlüsselt gespeichert und niemals wieder im Klartext angezeigt.</small></div><button class="form-button" id="manage-ai">KI-Anbieter einrichten</button></div><div class="panel"><div class="service"><span><b>Auto-Modus</b><br><small>Aus deiner Story entsteht ein editierbarer Plan mit Figuren, Orten und Video-Shots. Für den ersten Test reicht Gemini Flash oder DeepSeek.</small></span><span class="pill">PLANEN, NICHT RENDERN</span></div><div class="service"><span><b>Datenschutz</b><br><small>Nur deine Story und die gewählte Stilvorgabe gehen an den von dir eingerichteten KI-Anbieter.</small></span><span class="pill">PRO BENUTZER</span></div></div><div class="section-lead" style="margin-top:24px;"><div><p class="eyebrow">DEIN VERBRAUCH</p><h3>KI-Token & geschätzte Kosten</h3><small>Nur für deinen Account, basierend auf den tatsächlich von den Anbietern gemeldeten Token-Zahlen. Die Kosten sind grob geschätzt, keine offizielle Abrechnung.</small></div></div><div class="panel" id="usage-panel"><p class="upload-note">Lade …</p></div><div class="section-lead" style="margin-top:24px;"><div><p class="eyebrow">FORTGESCHRITTEN</p><h3>KI-Prompts</h3><small>Die Anweisungen, die bei jeder Story-Analyse und Shot-Generierung an die KI gehen. Änderungen wirken für alle deine Projekte, sofort beim nächsten Auto-Modus-Lauf.</small></div></div><div class="panel" id="prompts-panel"><p class="upload-note">Lade …</p></div>${renderPanel}${projectPanel}<div class="section-lead" style="margin-top:24px;"><div><p class="eyebrow">GELÖSCHTE ELEMENTE</p><h3>Papierkorb</h3><small>Gelöschte Shots, Figuren/Orte und Folgen bleiben 14 Tage wiederherstellbar.</small></div></div><div class="panel" id="trash-panel"><p class="upload-note">Lade …</p></div>`;
    $('#manage-ai').onclick = aiSettings;
    renderUsage();
    renderPrompts();
    const renderForm = $('#render-settings-form');
    if (renderForm) renderForm.addEventListener('submit', async event => {
      event.preventDefault();
      const noticeEl = $('#render-settings-notice');
      const values = Object.fromEntries(new FormData(renderForm));
      try {
        await api(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify(values) });
        if (typeof load === 'function') await load();
        renderSettings();
        notice('Render-Einstellungen gespeichert.');
      } catch (err) {
        if (noticeEl) noticeEl.textContent = `Fehler: ${err.message}`;
      }
    });
    const archiveBtn = $('#archive-project');
    if (archiveBtn) archiveBtn.onclick = async () => {
      if (!confirm(`"${project.title}" archivieren? Es verschwindet aus der Seitenleiste, bleibt aber erhalten und ist unter "Archivierte Projekte" wiederherstellbar.`)) return;
      try {
        await api(`/api/projects/${project.id}/archive`, { method: 'POST' });
        currentProject = null; currentEpisode = null;
        if (typeof load === 'function') await load();
        notice(`"${project.title}" wurde archiviert.`);
      } catch (err) { notice(`Fehler: ${err.message}`); }
    };
    const deleteBtn = $('#delete-project');
    if (deleteBtn) deleteBtn.onclick = async () => {
      const typed = prompt(`"${project.title}" wirklich löschen? Alle Episoden, Shots, Figuren/Orte und Renders werden mit verschoben. Kann 14 Tage lang im Papierkorb wiederhergestellt werden.\n\nGib zum Bestätigen den Projektnamen ein:`);
      if (typed !== project.title) { if (typed !== null) notice('Löschen abgebrochen: Name stimmte nicht überein.'); return; }
      try {
        await api(`/api/projects/${project.id}`, { method: 'DELETE' });
        currentProject = null; currentEpisode = null;
        if (typeof load === 'function') await load();
        notice(`"${project.title}" wurde in den Papierkorb verschoben.`);
      } catch (err) { notice(`Fehler: ${err.message}`); }
    };
    renderArchivedProjects();
    renderTrash();
  }

  async function renderUsage() {
    const panel = $('#usage-panel'); if (!panel) return;
    try {
      const usage = await api('/api/usage');
      const providerLabel = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };
      const row = (label, entries) => {
        if (!entries.length) return `<div class="service"><span><b>${label}</b><br><small>Keine Nutzung erfasst.</small></span></div>`;
        return `<div class="service"><span><b>${label}</b><br><small>${entries.map(e => `${providerLabel[e.provider] || e.provider}: ${e.totalTokens.toLocaleString('de-CH')} Token (${e.calls}×) · ~$${e.estimatedCostUsd.toFixed(3)}`).join(' · ')}</small></span></div>`;
      };
      panel.innerHTML = row('Letzte 7 Tage', usage.week) + row('Letzte 30 Tage', usage.month) + row('Gesamt', usage.allTime);
    } catch (err) {
      panel.innerHTML = `<p class="upload-note">Verbrauch konnte nicht geladen werden: ${esc(err.message)}</p>`;
    }
  }

  async function renderPrompts() {
    const panel = $('#prompts-panel'); if (!panel) return;
    try {
      const { prompts } = await api('/api/settings/prompts');
      panel.innerHTML = prompts.map(p => `
        <div class="service">
          <span><b>${esc(p.label)}</b><br><small>${p.isOverridden ? `Angepasst am ${new Date(p.updatedAt).toLocaleString('de-CH',{dateStyle:'short',timeStyle:'short'})}` : 'Original (Standard)'}</small></span>
          <button class="ghost" data-edit-prompt="${p.purpose}">Anzeigen & Bearbeiten</button>
        </div>
      `).join('');
      panel.querySelectorAll('[data-edit-prompt]').forEach(btn => btn.onclick = () => openPromptEditor(prompts.find(p => p.purpose === btn.dataset.editPrompt)));
    } catch (err) {
      panel.innerHTML = `<p class="upload-note">Prompts konnten nicht geladen werden: ${esc(err.message)}</p>`;
    }
  }

  function openPromptEditor(p) {
    showModal(`<h3>${esc(p.label)}</h3><form><p class="upload-note">Das ist der Teil der KI-Anweisung, der Regeln und Beispiele enthält. Story-Text, Assets und das JSON-Format werden immer automatisch vom System ergänzt und sind hier nicht editierbar.</p><label>Anweisung<textarea name="text" rows="16" style="font-family:monospace;font-size:12px;">${esc(p.current)}</textarea></label><p id="modal-error" class="error"></p><div style="display:flex;gap:8px;">${p.isOverridden ? `<button type="button" class="ghost" id="reset-prompt">Auf Standard zurücksetzen</button>` : ''}<button class="form-button" type="submit">Speichern</button></div></form>`, async form => {
      const submit = form.querySelector('button[type=submit]');
      const errEl = form.querySelector('#modal-error');
      submit.disabled = true;
      try {
        const text = form.elements.text.value;
        await api(`/api/settings/prompts/${p.purpose}`, { method: 'PUT', body: JSON.stringify({ text }) });
        closeModal();
        notice('Prompt gespeichert.');
        renderPrompts();
      } catch (err) {
        submit.disabled = false;
        if (errEl) errEl.textContent = `Fehler: ${err.message}`;
      }
    });
    const resetBtn = $('#reset-prompt');
    if (resetBtn) resetBtn.onclick = async () => {
      if (!confirm('Diesen Prompt wirklich auf den Original-Text zurücksetzen?')) return;
      try {
        await api(`/api/settings/prompts/${p.purpose}`, { method: 'DELETE' });
        closeModal();
        notice('Prompt zurückgesetzt.');
        renderPrompts();
      } catch (err) { notice(`Fehler: ${err.message}`); }
    };
  }

  async function renderArchivedProjects() {
    const panel = $('#archived-projects-panel'); if (!panel) return;
    try {
      const all = await api('/api/dashboard?includeArchived=1');
      const archived = all.projects.filter(p => p.archived_at);
      if (!archived.length) { panel.innerHTML = '<p class="upload-note">Keine archivierten Projekte.</p>'; return; }
      panel.innerHTML = archived.map(p => `
        <div class="service">
          <span><b>${esc(p.title)}</b><br><small>Archiviert am ${new Date(p.archived_at).toLocaleString('de-CH',{dateStyle:'short',timeStyle:'short'})}</small></span>
          <button class="ghost" data-unarchive-project="${p.id}">Wiederherstellen</button>
        </div>
      `).join('');
      panel.querySelectorAll('[data-unarchive-project]').forEach(btn => btn.onclick = async () => {
        try {
          await api(`/api/projects/${btn.dataset.unarchiveProject}/unarchive`, { method: 'POST' });
          notice('Projekt wiederhergestellt.');
          if (typeof load === 'function') await load();
          renderSettings();
        } catch (err) { notice(`Fehler: ${err.message}`); }
      });
    } catch (err) {
      panel.innerHTML = `<p class="upload-note">Archiv konnte nicht geladen werden: ${esc(err.message)}</p>`;
    }
  }

  async function renderTrash() {
    const panel = $('#trash-panel'); if (!panel) return;
    try {
      const { items } = await api('/api/trash');
      if (!items.length) { panel.innerHTML = '<p class="upload-note">Der Papierkorb ist leer.</p>'; return; }
      const kindLabel = { shot: 'Shot', asset: 'Figur/Ort/Requisite', episode: 'Folge', project: 'Projekt' };
      panel.innerHTML = items.map(item => `
        <div class="service">
          <span><b>${esc(item.label)}</b><br><small>${kindLabel[item.kind] || item.kind} · gelöscht am ${new Date(item.deleted_at).toLocaleString('de-CH',{dateStyle:'short',timeStyle:'short'})}</small></span>
          <span style="display:flex;gap:6px;">
            <button class="ghost" data-restore-trash="${item.id}">Wiederherstellen</button>
            <button class="ghost" data-purge-trash="${item.id}" style="color:#ff5252;">Endgültig löschen</button>
          </span>
        </div>
      `).join('');
      panel.querySelectorAll('[data-restore-trash]').forEach(btn => btn.onclick = async () => {
        try {
          await api(`/api/trash/${btn.dataset.restoreTrash}/restore`, { method: 'POST' });
          notice('Wiederhergestellt.');
          await renderTrash();
          if (typeof load === 'function') await load();
        } catch (err) { notice(`Fehler: ${err.message}`); }
      });
      panel.querySelectorAll('[data-purge-trash]').forEach(btn => btn.onclick = async () => {
        if (!confirm('Endgültig löschen? Das kann NICHT mehr rückgängig gemacht werden.')) return;
        try {
          await api(`/api/trash/${btn.dataset.purgeTrash}`, { method: 'DELETE' });
          notice('Endgültig gelöscht.');
          await renderTrash();
        } catch (err) { notice(`Fehler: ${err.message}`); }
      });
    } catch (err) {
      panel.innerHTML = `<p class="upload-note">Papierkorb konnte nicht geladen werden: ${esc(err.message)}</p>`;
    }
  }

  async function aiSettings() {
    const saved = await api('/api/settings/providers'); const by = new Map(saved.providers.map(x => [x.provider, x]));
    showModal(`<h3>KI-Anbieter einrichten</h3><form><p class="upload-note">Der Schlüssel wird nur für deinen Benutzer verschlüsselt abgelegt. Für den Auto-Modus reicht Gemini oder DeepSeek.</p><label>Anbieter<select name="provider"><option value="deepseek">DeepSeek</option><option value="gemini">Google Gemini</option><option value="openai">OpenAI</option></select></label><label>Modell (optional)<input name="model" placeholder="deepseek-chat"></label><label>API-Schlüssel<input name="key" type="password" required autocomplete="off" placeholder="wird nie wieder angezeigt"></label><p class="story">DeepSeek: ${by.get('deepseek')?.configured?'✅ eingerichtet':'noch nicht eingerichtet'} · Gemini: ${by.get('gemini')?.configured?'✅ eingerichtet':'noch nicht eingerichtet'} · OpenAI: ${by.get('openai')?.configured?'✅ eingerichtet':'nicht eingerichtet'}</p><p id="modal-error" class="error"></p><button class="form-button">Sicher speichern</button></form>`, async form => {
      const values = Object.fromEntries(new FormData(form)); await api(`/api/settings/providers/${values.provider}`, {method:'PUT', body:JSON.stringify(values)});
      notice(`${values.provider === 'deepseek' ? 'DeepSeek' : values.provider} ist für deinen Benutzer eingerichtet.`); renderSettings();
    });
    const provider=$('#modal [name=provider]'),model=$('#modal [name=model]');const sync=()=>{const defaults={gemini:'gemini-2.5-flash',openai:'gpt-4.1-mini',deepseek:'deepseek-chat'};model.placeholder=defaults[provider.value];model.value=by.get(provider.value)?.model||''};provider.onchange=sync;sync();
  }

  async function autoPlan() {
    const editor = $('#story-editor'); const story = editor?.value || '';
    if (story.trim().length < 30) return notice('Schreibe zuerst ein paar Sätze zur Handlung.');
    const style = data?.selected?.project?.style_profile || ''; const refs=(data?.selected?.assets||[]).filter(a=>a.url);
    const referencePicker=refs.length?`<div class="style-reference-picker"><b>Visuelle Referenzen für alle Shots</b><small>Standardmässig sind alle vorhandenen Figuren/Orte ausgewählt. Einzelne Fotos werden ohnehin automatisch pro Szene zugeordnet — diese Auswahl gibt der KI zusätzlich verbindliche Beschreibungen mit.</small><button type="button" class="ghost" id="toggle-all-refs" style="margin:6px 0;">Alle abwählen</button>${refs.map(a=>`<label class="check-row"><input type="checkbox" name="styleReferenceIds" value="${a.id}" checked>${a.url?`<img src="${a.url}" alt="">`:''}<span>${esc(a.name)}</span></label>`).join('')}</div>`:'<p class="upload-note">Noch keine Referenzbilder in dieser Episode. Du kannst sie zuerst unter „Besetzung & Welten“ hochladen.</p>';

    showModal(`<h3>Auto-Modus · Vorprüfung</h3><form><p class="upload-note">Die KI erstellt zunächst nur einen editierbaren Produktionsplan: Szenen, Figuren, Orte, Dialoge und Stimmvorschläge. Erst dein Render-Befehl startet Medienjobs.</p><label>Anbieter<select name="provider"><option value="deepseek">DeepSeek (Empfohlen)</option><option value="gemini">Google Gemini</option><option value="openai">OpenAI</option></select></label><div class="shot-modal-grid"><label>Gewünschte Dauer<input name="targetSeconds" type="number" min="15" max="900" value="300"><small>Sekunden · maximal 15 Minuten</small></label><label>Bearbeitung<select name="adaptationMode"><option value="cinematic">Filmisch ausbauen</option><option value="faithful">Werkgetreu verdichten</option></select></label></div><div class="shot-modal-grid"><label>Sprachregie<select name="audioMode"><option value="narrator_and_characters">Erzähler + Figuren</option><option value="narrator_only">Nur Erzähler</option><option value="characters_only">Nur Figuren</option></select><small>Figuren erhalten aus der Story einen editierbaren Stimmvorschlag.</small></label><label>Erzähler-Stimmprofil<input name="narratorVoice" placeholder="z. B. warm, ruhig, erzählerisch, Deutsch"><small>Leer = neutrale deutsche Erzählerstimme.</small></label></div><label>Stil-Grundlage<select name="stylePreset"><option value="custom">Eigene Stilbeschreibung</option><option value="noir">Düsterer Ink-Noir-Comic</option><option value="cinema">Realistischer Kinofilm</option><option value="graphic">Kontrastreicher Graphic Novel</option><option value="anime">Dynamische Anime-Inszenierung</option></select></label><label>Style Bible<textarea name="styleProfile" placeholder="Zeichenmedium, Farbwelt, Licht, Texturen, Epoche, Objektive, Bewegungsregeln und was vermieden werden soll">${esc(style)}</textarea></label>${referencePicker}<label>Modell (optional)<input name="model" placeholder="deepseek-chat"></label><p id="modal-error" class="error"></p><button class="form-button" id="modal-submit-btn">Geschichte prüfen</button></form>`, async form => {
      const submit=form.querySelector('#modal-submit-btn');
      const errEl = form.querySelector('#modal-error');
      if (errEl) errEl.textContent = '';
      submit.disabled=true;
      submit.innerHTML='<span class="pulse" style="display:inline-block;width:8px;height:8px;margin-right:6px;"></span> 1/2 Story wird von KI analysiert...';
      try {
        await api(`/api/episodes/${currentEpisode}/story`,{method:'PUT',body:JSON.stringify({markdown:story})});
        const values=Object.fromEntries(new FormData(form));
        await api(`/api/episodes/${currentEpisode}/audio-settings`, { method:'PUT', body:JSON.stringify({ mode:values.audioMode, narratorVoice:values.narratorVoice, language:'German' }) });
        values.styleReferenceIds=[...form.querySelectorAll('[name=styleReferenceIds]:checked')].map(x=>Number(x.value));
        const result=await api(`/api/episodes/${currentEpisode}/auto-assess`,{method:'POST',body:JSON.stringify(values)});
        setTimeout(()=>showAssessment(result),0);
      } catch (err) {
        submit.disabled = false;
        submit.textContent = 'Geschichte prüfen';
        if (errEl) errEl.textContent = `Fehler bei der KI-Analyse: ${err.message}`;
        notice(`Fehler: ${err.message}`);
      }
    });

    const toggleRefs=$('#toggle-all-refs');
    if (toggleRefs) toggleRefs.onclick = () => {
      const boxes=[...document.querySelectorAll('#modal [name=styleReferenceIds]')];
      const allChecked=boxes.every(b=>b.checked);
      boxes.forEach(b=>b.checked=!allChecked);
      toggleRefs.textContent=allChecked?'Alle auswählen':'Alle abwählen';
    };
    const provider=$('#modal [name=provider]'),model=$('#modal [name=model]'),preset=$('#modal [name=stylePreset]'),styleBox=$('#modal [name=styleProfile]');
    provider.onchange=()=>{model.placeholder={gemini:'gemini-2.5-flash',openai:'gpt-4.1-mini',deepseek:'deepseek-chat'}[provider.value]};
    preset.onchange=()=>{const presets={noir:'Original adult supernatural ink-noir comic. Dense hand-drawn black crosshatching, crushed charcoal shadows, restrained blood-red accents, wet reflective environments, printed halftone texture, dramatic negative space. Cinematic 16:9 composition, strong silhouettes, consistent anatomy and costumes. No white backgrounds, no glossy 3D look, no typography, logos or watermarks.',cinema:'Grounded cinematic realism, natural skin and materials, controlled practical lighting, subtle film grain, consistent production design, 16:9 framing, realistic camera inertia and physical motion. No plastic CGI look, no text, logos or watermarks.',graphic:'Original high-contrast graphic novel illustration, bold brush inks, angular shadows, limited color palette, tactile paper grain, expressive perspective, consistent character model sheets, cinematic widescreen staging. No photorealism, no 3D render, no text or logos.',anime:'Original mature animated action style, clean expressive linework, controlled cel shading, dramatic perspective, readable silhouettes, consistent character proportions, purposeful speed lines only during action, cinematic 16:9 staging. No text, logos or watermarks.'};if(presets[preset.value])styleBox.value=presets[preset.value]};
  }

  function showFailure(error){console.error('FrameCut Auto-Mode:',error);notice(`Auto-Modus konnte nicht geöffnet werden: ${error?.message||'Unbekannter Fehler.'}`)}

  function showAssessment(result){
    const a=result.analysis,requested=result.requestedSeconds,recommended=Math.round(a.recommendedSeconds),same=Math.abs(recommended-requested)<15;
    showModal(`<h3>Analyse abgeschlossen</h3><form><div class="assessment ${a.feasible?'is-good':'is-warning'}"><span>${a.feasible?'GESCHICHTE TRÄGT':'LAUFZEIT ANPASSEN'}</span><b>${Math.floor(recommended/60)}:${String(recommended%60).padStart(2,'0')} empfohlen</b><p>${esc(a.reason||'Die Geschichte lässt sich in dieser Laufzeit sinnvoll strukturieren.')}</p></div><div class="assessment-grid"><div><b>${a.wordCount.toLocaleString('de-CH')}</b><small>Wörter</small></div><div><b>${a.assets.length}</b><small>Elemente erkannt</small></div><div><b>${a.scenes.length}</b><small>Szenen erkannt</small></div><div><b>ca. ${result.estimatedCalls}</b><small>KI-Schritte</small></div></div><label>Zu verwendende Laufzeit<select name="durationChoice"><option value="recommended">Empfehlung · ${recommended} Sekunden</option>${same?'':`<option value="requested">Trotzdem Wunsch · ${requested} Sekunden</option>`}</select></label><div class="scene-preview">${a.scenes.slice(0,12).map((s,i)=>`<div><span>${String(i+1).padStart(2,'0')}</span><b>${esc(s.title)}</b><small>${esc(s.summary)}</small></div>`).join('')}${a.scenes.length>12?`<p>+ ${a.scenes.length-12} weitere Szenen</p>`:''}</div>${(data?.selected?.shots||[]).length ? `<label class="check-row" style="flex-direction:row;align-items:center;gap:8px;background:rgba(255,82,82,0.08);padding:10px;border-radius:8px;border:1px solid rgba(255,82,82,0.25);">
<input name="replaceExisting" type="checkbox" style="width:auto;">
<span>Bestehende ${(data.selected.shots||[]).length} Shots dieser Episode ERSETZEN statt anhängen (bereits gerenderte Videos gehen als Zuordnung verloren, Dateien bleiben aber auf der Platte)</span>
</label>` : ''}
<p class="upload-note">Beim Übernehmen erzeugt die KI abschnittsweise die Szenen und Shots. Das kann je nach Länge 1–2 Minuten dauern. Bitte Fenster geöffnet lassen.</p><p id="modal-error" class="error"></p><button class="form-button" id="modal-commit-btn">Produktionsplan übernehmen & Shots generieren</button></form>`,async form=>{
      const replaceExisting = form.elements.replaceExisting?.checked === true;
      if (replaceExisting && !confirm('Wirklich alle bestehenden Shots dieser Episode ersetzen? Das kann nicht rückgängig gemacht werden.')) return;
      const submit=form.querySelector('#modal-commit-btn');
      const errEl = form.querySelector('#modal-error');
      if (errEl) errEl.textContent = '';
      submit.disabled=true;
      submit.innerHTML='<span class="pulse" style="display:inline-block;width:8px;height:8px;margin-right:6px;"></span> 2/2 Shots & Szenen werden angelegt (bitte warten)...';
      try {
        const useRequested=form.elements.durationChoice.value==='requested';
        const plan=await api(`/api/auto-plans/${result.draftId}/commit`,{method:'POST',body:JSON.stringify({useRequested,replaceExisting})});
        closeModal();
        await load();
        openView('shots');
        notice(`Produktionsplan erfolgreich erstellt: ${plan.createdAssets} neue Elemente und ${plan.createdShots} editierbare Shots angelegt!`);
      } catch (err) {
        submit.disabled = false;
        submit.textContent = 'Produktionsplan übernehmen & Shots generieren';
        if (errEl) errEl.textContent = `Fehler beim Anlegen des Plans: ${err.message}`;
        notice(`Fehler: ${err.message}`);
      }
    });
  }

  window.triggerAutoPlan = () => autoPlan().catch(showFailure);

  document.addEventListener('click', event => {
    const nav = event.target.closest('.nav[data-view="settings"]'); if (!nav) return;
    event.preventDefault(); document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x === nav)); document.querySelectorAll('.view').forEach(x => x.classList.toggle('hidden', x.id !== 'view-settings')); renderSettings();
  }, true);
  new MutationObserver(()=>{decorateStory();decorateOverview()}).observe(document.body, {childList:true, subtree:true});
  decorateStory();decorateOverview();
})();
