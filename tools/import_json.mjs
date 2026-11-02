// Import en masse des fichiers JSON vers Legis Codex (même chemin que l'onglet « Base documentaire »).
// Usage :  node import_json.mjs "<dossier des JSON>" "<mot de passe maître>"
// Nécessite Node 18+. Aucune clé OpenAI ici : la vectorisation est faite par Supabase.

import fs from "node:fs";
import path from "node:path";

const URL = "https://shnniddpgtnukexuzhxc.supabase.co/functions/v1/admin-api";
const KEY = "sb_publishable_XVNn-qjeJMtmpUIlM9AAzA_5my4LUQo";
const [dir, password] = process.argv.slice(2);
if (!dir || !password) { console.error('Usage : node import_json.mjs "<dossier>" "<mot de passe maître>"'); process.exit(1); }

function parseLenient(text) {
  text = text.replace(/^﻿/, "");
  try { return JSON.parse(text); } catch (first) {
    let out = "", inStr = false, esc = false;
    for (const ch of text) {
      if (inStr) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === "\\") { out += ch; esc = true; continue; }
        if (ch === '"') { inStr = false; out += ch; continue; }
        if (ch.charCodeAt(0) < 32) { out += ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : ch === "\r" ? "\\r" : ""; continue; }
        out += ch;
      } else { if (ch === '"') inStr = true; out += ch; }
    }
    try { return JSON.parse(out); } catch { throw first; }
  }
}

let token = null;
async function call(action, body = {}) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: KEY, ...(token ? { "x-admin-token": token } : {}) },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}

token = (await call("login", { password })).token;
console.log("Connecté en administrateur principal.");

const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort();
console.log(`${files.length} fichiers à importer…`);
let done = 0, ok = 0, chunks = 0, embedded = 0; const failed = [];
const queue = [...files]; const t0 = Date.now();

async function worker() {
  while (queue.length) {
    const f = queue.shift();
    try {
      const data = parseLenient(fs.readFileSync(path.join(dir, f), "utf8"));
      let r;
      for (let attempt = 1; ; attempt++) {
        try { r = await call("ingest_file", { file_name: f, data }); break; }
        catch (e) {
          if (e.status === 401) { token = (await call("login", { password })).token; continue; }
          if (attempt >= 3 || ![429, 500, 502, 503, 504].includes(e.status)) throw e;
          await new Promise((z) => setTimeout(z, 2000 * attempt));
        }
      }
      ok++; chunks += r.chunks; embedded += r.embedded;
    } catch (e) { failed.push(`${f} : ${e.message}`); }
    done++;
    if (done % 20 === 0 || done === files.length) console.log(`  ${done}/${files.length} · ${ok} OK · ${failed.length} erreurs · ${chunks} extraits (${embedded} vectorisés)`);
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(`\nTerminé en ${Math.round((Date.now() - t0) / 1000)} s : ${ok} fichiers importés, ${failed.length} en erreur.`);
failed.forEach((x) => console.log("  ✗ " + x));
