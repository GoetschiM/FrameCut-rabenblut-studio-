/* Settings information architecture; existing forms retain their handlers. */
window.FrameCutSettings = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function organize(view) {
    const original=[...view.children];
    const groups=[['speech','Stimmen & Sprache'],['ai','KI & Schlüssel'],['project','Projekt & Bildqualität'],['workers','Worker & Produktion'],['usage','Verbrauch'],['advanced','KI-Anweisungen'],['storage','Archiv & Papierkorb']];
    view.classList.add('settings-organized');
    const header=document.createElement('header');header.className='settings-heading';header.innerHTML='<h2>Einstellungen</h2><p>Wähle einen Bereich. Schlüssel und Stimmen gehören zu deinem Konto; Bildqualität gehört zum ausgewählten Projekt.</p>';
    const nav=document.createElement('nav');nav.className='settings-nav';nav.setAttribute('aria-label','Einstellungsbereiche');
    const body=document.createElement('div');body.className='settings-body';
    const pages=new Map(groups.map(([id,label])=>{const page=document.createElement('section');page.id='settings-page-'+id;page.dataset.settingsPage=id;page.setAttribute('aria-label',label);page.hidden=true;body.append(page);const btn=document.createElement('button');btn.type='button';btn.textContent=label;btn.dataset.settingsTarget=id;btn.setAttribute('aria-controls',page.id);nav.append(btn);return[id,page];}));
    const speech=pages.get('speech');speech.innerHTML='<h3>Stimmen & Sprache</h3><p class="upload-note">Eine feste Stimme pro Figur, unabhängig vom Projektstil.</p><div id="speech-settings-panel" aria-live="polite">Stimmeinstellungen werden geladen …</div>';
    let group='ai';
    for(const node of original){
      if(node.classList.contains('section-lead')){
        const title=node.querySelector('h3')?.textContent||'';
        group=title.includes('GPU-Worker')?'workers':title.includes('geschätzte Kosten')?'usage':title==='KI-Prompts'?'advanced':title==='Render-Einstellungen'?'project':/Verwaltung|Papierkorb/.test(title)?'storage':'ai';
        node.querySelectorAll('.eyebrow').forEach(el=>el.remove());
        node.style.removeProperty('margin-top');
      }
      pages.get(group).append(node);
    }
    document.querySelector('#manage-speech')?.remove();
    const status=document.querySelector('#production-rebuild-status');if(status)pages.get('workers').prepend(status);
    if(!pages.get('project').children.length)pages.get('project').innerHTML='<h3>Projekt & Bildqualität</h3><p>Wähle zuerst ein Projekt in der Projektübersicht.</p>';
    view.prepend(header,nav,body);
    function show(id){if(!pages.has(id))id='speech';for(const [key,page]of pages)page.hidden=key!==id;for(const button of nav.children){if(button.dataset.settingsTarget===id)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}try{sessionStorage.setItem('framecut.settings.page',id);}catch{}}
    nav.onclick=event=>{const button=event.target.closest('[data-settings-target]');if(button)show(button.dataset.settingsTarget);};
    let last='speech';try{last=sessionStorage.getItem('framecut.settings.page')||last;}catch{}show(last);
  }
  function matchesVoice(voice,filter,query='') {
    const language=String(voice.labels?.language||'').toLowerCase(),accent=String(voice.labels?.accent||'').toLowerCase();
    const german=/^(de|de[-_].*|german|deutsch)$/.test(language);
    const swiss=/swiss|schweiz|schwyz|schwiiz|helvet|^ch$/.test(accent)||/^de[-_]ch$/.test(language);
    return (filter==='all'||filter==='de'&&german||filter==='ch'&&german&&swiss)&&`${voice.name} ${Object.values(voice.labels||{}).join(' ')}`.toLowerCase().includes(query.toLowerCase().trim());
  }
  function voiceLabel(v){const l=v.labels||{};const lang=l.language==='de'?'Deutsch':l.language==='en'?'Englisch':l.language||'Sprache nicht angegeben';return `${v.name} · ${lang}${l.accent?' · '+l.accent:''}${l.age?' · '+l.age:''}`;}
  return {organize,matchesVoice,voiceLabel,esc};
})();
