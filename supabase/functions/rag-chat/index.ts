// Edge Function "rag-chat" : question d'un membre connecté -> (reformulation) -> recherche
// vectorielle dans votre base -> réponse rédigée par le LLM selon les réglages de l'assistant.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json, verifySession } from "../_shared/auth.ts";
import { loadSettings, cleanHistory, rewriteQuery, search, answer } from "../_shared/rag.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MAX_QUESTION = 2000;
const RATE_LIMIT = Number(Deno.env.get("RATE_LIMIT_PER_MIN") ?? "20");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  const t0 = Date.now();

  // ---- Accès réservé : session valide obligatoire ----
  const session = await verifySession(req.headers.get("x-admin-token"));
  if (!session) return json({ error: "Veuillez vous connecter." }, 401);
  if (session.role === "admin") {
    const { data } = await supabase.from("rag_admins").select("status").eq("id", session.sub).maybeSingle();
    if (!data || data.status !== "active") return json({ error: "Accès révoqué." }, 403);
  }
  const userEmail = session.role === "master" ? "admin principal" : (session.email ?? session.sub);

  const body = await req.json().catch(() => ({}));
  const question = String(body?.question ?? "").trim();
  if (!question) return json({ error: "Veuillez saisir une question." }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `Question trop longue (${MAX_QUESTION} caractères max).` }, 400);
  const history = cleanHistory(body.history);

  const { count } = await supabase.from("rag_queries").select("id", { count: "exact", head: true })
    .eq("user_email", userEmail).gte("created_at", new Date(Date.now() - 60_000).toISOString());
  if ((count ?? 0) >= RATE_LIMIT) return json({ error: "Trop de questions en peu de temps. Réessayez dans une minute." }, 429);

  try {
    const settings = await loadSettings(supabase);
    const searchQuery = await rewriteQuery(question, history, settings);
    const sources = await search(supabase, searchQuery, settings);
    const text = await answer(question, history, sources, settings);
    await supabase.from("rag_queries").insert({
      question, search_query: searchQuery !== question ? searchQuery : null, answer: text,
      sources_count: sources.length, latency_ms: Date.now() - t0, user_email: userEmail,
    });
    return json({
      answer: text,
      search_query: searchQuery,
      sources: sources.map(({ n, title, url, similarity, content }) => ({ n, title, url, similarity, excerpt: content.slice(0, 400) })),
    });
  } catch (e) {
    console.error(e);
    await supabase.from("rag_queries").insert({
      question, latency_ms: Date.now() - t0, user_email: userEmail, error: String((e as Error).message).slice(0, 1000),
    });
    return json({ error: "Le service n'a pas pu répondre pour le moment. Réessayez plus tard." }, 500);
  }
});
