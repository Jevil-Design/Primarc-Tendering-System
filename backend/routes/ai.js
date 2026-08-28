import { requirePerm, MODULE } from '../permissions.js';
import { errors } from '../lib/response.js';
import { validate } from '../validation.js';
import { logAudit } from '../audit.js';
import { nowIso } from '../lib/util.js';

/* ═══════════════════════════════════════════════════════════════
   Server-side proxy for BOQ description AI-enhance.

   One org-wide key lives in ai_provider_config (see migration 019), set
   once by an admin. POST /ai/call is the only thing that ever reads it —
   it never appears in a response body, GET, or audit log entry. Every
   other authenticated user just calls /ai/call; they never see the key.

   Mirrors the three provider shapes the client used to call directly
   (Tendering System.html's AI.call) so prompt-building/parsing on the
   client didn't need to change, only where the network call goes.
   ═══════════════════════════════════════════════════════════════ */

const CONFIG_ID = 'default';

const PROVIDER_DETECT = {
  gemini:     (k) => /^AIza[\w-]{30,}$/.test(k),
  groq:       (k) => k.startsWith('gsk_'),
  openrouter: (k) => k.startsWith('sk-or-'),
  anthropic:  (k) => k.startsWith('sk-ant-'),
  openai:     (k) => k.startsWith('sk-') && !k.startsWith('sk-or-') && !k.startsWith('sk-ant-'),
  mistral:    (k) => /^[A-Za-z0-9]{32}$/.test(k),
};

const PROVIDER_BASE_URL = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
};

export default function register(router) {
  router.get('/ai/config', async (ctx) => {
    if (!ctx.user) throw errors.unauthorized();
    const row = await ctx.env.DB.prepare(
      'select provider, model from ai_provider_config where id = ?'
    ).bind(CONFIG_ID).first();
    return { configured: !!row, provider: row?.provider || null, model: row?.model || null };
  });

  router.post('/ai/config', async (ctx) => {
    requirePerm(ctx, MODULE.SETTINGS, 'edit');
    const v = validate(ctx.body)
      .string('provider', { required: true, max: 40 })
      .string('model', { required: true, max: 120 })
      .string('key', { max: 300 }).done();   // omitted = model-only change, keep the existing key

    let key = v.key;
    if (!key) {
      const existing = await ctx.env.DB.prepare(
        'select provider, api_key from ai_provider_config where id = ?'
      ).bind(CONFIG_ID).first();
      if (!existing || existing.provider !== v.provider) {
        throw errors.validation('An API key is required.', { key: 'This field is required.' });
      }
      key = existing.api_key;
    } else {
      const detect = PROVIDER_DETECT[v.provider];
      if (!detect) throw errors.validation('Unknown provider.', { provider: 'Choose a supported provider.' });
      if (!detect(key)) {
        throw errors.validation('That key does not look like a valid key for this provider.', { key: 'Check the key format.' });
      }
    }

    await ctx.env.DB.prepare(
      `insert into ai_provider_config (id, provider, model, api_key, updated_by, updated_at)
       values (?,?,?,?,?,?)
       on conflict(id) do update set provider = excluded.provider, model = excluded.model,
         api_key = excluded.api_key, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(CONFIG_ID, v.provider, v.model, key, ctx.user.id, nowIso()).run();

    // Never put the key in the audit trail -- provider/model only.
    await logAudit(ctx, { module: 'Settings', action: 'update_ai_config', entityType: 'ai_provider_config', target: v.provider });
    return { ok: true, provider: v.provider, model: v.model };
  });

  router.delete('/ai/config', async (ctx) => {
    requirePerm(ctx, MODULE.SETTINGS, 'edit');
    await ctx.env.DB.prepare('delete from ai_provider_config where id = ?').bind(CONFIG_ID).run();
    await logAudit(ctx, { module: 'Settings', action: 'remove_ai_config', entityType: 'ai_provider_config', target: CONFIG_ID });
    return { ok: true };
  });

  router.post('/ai/call', async (ctx) => {
    if (!ctx.user) throw errors.unauthorized();
    const v = validate(ctx.body).string('prompt', { required: true, max: 20000 }).done();
    const maxTokens = Math.min(Math.max(Number(ctx.body?.maxTokens) || 1000, 1), 4000);

    const cfg = await ctx.env.DB.prepare(
      'select provider, model, api_key from ai_provider_config where id = ?'
    ).bind(CONFIG_ID).first();
    if (!cfg) throw errors.validation('No AI provider is configured. Ask an administrator to set one up in Settings.');

    const { provider, model, api_key: key } = cfg;
    let rawText = '';

    if (provider === 'gemini') {
      let res;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: v.prompt }] }],
              generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
            }),
          }
        );
      } catch {
        // Caught here (not left to the router's generic handler) so a network-level
        // failure can never put the key-bearing URL into an error log.
        throw errors.validation('Could not reach Gemini. Please try again.');
      }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw errors.validation(e.error?.message || `Gemini ${res.status}`); }
      const d = await res.json();
      rawText = (d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    } else if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: v.prompt }] }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw errors.validation(e.error?.message || `Anthropic ${res.status}`); }
      const d = await res.json();
      rawText = (d.content?.[0]?.text || '').trim();
    } else {
      // OpenAI-compatible: OpenAI, Groq, OpenRouter, Mistral.
      const baseURL = PROVIDER_BASE_URL[provider];
      if (!baseURL) throw errors.validation('The configured AI provider is not recognised.');
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
      if (provider === 'openrouter') {
        headers['HTTP-Referer'] = (ctx.env.ALLOWED_ORIGINS || '').split(',')[0].trim() || 'https://vercel.app';
        headers['X-Title'] = 'BOQ Builder';
      }
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST', headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: v.prompt }], max_tokens: maxTokens, temperature: 0.3 }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw errors.validation(e.error?.message || `${provider} ${res.status}`); }
      const d = await res.json();
      rawText = (d.choices?.[0]?.message?.content || '').trim();
    }

    const clean = rawText.replace(/```json|```/g, '').trim();
    let result; try { result = JSON.parse(clean); } catch { result = { text: rawText }; }
    return { result };
  });
}
