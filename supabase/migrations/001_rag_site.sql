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
