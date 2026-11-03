// Fonction « admin-api » — version en un seul fichier (Supabase > Edge Functions > Via Editor). Verify JWT : désactivé.

// ../../home/claude/rag-site/supabase/functions/admin-api/index.ts
import { createClient } from "npm:@supabase/supabase-js@2";

// ../../home/claude/rag-site/supabase/functions/_shared/auth.ts
var enc = new TextEncoder();
var PBKDF2_ITERATIONS = 1e5;
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
function b64url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function timingSafeEqual(a, b) {
  const A = enc.encode(a);
  const B = enc.encode(b);
  let diff = A.length ^ B.length;
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) diff |= (A[i] ?? 0) ^ (B[i] ?? 0);
  return diff === 0;
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(bits)}`;
}
async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const bits = await pbkdf2(password, b64urlDecode(salt), Number(iter));
  return timingSafeEqual(b64url(bits), hash);
}
async function hmacKey() {
  const secret = Deno.env.get("SESSION_SECRET");
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET manquant ou trop court (32 caract\xE8res minimum)");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signSession(payload, ttlSeconds = 8 * 3600) {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1e3) + ttlSeconds })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
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
var clamp = (n, lo, hi, d) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};
function sanitizeSettings(i) {
  const d = defaults();
  const out = {};
  if (typeof i.system_prompt === "string") out.system_prompt = i.system_prompt.slice(0, 8e3);
  if (["auto", "fr", "en", "ar", "es"].includes(i.answer_language)) out.answer_language = i.answer_language;
  if (i.llm_provider === "anthropic" || i.llm_provider === "openai") out.llm_provider = i.llm_provider;
  if (typeof i.llm_model === "string" && i.llm_model.trim()) out.llm_model = i.llm_model.trim().slice(0, 100);
  if (i.temperature !== void 0) out.temperature = clamp(i.temperature, 0, 1, d.temperature);
  if (i.max_tokens !== void 0) out.max_tokens = Math.round(clamp(i.max_tokens, 200, 8e3, d.max_tokens));
  if (typeof i.rewrite_query === "boolean") out.rewrite_query = i.rewrite_query;
  if (typeof i.hybrid_search === "boolean") out.hybrid_search = i.hybrid_search;
  if (typeof i.match_function === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(i.match_function)) out.match_function = i.match_function;
  if (i.match_count !== void 0) out.match_count = Math.round(clamp(i.match_count, 1, 30, d.match_count));
  if (i.match_threshold === null || i.match_threshold === "") out.match_threshold = null;
  else if (i.match_threshold !== void 0) out.match_threshold = clamp(i.match_threshold, 0, 1, 0.5);
  if (typeof i.match_extra_params === "string") {
    const t = i.match_extra_params.trim();
    if (t) {
      const o = JSON.parse(t);
      if (typeof o !== "object" || Array.isArray(o)) throw new Error("Param\xE8tres suppl\xE9mentaires : objet JSON attendu.");
    }
    out.match_extra_params = t;
  }
  if (typeof i.embedding_model === "string" && i.embedding_model.trim()) out.embedding_model = i.embedding_model.trim();
  if (i.embedding_dimensions === null || i.embedding_dimensions === "") out.embedding_dimensions = null;
  else if (i.embedding_dimensions !== void 0) out.embedding_dimensions = Math.round(clamp(i.embedding_dimensions, 64, 4096, 1536));
  if (Array.isArray(i.suggestions)) out.suggestions = i.suggestions.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  return out;
}
async function loadSettings(sb) {
  const { data } = await sb.from("rag_settings").select("settings").eq("id", 1).maybeSingle();
  return { ...defaults(), ...data?.settings ?? {} };
}
function keysStatus() {
  return {
    anthropic: !!(env("ANTHROPIC_API_KEY") || env("LLM_PROVIDER") !== "openai" && env("LLM_API_KEY")),
    openai: !!env("OPENAI_API_KEY"),
    embeddings: !!(env("EMBEDDING_API_KEY") || env("OPENAI_API_KEY"))
  };
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

// ../../home/claude/rag-site/supabase/functions/_shared/ingest.ts
var HEADER_KEYS = ["circulaire", "note", "document"];
var ISO = /^\d{4}-\d{2}-\d{2}$/;
var MAX_CHUNK = 3e3;
var str = (v) => v === null || v === void 0 || v === "" ? null : typeof v === "string" ? v : JSON.stringify(v);
var MOIS = { janvier: "01", fevrier: "02", mars: "03", avril: "04", mai: "05", juin: "06", juillet: "07", aout: "08", septembre: "09", octobre: "10", novembre: "11", decembre: "12" };
function isoDate(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (ISO.test(s)) return s;
  let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/^(\d{1,2})(?:er)?\s+([a-z]+)\s+(\d{4})$/);
  if (m && MOIS[m[2]]) return `${m[3]}-${MOIS[m[2]]}-${m[1].padStart(2, "0")}`;
  return null;
}
var frDate = (v) => {
  const d = isoDate(v);
  return d ? d.split("-").reverse().join("/") : typeof v === "string" ? v : "";
};
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function makeTitle(type, h, fileName) {
  const num = h.numero ?? h.reference_interne ?? h.reference;
  const date = h.date ?? h.date_gregorienne;
  const obj = h.titre ?? h.objet;
  if (type === "circulaire" || type === "note") {
    const label = type === "circulaire" ? "Circulaire" : "Note";
    return `${label} n\xB0 ${num ?? "?"}${date ? ` du ${frDate(date)}` : ""}${obj ? ` \u2014 ${obj}` : ""}`.slice(0, 400);
  }
  return String(obj ?? num ?? fileName.replace(/\.json$/i, "")).slice(0, 400);
}
function split(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf("\n", MAX_CHUNK);
    if (cut < MAX_CHUNK * 0.5) cut = rest.lastIndexOf(". ", MAX_CHUNK) + 1;
    if (cut < MAX_CHUNK * 0.5) cut = MAX_CHUNK;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}
var asText = (v) => Array.isArray(v) ? v.map((x) => `- ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n") : String(v ?? "");
var FICHE_FIELDS = [
  ["objet", "Objet"],
  ["resume", "R\xE9sum\xE9"],
  ["contenu_synthetique", "Synth\xE8se"],
  ["contenu_complet", "Contenu"],
  ["points_cles", "Points cl\xE9s"],
  ["impact_operationnel", "Impact op\xE9rationnel"],
  ["abrogations", "Abrogations"],
  ["references", "R\xE9f\xE9rences"],
  ["references_legales", "R\xE9f\xE9rences l\xE9gales"],
  ["mots_cles", "Mots-cl\xE9s"]
];
function prepare(fileName, data) {
  if (!isObj(data)) throw new Error("Format non reconnu : un objet JSON est attendu.");
  let type;
  let header;
  let raw;
  if (Array.isArray(data.chunks)) {
    const hk = HEADER_KEYS.find((k) => isObj(data[k]));
    type = hk ?? "document";
    header = hk ? data[hk] : Object.fromEntries(Object.entries(data).filter(([k]) => k !== "chunks"));
    raw = data.chunks.flatMap((c, i) => {
      const content = String(c?.content ?? c?.contenu ?? c?.text ?? c?.texte ?? "").trim();
      if (!content) return [];
      const id = String(c?.id ?? `chunk_${i}`);
      const meta = isObj(c?.metadata) ? c.metadata : {};
      const pieces = split(content);
      const index = typeof c?.index === "number" ? c.index : void 0;
      return pieces.map((p, j) => ({ id: pieces.length > 1 ? `${id}__${j + 1}` : id, content: p, metadata: meta, index }));
    });
  } else {
    const listKey = Object.keys(data).find((k) => Array.isArray(data[k]) && data[k].length > 5 && isObj(data[k][0]));
    if (listKey) {
      type = "liste";
      const hk = Object.keys(data).find((k) => k !== listKey && isObj(data[k]));
      header = hk ? data[hk] : {};
      const items = data[listKey];
      const first = items[0] ?? {};
      const intro = [header.titre, header.annexe_de].filter(Boolean).join("\n");
      raw = [];
      for (let i = 0; i < items.length; i += 40) {
        const group = items.slice(i, i + 40);
        const lines = group.map((e) => {
          const name = e.denomination_commerciale ?? e.denomination ?? e.nom ?? e.designation ?? e.libelle ?? e.titre ?? e.id;
          return `- ${name}${e.statut ? ` (${String(e.statut).replace(/_/g, " ")})` : ""}`;
        }).join("\n");
        raw.push({
          id: `${listKey}_${i + 1}-${i + group.length}`,
          content: `${intro}
Entr\xE9es ${i + 1} \xE0 ${i + group.length} sur ${items.length} :
${lines}${header.avertissement_global ? `

Avertissement : ${header.avertissement_global}` : ""}`,
          metadata: { domaine: first.domaine, sous_domaine: first.sous_domaine, motif: first.motif, source: first.source }
        });
      }
      header = { ...header, numero: header.numero ?? first.source?.numero, date: header.date ?? first.source?.date, emetteur: header.emetteur ?? header.organisme_emetteur_liste };
    } else {
      type = "fiche";
      header = data;
      const body = FICHE_FIELDS.filter(([k]) => data[k]).map(([k, label]) => `${label} :
${asText(data[k])}`).join("\n\n");
      if (!body.trim()) throw new Error("Aucun contenu exploitable (ni \xAB chunks \xBB, ni champs de texte reconnus).");
      const meta = { domaine: data.domaine ?? data.categorie, sous_domaine: data.sous_domaine ?? data.sous_categorie, mots_cles: data.mots_cles, statut: data.statut };
      raw = split(body).map((p, j) => ({ id: `fiche_${j + 1}`, content: p, metadata: meta }));
    }
  }
  const titre = str(header.titre_affiche) ?? makeTitle(type, header, fileName);
  const docType = str(header.doc_type) ?? type;
  const smallHeader = Object.fromEntries(Object.entries(header).filter(([, v]) => !(typeof v === "string" && v.length > 4e3)));
  const doc = {
    file_name: fileName,
    doc_type: docType,
    numero: str(header.numero ?? header.reference_interne ?? header.reference),
    titre,
    objet: str(header.objet),
    date_doc: isoDate(header.date ?? header.date_gregorienne),
    emetteur: str(header.emetteur),
    statut: str(header.statut),
    langue: str(header.langue) ?? "fr",
    abroge_ou_modifie: str(header.abroge_ou_modifie ?? header.abrogations),
    modifie_par: str(header.modifie_par),
    date_fin_validite: isoDate(header.date_fin_validite),
    header: smallHeader
  };
  const seen = /* @__PURE__ */ new Map();
  const chunks = raw.map((c, i) => {
    const n = (seen.get(c.id) ?? 0) + 1;
    seen.set(c.id, n);
    const chunk_id = n > 1 ? `${c.id}__dup${n}` : c.id;
    const m = c.metadata;
    const metadata = { ...m, title: titre, doc_type: docType, numero: doc.numero, statut: m.statut ?? doc.statut };
    const path = [m.domaine, m.sous_domaine].filter(Boolean).join(" \u203A ");
    const embed_text = [titre, path, m.article ? `Article : ${m.article}` : "", "", c.content].filter((x, k) => x || k === 3).join("\n").slice(0, 8e3);
    return { chunk_id, chunk_index: typeof c.index === "number" ? c.index : i, content: c.content, metadata, embed_text };
  });
  return { doc, chunks };
}

// ../../home/claude/rag-site/supabase/functions/admin-api/index.ts
var supabase = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } }
);
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
var MIN_PASSWORD = 8;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var HttpError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
async function requireSession(req, role) {
  const session = await verifySession(req.headers.get("x-admin-token"));
  if (!session) throw new HttpError(401, "Session expir\xE9e, veuillez vous reconnecter.");
  if (session.role === "admin") {
    const { data } = await supabase.from("rag_admins").select("status").eq("id", session.sub).maybeSingle();
    if (!data || data.status !== "active") throw new HttpError(403, "Acc\xE8s r\xE9voqu\xE9.");
  }
  if (role === "master" && session.role !== "master") {
    throw new HttpError(403, "Action r\xE9serv\xE9e \xE0 l'administrateur principal.");
  }
  return session;
}
function checkPassword(pw) {
  const p = String(pw ?? "");
  if (p.length < MIN_PASSWORD) throw new HttpError(400, `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caract\xE8res.`);
  return p;
}
var actions = {
  async login(_req, body) {
    const password = String(body.password ?? "");
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email) {
      const master = Deno.env.get("MASTER_PASSWORD") ?? "";
      if (!master) throw new HttpError(500, "MASTER_PASSWORD n'est pas configur\xE9.");
      if (!timingSafeEqual(password, master)) {
        await sleep(800);
        throw new HttpError(401, "Mot de passe incorrect.");
      }
      return { token: await signSession({ sub: "master", role: "master" }), role: "master" };
    }
    const { data: admin } = await supabase.from("rag_admins").select("*").eq("email", email).maybeSingle();
    if (!admin || !await verifyPassword(password, admin.password_hash)) {
      await sleep(800);
      throw new HttpError(401, "Email ou mot de passe incorrect.");
    }
    if (admin.status !== "active") throw new HttpError(403, "Ce compte est bloqu\xE9.");
    await supabase.from("rag_admins").update({ last_login_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", admin.id);
    return { token: await signSession({ sub: admin.id, role: "admin", email: admin.email }), role: "admin", email: admin.email };
  },
  async me(req) {
    const s = await requireSession(req);
    return { role: s.role, email: s.email ?? null };
  },
  async stats(req) {
    await requireSession(req, "master");
    const day = new Date(Date.now() - 864e5).toISOString();
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    const q = () => supabase.from("rag_queries").select("id", { count: "exact", head: true });
    const [d, w, t, a, b] = await Promise.all([
      q().gte("created_at", day),
      q().gte("created_at", week),
      q(),
      supabase.from("rag_admins").select("id", { count: "exact", head: true }).eq("status", "active"),
      supabase.from("rag_admins").select("id", { count: "exact", head: true }).eq("status", "blocked")
    ]);
    return { last24h: d.count ?? 0, last7d: w.count ?? 0, total: t.count ?? 0, activeAdmins: a.count ?? 0, blockedAdmins: b.count ?? 0 };
  },
  async list_queries(req, body) {
    await requireSession(req, "master");
    const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
    const { data, error } = await supabase.from("rag_queries").select("id, created_at, user_email, question, search_query, answer, sources_count, latency_ms, error").order("created_at", { ascending: false }).limit(limit);
    if (error) throw new HttpError(500, error.message);
    return { queries: data };
  },
  async list_admins(req) {
    await requireSession(req, "master");
    const { data, error } = await supabase.from("rag_admins").select("id, email, status, created_at, last_login_at").order("created_at", { ascending: false });
    if (error) throw new HttpError(500, error.message);
    return { admins: data };
  },
  async create_admin(req, body) {
    await requireSession(req, "master");
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Adresse email invalide.");
    const password_hash = await hashPassword(checkPassword(body.password));
    const { data, error } = await supabase.from("rag_admins").insert({ email, password_hash }).select("id, email, status, created_at, last_login_at").single();
    if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.code === "23505" ? "Cet email existe d\xE9j\xE0." : error.message);
    return { admin: data };
  },
  async set_status(req, body) {
    await requireSession(req, "master");
    const status = body.status === "blocked" ? "blocked" : "active";
    const { error } = await supabase.from("rag_admins").update({ status }).eq("id", String(body.id));
    if (error) throw new HttpError(500, error.message);
    return { ok: true, status };
  },
  async reset_password(req, body) {
    await requireSession(req, "master");
    const password_hash = await hashPassword(checkPassword(body.password));
    const { error } = await supabase.from("rag_admins").update({ password_hash }).eq("id", String(body.id));
    if (error) throw new HttpError(500, error.message);
    return { ok: true };
  },
  async delete_admin(req, body) {
    await requireSession(req, "master");
    const { error } = await supabase.from("rag_admins").delete().eq("id", String(body.id));
    if (error) throw new HttpError(500, error.message);
    return { ok: true };
  },
  // ---------- Assistant (réglages de la recherche et du LLM) ----------
  async client_settings(req) {
    await requireSession(req);
    const s = await loadSettings(supabase);
    return { suggestions: s.suggestions };
  },
  async get_settings(req) {
    await requireSession(req, "master");
    return { settings: await loadSettings(supabase), defaults: defaults(), keys: keysStatus() };
  },
  async save_settings(req, body) {
    await requireSession(req, "master");
    let clean;
    try {
      clean = sanitizeSettings(body.settings ?? {});
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const current = await loadSettings(supabase);
    const settings = { ...current, ...clean };
    const { error } = await supabase.from("rag_settings").upsert({ id: 1, settings, updated_at: (/* @__PURE__ */ new Date()).toISOString() });
    if (error) throw new HttpError(500, error.message);
    return { settings };
  },
  async reset_settings(req) {
    await requireSession(req, "master");
    await supabase.from("rag_settings").delete().eq("id", 1);
    return { settings: defaults() };
  },
  async test_search(req, body) {
    await requireSession(req, "master");
    const q = String(body.query ?? "").trim();
    if (!q) throw new HttpError(400, "Saisissez une requ\xEAte de test.");
    let clean;
    try {
      clean = sanitizeSettings(body.settings ?? {});
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const settings = { ...await loadSettings(supabase), ...clean };
    const t0 = Date.now();
    try {
      const sources = await search(supabase, q, settings);
      return { ms: Date.now() - t0, sources: sources.map(({ n, title, similarity, content }) => ({ n, title, similarity, excerpt: content.slice(0, 300) })) };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  },
  // ---------- Base documentaire : import des fichiers JSON ----------
  async ingest_file(req, body) {
    await requireSession(req, "master");
    const t0 = Date.now();
    const fileName = String(body.file_name ?? "").trim().slice(0, 300);
    if (!fileName) throw new HttpError(400, "Nom de fichier manquant.");
    let prep;
    try {
      prep = prepare(fileName, body.data);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (!prep.chunks.length) throw new HttpError(400, "Aucun extrait exploitable dans ce fichier.");
    const settings = await loadSettings(supabase);
    const allIds = Array.isArray(body.all_chunk_ids) ? body.all_chunk_ids.map(String) : null;
    const { data: doc, error: e1 } = await supabase.from("rag_documents").upsert({ ...prep.doc, chunks_count: allIds ? allIds.length : prep.chunks.length, updated_at: (/* @__PURE__ */ new Date()).toISOString() }, { onConflict: "file_name" }).select("id").single();
    if (e1) throw new HttpError(500, `Document : ${e1.message}`);
    const { data: existing, error: e2 } = await supabase.from("rag_chunks").select("chunk_id, content_hash").eq("document_id", doc.id);
    if (e2) throw new HttpError(500, e2.message);
    const old = new Map((existing ?? []).map((r) => [r.chunk_id, r.content_hash]));
    const withHash = await Promise.all(prep.chunks.map(async (c) => ({
      ...c,
      hash: await sha256Hex(settings.embedding_model + "|" + c.chunk_index + "|" + c.embed_text + "|" + JSON.stringify(c.metadata))
    })));
    const todo = withHash.filter((c) => old.get(c.chunk_id) !== c.hash);
    if (todo.length) {
      let vectors;
      try {
        vectors = await embedMany(todo.map((c) => c.embed_text), settings);
      } catch (e) {
        throw new HttpError(502, e.message);
      }
      const rows = todo.map((c, i) => ({
        document_id: doc.id,
        chunk_id: c.chunk_id,
        chunk_index: c.chunk_index,
        content: c.content,
        metadata: c.metadata,
        content_hash: c.hash,
        embedding: vectors[i]
      }));
      for (let i = 0; i < rows.length; i += 50) {
        const { error } = await supabase.from("rag_chunks").upsert(rows.slice(i, i + 50), { onConflict: "document_id,chunk_id" });
        if (error) throw new HttpError(500, `Extraits : ${error.message}`);
      }
    }
    const keep = new Set(allIds ?? withHash.map((c) => c.chunk_id));
    const stale = [...old.keys()].filter((id) => !keep.has(id));
    if (stale.length) await supabase.from("rag_chunks").delete().eq("document_id", doc.id).in("chunk_id", stale);
    return { titre: prep.doc.titre, type: prep.doc.doc_type, chunks: prep.chunks.length, embedded: todo.length, removed: stale.length, ms: Date.now() - t0 };
  },
  async list_documents(req) {
    await requireSession(req, "master");
    const { data, error } = await supabase.from("rag_documents").select("id, file_name, doc_type, numero, titre, date_doc, statut, chunks_count, updated_at").order("updated_at", { ascending: false }).limit(2e3);
    if (error) throw new HttpError(500, error.message);
    const { count } = await supabase.from("rag_chunks").select("id", { count: "exact", head: true });
    return { documents: data, chunks_total: count ?? 0 };
  },
  async delete_document(req, body) {
    await requireSession(req, "master");
    const { error } = await supabase.from("rag_documents").delete().eq("id", String(body.id));
    if (error) throw new HttpError(500, error.message);
    return { ok: true };
  }
};
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "M\xE9thode non autoris\xE9e" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const handler = actions[String(body.action)];
    if (!handler) return json({ error: "Action inconnue" }, 400);
    return json(await handler(req, body));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    const msg = String(e?.message ?? "");
    if (/SESSION_SECRET|MASTER_PASSWORD|relation .* does not exist|Could not find the table/i.test(msg)) {
      return json({ error: `Configuration incompl\xE8te : ${msg}` }, 500);
    }
    return json({ error: "Erreur serveur" }, 500);
  }
});
