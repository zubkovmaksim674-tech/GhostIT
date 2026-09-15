function normalizeBaseUrl(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) throw new Error('Не указан Base URL API');
  return clean;
}

function buildMessages(systemPrompt, history, question) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const item of history.slice(-8)) messages.push(item);
  messages.push({ role: 'user', content: question });
  return messages;
}

async function streamAnswer(options, handlers) {
  const {
    baseUrl, apiKey, model, temperature, maxTokens, systemPrompt, history, question, signal
  } = options;
  const { onDelta, onDone } = handlers;

  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: buildMessages(systemPrompt, history, question),
    temperature,
    max_tokens: maxTokens,
    stream: true
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 400); } catch {}
    throw new Error(`API ответил ${res.status}. ${detail}`);
  }

  if (!res.body || !res.body.getReader) {
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    if (text) onDelta(text);
    onDone(text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {}
    }
  }

  onDone(full);
  return full;
}

module.exports = { streamAnswer };
