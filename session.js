// Session partagée entre les deux pages de l'onglet : elle prend fin à la fermeture de l'onglet ou du navigateur
// (et au plus tard après 8 h). Le jeton est vérifié côté serveur à chaque appel.
const RAG = (() => {
  const C = window.RAG_CONFIG;
  const KEY = "rag_session";

  function get() {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY));
      if (!s || !s.token || s.exp < Date.now()) { sessionStorage.removeItem(KEY); return null; }
      return s;
    } catch { return null; }
  }
  function set(s) { sessionStorage.setItem(KEY, JSON.stringify({ ...s, exp: Date.now() + 8 * 3600e3 })); }
  function clear() { sessionStorage.removeItem(KEY); try { localStorage.removeItem(KEY); } catch {} }

  const fail = (msg, status = 0) => { const e = new Error(msg); e.status = status; return e; };

  function configured() {
    return C.SUPABASE_URL && !/VOTRE-PROJET/.test(C.SUPABASE_URL) && C.SUPABASE_ANON_KEY && !/^VOTRE/.test(C.SUPABASE_ANON_KEY);
  }

  async function call(fn, body = {}) {
    if (!configured()) throw fail("Le site n'est pas encore relié à Supabase : renseignez SUPABASE_URL et SUPABASE_ANON_KEY dans config.js.");
    const s = get();
    let res;
    try {
      res = await fetch(`${C.SUPABASE_URL.replace(/\/$/, "")}/functions/v1/${fn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: C.SUPABASE_ANON_KEY, ...(s ? { "x-admin-token": s.token } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw fail(`Impossible de joindre Supabase. Vérifiez que le projet n'est pas en pause, que l'URL de config.js est correcte et que la fonction « ${fn} » est déployée.`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 404 && !data.error) throw fail(`La fonction « ${fn} » n'est pas déployée sur ce projet Supabase.`, 404);
    if (!res.ok) throw fail(data.error || data.message || data.msg || `Erreur ${res.status} renvoyée par Supabase.`, res.status);
    return data;
  }

  /** JSON.parse tolérant : échappe les retours à la ligne / tabulations bruts à l'intérieur des chaînes. */
  function parseJsonLenient(text) {
    text = text.replace(/^\uFEFF/, "");
    try { return JSON.parse(text); } catch (first) {
      let out = "", inStr = false, esc = false;
      for (const ch of text) {
        if (inStr) {
          if (esc) { out += ch; esc = false; continue; }
          if (ch === "\\") { out += ch; esc = true; continue; }
          if (ch === '"') { inStr = false; out += ch; continue; }
          const code = ch.charCodeAt(0);
          if (code < 32) { out += ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : ch === "\r" ? "\\r" : ""; continue; }
          out += ch;
        } else { if (ch === '"') inStr = true; out += ch; }
      }
      try { return JSON.parse(out); } catch { throw first; }
    }
  }

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  return { C, get, set, clear, call, esc, configured, parseJsonLenient };
})();
