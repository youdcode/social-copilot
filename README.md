# Social Copilot

A service that follows tech news, drafts posts for your social accounts and proposes them in a private Telegram bot. **It never publishes anything**: you read, copy and post by hand from each app.

> **Status: early version.** Every part is covered by tests, with Mistral, X and Telegram faked, but the service has not run against the live APIs yet. Expect rough edges on a first install, and please open an issue when something breaks.

- **Watch**: RSS feeds and Hacker News, plus chosen X accounts if you give it X API keys (official API, read only).
- **Writing**: Mistral checks the topic with a web search, then writes in English, in the voice you defined, in the format of each network.
- **Checks in code** before anything reaches you:
  - real sources;
  - length as each network counts it;
  - no forbidden term;
  - a fresh topic, not covered already.
- **Visuals made on your computer**: carousels for Instagram (and for any post that calls for an image), motion design videos for TikTok and YouTube Shorts, sent under the draft card.
- **Telegram**:
  - draft cards with Open, Copy, Posted, Edit and No;
  - posts worth a reply and replies received (X);
  - asset requests;
  - a free conversation with Mistral;
  - the day's spend.

## Networks

Each network has its own format, slots and checks. Turn networks on or off in `config/config.json`.

| Network | What you get | Limit checked |
| --- | --- | --- |
| X | A tweet | 280, counted as X does (a URL is 23) |
| Threads | A post | 500 characters |
| Bluesky | A post | 300 characters (an emoji counts once) |
| LinkedIn | A post in short paragraphs, hashtags at the end | 1,500 characters |
| Instagram | A caption, plus a mandatory visual brief (image or carousel, slide by slide) | 1,000 characters |
| TikTok | A shot-by-shot script (hook, what to show, what to say, text on screen) and a caption | 90 s, caption 300 characters |
| YouTube Shorts | A title, a shot-by-shot script and a description | 90 s, title 100, description 1,000 |

Sources are the same for every network. The same news can go out on several networks; a topic refused on one network stays open on the others. Networks whose slots fall together share one grouping of the news into topics, so Mistral is paid once for it.

"Who to reply to" and "Replies received" work on X only, since X is the only network the service reads.

## Visuals

Made on your computer, free, and sent as a reply to the draft card:

- **Carousels** (Instagram always, other networks when Mistral asks for an image): Mistral's small model cuts the post into 3 to 6 slides (hook, one idea per slide, takeaway), checked like any text, then drawn as 1080 × 1350 PNGs. They arrive as files, so Telegram does not recompress them.
- **Videos** (TikTok and YouTube Shorts), 30 seconds at most, made **only when you say so**:
  - at a video slot, the bot first pitches an idea: the hook and the angle, for about a tenth of a cent (small model, no web search). **🎬 Make the video** writes the script and makes the video, about €0.10; **❌ No** pitches another one. `media.askBeforeVideo: false` makes them on their own instead;
  - Mistral can also answer "not worth a video today";
  - an **English voiceover** by [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0), run on your computer, `af_heart` by default. The first video downloads the model, about 300 MB;
  - the voice is the type: what is said rises on screen 2 or 3 words at a time, large, the key word or number in the accent colour; lines follow each other with no gap (the silence Kokoro leaves around a line is trimmed);
  - each shot shows an animated example chosen by Mistral: a headline card with its outlet, a counter running to the number, bars comparing before and after, a terminal typing a command, a chat answering, a list building up, a quote;
  - two colour fields, dark and accent, swap from shot to shot with a wipe; a film grain moves over everything; no flashes;
  - frame 0 shows the hook, so it works as the thumbnail; everything stays out of the areas the apps cover;
  - **music**: put royalty-free tracks in `data/music` (or point `media.music` to a file or a folder); videos take them in turn. The track is started so that its drop lands on the first cut after the hook, lowered under the voice (sidechain ducking), and the whole sound levelled to -14 LUFS. Check that each track's license allows social media use (the [Mixkit](https://mixkit.co/license/#musicFree) free license does, for example). Without music, the voice is levelled alone;
  - rendered by [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache 2.0): each video is an HTML page animated with [GSAP](https://gsap.com) (free "Standard no charge" license), rendered frame by frame in a headless Chrome with motion blur. A 16 s video renders in about 13 s. The service turns HyperFrames' usage telemetry off;
  - each video's project folder is kept next to it (`data/media/<id>/project`): open it in HyperFrames Studio to tweak one by hand;
  - `media.engine: "basic"` draws videos without a browser instead (plainer, no Chrome needed); it also takes over if HyperFrames fails.
- **What works this week**: once a week, Mistral studies what makes short tech videos perform right now (hooks, length, pace, captions, voice) with a web search, and the video scripts follow that brief. `/trends` shows it. About €0.07 a week.

Colors, frame rate, the voice (`media.voice`), music and how long files are kept (`keepDays`, 7 by default) are in the `media` section of `config/config.json`. Set `media.enabled` to `false` to turn visuals off. Text and fonts are rendered with [satori](https://github.com/vercel/satori) and [resvg](https://github.com/yisibl/resvg-js), in the Inter typeface (SIL Open Font License).

## Ground rules

- **X is read only, through the official API.** No scraping, no browser automation: that is what gets accounts suspended. The X app is set to "Read only": its tokens cannot write.
- **Nothing is ever published.** No code sends anything to any network.
- **Sourced or nothing.** A draft keeps only the URLs actually returned by Mistral's web search, plus the URL of the item that triggered it. With no source left, it is rejected.
- **Nothing made up.**
  - The trigger must be less than 24 hours old.
  - The account never claims it tried, tested or measured anything.
  - The prompt forbids numbers, quotes and dates absent from the sources.
  - "Edit" rewrites without web search, so it cannot add facts.
- **Anonymity.** A list of forbidden terms (your name, city, company…) is checked in every draft, rewrite, reply and Mistral answer. Without that list, the service refuses to generate.
- **Daily spend caps**, VAT included: €1 for Mistral and $1.80 for X by default. At the cap, paid calls stop until the next day and the bot tells you once.
- **Private bot.** It answers only your Telegram chat id. Anyone else is ignored, messages and clicks alike.

## Requirements

- macOS or Linux, with **Node 24 LTS** (see `.node-version` and `.nvmrc`). `npm install` refuses any other version.
- **ffmpeg** for the videos (`brew install ffmpeg`, or `sudo apt install ffmpeg`). Without it, carousels still work and videos are skipped with a message.
- A Mistral API key, ideally in an organization of its own.
- A Telegram account.
- Optional: an X developer account on pay-per-use, with credits, to watch X accounts and use the reply features. Without it, the watch reads RSS feeds and Hacker News only, and drafts are still written for every network.

> Do not put the project in a folder synced by iCloud (Desktop, Documents). macOS swaps rarely used files for online placeholders there, which makes Node hang at start and puts `.env` and the SQLite database in the cloud. A folder like `~/dev` is fine.

## Setup, step by step

### 1. The code

```sh
git clone https://github.com/youdcode/social-copilot.git
cd social-copilot
npm ci
npm run check   # types + tests, without any network call
cp .env.example .env
```

`npm ci` may warn that install scripts of `better-sqlite3` and `core-js` were not run. Nothing is missing: `better-sqlite3` ships prebuilt binaries for macOS, Linux and Windows, and `npm run check` confirms it loads.

### 2. Mistral

1. Create an API key in an organization or workspace dedicated to the project, and put it in `.env` as `MISTRAL_API_KEY`.
2. In *Admin panel › Privacy*, turn off **Anonymous improvement data**. X's developer agreement forbids letting a model train on X content.
3. Set a monthly cap on the workspace: it is the second safety net, after the daily cap in the code.
4. Check that pay-per-use is active. A limit of 0 requests per minute makes every call fail (error 429).

Conversations are opened with `store: false`. Models are pinned in `config/config.json` (never a `-latest` alias).

### 3. X (optional)

Skip this step to start without X: leave the X variables of `.env` empty. You can add them later and restart.

On [console.x.com](https://console.x.com), signed in with the account that will publish:

1. In the app's authentication settings, set permissions to **Read only**. If a website and a callback URL are required, use the X profile URL and `http://127.0.0.1`.
2. In *Keys and tokens*, get:
   - the **Bearer Token** (`X_BEARER_TOKEN`);
   - the **API Key & Secret** (`X_API_KEY`, `X_API_SECRET`).
3. **Only then**, generate the **Access Token & Secret** (`X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`). A token keeps the access level the app had when it was generated: if it was made before the switch to "Read only", generate it again.
4. Add credits, set a spending cap and turn off automatic top-up.
5. In the use case description, mention processing by an LLM and local storage.

With the Bearer Token alone, the X watch, "Who to reply to" and pasted links work. The four account tokens add "Replies received".

### 4. Telegram

1. Create the bot with [@BotFather](https://t.me/BotFather), with a neutral name. Turn off groups (*Allow Groups*: off) and inline mode.
2. Put its token in `.env` as `TELEGRAM_BOT_TOKEN`.
3. Run `npm run telegram:chat-id`, then write anything to the bot. The command prints `TELEGRAM_ALLOWED_CHAT_ID=…`: copy the line into `.env`. The bot answers nothing.

### 5. Your files, kept out of git

```sh
cp voice.example.md voice.md
cp config/forbidden-terms.example.txt config/forbidden-terms.txt
```

- **`voice.md`**: the voice of the account, in English, sent to Mistral with every draft. `<!-- … -->` comments are ignored.
- **`config/forbidden-terms.txt`**: one term per line (name, handle, city, company, relatives).
  - Case and accents are ignored, and a term is found even inside a word: "Acme" catches "AcmeAI" and "acme.io".
  - Avoid common words: they would block harmless texts.

`.gitignore` already excludes both files, `.env` and `data/`.

### 6. Networks and watch

In `config/config.json`:

- **`networks`**: turn each network on or off, and set its slots, in the configured time zone (`timezone`). Each slot gives one draft for that network.
- **`x.watchedAccounts`** and **`sources.rssFeeds`**: what the service reads.

The file is checked at start: an unknown key or an out-of-range value is refused, with a message naming it.

With X keys, resolve the ids of the watched accounts, once and for all ($0.01 per account):

```sh
npm run x:resolve
```

It prints what X says about each account: remove from the config any handle that is not the one you meant.

### 7. Dry run, then start

```sh
npm run dry-run              # one real watch and one real draft, printed here, never sent nor stored
npm run dry-run -- linkedin  # the same for another network
npm start                    # the service and the bot; Ctrl+C to stop
```

Send `/start` to the bot.

## Using the bot

- **`/start`**: one button per network. Networks that are off in the config are greyed out.
- **Drafts** arrive as one message each, with a notification. A card holds the text (and the title and script for video networks), the pillar, a "why" line, the sources and any asset request.
  - **Open in X** (or Threads, Bluesky, LinkedIn): opens the network's compose window with the text already in, through its official share link. You only tap Post.
  - **Copy**: Telegram's native copy button up to 256 characters (a Telegram limit), otherwise the text sits in a block easy to copy. For Instagram, TikTok and YouTube, which take no text in a link, Copy comes first, then Open. YouTube titles get their own button.
  - **Posted**: tap it once published. The bot then offers to save the link of the post.
  - **Edit**: reply to the card with an instruction ("shorter", "lead with the price"…). Mistral rewrites it without web search, so without adding facts, and a new card arrives.
  - **No**: optional reason, then a new topic for that network right away. A click Telegram sends twice does not start a second draft.
- **Who to reply to** (X): among recent posts of the watched accounts, Mistral picks those worth a reply and writes 3 replies. Each one has a button that opens X's reply window on the post, the reply already in. A reply works best on a post less than an hour old.
- **Replies received** (X): replies and mentions the account received, with the post they answer, advice and 3 replies. The bot tells you when new ones arrive.
- **Video ideas** (TikTok, YouTube): a hook and an angle, with **🎬 Make the video** and **❌ No**. Nothing costly is made before you accept.
- **Visuals**: carousels arrive under their card on their own; videos once you accepted the idea (see [Visuals](#visuals)).
- **Asset requests**: type, brief and duration, with an "Asset ready" button. Making the visual marks it ready.
- **Free messages** go to Mistral, with the account voice and the pending draft of the network you opened last; `/reset` forgets the conversation.
  - A link to an X post (`x.com/…/status/…`) gets the advice and 3 replies. The post is read on X ($0.005), and the words around the link are taken as an instruction.
  - For a post without a link, paste its text after `/advice`.
- **`/stats`**: posts per network, replies made, spend against the caps. **`/trends`**: this week's short-video brief. **`/help`**: the help.

A slot is skipped while a draft of the same network is still waiting for you. After the computer sleeps, only the slot in progress is handled: missed slots never pile up.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Service and bot. One instance at a time (lock in `data/`). |
| `npm run dry-run [-- <network>]` | Dry run: one real watch and one real draft, printed, neither stored nor sent. |
| `npm run x:resolve` | Resolves the ids of the watched accounts (once per account). |
| `npm run x:purge -- <id>` | Removes an X post from the database, on request. |
| `npm run telegram:chat-id` | Prints the id of the chat that writes to the bot. |
| `npm run mac:install` / `mac:uninstall` / `mac:status` | Automatic start on the Mac (launchd). |
| `npm run db:migrate` | Creates or updates the SQLite database. The service does it on its own at start. |
| `npm run check` | Checks types, then runs the tests. |

## Costs

Prices live in `config/config.json`: update them if providers change theirs.

- **X**, pay-per-use:
  - $0.005 per post read;
  - $0.010 per account resolved;
  - $0.001 per mention of the account ("Owned Reads" price).

  A post read again the same UTC day is not billed again, and a request with no result is not billed. With 40 watched accounts, expect around $0.80 a day, VAT included.
- **Mistral**:
  - each news is checked once, with 2 web searches at most (about €0.03 each), then written for each network without searching again;
  - measured: about €0.09 for a draft on a news not checked yet, about €0.01 for the same news on another network;
  - networks drafting at the same time also share the cost of grouping the news into topics;
  - with the 7 networks on, expect well under €1 a day.
- **Daily caps**:
  - `mistral.dailyCapEur` and `x.dailyCapUsd`, VAT included (`vatMultiplier`, 1.2 by default);
  - the Mistral cap follows the day of the configured time zone, the X cap the UTC day, like X's invoice;
  - with every network on, raise the Mistral cap if drafts start being skipped late in the day.

## Data

Everything stays on your machine, in `data/social-copilot.sqlite`.

- The text of X posts read (watch, mentions, pasted posts) is **purged 24 hours after it was read**. Only ids and URLs remain. `npm run x:purge -- <id>` erases a post on request.
- What goes to Mistral: the watched items, the account voice, your instructions and your free messages.
- What goes to Telegram: the cards and the bot's answers, in your private chat.

## Deployment

### On the Mac

```sh
npm run mac:install   # starts at login, restarts after a crash
npm run mac:status
npm run mac:uninstall # stops and removes
```

- Logs: `data/logs/service.log` and `data/logs/service.error.log`.
- The service runs only while the Mac is on. Telegram keeps messages and clicks sent while the Mac sleeps for 24 hours; after that they are lost.
- After a Node update or moving the folder, run `npm run mac:install` again.

### Moving to a server

A bot can be polled by a single instance only. If the Mac and the server run at the same time, Telegram answers 409 and spend doubles. The service checks this at start and refuses to run a second instance.

1. **Stop the Mac first**: `npm run mac:uninstall`, then check with `npm run mac:status`.
2. On the server (Linux, Node 24), copy the project to `/opt/social-copilot` with:
   - `.env`, `voice.md` and `config/forbidden-terms.txt`;
   - `data/` if you want to keep the history.

   Then run `npm ci`.
3. Create a system user `social-copilot` that owns `/opt/social-copilot/data`.
4. Install `deploy/social-copilot.service`, adapting the paths if needed:
   ```sh
   sudo cp deploy/social-copilot.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now social-copilot
   journalctl -u social-copilot -f
   ```
5. Send `/stats` to the bot to check it answers.

To go back to the Mac: `sudo systemctl disable --now social-copilot` on the server, then `npm run mac:install`.

No port is opened and no domain name is needed: the bot uses long polling.

## Development

- TypeScript run directly by Node 24, types checked by `tsc` without a build step, tests with `node:test`.
- Exact dependency versions, lockfile committed.
- Tests make no network call: Mistral, X and Telegram are faked.

| Folder | Content |
| --- | --- |
| `src/networks.ts` | Each network: format, limits, how length is counted, writing rules |
| `src/sources`, `src/x` | RSS, Hacker News and X watch, mentions, OAuth 1.0a signing |
| `src/generation` | Grouping into topics, ranking, writing, validation |
| `src/telegram` | Bot, cards, menus, sending visuals |
| `src/media` | Carousels and videos: slide design, drawing, ffmpeg encoding |
| `src/assistant.ts`, `src/replies.ts` | Edit, Talk to Mistral, reply advice and variants |
| `src/spend.ts` | Spend counting and caps |
| `src/db` | SQLite schema and migrations |

Adding a network means adding its entry in `src/networks.ts` and in `config/config.json`. Validation, cards and menus follow from there.

## License

[MIT](LICENSE).
