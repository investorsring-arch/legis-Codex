-- =====================================================================
-- Vecteurs compactés : vector(1536) -> halfvec(1536) (demi-précision)
-- Divise par deux la place des vecteurs et de leur index, sans re-vectoriser.
-- =====================================================================

drop index if exists public.rag_chunks_embedding_idx;

alter table public.rag_chunks
  alter column embedding type extensions.halfvec(1536)
  using embedding::extensions.halfvec(1536);

create index rag_chunks_embedding_idx on public.rag_chunks
  using hnsw (embedding extensions.halfvec_cosine_ops);

-- Même signature qu'avant (l'appel depuis les fonctions ne change pas) :
-- le vecteur de la question est converti en halfvec au moment de la recherche.
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
  with p as (select query_embedding::extensions.halfvec(1536) as qe),
  vec as (
    select c.id, row_number() over (order by c.embedding <=> p.qe) as r
    from rag_chunks c, p
    where c.embedding is not null and c.metadata @> filter
    order by c.embedding <=> p.qe
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
         (1 - (c.embedding <=> p.qe))::float as similarity
  from fused f
  cross join p
  join rag_chunks c    on c.id = f.id
  join rag_documents d on d.id = c.document_id
  where match_threshold is null
     or f.keyword_hit
     or (1 - (c.embedding <=> p.qe)) >= match_threshold
  order by f.score desc
  limit match_count;
$$;

revoke execute on function public.match_documents(extensions.vector, int, float, jsonb, text) from public, anon, authenticated;
grant execute on function public.match_documents(extensions.vector, int, float, jsonb, text) to service_role;
