// Edge Function "admin-api" : connexion admin + gestion des administrateurs secondaires.
// Toutes les requêtes : POST { action, ...params }, jeton de session dans l'en-tête "x-admin-token".

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  corsHeaders, json, hashPassword, verifyPassword, timingSafeEqual,
  signSession, verifySession, type Session,
} from "../_shared/auth.ts";
import { loadSettings, sanitizeSettings, keysStatus, search, defaults, embedMany } from "../_shared/rag.ts";
import { prepare } from "../_shared/ingest.ts";
import { sha256Hex } from "../_shared/auth.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function requireSession(req: Request, role?: "master"): Promise<Session> {
  const session = await verifySession(req.headers.get("x-admin-token"));
  if (!session) throw new HttpError(401, "Session expirée, veuillez vous reconnecter.");
  if (session.role === "admin") {
    // Un admin bloqué ou supprimé perd l'accès immédiatement, même avec un jeton valide.
    const { data } = await supabase.from("rag_admins").select("status").eq("id", session.sub).maybeSingle();
    if (!data || data.status !== "active") throw new HttpError(403, "Accès révoqué.");
  }
  if (role === "master" && session.role !== "master") {
    throw new HttpError(403, "Action réservée à l'administrateur principal.");
  }
  return session;
}

function checkPassword(pw: unknown): string {
  const p = String(pw ?? "");
  if (p.length < MIN_PASSWORD) throw new HttpError(400, `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`);
  return p;
}

const actions: Record<string, (req: Request, body: any) => Promise<unknown>> = {

  async login(_req, body) {
    const password = String(body.password ?? "");
    const email = String(body.email ?? "").trim().toLowerCase();

    if (!email) {
      const master = Deno.env.get("MASTER_PASSWORD") ?? "";
      if (!master) throw new HttpError(500, "MASTER_PASSWORD n'est pas configuré.");
      if (!timingSafeEqual(password, master)) { await sleep(800); throw new HttpError(401, "Mot de passe incorrect."); }
      return { token: await signSession({ sub: "master", role: "master" }), role: "master" };
    }

    const { data: admin } = await supabase.from("rag_admins").select("*").eq("email", email).maybeSingle();
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      await sleep(800);
      throw new HttpError(401, "Email ou mot de passe incorrect.");
    }
    if (admin.status !== "active") throw new HttpError(403, "Ce compte est bloqué.");
    await supabase.from("rag_admins").update({ last_login_at: new Date().toISOString() }).eq("id", admin.id);
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
      supabase.from("rag_admins").select("id", { count: "exact", head: true }).eq("status", "blocked"),
    ]);
    return { last24h: d.count ?? 0, last7d: w.count ?? 0, total: t.count ?? 0, activeAdmins: a.count ?? 0, blockedAdmins: b.count ?? 0 };
  },

  async list_queries(req, body) {
    await requireSession(req, "master");
    const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
    const { data, error } = await supabase.from("rag_queries")
      .select("id, created_at, user_email, question, search_query, answer, sources_count, latency_ms, error")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw new HttpError(500, error.message);
    return { queries: data };
  },

  async list_admins(req) {
    await requireSession(req, "master");
    const { data, error } = await supabase.from("rag_admins")
      .select("id, email, status, created_at, last_login_at").order("created_at", { ascending: false });
    if (error) throw new HttpError(500, error.message);
    return { admins: data };
  },

  async create_admin(req, body) {
    await requireSession(req, "master");
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Adresse email invalide.");
    const password_hash = await hashPassword(checkPassword(body.password));
    const { data, error } = await supabase.from("rag_admins")
      .insert({ email, password_hash }).select("id, email, status, created_at, last_login_at").single();
    if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.code === "23505" ? "Cet email existe déjà." : error.message);
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
    try { clean = sanitizeSettings(body.settings ?? {}); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const current = await loadSettings(supabase);
    const settings = { ...current, ...clean };
    const { error } = await supabase.from("rag_settings").upsert({ id: 1, settings, updated_at: new Date().toISOString() });
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
    if (!q) throw new HttpError(400, "Saisissez une requête de test.");
    let clean;
    try { clean = sanitizeSettings(body.settings ?? {}); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const settings = { ...(await loadSettings(supabase)), ...clean };   // teste les réglages affichés, même non enregistrés
    const t0 = Date.now();
    try {
      const sources = await search(supabase, q, settings);
      return { ms: Date.now() - t0, sources: sources.map(({ n, title, similarity, content }) => ({ n, title, similarity, excerpt: content.slice(0, 300) })) };
    } catch (e) { throw new HttpError(400, (e as Error).message); }
  },
  // ---------- Base documentaire : import des fichiers JSON ----------

  async ingest_file(req, body) {
    await requireSession(req, "master");
    const t0 = Date.now();
    const fileName = String(body.file_name ?? "").trim().slice(0, 300);
    if (!fileName) throw new HttpError(400, "Nom de fichier manquant.");
    let prep;
    try { prep = prepare(fileName, body.data); } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (!prep.chunks.length) throw new HttpError(400, "Aucun extrait exploitable dans ce fichier.");
    const settings = await loadSettings(supabase);
    // Import en plusieurs parties (gros codes) : la liste complète des extraits du document est fournie à chaque partie.
    const allIds: string[] | null = Array.isArray(body.all_chunk_ids) ? body.all_chunk_ids.map(String) : null;

    const { data: doc, error: e1 } = await supabase.from("rag_documents")
      .upsert({ ...prep.doc, chunks_count: allIds ? allIds.length : prep.chunks.length, updated_at: new Date().toISOString() }, { onConflict: "file_name" })
      .select("id").single();
    if (e1) throw new HttpError(500, `Document : ${e1.message}`);

    const { data: existing, error: e2 } = await supabase.from("rag_chunks").select("chunk_id, content_hash").eq("document_id", doc.id);
    if (e2) throw new HttpError(500, e2.message);
    const old = new Map((existing ?? []).map((r: any) => [r.chunk_id, r.content_hash]));

    const withHash = await Promise.all(prep.chunks.map(async (c) => ({
      ...c, hash: await sha256Hex(settings.embedding_model + "|" + c.chunk_index + "|" + c.embed_text + "|" + JSON.stringify(c.metadata)),
    })));
    const todo = withHash.filter((c) => old.get(c.chunk_id) !== c.hash);   // nouveaux ou modifiés uniquement

    if (todo.length) {
      let vectors: number[][];
      try { vectors = await embedMany(todo.map((c) => c.embed_text), settings); }
      catch (e) { throw new HttpError(502, (e as Error).message); }
      const rows = todo.map((c, i) => ({
        document_id: doc.id, chunk_id: c.chunk_id, chunk_index: c.chunk_index, content: c.content,
        metadata: c.metadata, content_hash: c.hash, embedding: vectors[i],
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
    const { data, error } = await supabase.from("rag_documents")
      .select("id, file_name, doc_type, numero, titre, date_doc, statut, chunks_count, updated_at")
      .order("updated_at", { ascending: false }).limit(2000);
    if (error) throw new HttpError(500, error.message);
    const { count } = await supabase.from("rag_chunks").select("id", { count: "exact", head: true });
    return { documents: data, chunks_total: count ?? 0 };
  },

  async delete_document(req, body) {
    await requireSession(req, "master");
    const { error } = await supabase.from("rag_documents").delete().eq("id", String(body.id));
    if (error) throw new HttpError(500, error.message);
    return { ok: true };
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const handler = actions[String(body.action)];
    if (!handler) return json({ error: "Action inconnue" }, 400);
    return json(await handler(req, body));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    const msg = String((e as Error)?.message ?? "");
    // Erreurs de configuration : message explicite pour faciliter l'installation
    if (/SESSION_SECRET|MASTER_PASSWORD|relation .* does not exist|Could not find the table/i.test(msg)) {
      return json({ error: `Configuration incomplète : ${msg}` }, 500);
    }
    return json({ error: "Erreur serveur" }, 500);
  }
});
