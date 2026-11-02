import { InlineKeyboard } from 'grammy';
import type { AppConfig } from '../config.ts';
import type { Draft } from '../drafts.ts';
import { replyAgeMinutes, type Reply } from '../replies.ts';
import type { DailyStats } from '../stats.ts';

/** Telegram HTML: only &, < and > must be escaped in text; quotes too inside attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function link(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** Host and path of a URL, short enough for a card. */
export function shortUrl(url: string, max = 48): string {
  try {
    const parsed = new URL(url);
    const label = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}`;
    return label.length > max ? `${label.slice(0, max - 1)}…` : label;
  } catch {
    return url.slice(0, max);
  }
}

/** The native copy button holds 256 characters at most (Bot API): longer texts go in a block instead. */
export function fitsCopyButton(text: string, max: number): boolean {
  return text.length <= max;
}

export const NETWORK_NAMES: Record<keyof AppConfig['networks'], string> = {
  x: 'X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

const PILLAR_NAMES: Record<Draft['pillar'], string> = {
  ai: 'IA',
  startups: 'startups',
  deeptech: 'deeptech',
  devtools: 'outils de dev',
  motion: 'motion design',
};

const ASSET_NAMES = { video: 'vidéo', image: 'image', screenshot: "capture d'écran" } as const;

function assetLine(draft: Draft): string | undefined {
  const asset = draft.assetRequest;
  if (!asset) return undefined;
  const duration = asset.type === 'video' && asset.duration_s > 0 ? `, ${asset.duration_s} s` : '';
  const ready = draft.assetReadyAt ? ' (prête)' : '';
  return `🎬 <b>Matière${ready} :</b> ${ASSET_NAMES[asset.type]}${duration}. ${escapeHtml(asset.brief)}`;
}

function statusLine(draft: Draft): string | undefined {
  if (draft.status === 'posted') {
    return draft.postedUrl ? `✅ Posté : ${link(draft.postedUrl, 'voir le tweet')}` : '✅ Posté';
  }
  if (draft.status === 'refused') {
    return draft.refusalReason ? `❌ Refusé : ${escapeHtml(draft.refusalReason)}` : '❌ Refusé';
  }
  if (draft.status === 'edited') return '✏️ Version modifiée';
  return undefined;
}

export type Card = { text: string; keyboard?: InlineKeyboard };

/**
 * A draft card: the text, then the pillar, the "why" line, the sources and the asset request.
 * Pending drafts get Copier (native button up to 256 characters, else the text sits in a block), Posté, Modifier, Non.
 */
export function draftCard(draft: Draft, copyMax: number): Card {
  const pending = draft.status === 'proposed' || draft.status === 'edited';
  const copyable = fitsCopyButton(draft.tweet, copyMax);
  const lines = [
    `<b>${NETWORK_NAMES[draft.network as keyof typeof NETWORK_NAMES] ?? draft.network} · brouillon n° ${draft.id}</b> · ${PILLAR_NAMES[draft.pillar]} · ${draft.weightedLength}/280`,
    ...(statusLine(draft) ? [statusLine(draft)!] : []),
    '',
    copyable ? escapeHtml(draft.tweet) : `<pre>${escapeHtml(draft.tweet)}</pre>`,
    '',
    `<b>Pourquoi :</b> ${escapeHtml(draft.whyItMatters)}`,
    `<b>Sources :</b> ${draft.sources.map((s) => link(s, shortUrl(s))).join(' · ')}`,
    `<b>Déclencheur :</b> ${link(draft.triggerUrl, shortUrl(draft.triggerUrl))}`,
    ...(assetLine(draft) ? [assetLine(draft)!] : []),
  ];
  if (!pending) return { text: lines.join('\n') };

  const keyboard = new InlineKeyboard();
  if (copyable) keyboard.copyText('📋 Copier', draft.tweet).row();
  keyboard
    .text({ text: '✅ Posté', style: 'success' }, `d:${draft.id}:post`)
    .text('✏️ Modifier', `d:${draft.id}:edit`)
    .text({ text: '❌ Non', style: 'danger' }, `d:${draft.id}:no`);
  return { text: lines.join('\n'), keyboard };
}

/** A card of "Demandes de visuels": type, brief, duration, and the Matière prête button. */
export function assetCard(draft: Draft): Card {
  const lines = [
    `<b>Visuel pour le brouillon n° ${draft.id}</b>${draft.status === 'posted' ? ' (posté)' : ''}`,
    assetLine(draft) ?? '',
    '',
    `<i>${escapeHtml(draft.tweet)}</i>`,
  ];
  if (draft.assetReadyAt) return { text: lines.join('\n') };
  return { text: lines.join('\n'), keyboard: new InlineKeyboard().text('✅ Matière prête', `a:${draft.id}`) };
}

const ORIGIN_TITLES: Record<Reply['origin'], string> = {
  watchlist: 'À qui répondre',
  mention: 'Réponse reçue',
  pasted: 'Post collé',
};

function age(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} j`;
}

function freshnessLine(minutes: number | undefined): string {
  const tip = 'Une réponse porte le plus sur un post de moins d’une heure.';
  if (minutes === undefined) return `⏱ ${tip}`;
  return minutes < 60 ? `⏱ Post de ${age(minutes)}. ${tip}` : `⏱ Post de ${age(minutes)} : une réponse portera moins. ${tip}`;
}

function quote(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return escapeHtml(clean.length > max ? `${clean.slice(0, max - 1)}…` : clean);
}

/**
 * A reply card: the post (and the one it answers), the advice, the freshness reminder and 3 variants,
 * each with its own copy button when it fits. Open replies get Répondu and Ignorer.
 */
export function replyCard(reply: Reply, now: Date, copyMax: number): Card {
  const minutes = replyAgeMinutes(reply, now);
  const verdict =
    reply.worthReplying === null
      ? '❔ Pas d’avis de Mistral.'
      : `${reply.worthReplying ? '👍 Vaut une réponse' : '👎 Ne vaut pas une réponse'}${reply.reason ? ` : ${escapeHtml(reply.reason)}` : '.'}`;
  const lines = [
    `<b>${ORIGIN_TITLES[reply.origin]}</b>${reply.author ? ` · @${escapeHtml(reply.author)}` : ''}${reply.postUrl ? ` · ${link(reply.postUrl, 'ouvrir sur X')}` : ''}`,
    ...(reply.parentText ? [`↪️ En réponse à : <i>${quote(reply.parentText, 300)}</i>`] : []),
    reply.postText ? `<blockquote>${quote(reply.postText)}</blockquote>` : '<i>Texte du post purgé (plus de 24 h).</i>',
    verdict,
    freshnessLine(minutes),
  ];
  if (reply.worthReplying && reply.variants.length === 0) {
    lines.push('Aucune variante n’a passé les contrôles (longueur, tiret cadratin, termes interdits).');
  }
  reply.variants.forEach((variant, i) => {
    lines.push('', `<b>${i + 1}.</b> ${fitsCopyButton(variant, copyMax) ? escapeHtml(variant) : `<pre>${escapeHtml(variant)}</pre>`}`);
  });
  if (reply.status !== 'proposed') {
    lines.push('', reply.status === 'replied' ? '✅ Répondu' : '➖ Ignoré');
    return { text: lines.join('\n') };
  }
  const keyboard = new InlineKeyboard();
  reply.variants.forEach((variant, i) => {
    if (fitsCopyButton(variant, copyMax)) keyboard.copyText(`📋 ${i + 1}`, variant);
  });
  if (reply.variants.some((v) => fitsCopyButton(v, copyMax))) keyboard.row();
  keyboard.text({ text: '✅ Répondu', style: 'success' }, `r:${reply.id}:done`).text('➖ Ignorer', `r:${reply.id}:skip`);
  return { text: lines.join('\n'), keyboard };
}

/** /start: one button per network; those not enabled in the config show as waiting, disabled. */
export function mainMenu(config: AppConfig): Card {
  const keyboard = new InlineKeyboard();
  for (const [key, network] of Object.entries(config.networks) as Array<[keyof AppConfig['networks'], { enabled: boolean }]>) {
    if (network.enabled) keyboard.text(NETWORK_NAMES[key], `net:${key}`);
    else keyboard.disabled(`${NETWORK_NAMES[key]} · en attente`);
    keyboard.row();
  }
  return { text: '<b>Copilote</b>\nChoisis un réseau.', keyboard };
}

export function networkMenu(stats: DailyStats): Card {
  const keyboard = new InlineKeyboard()
    .text(`📝 Brouillons en attente (${stats.pendingDrafts})`, 'x:pending')
    .row()
    .text('💬 À qui répondre', 'x:targets')
    .row()
    .text('📥 Réponses reçues', 'x:mentions')
    .row()
    .text(`🎬 Demandes de visuels (${stats.openAssets})`, 'x:assets')
    .row()
    .text('🤖 Parler à Mistral', 'x:chat')
    .row()
    .text('← Réseaux', 'home');
  return {
    text: `<b>X</b>\nAujourd’hui : ${stats.posted} post(s) publié(s), ${stats.replied} réponse(s) faite(s).`,
    keyboard,
  };
}

function money(amount: number, unit: string): string {
  return `${amount.toFixed(2).replace('.', ',')} ${unit}`;
}

export function statsText(stats: DailyStats): string {
  const { mistral, x } = stats.spend;
  return [
    `<b>Aujourd’hui</b> (${stats.day})`,
    `Posts publiés : ${stats.posted}`,
    `Réponses faites : ${stats.replied}`,
    `Brouillons en attente : ${stats.pendingDrafts}`,
    `Visuels à produire : ${stats.openAssets}`,
    '',
    '<b>Dépenses TTC</b>',
    `Mistral : ${money(mistral.spent, '€')} sur ${money(mistral.cap, '€')}`,
    `X : ${money(x.spent, '$')} sur ${money(x.cap, '$')} (jour UTC)`,
  ].join('\n');
}

export const HELP_TEXT = [
  '<b>Commandes</b>',
  '/start : menu des réseaux',
  '/stats : publications, réponses et dépenses du jour',
  '/reset : efface l’historique de « Parler à Mistral »',
  '/avis &lt;texte&gt; : avis « vaut une réponse » et 3 variantes sur un post collé sans lien',
  '/help : cette aide',
  '',
  '<b>Sur une carte de brouillon</b>',
  'Copier, puis Posté une fois publié à la main. Modifier : réponds à la carte avec ta consigne. Non : motif facultatif, puis nouveau sujet.',
  '',
  '<b>Messages libres</b>',
  'Tout message part à Mistral, avec la voix du compte et le brouillon en cours. Un lien de post X déclenche l’avis et 3 variantes ; les mots autour du lien servent de consigne.',
  '',
  'Le service ne publie jamais rien : tout se poste à la main.',
].join('\n');

export const CHAT_HINT =
  'Écris-moi directement : tout message libre part à Mistral, avec la voix du compte et le brouillon en cours.\n' +
  'Colle un lien de post X pour un avis « vaut une réponse » et 3 variantes.\n/reset efface l’historique.';

/** Telegram refuses messages over 4096 characters: long answers are split on line breaks. */
export function splitMessage(text: string, max = 4000): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
