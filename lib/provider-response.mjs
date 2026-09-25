function providerLabel(provider) {
  return provider === 'gemini' ? 'Gemini' : provider === 'deepseek' ? 'DeepSeek' : 'OpenAI';
}

export function parseProviderHttpResponse(provider, status, contentType, body) {
  const raw = String(body || '').trim();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch {
    const html = /<\s*!doctype\b|<\s*html\b/i.test(raw) || /text\/html/i.test(String(contentType || ''));
    if (html) throw new Error(`${providerLabel(provider)} hat statt einer API-Antwort eine HTML-Seite geliefert (HTTP ${status}). Prüfe API-Schlüssel, Modellname und Netzwerkzugang des FrameCut-Containers.`);
    throw new Error(`${providerLabel(provider)} hat keine lesbare JSON-Antwort geliefert (HTTP ${status}). Bitte erneut versuchen.`);
  }
  if (status < 200 || status >= 300) throw new Error(`KI-Anbieter: ${data?.error?.message || data?.message || `HTTP ${status}`}`);
  return data;
}

export function parseModelJson(provider, content) {
  let text = String(content || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    .replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  try { return JSON.parse(text); } catch {}
  // Some compatible models prepend a short sentence despite JSON mode. Accept
  // one complete JSON object, but never try to invent missing structure.
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  throw new Error(`${providerLabel(provider)} lieferte keinen gültigen Szenenplan. Bitte erneut versuchen oder in Einstellungen ein anderes Modell wählen.`);
}
