const logger = require('./_logger');

// ── AI provider ───────────────────────────────────────────────────────────────
// Uses the OpenAI chat completions standard (/v1/chat/completions).
// To switch provider, update the 4 lines in the AI object below.
//
//   Google Gemini with Google Search grounding — default (finds obscure/non-English songs):
//     format:  'gemini'
//     baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
//     model:   'gemini-3.6-flash'
//     apiKey:  () => process.env.GEMINI_API_KEY
//   Google retires models on a schedule (gemini-2.0-flash shut down 2026-06-01):
//   https://ai.google.dev/gemini-api/docs/deprecations
//
//   Google Gemini knowledge-only (faster, no web search — use if grounding quota runs low):
//     format:  'openai'
//     baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'
//     model:   'gemini-3.6-flash'
//     apiKey:  () => process.env.GEMINI_API_KEY
//
//   Groq (free, fast, Llama):
//     format:  'openai'
//     baseUrl: 'https://api.groq.com/openai/v1'
//     model:   'llama-3.3-70b-versatile'
//     apiKey:  () => process.env.GROQ_API_KEY
//
//   Mistral (free):
//     format:  'openai'
//     baseUrl: 'https://api.mistral.ai/v1'
//     model:   'mistral-small-latest'
//     apiKey:  () => process.env.MISTRAL_API_KEY
//
//   Ollama (local, no key):
//     format:  'openai'
//     baseUrl: 'http://localhost:11434/v1'
//     model:   'llama3.2'
//     apiKey:  () => ''
const AI = {
  format:  'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model:   'gemini-3.6-flash',
  apiKey:  () => process.env.GEMINI_API_KEY,
};
// ─────────────────────────────────────────────────────────────────────────────

function _stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.*?)\*/g, '$1')        // *italic*
    .replace(/^#{1,6}\s+/gm, '')        // ## headings
    .replace(/^---+$/gm, '')            // --- dividers
    .replace(/\[\d+\]/g, '')            // [1] citation indices
    .replace(/\^(\[\d+\]|\d+)\^/g, '') // ^[1]^ or ^1^ superscript citations
    .replace(/\(https?:\/\/[^)]*\)/g, '') // (https://...) inline links
    .trim();
}

// language: ISO code ('FR', 'DE', 'EN', …) 
// genre:    string ('FOLK', 'SCHLAGER', …)
// Returns { lyrics: string } on success, { lyrics: null, skipped: true } when the
// AI provider is unavailable (no key / quota exceeded), or { lyrics: null } on miss.
async function suggestLyricsWithAI(title, artist, { language, genre } = {}) {
  const apiKey = AI.apiKey();
  if (!apiKey) {
    await logger.warn('ai_no_api_key', { format: AI.format, model: AI.model });
    return { lyrics: null, skipped: true };
  }

  const genreHint = genre ? `, a ${genre.toLowerCase()} song` : '';
  // "in their original language" prevents the AI from returning an English translation
  // of a French/German/Cajun song. Explicit code beats the generic instruction.
  const langInst = language === 'FR' ? ' Return the lyrics in French.'
                 : language === 'DE' ? ' Return the lyrics in German.'
                 : ' Return the lyrics in their original language.';
  const prompt =
    `Return the complete lyrics for "${title}" by "${artist}"${genreHint}.` +
    `${langInst} Output only the raw lyrics text — no introduction, no markdown, no explanations.`;

  let res;
  try {
    if (AI.format === 'gemini') {
      // Key in a header, not the URL: URLs end up in proxy and access logs.
      res = await fetch(`${AI.baseUrl}/models/${AI.model}:generateContent`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          tools:            [{ google_search: {} }],
          // Thinking tokens count against maxOutputTokens: keep thinking low and
          // leave room for a full song after it.
          generationConfig: { maxOutputTokens: 4000, thinkingConfig: { thinkingLevel: 'low' } },
        }),
        signal: AbortSignal.timeout(20000),
      });
    } else {
      res = await fetch(`${AI.baseUrl}/chat/completions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model:      AI.model,
          messages:   [{ role: 'user', content: prompt }],
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(15000),
      });
    }
  } catch (e) {
    await logger.warn('ai_fetch_error', { format: AI.format, model: AI.model, error: e.message });
    return { lyrics: null };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 429 = quota exhausted — treat as skipped so callers can distinguish
    // "AI tried and found nothing" from "AI never ran"
    const skipped = res.status === 429;
    await logger.warn('ai_response_error', { format: AI.format, model: AI.model, status: res.status, skipped, body: body.slice(0, 300) });
    return { lyrics: null, skipped };
  }

  const json = await res.json();
  const text = AI.format === 'gemini'
    ? json.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? null
    : json.choices?.[0]?.message?.content ?? null;

  if (!text) return { lyrics: null };
  const cleaned = _stripMarkdown(text);
  return { lyrics: cleaned.length > 50 ? cleaned : null };
}

module.exports = { suggestLyricsWithAI };
