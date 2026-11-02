// Moteur de l'assistant : réglages (table rag_settings, modifiables depuis le tableau de bord),
// reformulation de la question, recherche vectorielle, rédaction de la réponse par le LLM.
// Les CLÉS d'API restent dans les secrets Supabase (.env.local), jamais en base.

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

export type Settings = {
  system_prompt: string;
  answer_language: "auto" | "fr" | "en" | "ar" | "es";
  llm_provider: "anthropic" | "openai";
  llm_model: string;
  temperature: number;
  max_tokens: number;
  rewrite_query: boolean;
  hybrid_search: boolean;
  match_function: string;
  match_count: number;
  match_threshold: number | null;
  match_extra_params: string;     // JSON
  embedding_model: string;
  embedding_dimensions: number | null;
  suggestions: string[];
};

export const DEFAULT_PROMPT = `Tu es l'assistant documentaire privé de ce site.
Réponds UNIQUEMENT à partir des extraits fournis dans <contexte>. Cite tes sources avec leur numéro entre crochets, ex. [1] ou [2][3].
Si les extraits ne permettent pas de répondre, dis-le clairement et indique quelle information manque ; n'invente rien.
Sois précis, structuré et professionnel (Markdown autorisé : titres courts, listes, tableaux). Cite les références exactes (articles, numéros de textes) lorsqu'elles figurent dans les extraits.`;

export function defaults(): Settings {
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
    suggestions: [],
  };
}

const clamp = (n: unknown, lo: number, hi: number, d: number) => {
  const v = Number(n); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};

/** Ne garde que les champs connus, correctement typés (entrée venant du tableau de bord). */
export function sanitizeSettings(i: any): Partial<Settings> {
  const d = defaults();
  const out: Partial<Settings> = {};
  if (typeof i.system_prompt === "string") out.system_prompt = i.system_prompt.slice(0, 8000);
  if (["auto", "fr", "en", "ar", "es"].includes(i.answer_language)) out.answer_language = i.answer_language;
  if (i.llm_provider === "anthropic" || i.llm_provider === "openai") out.llm_provider = i.llm_provider;
  if (typeof i.llm_model === "string" && i.llm_model.trim()) out.llm_model = i.llm_model.trim().slice(0, 100);
  if (i.temperature !== undefined) out.temperature = clamp(i.temperature, 0, 1, d.temperature);
  if (i.max_tokens !== undefined) out.max_tokens = Math.round(clamp(i.max_tokens, 200, 8000, d.max_tokens));
  if (typeof i.rewrite_query === "boolean") out.rewrite_query = i.rewrite_query;
  if (typeof i.hybrid_search === "boolean") out.hybrid_search = i.hybrid_search;
  if (typeof i.match_function === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(i.match_function)) out.match_function = i.match_function;
  if (i.match_count !== undefined) out.match_count = Math.round(clamp(i.match_count, 1, 30, d.match_count));
  if (i.match_threshold === null || i.match_threshold === "") out.match_threshold = null;
  else if (i.match_threshold !== undefined) out.match_threshold = clamp(i.match_threshold, 0, 1, 0.5);
  if (typeof i.match_extra_params === "string") {
    const t = i.match_extra_params.trim();
    if (t) { const o = JSON.parse(t); if (typeof o !== "object" || Array.isArray(o)) throw new Error("Paramètres supplémentaires : objet JSON attendu."); }
    out.match_extra_params = t;
  }
  if (typeof i.embedding_model === "string" && i.embedding_model.trim()) out.embedding_model = i.embedding_model.trim();
  if (i.embedding_dimensions === null || i.embedding_dimensions === "") out.embedding_dimensions = null;
  else if (i.embedding_dimensions !== undefined) out.embedding_dimensions = Math.round(clamp(i.embedding_dimensions, 64, 4096, 1536));
  if (Array.isArray(i.suggestions)) out.suggestions = i.suggestions.map(String).map((s: string) => s.trim()).filter(Boolean).slice(0, 8);
  return out;
}

// deno-lint-ignore no-explicit-any
export async function loadSettings(sb: any): Promise<Settings> {
  const { data } = await sb.from("rag_settings").select("settings").eq("id", 1).maybeSingle();
  return { ...defaults(), ...(data?.settings ?? {}) };
}

export function keysStatus() {
  return {
    anthropic: !!(env("ANTHROPIC_API_KEY") || (env("LLM_PROVIDER") !== "openai" && env("LLM_API_KEY"))),
    openai: !!env("OPENAI_API_KEY"),
    embeddings: !!(env("EMBEDDING_API_KEY") || env("OPENAI_API_KEY")),
  };
}

// ---------------------------------------------------------------- Embeddings & recherche

export type Source = { n: number; title: string; url: string | null; similarity: number | null; content: string };

/** Calcule les vecteurs d'une liste de textes (par lots de 96). */
export async function embedMany(texts: string[], s: Settings): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96);
    const res = await fetch(env("EMBEDDING_API_URL", "https://api.openai.com/v1/embeddings"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("EMBEDDING_API_KEY", env("OPENAI_API_KEY"))}` },
      body: JSON.stringify({ model: s.embedding_model, input: batch, ...(s.embedding_dimensions ? { dimensions: s.embedding_dimensions } : {}) }),
    });
    if (!res.ok) throw new Error(`Embedding ${res.status} : ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    data.data.sort((a: any, b: any) => a.index - b.index).forEach((d: any) => out.push(d.embedding));
  }
  return out;
}

async function embed(text: string, s: Settings): Promise<number[]> {
  return (await embedMany([text], s))[0];
}

function normalize(r: any, i: number): Source {
  const m = (typeof r.metadata === "object" && r.metadata) || {};
  const content = String(r.content ?? r.chunk ?? r.text ?? r.page_content ?? r.body ?? "");
  const title = m.title ?? m.source ?? m.file_name ?? m.filename ?? m.document ?? r.title ?? r.source ?? `Document ${i + 1}`;
  return { n: i + 1, title: String(title), url: m.url ?? r.url ?? null, similarity: typeof r.similarity === "number" ? r.similarity : null, content };
}

// deno-lint-ignore no-explicit-any
export async function search(sb: any, query: string, s: Settings): Promise<Source[]> {
  const params: Record<string, unknown> = { query_embedding: await embed(query, s), match_count: s.match_count };
  if (s.match_threshold !== null && s.match_threshold !== undefined) params.match_threshold = s.match_threshold;
  if (s.hybrid_search) params.query_text = query;   // recherche par mots exacts en complément (numéros, articles…)
  if (s.match_extra_params) Object.assign(params, JSON.parse(s.match_extra_params));
  const { data, error } = await sb.rpc(s.match_function, params);
  if (error) throw new Error(`Recherche (${s.match_function}) : ${error.message}`);
  return (data ?? []).map(normalize).filter((x: Source) => x.content.trim()).map((x: Source, i: number) => ({ ...x, n: i + 1 }));
}

// ---------------------------------------------------------------- LLM

type Msg = { role: "user" | "assistant"; content: string };

async function callLLM(system: string, messages: Msg[], s: Settings, maxTokens: number, temperature: number): Promise<string> {
  // Certains modèles récents refusent le paramètre « temperature » : on réessaie alors sans.
  const post = async (url: string, headers: Record<string, string>, body: Record<string, unknown>) => {
    let res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, temperature }) });
    if (res.status === 400) {
      const t = await res.text();
      if (!/temperature/i.test(t)) throw new Error(`LLM 400 : ${t.slice(0, 300)}`);
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    }
    if (!res.ok) throw new Error(`LLM ${res.status} : ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  if (s.llm_provider === "anthropic") {
    const data = await post(env("ANTHROPIC_API_URL", "https://api.anthropic.com/v1/messages"),
      { "Content-Type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY", env("LLM_API_KEY")), "anthropic-version": "2023-06-01" },
      { model: s.llm_model, max_tokens: maxTokens, system, messages });
    return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  }
  const data = await post(env("OPENAI_API_URL", "https://api.openai.com/v1/chat/completions"),
    { "Content-Type": "application/json", Authorization: `Bearer ${env("OPENAI_API_KEY", env("LLM_API_KEY"))}` },
    { model: s.llm_model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, ...messages] });
  return data.choices?.[0]?.message?.content ?? "";
}

export function cleanHistory(history: unknown): Msg[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h: any) => (h?.role === "user" || h?.role === "assistant") && typeof h.content === "string")
    .slice(-6)
    .map((h: any) => ({ role: h.role, content: h.content.slice(0, 3000) }));
}

/** Transforme une question de suivi ("et pour l'export ?") en requête de recherche autonome. */
export async function rewriteQuery(question: string, history: Msg[], s: Settings): Promise<string> {
  if (!s.rewrite_query || !history.length) return question;
  const convo = history.map((h) => `${h.role === "user" ? "Utilisateur" : "Assistant"} : ${h.content.slice(0, 800)}`).join("\n");
  try {
    const out = await callLLM(
      "Tu reformules la dernière question de l'utilisateur en une requête de recherche documentaire autonome et précise, dans la même langue, en intégrant le contexte nécessaire de la conversation. Réponds uniquement par la requête, sans guillemets ni commentaire.",
      [{ role: "user", content: `Conversation :\n${convo}\n\nDernière question : ${question}` }],
      s, 200, 0,
    );
    const q = out.trim().split("\n")[0].slice(0, 500);
    return q || question;
  } catch {
    return question;
  }
}

const LANG: Record<string, string> = { fr: "français", en: "anglais", ar: "arabe", es: "espagnol" };

export async function answer(question: string, history: Msg[], sources: Source[], s: Settings): Promise<string> {
  const context = sources.length
    ? sources.map((x) => `[${x.n}] ${x.title}\n${x.content.slice(0, 4000)}`).join("\n\n---\n\n")
    : "(aucun extrait pertinent trouvé)";
  const lang = s.answer_language === "auto" ? "Réponds dans la langue de la question." : `Réponds en ${LANG[s.answer_language]}.`;
  return callLLM(`${s.system_prompt}\n\n${lang}`, [...history, { role: "user", content: `<contexte>\n${context}\n</contexte>\n\nQuestion : ${question}` }], s, s.max_tokens, s.temperature);
}
