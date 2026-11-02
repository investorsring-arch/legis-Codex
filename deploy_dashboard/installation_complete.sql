-- Installation complète (001 + 002) — à coller en une fois dans SQL Editor > New query > Run

-- =====================================================================
-- RAG public — tables d'administration et journal des questions
-- À exécuter une fois dans Supabase : SQL Editor > New query > Run
-- (ne touche pas à vos tables RAG existantes)
-- =====================================================================

create extension if not exists pgcrypto;

-- Administrateurs secondaires (l'administrateur principal n'est pas en base :
-- son mot de passe maître est un secret de la fonction "admin-api").
create table if not exists public.rag_admins (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique check (email = lower(email)),
  password_hash  text not null,
  status         text not null default 'active' check (status in ('active', 'blocked')),
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- Journal des questions posées par les membres
create table if not exists public.rag_queries (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  question       text not null,
  answer         text,
  sources_count  int,
  latency_ms     int,
  user_email     text,
  search_query   text,
  error          text
);

-- (si la table existait déjà avec l'ancienne version)
alter table public.rag_queries add column if not exists user_email text;
alter table public.rag_queries add column if not exists search_query text;

create index if not exists rag_queries_user_created_idx on public.rag_queries (user_email, created_at desc);
create index if not exists rag_queries_created_idx    on public.rag_queries (created_at desc);

-- Réglages de l'assistant (une seule ligne, id = 1), modifiés depuis le tableau de bord
create table if not exists public.rag_settings (
  id          int primary key default 1 check (id = 1),
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Sécurité : RLS activé SANS aucune policy => inaccessible avec la clé publique (anon).
-- Seules les Edge Functions (clé service_role) peuvent lire/écrire.
alter table public.rag_admins  enable row level security;
alter table public.rag_queries enable row level security;
alter table public.rag_settings enable row level security;

revoke all on public.rag_admins  from anon, authenticated;
revoke all on public.rag_queries from anon, authenticated;
revoke all on public.rag_settings from anon, authenticated;

-- =====================================================================
-- Base documentaire RAG — circulaires, notes, documents ADII (format JSON « en-tête + chunks »)
-- À exécuter APRÈS 001_rag_site.sql : SQL Editor > New query > Run
-- Embeddings : OpenAI text-embedding-3-small (1536 dimensions)
-- =====================================================================

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Un document = un fichier JSON (circulaire, note, document, fiche, liste)
-- ---------------------------------------------------------------------
create table if not exists public.rag_documents (
  id                 uuid primary key default gen_random_uuid(),
  file_name          text not null unique,          -- clé de mise à jour : réimporter le même fichier le remplace
  doc_type           text not null,                 -- circulaire | note | document | fiche | liste
  numero             text,                          -- ex. 6542/313, D23/2026/ADII/AC/100
  titre              text not null,                 -- titre affiché dans les sources
  objet              text,
  date_doc           date,
  emetteur           text,
  statut             text,                          -- en_vigueur, abrogé…
  langue             text default 'fr',
  abroge_ou_modifie  text,
  modifie_par        text,
  date_fin_validite  date,
  header             jsonb not null default '{}'::jsonb,   -- en-tête complet du fichier
  chunks_count       int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists rag_documents_numero_idx on public.rag_documents (numero);
create index if not exists rag_documents_type_idx   on public.rag_documents (doc_type);

-- ---------------------------------------------------------------------
-- 2. Un extrait (chunk) = un passage indexé avec son vecteur
-- ---------------------------------------------------------------------
create table if not exists public.rag_chunks (
  id            bigserial primary key,
  document_id   uuid not null references public.rag_documents(id) on delete cascade,
  chunk_id      text not null,                      -- "id" du chunk dans le JSON
  chunk_index   int  not null default 0,
  content       text not null,
  metadata      jsonb not null default '{}'::jsonb, -- domaine, sous_domaine, article, mots_cles, regime_douanier, nc8…
  embedding     extensions.vector(1536),
  content_hash  text,                               -- évite de recalculer les vecteurs d'un extrait inchangé
  fts           tsvector generated always as (
                  to_tsvector('french',
                    coalesce(metadata->>'title', '') || ' ' ||
                    coalesce(metadata->>'numero', '') || ' ' ||
                    coalesce(metadata->>'article', '') || ' ' ||
                    content)
                ) stored,
  created_at    timestamptz not null default now(),
  unique (document_id, chunk_id)
);

create index if not exists rag_chunks_embedding_idx on public.rag_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists rag_chunks_fts_idx       on public.rag_chunks using gin (fts);
create index if not exists rag_chunks_metadata_idx  on public.rag_chunks using gin (metadata jsonb_path_ops);
create index if not exists rag_chunks_document_idx  on public.rag_chunks (document_id);

-- ---------------------------------------------------------------------
-- 3. Recherche hybride : sens (vecteurs) + mots exacts (plein texte), fusion RRF
--    filter : ex. {"statut":"en_vigueur"} ou {"domaine":"Zones franches et ZAI"}
-- ---------------------------------------------------------------------
create or replace function public.match_documents(
  query_embedding  extensions.vector(1536),
  match_count      int     default 6,
  match_threshold  float   default null,
  filter           jsonb   default '{}'::jsonb,
  query_text       text    default null
)
returns table (id bigint, content text, metadata jsonb, similarity float)
language sql stable
set search_path = public, extensions
as $$
  with vec as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as r
    from rag_chunks c
    where c.embedding is not null and c.metadata @> filter
    order by c.embedding <=> query_embedding
    limit greatest(match_count, 1) * 4
  ),
  kw as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, q) desc) as r
    from rag_chunks c, websearch_to_tsquery('french', coalesce(query_text, '')) q
    where coalesce(query_text, '') <> '' and c.fts @@ q and c.metadata @> filter
    order by ts_rank_cd(c.fts, q) desc
    limit greatest(match_count, 1) * 4
  ),
  fused as (
    select coalesce(v.id, k.id) as id,
           coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + k.r), 0) as score,
           k.id is not null as keyword_hit
    from vec v full outer join kw k on v.id = k.id
  )
  select c.id,
         c.content,
         c.metadata || jsonb_build_object(
           'title', d.titre, 'numero', d.numero, 'date', d.date_doc, 'doc_type', d.doc_type,
           'statut_document', d.statut, 'emetteur', d.emetteur, 'file_name', d.file_name),
         (1 - (c.embedding <=> query_embedding))::float as similarity
  from fused f
  join rag_chunks c    on c.id = f.id
  join rag_documents d on d.id = c.document_id
  where match_threshold is null
     or f.keyword_hit
     or (1 - (c.embedding <=> query_embedding)) >= match_threshold
  order by f.score desc
  limit match_count;
$$;

-- ---------------------------------------------------------------------
-- 4. Sécurité : accessible uniquement par les Edge Functions (service_role)
-- ---------------------------------------------------------------------
alter table public.rag_documents enable row level security;
alter table public.rag_chunks    enable row level security;
revoke all on public.rag_documents from anon, authenticated;
revoke all on public.rag_chunks    from anon, authenticated;
revoke execute on function public.match_documents(extensions.vector, int, float, jsonb, text) from public, anon, authenticated;
