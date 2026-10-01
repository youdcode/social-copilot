# Copilote X

Service local qui suit l'actualité tech (API officielle de X en lecture seule, flux RSS, Hacker News), prépare des brouillons de posts avec Mistral et les propose dans un bot Telegram privé. Il ne publie jamais rien : tout est posté à la main.

## Prérequis

- Node 24 LTS (voir `.node-version` et `.nvmrc`). `npm install` refuse une autre version.
- Un fichier `.env` avec les variables listées dans `.env.example`.
- `config/forbidden-terms.txt`, créé à partir de `config/forbidden-terms.example.txt`. Sans lui, rien n'est généré.

## Commandes

- `npm start` : lance le service. Un battement par minute : purge des textes X de plus de 24 h, veille toutes les 30 minutes (X, RSS, Hacker News), et brouillon du créneau en cours s'il n'a pas encore été traité. Une seule instance à la fois (verrou dans `data/`).
- `npm run dry-run` : test à blanc. Une veille réelle et un brouillon réel, affichés ici, jamais stockés ni envoyés.
- `npm run x:resolve` : résout les identifiants des comptes suivis pas encore résolus (0,01 $ par compte, une fois) et affiche ce que X en dit.
- `npm run x:purge -- <id>` : supprime un post X de la base, sur demande.
- `npm install` : installe les dépendances, à version exacte.
- `npm run check` : vérifie les types puis lance les tests.
- `npm test` : lance les tests seuls.
- `npm run db:migrate` : crée ou met à jour la base SQLite dans `data/`.
- `npm run telegram:chat-id` : affiche l'identifiant du chat qui écrit au bot, à reporter dans `TELEGRAM_ALLOWED_CHAT_ID`. Le bot ne répond rien.

## Configuration

- `config/config.json` : créneaux, réseaux, modèles et tarifs, plafonds de dépense, comptes suivis, flux RSS, durées de conservation. Le fichier est validé au chargement : une clé inconnue ou une valeur hors bornes est refusée avec un message qui la nomme.
- `.env` : secrets, jamais commité.
- Hors git : `.env`, `data/`, la liste de termes interdits et les notes locales.

## Runbook

À venir avec le déploiement.
