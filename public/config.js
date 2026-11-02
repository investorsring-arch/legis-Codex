// ============ À PERSONNALISER ============
// Ces deux valeurs sont PUBLIQUES (Supabase > Project Settings > API).
// Ne mettez JAMAIS ici la clé service_role ni une clé de LLM.
window.RAG_CONFIG = {
  SUPABASE_URL: "https://shnniddpgtnukexuzhxc.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_XVNn-qjeJMtmpUIlM9AAzA_5my4LUQo",

  SITE_TITLE: "Assistant documentaire",
  SITE_SUBTITLE: "Posez vos questions, les réponses citent les documents de la base.",
  SUGGESTIONS: [
    "Quels sont les principaux textes applicables ?",
    "Résume la procédure en 5 étapes",
    "Quelles sont les pièces justificatives exigées ?",
  ],
};
