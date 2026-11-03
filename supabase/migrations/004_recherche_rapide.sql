-- =====================================================================
-- Recherche rapide sur grand volume (> 10 000 extraits) :
-- la partie vectorielle passe par l'index HNSW (au lieu de calculer toutes les distances),
-- 100 candidats au lieu de 40, parcours itératif quand un filtre est appliqué.
-- Temps mesuré sur 14 838 extraits : 7,8 s -> 0,5 s.
-- =====================================================================
create or replace function public.match_documents(
  query_embedding  extensions.vector(1536),
  match_count      int     default 6,
  match_threshold  float   default null,
  filter           jsonb   default '{}'::jsonb,
  query_text       text    default null
)
returns table (id bigint, content text, metadata jsonb, similarity float)
language plpgsql stable
set search_path = public, extensions
as $$
declare
  qe extensions.halfvec(1536) := query_embedding::extensions.halfvec(1536);
  n  int := greatest(match_count, 1) * 4;
begin
  perform set_config('hnsw.ef_search', '100', true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  return query
  with vec as (
    select s.id, row_number() over (order by s.dist) as r
    from (
      select c.id, c.embedding <=> qe as dist
      from rag_chunks c
      where c.metadata @> filter
      order by c.embedding <=> qe
      limit n
    ) s
  ),
  kw as (
    select s.id, row_number() over (order by s.rk desc) as r
    from (
      select c.id, ts_rank_cd(c.fts, q) as rk
      from rag_chunks c, websearch_to_tsquery('french', coalesce(query_text, '')) q
      where coalesce(query_text, '') <> '' and c.fts @@ q and c.metadata @> filter
      order by ts_rank_cd(c.fts, q) desc
      limit n
    ) s
  ),
  fused as (
    select coalesce(v.id, k.id) as fid,
           coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + k.r), 0) as score,
           k.id is not null as keyword_hit
    from vec v full outer join kw k on v.id = k.id
  )
  select c.id,
         c.content,
         c.metadata || jsonb_build_object(
           'title', d.titre, 'numero', d.numero, 'date', d.date_doc, 'doc_type', d.doc_type,
           'statut_document', d.statut, 'emetteur', d.emetteur, 'file_name', d.file_name),
         (1 - (c.embedding <=> qe))::float
  from fused f
  join rag_chunks c    on c.id = f.fid
  join rag_documents d on d.id = c.document_id
  where match_threshold is null
     or f.keyword_hit
     or (1 - (c.embedding <=> qe)) >= match_threshold
  order by f.score desc
  limit match_count;
end;
$$;

revoke execute on function public.match_documents(extensions.vector, int, float, jsonb, text) from public, anon, authenticated;
grant execute on function public.match_documents(extensions.vector, int, float, jsonb, text) to service_role;
