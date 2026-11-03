// Import des lots au format « paire » : <doc>.md (en-tête YAML + texte) + <doc>.jsonl (un extrait par ligne).
// - regroupe les extraits courts consécutifs d'un même document (≈ CIBLE caractères) : ~2 fois moins de vecteurs
// - découpe les extraits trop longs (> MAX) sur les paragraphes
// - écarte les contenus strictement identiques déjà vus et les documents listés dans EXCLURE
// - envoie les gros documents en plusieurs parties
//
// Usage :
//   node import_lex.mjs "<dossier>" --apercu                       (analyse seule, n'envoie rien)
//   node import_lex.mjs "<dossier>" "<mot de passe maître>"        (import)
//   options : --only=<doc_id>  --exclure=<doc_id,doc_id>  --prefixe=lex/

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";

const API = "https://shnniddpgtnukexuzhxc.supabase.co/functions/v1/admin-api";
const KEY = "sb_publishable_XVNn-qjeJMtmpUIlM9AAzA_5my4LUQo";
const CIBLE = 1800, MAX = 3000, PARTIE = 200;

const args = process.argv.slice(2);
const dir = args[0];
const apercu = args.includes("--apercu");
const password = apercu ? null : args[1];
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=");
const only = opt("only");
const prefixe = opt("prefixe") || "lex/";
const EXCLURE = new Set([
  // résumés ADII déjà présents en version complète dans la base
  "circ-adii-5322-210-resume", "circ-adii-5549-230-resume", "circ-adii-6142-300-resume", "note-adii-10675-314-resume",
  "circ-adii-6337-311-resume", "circ-adii-5877-312-resume", "circ-adii-6343-311-resume",
  ...opt("exclure").split(",").filter(Boolean),
]);
if (!dir || (!apercu && !password)) { console.error('Usage : node import_lex.mjs "<dossier>" "<mot de passe>" | --apercu'); process.exit(1); }

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
function typeDoc(t) {
  const n = norm(t).replace(/\s+/g, "-");
  if (!n) return "document";
  if (t === "مرسوم") return "decret";
  if (t === "قانون" || n.startsWith("loi")) return n.startsWith("loi-organique") || n === "loi_organique" ? "loi-organique" : "loi";
  if (n.startsWith("dahir")) return "dahir";
  if (n.startsWith("decret")) return "decret";
  if (n.startsWith("arrete")) return "arrete";
  return n.replace(/_/g, "-");
}
const isoDate = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : (v == null ? null : String(v));
const corps = (c) => c.replace(/^\[[^\]\n]{0,300}\]\s*/, "").trim();

function lireEnTete(mdPath) {
  const t = fs.readFileSync(mdPath, "utf8").replace(/^﻿/, "");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error("en-tête YAML absent");
  return yaml.load(m[1]) || {};
}

function decouper(txt) {
  if (txt.length <= MAX) return [txt];
  const out = []; let rest = txt;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf("\n\n", MAX);
    if (cut < MAX * 0.5) cut = rest.lastIndexOf("\n", MAX);
    if (cut < MAX * 0.5) cut = rest.lastIndexOf(". ", MAX) + 1;
    if (cut < MAX * 0.5) cut = MAX;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const vus = new Set();   // empreintes des contenus déjà retenus (doublons stricts)
function convertir(docId, dossier) {
  const h = lireEnTete(path.join(dossier, docId + ".md"));
  const rows = fs.readFileSync(path.join(dossier, docId + ".jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const domaine = Array.isArray(h.domaine) ? h.domaine.join(", ") : (h.domaine ?? null);
  const header = {
    ...h,
    titre_affiche: String(h.titre ?? docId),
    doc_type: typeDoc(h.type),
    type_origine: h.type ?? null,
    date: isoDate(h.date),
    statut: h.statut ?? null,
    abroge_ou_modifie: h.abroge && (!Array.isArray(h.abroge) || h.abroge.length) ? h.abroge : null,
    modifie_par: h.modifie_par && (!Array.isArray(h.modifie_par) || h.modifie_par.length) ? h.modifie_par : null,
    lot: "LEX LEGIS — compilation générale 10.26",
  };
  delete header.titre;
  for (const k of Object.keys(header)) if (header[k] instanceof Date) header[k] = isoDate(header[k]);

  // 1. doublons stricts + extraits vides
  let ecartes = 0;
  const propres = rows.filter((r) => {
    const b = corps(String(r.content ?? ""));
    if (!b) { ecartes++; return false; }
    const k = crypto.createHash("md5").update(b).digest("hex");
    if (vus.has(k)) { ecartes++; return false; }
    vus.add(k); return true;
  });

  // 2. regroupement des extraits consécutifs (sans dépasser CIBLE), découpe des trop longs
  const groupes = []; let cur = null;
  const fermer = () => { if (cur) groupes.push(cur); cur = null; };
  for (const r of propres) {
    const c = String(r.content).trim();
    if (c.length > MAX) {
      fermer();
      decouper(c).forEach((p, j) => groupes.push({ ids: [r.chunk_id + (j ? `~${j + 1}` : "")], parts: [p], rows: [r] }));
      continue;
    }
    if (cur && cur.len + c.length + 2 > CIBLE) fermer();
    if (!cur) cur = { ids: [], parts: [], rows: [], len: 0 };
    cur.ids.push(r.chunk_id); cur.parts.push(c); cur.rows.push(r); cur.len += c.length + 2;
  }
  fermer();

  const chunks = groupes.map((g, i) => {
    const chemins = [...new Set(g.rows.map((r) => r.chemin).filter(Boolean))];
    const articles = [...new Set(g.rows.map((r) => r.article).filter(Boolean))];
    const pd = g.rows.map((r) => r.page_debut).filter((x) => x != null), pf = g.rows.map((r) => r.page_fin).filter((x) => x != null);
    return {
      id: g.ids.length > 1 ? `${g.ids[0]}+${g.ids.length - 1}` : g.ids[0],
      index: i,
      content: g.parts.join("\n\n"),
      metadata: {
        domaine,
        sous_domaine: chemins.length > 1 ? `${chemins[0]} … ${chemins[chemins.length - 1]}` : (chemins[0] ?? null),
        article: articles.length ? articles.join(", ").slice(0, 300) : null,
        chemins: chemins.slice(0, 30),
        page_debut: pd.length ? Math.min(...pd) : null,
        page_fin: pf.length ? Math.max(...pf) : null,
        extraits_source: g.ids.length,
      },
    };
  });
  return { header, chunks, source: rows.length, ecartes };
}

// ------------------------------------------------------------------ main
const fichiers = fs.readdirSync(dir);
const ids = fichiers.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6))
  .filter((d) => fichiers.includes(d + ".md")).filter((d) => !only || d === only).sort();
const ignores = ids.filter((d) => EXCLURE.has(d));
const docs = []; const erreurs = [];
for (const d of ids) {
  if (EXCLURE.has(d)) continue;
  try { docs.push({ id: d, ...convertir(d, dir) }); } catch (e) { erreurs.push(`${d} : ${e.message}`); }
}
const src = docs.reduce((a, d) => a + d.source, 0), out = docs.reduce((a, d) => a + d.chunks.length, 0), ec = docs.reduce((a, d) => a + d.ecartes, 0);
const orphelins = fichiers.filter((f) => f.endsWith(".md") && !fichiers.includes(f.slice(0, -3) + ".jsonl"));
console.log(`Documents : ${docs.length} à importer · ${ignores.length} ignorés (doublons ADII) · ${orphelins.length} .md sans .jsonl ignorés · ${erreurs.length} en erreur`);
console.log(`Extraits : ${src} dans les fichiers → ${out} après regroupement (${ec} doublons/vides écartés)`);
erreurs.forEach((x) => console.log("  ✗ " + x));
if (apercu) {
  const types = {}; docs.forEach((d) => (types[d.header.doc_type] = (types[d.header.doc_type] || 0) + 1));
  console.log("Types :", JSON.stringify(types));
  const ex = docs.find((d) => d.id === "loi-93-18") || docs[0];
  console.log("\nExemple :", JSON.stringify({ titre: ex.header.titre_affiche, doc_type: ex.header.doc_type, date: ex.header.date, statut: ex.header.statut, chunk0: { ...ex.chunks[0], content: ex.chunks[0].content.slice(0, 200) + "…" } }, null, 1));
  const tailles = docs.flatMap((d) => d.chunks.map((c) => c.content.length)).sort((a, b) => a - b);
  console.log("Taille des extraits : médiane", tailles[tailles.length >> 1], "· max", tailles[tailles.length - 1]);
  process.exit(0);
}

let token = null;
async function call(action, body = {}) {
  const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", apikey: KEY, ...(token ? { "x-admin-token": token } : {}) }, body: JSON.stringify({ action, ...body }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
async function envoyer(fileName, header, chunks, allIds) {
  for (let attempt = 1; ; attempt++) {
    try { return await call("ingest_file", { file_name: fileName, data: { document: header, chunks }, ...(allIds ? { all_chunk_ids: allIds } : {}) }); }
    catch (e) {
      if (e.status === 401) { token = (await call("login", { password })).token; continue; }
      if (attempt >= 4 || ![429, 500, 502, 503, 504, 546].includes(e.status)) throw e;
      await new Promise((z) => setTimeout(z, 3000 * attempt));
    }
  }
}

token = (await call("login", { password })).token;
console.log("Connecté. Import en cours…");
const t0 = Date.now(); let fait = 0, ok = 0, total = 0, vect = 0; const echecs = [];
const file = [...docs].sort((a, b) => b.chunks.length - a.chunks.length);   // gros documents d'abord
async function worker() {
  while (file.length) {
    const d = file.shift(); const fileName = prefixe + d.id;
    try {
      const allIds = d.chunks.map((c) => c.id);
      if (d.chunks.length <= PARTIE) { const r = await envoyer(fileName, d.header, d.chunks, null); vect += r.embedded; }
      else for (let i = 0; i < d.chunks.length; i += PARTIE) { const r = await envoyer(fileName, d.header, d.chunks.slice(i, i + PARTIE), allIds); vect += r.embedded; }
      ok++; total += d.chunks.length;
    } catch (e) { echecs.push(`${d.id} : ${e.message}`); }
    fait++;
    if (fait % 25 === 0 || fait === docs.length) console.log(`  ${fait}/${docs.length} · ${ok} OK · ${echecs.length} erreurs · ${total} extraits (${vect} vectorisés) · ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(`\nTerminé en ${Math.round((Date.now() - t0) / 1000)} s : ${ok} documents importés, ${echecs.length} en erreur.`);
echecs.forEach((x) => console.log("  ✗ " + x));
