// Keys stay on the server. The initial integration deliberately permits only
// the free plan: no top-ups, automatic purchases, or paid-plan overages.
const BASE='https://api.elevenlabs.io';
export class SpeechProviderError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
export function speechSettings(value={}) {
  const voices={};
  for(const [id,voice] of Object.entries(value.voices||{})) {
    if(!/^(narrator|\d+)$/.test(id)) throw new Error('Ungültige Figuren-ID.');
    if(voice && !/^[A-Za-z0-9_-]{5,100}$/.test(String(voice))) throw new Error('Ungültige ElevenLabs Voice-ID.');
    if(voice) voices[id]=String(voice);
  }
  return {provider:value.provider==='elevenlabs'?'elevenlabs':'local',fallbackOnQuota:value.fallbackOnQuota===true,model:'eleven_multilingual_v2',voices};
}
async function request(key,path,options={},fetcher=fetch) {
  let response;
  try {response=await fetcher(BASE+path,{...options,headers:{'xi-api-key':key,...options.headers},signal:AbortSignal.timeout(90000)});}
  catch {throw new SpeechProviderError('network','ElevenLabs nicht erreichbar. Kein automatischer Wechsel und keine erneute kostenpflichtige Anfrage.');}
  if(!response.ok){
    let detail={};try{detail=await response.json();}catch{}
    const code=String(detail?.detail?.status||'');
    if(code==='quota_exceeded')throw new SpeechProviderError('quota','ElevenLabs-Kontingent aufgebraucht.');
    throw new SpeechProviderError('provider',`ElevenLabs-Anfrage abgewiesen (${response.status}). Schlüssel, Berechtigungen und Voice-ID prüfen.`);
  }
  return response;
}
export async function elevenQuota(key,fetcher=fetch){
  const sub=await (await request(key,'/v1/user/subscription',{},fetcher)).json();
  if(!Number.isFinite(sub.character_count)||!Number.isFinite(sub.character_limit))throw new SpeechProviderError('quota_unknown','ElevenLabs-Kontingent nicht prüfbar.');
  return {tier:sub.tier,remaining:Math.max(0,sub.character_limit-sub.character_count),limit:sub.character_limit,used:sub.character_count,resetAt:sub.next_character_count_reset_unix||null};
}
export async function elevenVoices(key,fetcher=fetch){
  const data=await(await request(key,'/v1/voices',{},fetcher)).json();
  return (data.voices||[]).map(v=>({id:v.voice_id,name:v.name,labels:v.labels||{}}));
}
export async function elevenSpeech({key,text,voiceId,performance=''},fetcher=fetch){
  if(!/^[A-Za-z0-9_-]{5,100}$/.test(String(voiceId||'')))throw new SpeechProviderError('voice','Bitte eine feste ElevenLabs-Stimme für diese Figur hinterlegen.');
  if(!text?.trim()||text.length>2500)throw new SpeechProviderError('text','Dialog muss zwischen 1 und 2500 Zeichen enthalten.');
  const quota=await elevenQuota(key,fetcher);
  if(quota.tier!=='free')throw new SpeechProviderError('paid_plan','Dieser Test unterstützt nur ElevenLabs Free, damit keine Zusatzkosten entstehen.');
  if([...text].length>quota.remaining)throw new SpeechProviderError('quota','ElevenLabs-Kontingent reicht für diese Zeile nicht.');
  const expressive=/panik|hekt|aufgeregt|angry|excited|schrei|wüt/i.test(performance);
  const response=await request(key,`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({text,model_id:'eleven_multilingual_v2',voice_settings:{stability:expressive?0.35:0.5,similarity_boost:0.75,style:expressive?0.35:0.15,use_speaker_boost:true}})
  },fetcher);
  if(!/audio\//i.test(response.headers.get('content-type')||''))throw new SpeechProviderError('audio','ElevenLabs lieferte keine Audiodatei.');
  const audio=Buffer.from(await response.arrayBuffer());
  if(audio.length<128)throw new SpeechProviderError('audio','ElevenLabs-Audiodatei ist leer oder ungültig.');
  return audio;
}
