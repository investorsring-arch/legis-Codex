# Site RAG privé — 2 pages + Supabase

```
.env.local               ← SECRETS (mot de passe maître, clés) — à envoyer sur Supabase, jamais en ligne
public/                  ← LE SITE à mettre sur Cloudflare Pages (seul ce dossier est publié)
  index.html             ← connexion obligatoire, puis questions / réponses avec sources
  admin.html             ← tableau de bord : Membres · Assistant · Journal
  session.js, style.css, config.js
supabase/
  migrations/001_rag_site.sql          ← tables membres, réglages de l'assistant, journal
  migrations/002_base_documentaire.sql ← documents, extraits vectorisés, recherche hybride match_documents
  functions/rag-chat/           ← l'assistant : reformulation → recherche → réponse LLM
  functions/admin-api/          ← connexion, gestion des membres, réglages, test de recherche
  functions/_shared/            ← sécurité, moteur RAG, préparation des fichiers JSON (ingest.ts)
```

## Qui accède à quoi

| | Site (questions) | Tableau de bord |
|---|---|---|
| **Administrateur principal** (mot de passe maître, champ email vide) | oui | Membres + Base documentaire + Assistant + Journal |
| **Membre** (email + mot de passe créés dans le tableau de bord) | oui | Journal et statistiques uniquement |
| Sans connexion | **non** — écran de connexion ; le serveur refuse toute question | non |

Bloquer ou supprimer un membre coupe son accès immédiatement. Sessions de 8 h.

## L'assistant (onglet « Assistant » du tableau de bord)

Réglable sans toucher au code : consignes du LLM, langue des réponses, questions suggérées,
fournisseur et modèle (Claude / OpenAI), température, longueur, reformulation des questions de suivi,
fonction de recherche Supabase, nombre d'extraits, seuil, modèle d'embedding.
Le bouton **Tester la recherche** montre ce que la base renvoie avec les réglages affichés — idéal pour valider la connexion.

## Installation

### 1. Base de données
Supabase → **SQL Editor** → coller et exécuter **dans l'ordre** :
1. `supabase/migrations/001_rag_site.sql`
2. `supabase/migrations/002_base_documentaire.sql`

Les deux scripts peuvent être relancés sans risque.

### 2. Secrets
Ouvrez `.env.local`, complétez les clés `OPENAI_API_KEY` et `ANTHROPIC_API_KEY`
(le mot de passe maître et `SESSION_SECRET` sont déjà remplis), puis :
```bash
npm i -g supabase
supabase login
supabase link --project-ref VOTRE_REF
supabase secrets set --env-file .env.local
```
Sans terminal : Supabase → Edge Functions → **Secrets** → ajouter chaque ligne à la main.
Pour changer le mot de passe maître plus tard : modifier `.env.local` et relancer `supabase secrets set --env-file .env.local`.

### 3. Fonctions
```bash
supabase functions deploy rag-chat --no-verify-jwt
supabase functions deploy admin-api --no-verify-jwt
```

### 4. Configurer le site
`public/config.js` : `SUPABASE_URL` et la clé **anon / publishable** (Supabase → Settings → API).
Ces deux valeurs sont publiques par nature ; elles ne donnent accès à rien sans connexion.

### 5. Mettre en ligne sur Cloudflare Pages (sans GitHub)
1. dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages** → **Drag and drop your files**.
2. Nommer le projet, glisser **le dossier `public`** (ou un zip de ce dossier) → **Deploy site**.
3. Le site est en ligne sur `https://<nom>.pages.dev`.
4. Ajouter `ALLOWED_ORIGIN=https://<nom>.pages.dev` dans `.env.local` et relancer `supabase secrets set --env-file .env.local`.

Mises à jour : même écran → **Create new deployment** → glisser à nouveau `public`.
En ligne de commande : `npx wrangler pages deploy public --project-name <nom>`.
Note : un projet créé par glisser-déposer ne peut pas être converti ensuite en projet relié à GitHub (il faudrait en créer un nouveau).

### 6. Charger les documents (ingestion des JSON)
Tableau de bord → onglet **Base documentaire** → **Choisir un dossier** (ou des fichiers) → **Importer**.
Pour chaque fichier, la fonction découpe les extraits, calcule les vecteurs (OpenAI), puis enregistre dans
`rag_documents` / `rag_chunks`. Un journal indique les fichiers en erreur. Réimporter un fichier le met à jour
(seuls les extraits modifiés sont recalculés) ; le supprimer depuis la liste retire tous ses extraits.

Formats acceptés : `{ "circulaire"|"note"|"document": {…}, "chunks": [{id, content, metadata}] }`,
fiches de synthèse sans chunks (`objet`, `resume`, `points_cles`…), listes (`liste_source` + tableau d'entrées).

Vérifier ensuite : onglet **Assistant** → **Tester la recherche**.

## Dépannage connexion
| Message | Cause | Solution |
|---|---|---|
| « pas encore relié à Supabase » | `config.js` non rempli | renseigner URL + clé publique |
| « Impossible de joindre Supabase » | projet en pause, URL fausse, fonction non déployée | Supabase → Restore project ; vérifier l'URL ; `supabase functions deploy …` |
| « fonction … n'est pas déployée » | fonction absente | étape 3 |
| « Configuration incomplète : … » | secret manquant ou script SQL non exécuté | étapes 1 et 2 |
| « Mot de passe incorrect » | mauvais mot de passe, ou secrets non renvoyés après modification de `.env.local` | relancer `supabase secrets set --env-file .env.local` |

L'administrateur principal se connecte en laissant le champ **email vide**.

## Sécurité
- Le mot de passe maître actuel (`123`) est un mot de passe de TEST : remplacez-le avant d'inviter des membres.
- `.env.local` ne doit jamais être publié (exclu par `.gitignore`, hors du dossier `public/`).
- Tables en RLS sans policy : illisibles avec la clé publique ; seules les fonctions y accèdent.
- Mots de passe des membres hachés (PBKDF2-SHA256, 100 000 itérations), sessions signées HMAC.
- Délai après un échec de connexion ; limite de questions par minute et par membre.
- Pages en `noindex`.
