// Préparation d'un fichier JSON pour l'ingestion.
// Formats reconnus :
//   1. { "circulaire"|"note"|"document": {en-tête}, "chunks": [{id, content, metadata}] }   (format principal)
//   2. { ..., "chunks": [...] } sans clé d'en-tête connue
//   3. fiche de synthèse sans chunks : { numero, objet, resume, points_cles, contenu_complet… }
//   4. liste : { "liste_source": {…}, "<entrées>": [ {…}, {…} ] }  (ex. pesticides interdits)

export type PreparedChunk = { chunk_id: string; chunk_index: number; content: string; metadata: Record<string, unknown>; embed_text: string };
export type Prepared = { doc: Record<string, unknown>; chunks: PreparedChunk[] };

const HEADER_KEYS = ["circulaire", "note", "document"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CHUNK = 3000;

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : typeof v === "string" ? v : JSON.stringify(v);
const MOIS: Record<string, string> = { janvier: "01", fevrier: "02", mars: "03", avril: "04", mai: "05", juin: "06", juillet: "07", aout: "08", septembre: "09", octobre: "10", novembre: "11", decembre: "12" };
/** Accepte 2024-02-20, 20/02/2024, 20-02-2024, « 5 octobre 2021 ». Renvoie AAAA-MM-JJ ou null. */
function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (ISO.test(s)) return s;
  let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/^(\d{1,2})(?:er)?\s+([a-z]+)\s+(\d{4})$/);
  if (m && MOIS[m[2]]) return `${m[3]}-${MOIS[m[2]]}-${m[1].padStart(2, "0")}`;
  return null;
}
const frDate = (v: unknown) => { const d = isoDate(v); return d ? d.split("-").reverse().join("/") : (typeof v === "string" ? v : ""); };
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function makeTitle(type: string, h: Record<string, any>, fileName: string): string {
  const num = h.numero ?? h.reference_interne ?? h.reference;
  const date = h.date ?? h.date_gregorienne;
  const obj = h.titre ?? h.objet;
  if (type === "circulaire" || type === "note") {
    const label = type === "circulaire" ? "Circulaire" : "Note";
    return `${label} n° ${num ?? "?"}${date ? ` du ${frDate(date)}` : ""}${obj ? ` — ${obj}` : ""}`.slice(0, 400);
  }
  return String(obj ?? num ?? fileName.replace(/\.json$/i, "")).slice(0, 400);
}

/** Découpe un texte trop long en morceaux ≤ MAX_CHUNK, en coupant de préférence entre paragraphes / phrases. */
function split(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
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

const asText = (v: unknown): string =>
  Array.isArray(v) ? v.map((x) => `- ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n") : String(v ?? "");

const FICHE_FIELDS: [string, string][] = [
  ["objet", "Objet"], ["resume", "Résumé"], ["contenu_synthetique", "Synthèse"], ["contenu_complet", "Contenu"],
  ["points_cles", "Points clés"], ["impact_operationnel", "Impact opérationnel"], ["abrogations", "Abrogations"],
  ["references", "Références"], ["references_legales", "Références légales"], ["mots_cles", "Mots-clés"],
];

export function prepare(fileName: string, data: unknown): Prepared {
  if (!isObj(data)) throw new Error("Format non reconnu : un objet JSON est attendu.");

  let type: string;
  let header: Record<string, any>;
  let raw: { id: string; content: string; metadata: Record<string, any>; index?: number }[];

  if (Array.isArray(data.chunks)) {
    // ---- Formats 1 et 2 ----
    const hk = HEADER_KEYS.find((k) => isObj(data[k]));
    type = hk ?? "document";
    header = hk ? data[hk] : Object.fromEntries(Object.entries(data).filter(([k]) => k !== "chunks"));
    raw = data.chunks.flatMap((c: any, i: number) => {
      const content = String(c?.content ?? c?.contenu ?? c?.text ?? c?.texte ?? "").trim();
      if (!content) return [];
      const id = String(c?.id ?? `chunk_${i}`);
      const meta = isObj(c?.metadata) ? c.metadata : {};
      const pieces = split(content);
      const index = typeof c?.index === "number" ? c.index : undefined;
      return pieces.map((p, j) => ({ id: pieces.length > 1 ? `${id}__${j + 1}` : id, content: p, metadata: meta, index }));
    });
  } else {
    const listKey = Object.keys(data).find((k) => Array.isArray(data[k]) && data[k].length > 5 && isObj(data[k][0]));
    if (listKey) {
      // ---- Format 4 : liste d'entrées, regroupées par 40 ----
      type = "liste";
      const hk = Object.keys(data).find((k) => k !== listKey && isObj(data[k]));
      header = hk ? data[hk] : {};
      const items: any[] = data[listKey];
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
          content: `${intro}\nEntrées ${i + 1} à ${i + group.length} sur ${items.length} :\n${lines}${header.avertissement_global ? `\n\nAvertissement : ${header.avertissement_global}` : ""}`,
          metadata: { domaine: first.domaine, sous_domaine: first.sous_domaine, motif: first.motif, source: first.source },
        });
      }
      header = { ...header, numero: header.numero ?? first.source?.numero, date: header.date ?? first.source?.date, emetteur: header.emetteur ?? header.organisme_emetteur_liste };
    } else {
      // ---- Format 3 : fiche de synthèse ----
      type = "fiche";
      header = data;
      const body = FICHE_FIELDS.filter(([k]) => data[k]).map(([k, label]) => `${label} :\n${asText(data[k])}`).join("\n\n");
      if (!body.trim()) throw new Error("Aucun contenu exploitable (ni « chunks », ni champs de texte reconnus).");
      const meta = { domaine: data.domaine ?? data.categorie, sous_domaine: data.sous_domaine ?? data.sous_categorie, mots_cles: data.mots_cles, statut: data.statut };
      raw = split(body).map((p, j) => ({ id: `fiche_${j + 1}`, content: p, metadata: meta }));
    }
  }

  // Un en-tête peut imposer son titre affiché et son type (ex. loi, décret, arrêté) — utile pour les lots convertis.
  const titre = str(header.titre_affiche) ?? makeTitle(type, header, fileName);
  const docType = str(header.doc_type) ?? type;
  const smallHeader = Object.fromEntries(Object.entries(header).filter(([, v]) => !(typeof v === "string" && v.length > 4000)));

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
    header: smallHeader,
  };

  // Déduplique les identifiants de chunk éventuellement répétés dans un même fichier
  const seen = new Map<string, number>();
  const chunks = raw.map((c, i) => {
    const n = (seen.get(c.id) ?? 0) + 1; seen.set(c.id, n);
    const chunk_id = n > 1 ? `${c.id}__dup${n}` : c.id;
    const m = c.metadata;
    const metadata = { ...m, title: titre, doc_type: docType, numero: doc.numero, statut: m.statut ?? doc.statut };
    const path = [m.domaine, m.sous_domaine].filter(Boolean).join(" › ");
    const embed_text = [titre, path, m.article ? `Article : ${m.article}` : "", "", c.content].filter((x, k) => x || k === 3).join("\n").slice(0, 8000);
    return { chunk_id, chunk_index: typeof c.index === "number" ? c.index : i, content: c.content, metadata, embed_text };
  });

  return { doc, chunks };
}
