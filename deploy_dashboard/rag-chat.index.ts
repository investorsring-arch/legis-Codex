// Fonction « rag-chat » — version en un seul fichier (Supabase > Edge Functions > Via Editor). Verify JWT : désactivé.

// ../../home/claude/rag-site/supabase/functions/rag-chat/index.ts
import { createClient } from "npm:@supabase/supabase-js@2";

// ../../home/claude/rag-site/supabase/functions/_shared/auth.ts
var enc = new TextEncoder();
var corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-admin-token, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmacKey() {
  const secret = Deno.env.get("SESSION_SECRET");
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET manquant ou trop court (32 caract\xE8res minimum)");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function verifySession(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(), b64urlDecode(sig), enc.encode(`${header}.${body}`));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1e3)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ../../home/claude/rag-site/supabase/functions/_shared/rag.ts
var env = (k, d = "") => Deno.env.get(k) ?? d;
var DEFAULT_PROMPT = `Tu es l'assistant documentaire priv\xE9 de ce site.
R\xE9ponds UNIQUEMENT \xE0 partir des extraits fournis dans <contexte>. Cite tes sources avec leur num\xE9ro entre crochets, ex. [1] ou [2][3].
Si les extraits ne permettent pas de r\xE9pondre, dis-le clairement et indique quelle information manque ; n'invente rien.
Sois pr\xE9cis, structur\xE9 et professionnel (Markdown autoris\xE9 : titres courts, listes, tableaux). Cite les r\xE9f\xE9rences exactes (articles, num\xE9ros de textes) lorsqu'elles figurent dans les extraits.`;
function defaults() {
  const provider = env("LLM_PROVIDER", "anthropic") === "openai" ? "openai" : "anthropic";
  return {
    system_prompt: env("SYSTEM_PROMPT", DEFAULT_PROMPT),
    answer_language: "auto",
    llm_provider: provider,
    llm_model: env("LLM_MODEL", provider === "anthropic" ? "claude-sonnet-5-5" : "gpt-4.1-mini"),
    temperature: 0.2,
    max_tokens: 1500,
    rewrite_query: true,
    hybrid_search: true,
    match_function: env("MATCH_FUNCTION", "match_documents"),
    match_count: Number(env("MATCH_COUNT", "6")),
    match_threshold: env("MATCH_THRESHOLD") ? Number(env("MATCH_THRESHOLD")) : null,
    match_extra_params: env("MATCH_EXTRA_PARAMS", ""),
    embedding_model: env("EMBEDDING_MODEL", "text-embedding-3-small"),
    embedding_dimensions: env("EMBEDDING_DIMENSIONS") ? Number(env("EMBEDDING_DIMENSIONS")) : null,
    suggestions: []
  };
}
async function loadSettings(sb) {
  const { data } = await sb.from("rag_settings").select("settings").eq("id", 1).maybeSingle();
  return { ...defaults(), ...data?.settings ?? {} };
}
async function embedMany(texts, s) {
  const out = [];
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96);
    const res = await fetch(env("EMBEDDING_API_URL", "https://api.openai.com/v1/embeddings"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("EMBEDDING_API_KEY", env("OPENAI_API_KEY"))}` },
      body: JSON.stringify({ model: s.embedding_model, input: batch, ...s.embedding_dimensions ? { dimensions: s.embedding_dimensions } : {} })
    });
    if (!res.ok) throw new Error(`Embedding ${res.status} : ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    data.data.sort((a, b) => a.index - b.index).forEach((d) => out.push(d.embedding));
  }
  return out;
}
async function embed(text, s) {
  return (await embedMany([text], s))[0];
}
function normalize(r, i) {
  const m = typeof r.metadata === "object" && r.metadata || {};
  const content = String(r.content ?? r.chunk ?? r.text ?? r.page_content ?? r.body ?? "");
  const title = m.title ?? m.source ?? m.file_name ?? m.filename ?? m.document ?? r.title ?? r.source ?? `Document ${i + 1}`;
  return { n: i + 1, title: String(title), url: m.url ?? r.url ?? null, similarity: typeof r.similarity === "number" ? r.similarity : null, content };
}
async function search(sb, query, s) {
  const params = { query_embedding: await embed(query, s), match_count: s.match_count };
  if (s.match_threshold !== null && s.match_threshold !== void 0) params.match_threshold = s.match_threshold;
  if (s.hybrid_search) params.query_text = query;
  if (s.match_extra_params) Object.assign(params, JSON.parse(s.match_extra_params));
  const { data, error } = await sb.rpc(s.match_function, params);
  if (error) throw new Error(`Recherche (${s.match_function}) : ${error.message}`);
  return (data ?? []).map(normalize).filter((x) => x.content.trim()).map((x, i) => ({ ...x, n: i + 1 }));
}
async function callLLM(system, messages, s, maxTokens, temperature) {
  if (s.llm_provider === "anthropic") {
    const res2 = await fetch(env("ANTHROPIC_API_URL", "https://api.anthropic.com/v1/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY", env("LLM_API_KEY")), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: s.llm_model, max_tokens: maxTokens, temperature, system, messages })
    });
    if (!res2.ok) throw new Error(`LLM ${res2.status} : ${(await res2.text()).slice(0, 300)}`);
    const data = await res2.json();
    return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  const res = await fetch(env("OPENAI_API_URL", "https://api.openai.com/v1/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("OPENAI_API_KEY", env("LLM_API_KEY"))}` },
    body: JSON.stringify({ model: s.llm_model, max_tokens: maxTokens, temperature, messages: [{ role: "system", content: system }, ...messages] })
  });
  if (!res.ok) throw new Error(`LLM ${res.status} : ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.filter((h) => (h?.role === "user" || h?.role === "assistant") && typeof h.content === "string").slice(-6).map((h) => ({ role: h.role, content: h.content.slice(0, 3e3) }));
}
async function rewriteQuery(question, history, s) {
  if (!s.rewrite_query || !history.length) return question;
  const convo = history.map((h) => `${h.role === "user" ? "Utilisateur" : "Assistant"} : ${h.content.slice(0, 800)}`).join("\n");
  try {
    const out = await callLLM(
      "Tu reformules la derni\xE8re question de l'utilisateur en une requ\xEAte de recherche documentaire autonome et pr\xE9cise, dans la m\xEAme langue, en int\xE9grant le contexte n\xE9cessaire de la conversation. R\xE9ponds uniquement par la requ\xEAte, sans guillemets ni commentaire.",
      [{ role: "user", content: `Conversation :
${convo}

Derni\xE8re question : ${question}` }],
      s,
      200,
      0
    );
    const q = out.trim().split("\n")[0].slice(0, 500);
    return q || question;
  } catch {
    return question;
  }
}
var LANG = { fr: "fran\xE7ais", en: "anglais", ar: "arabe", es: "espagnol" };
async function answer(question, history, sources, s) {
  const context = sources.length ? sources.map((x) => `[${x.n}] ${x.title}
${x.content.slice(0, 4e3)}`).join("\n\n---\n\n") : "(aucun extrait pertinent trouv\xE9)";
  const lang = s.answer_language === "auto" ? "R\xE9ponds dans la langue de la question." : `R\xE9ponds en ${LANG[s.answer_language]}.`;
  return callLLM(`${s.system_prompt}

${lang}`, [...history, { role: "user", content: `<contexte>
${context}
</contexte>

Question : ${question}` }], s, s.max_tokens, s.temperature);
}

// ../../home/claude/rag-site/supabase/functions/rag-chat/index.ts
var supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
var MAX_QUESTION = 2e3;
var RATE_LIMIT = Number(Deno.env.get("RATE_LIMIT_PER_MIN") ?? "20");
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "M\xE9thode non autoris\xE9e" }, 405);
  const t0 = Date.now();
  const session = await verifySession(req.headers.get("x-admin-token"));
  if (!session) return json({ error: "Veuillez vous connecter." }, 401);
  if (session.role === "admin") {
    const { data } = await supabase.from("rag_admins").select("status").eq("id", session.sub).maybeSingle();
    if (!data || data.status !== "active") return json({ error: "Acc\xE8s r\xE9voqu\xE9." }, 403);
  }
  const userEmail = session.role === "master" ? "admin principal" : session.email ?? session.sub;
  const body = await req.json().catch(() => ({}));
  const question = String(body?.question ?? "").trim();
  if (!question) return json({ error: "Veuillez saisir une question." }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `Question trop longue (${MAX_QUESTION} caract\xE8res max).` }, 400);
  const history = cleanHistory(body.history);
  const { count } = await supabase.from("rag_queries").select("id", { count: "exact", head: true }).eq("user_email", userEmail).gte("created_at", new Date(Date.now() - 6e4).toISOString());
  if ((count ?? 0) >= RATE_LIMIT) return json({ error: "Trop de questions en peu de temps. R\xE9essayez dans une minute." }, 429);
  try {
    const settings = await loadSettings(supabase);
    const searchQuery = await rewriteQuery(question, history, settings);
    const sources = await search(supabase, searchQuery, settings);
    const text = await answer(question, history, sources, settings);
    await supabase.from("rag_queries").insert({
      question,
      search_query: searchQuery !== question ? searchQuery : null,
      answer: text,
      sources_count: sources.length,
      latency_ms: Date.now() - t0,
      user_email: userEmail
    });
    return json({
      answer: text,
      search_query: searchQuery,
      sources: sources.map(({ n, title, url, similarity, content }) => ({ n, title, url, similarity, excerpt: content.slice(0, 400) }))
    });
  } catch (e) {
    console.error(e);
    await supabase.from("rag_queries").insert({
      question,
      latency_ms: Date.now() - t0,
      user_email: userEmail,
      error: String(e.message).slice(0, 1e3)
    });
    return json({ error: "Le service n'a pas pu r\xE9pondre pour le moment. R\xE9essayez plus tard." }, 500);
  }
});
