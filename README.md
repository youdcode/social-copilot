# Copilote X

Un service qui suit l'actualité tech, prépare des brouillons de posts pour un compte X et te les propose dans un bot Telegram privé. **Il ne publie jamais rien** : tu relis, tu copies, tu postes toi-même depuis l'appli X.

- **Veille** : comptes X choisis (API officielle, en lecture seule), flux RSS et Hacker News.
- **Rédaction** : Mistral vérifie le sujet par une recherche web, puis rédige en anglais, dans la voix que tu as définie.
- **Contrôles par le code** avant chaque envoi : sources réelles, 280 caractères au sens de X, aucun terme interdit, sujet frais et pas déjà traité.
- **Telegram** : cartes de brouillon (Copier, Posté, Modifier, Non), posts à qui répondre, réponses reçues, demandes de visuels, conversation libre avec Mistral, dépenses du jour.

L'interface du bot est en français ; les posts sont rédigés en anglais.

## Garde-fous

- **X en lecture seule, par l'API officielle.** Jamais de scraping ni d'automatisation de navigateur : c'est ce qui fait suspendre un compte. L'application X est réglée en « Read only » : ses jetons ne peuvent rien écrire.
- **Aucune publication.** Aucun code n'envoie quoi que ce soit vers X.
- **Sourcé ou rien.** Un brouillon ne garde que les URL réellement renvoyées par la recherche web de Mistral, plus celle de l'élément déclencheur. Sans source, il est rejeté.
- **Rien d'inventé.** Le déclencheur doit dater de moins de 24 h, et le prompt interdit chiffres, citations et dates absents des sources.
- **Anonymat.** Une liste de termes interdits (ton nom, ta ville, ton entreprise…) est contrôlée dans chaque brouillon, chaque réécriture, chaque réponse et chaque message de Mistral. Sans cette liste, le service refuse de générer.
- **Plafonds de dépense journaliers**, TVA comprise : 1 € pour Mistral et 1,80 $ pour X par défaut. Au plafond, les appels payants s'arrêtent jusqu'au lendemain et le bot prévient une fois.
- **Bot privé.** Il ne répond qu'à ton identifiant de chat Telegram. Tout autre expéditeur est ignoré, messages comme clics.

## Prérequis

- macOS ou Linux, avec **Node 24 LTS** (voir `.node-version` et `.nvmrc`). `npm install` refuse une autre version.
- Un compte développeur X en paiement à l'usage, avec des crédits.
- Une clé API Mistral, de préférence dans une organisation dédiée.
- Un compte Telegram.

> Ne place pas le projet dans un dossier synchronisé par iCloud (Bureau, Documents) : macOS y remplace les fichiers peu utilisés par des copies en ligne, ce qui bloque Node au démarrage et expose `.env` et la base SQLite. Un dossier comme `~/dev` convient.

## Installation pas à pas

### 1. Le code

```sh
git clone <url-du-dépôt> copilote-x
cd copilote-x
npm ci
npm run check   # types + tests, sans aucun appel réseau
cp .env.example .env
```

### 2. Mistral

1. Crée une clé API dans une organisation ou un espace de travail dédié au projet, et mets-la dans `.env` sous `MISTRAL_API_KEY`.
2. Dans *Admin panel › Privacy*, coupe **Anonymous improvement data**. L'accord développeur de X interdit de laisser entraîner un modèle sur du contenu X.
3. Fixe un plafond mensuel sur l'espace de travail : c'est le second filet, après le plafond journalier du code.
4. Vérifie que le paiement à l'usage est actif. Une limite de 0 requête par minute fait échouer chaque appel (erreur 429).

Les conversations sont ouvertes avec `store: false`. Les modèles sont figés dans `config/config.json` (jamais d'alias `-latest`).

### 3. X

Sur [console.x.com](https://console.x.com), connecté avec le compte qui publiera :

1. Dans les réglages d'authentification de l'app, mets les permissions sur **Read only**. Si un site et une adresse de rappel sont exigés, mets l'URL du profil X et `http://127.0.0.1`.
2. Dans *Keys and tokens*, récupère le **Bearer Token** (`X_BEARER_TOKEN`) et l'**API Key & Secret** (`X_API_KEY`, `X_API_SECRET`).
3. **Seulement ensuite**, génère l'**Access Token & Secret** (`X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`). Un jeton garde le niveau d'accès qu'avait l'app au moment de sa création : s'il a été généré avant le passage en « Read only », régénère-le.
4. Ajoute des crédits, fixe un plafond de dépense et coupe la recharge automatique.
5. Dans la description du cas d'usage, mentionne le traitement par un LLM et le stockage local.

Les quatre jetons du compte sont facultatifs : sans eux, tout fonctionne sauf « Réponses reçues ».

### 4. Telegram

1. Crée le bot avec [@BotFather](https://t.me/BotFather), avec un nom neutre. Désactive les groupes (*Allow Groups* : off) et le mode inline.
2. Mets le jeton dans `.env` sous `TELEGRAM_BOT_TOKEN`.
3. Lance `npm run telegram:chat-id`, puis écris n'importe quoi au bot. La commande affiche `TELEGRAM_ALLOWED_CHAT_ID=…` : copie la ligne dans `.env`. Le bot ne répond rien.

### 5. Tes fichiers, hors git

```sh
cp voice.example.md voice.md
cp config/forbidden-terms.example.txt config/forbidden-terms.txt
```

- **`voice.md`** : la voix du compte, en anglais, envoyée à Mistral à chaque rédaction. Les commentaires `<!-- … -->` sont ignorés.
- **`config/forbidden-terms.txt`** : un terme par ligne (nom, pseudo, ville, entreprise, proches). Casse et accents ignorés, recherche même dans un mot collé : « Acme » attrape « AcmeAI » et « acme.io ». Évite les mots courants, ils bloqueraient des textes anodins.

`.gitignore` exclut déjà ces deux fichiers, `.env` et `data/`.

### 6. La veille

Dans `config/config.json`, ajuste les comptes X suivis (`x.watchedAccounts`), les flux RSS (`sources.rssFeeds`), les créneaux et le fuseau horaire. Le fichier est validé au démarrage : une clé inconnue ou une valeur hors bornes est refusée, avec un message qui la nomme.

Puis résous les identifiants des comptes suivis, une fois pour toutes (0,01 $ par compte) :

```sh
npm run x:resolve
```

Elle affiche ce que X dit de chaque compte : retire de la config tout pseudo qui ne correspond pas à celui que tu visais.

### 7. Test à blanc, puis lancement

```sh
npm run dry-run   # une veille et un brouillon réels, affichés ici, jamais envoyés ni stockés
npm start         # le service et le bot ; Ctrl+C pour arrêter
```

Envoie `/start` au bot.

## Utilisation du bot

- **`/start`** : un bouton par réseau. X est actif ; les autres réseaux restent grisés tant qu'ils ne sont pas activés dans la config.
- **Brouillons** : un message par brouillon, avec une notification. Il comporte le texte, le pilier, une phrase « pourquoi », les sources et une éventuelle demande de visuel.
  - **Copier** : bouton de copie natif jusqu'à 256 caractères (limite de Telegram), sinon texte dans un bloc à copier.
  - **Posté** : à toucher une fois publié. Le bot te propose ensuite d'enregistrer le lien du tweet.
  - **Modifier** : réponds à la carte avec une consigne (« plus court », « angle prix »…). Mistral réécrit sans recherche web, donc sans ajouter de fait, et une nouvelle carte arrive.
  - **Non** : motif facultatif, puis un nouveau sujet arrive tout de suite. Un clic rejoué par Telegram ne relance pas une seconde génération.
- **À qui répondre** : parmi les posts récents des comptes suivis, Mistral repère ceux qui valent une réponse et propose 3 variantes, chacune avec son bouton de copie. Une réponse porte surtout sur un post de moins d'une heure.
- **Réponses reçues** : les réponses et mentions reçues par le compte, avec le post auquel elles répondent, un avis et 3 variantes. Le bot te prévient quand il y en a de nouvelles.
- **Demandes de visuels** : type, brief et durée, avec un bouton « Matière prête ».
- **Messages libres** : ils partent à Mistral, avec la voix du compte et le brouillon en cours ; `/reset` efface l'historique. Un lien de post X (`x.com/…/status/…`) déclenche l'avis et 3 variantes. Si tu colles aussi son texte, X n'est pas sollicité.
- **`/stats`** : posts publiés, réponses faites, dépenses face aux plafonds. **`/help`** : l'aide.

Quatre créneaux par jour par défaut (9 h, 13 h, 17 h, 21 h, heure de Paris). Un créneau est sauté si un brouillon attend encore ta décision. Après une mise en veille, seul le créneau en cours est traité : les créneaux manqués ne s'empilent pas.

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm start` | Service et bot. Une seule instance à la fois (verrou dans `data/`). |
| `npm run dry-run` | Test à blanc : une veille et un brouillon réels, affichés, ni stockés ni envoyés. |
| `npm run x:resolve` | Résout les identifiants des comptes suivis (une fois par compte). |
| `npm run x:purge -- <id>` | Supprime un post X de la base, sur demande. |
| `npm run telegram:chat-id` | Affiche l'identifiant du chat qui écrit au bot. |
| `npm run mac:install` / `mac:uninstall` / `mac:status` | Lancement automatique sur le Mac (launchd). |
| `npm run db:migrate` | Crée ou met à jour la base SQLite. Le service le fait seul au démarrage. |
| `npm run check` | Vérifie les types, puis lance les tests. |

## Coûts

Les tarifs sont dans `config/config.json`. Mets-les à jour si les fournisseurs changent les leurs.

- **X**, facturé à l'usage : 0,005 $ par post lu, 0,010 $ par compte résolu, 0,001 $ par mention du compte (tarif « Owned Reads »). Un post relu le même jour UTC n'est pas refacturé, et une requête sans résultat n'est pas facturée. Avec 40 comptes suivis, compte de l'ordre de 0,80 $ TTC par jour.
- **Mistral** : jetons d'entrée et de sortie, plus environ 0,03 € par recherche web. Un brouillon coûte quelques centimes.
- Les deux plafonds journaliers (`mistral.dailyCapEur`, `x.dailyCapUsd`) incluent un coefficient de TVA (`vatMultiplier`, 1,2 par défaut). Le plafond Mistral suit le jour du fuseau de la config, le plafond X le jour UTC, comme la facture d'X.

## Données

Tout reste sur ta machine, dans `data/copilote.sqlite`.

- Le texte des posts X lus (veille, mentions, posts collés) est **purgé 24 h après sa lecture**. Seuls restent les identifiants et les URL. `npm run x:purge -- <id>` efface un post sur demande.
- Ce qui part chez Mistral : les éléments de veille, la voix du compte, tes consignes et tes messages libres.
- Ce qui part chez Telegram : les cartes et les réponses du bot, dans ton chat privé.

## Déploiement

### Sur le Mac

```sh
npm run mac:install   # démarre à l'ouverture de session, redémarre après un plantage
npm run mac:status
npm run mac:uninstall # arrête et retire
```

- Journaux : `data/logs/service.log` et `data/logs/service.error.log`.
- Le service ne tourne que Mac allumé. Telegram garde 24 h les messages et clics envoyés pendant la veille du Mac ; au-delà, ils sont perdus.
- Après une mise à jour de Node ou un déplacement du dossier, relance `npm run mac:install`.

### Passer sur un VPS

Un seul bot ne peut être interrogé que par une seule instance. Si le Mac et le VPS tournent en même temps, Telegram renvoie une erreur 409 et la dépense double.

1. **Arrête le Mac d'abord** : `npm run mac:uninstall`, puis vérifie avec `npm run mac:status`.
2. Sur le VPS (Linux, Node 24) : copie le projet dans `/opt/copilote-x` avec `.env`, `voice.md`, `config/forbidden-terms.txt`, et `data/` si tu veux garder l'historique. Puis lance `npm ci`.
3. Crée un utilisateur système `copilote`, propriétaire de `/opt/copilote-x/data`.
4. Installe `deploy/copilote-x.service`, en adaptant les chemins si besoin :
   ```sh
   sudo cp deploy/copilote-x.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now copilote-x
   journalctl -u copilote-x -f
   ```
5. Envoie `/stats` au bot pour vérifier qu'il répond.

Pour revenir sur le Mac : `sudo systemctl disable --now copilote-x` sur le VPS, puis `npm run mac:install`.

Aucun port n'est ouvert et aucun nom de domaine n'est nécessaire : le bot fonctionne en long polling.

## Développement

- TypeScript exécuté directement par Node 24, types vérifiés par `tsc` sans compilation, tests avec `node:test`.
- Dépendances à version exacte, fichier de verrouillage versionné.
- Les tests ne font aucun appel réseau : Mistral, X et Telegram y sont simulés.

| Dossier | Contenu |
| --- | --- |
| `src/sources`, `src/x` | Veille RSS, Hacker News et X, mentions, signature OAuth 1.0a |
| `src/generation` | Regroupement en sujets, classement, rédaction, validation |
| `src/telegram` | Bot, cartes, menus |
| `src/assistant.ts`, `src/replies.ts` | Modifier, Parler à Mistral, avis et variantes de réponse |
| `src/spend.ts` | Comptage des dépenses et plafonds |
| `src/db` | Schéma SQLite et migrations |

## Licence

[MIT](LICENSE).
