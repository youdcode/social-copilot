import { InlineKeyboard } from 'grammy';
import { enabledNetworks, type AppConfig } from '../config.ts';
import type { Draft } from '../drafts.ts';
import type { VideoScript } from '../generation/draft.ts';
import type { VideoIdea } from '../generation/ideas.ts';
import { composeLink, NETWORK_SPECS, NETWORKS, xReplyLink, type Network } from '../networks.ts';
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

/** Telegram refuses messages over 4,096 characters. */
export const MESSAGE_MAX = 4096;

const PILLAR_NAMES: Record<Draft['pillar'], string> = {
  ai: 'AI',
  startups: 'startups',
  deeptech: 'deeptech',
  devtools: 'dev tools',
  motion: 'motion design',
};

const ASSET_NAMES = { video: 'video', image: 'image', carousel: 'carousel', screenshot: 'screenshot' } as const;

function assetLine(draft: Draft): string | undefined {
  const asset = draft.assetRequest;
  if (!asset) return undefined;
  const duration = asset.type === 'video' && asset.duration_s > 0 ? `, ${asset.duration_s} s` : '';
  const ready = draft.assetReadyAt ? ' (ready)' : '';
  return `🎬 <b>Asset${ready}:</b> ${ASSET_NAMES[asset.type]}${duration}. ${escapeHtml(asset.brief)}`;
}

function statusLine(draft: Draft): string | undefined {
  if (draft.status === 'posted') {
    return draft.postedUrl ? `✅ Posted: ${link(draft.postedUrl, 'see the post')}` : '✅ Posted';
  }
  if (draft.status === 'refused') {
    return draft.refusalReason ? `❌ Refused: ${escapeHtml(draft.refusalReason)}` : '❌ Refused';
  }
  if (draft.status === 'edited') return '✏️ Edited version';
  return undefined;
}

export function scriptLines(script: VideoScript): string[] {
  return [
    `<b>Script</b> (${script.duration_s} s)`,
    `<b>Hook:</b> ${escapeHtml(script.hook)}`,
    ...script.shots.flatMap((shot, i) => [
      `${i + 1}. 🎥 ${escapeHtml(shot.visual)}`,
      ...(shot.voiceover ? [`    🗣 ${escapeHtml(shot.voiceover)}`] : []),
      ...(shot.on_screen_text ? [`    🔤 ${escapeHtml(shot.on_screen_text)}`] : []),
    ]),
  ];
}

/** A message to send, with its buttons. before holds messages to send first, when the card would be too long. */
export type Card = { text: string; keyboard?: InlineKeyboard; before?: string[] };

/**
 * A draft card: the title (YouTube), the text, the script (video networks), then the pillar, the "why" line, the
 * sources and the asset request. Pending drafts get Copy (native button up to 256 characters, else the text sits in a
 * block), Posted, Edit and No.
 */
export function draftCard(draft: Draft, copyMax: number): Card {
  const spec = NETWORK_SPECS[draft.network];
  const pending = draft.status === 'proposed' || draft.status === 'edited';
  const copyable = fitsCopyButton(draft.text, copyMax);
  let textBlock = copyable ? escapeHtml(draft.text) : `<pre>${escapeHtml(draft.text)}</pre>`;
  let scriptBlock = draft.script ? scriptLines(draft.script) : [];
  // Sources are for checking, not for the post: one discreet line, the trigger folded in.
  const allSources = draft.sources.includes(draft.triggerUrl) ? draft.sources : [...draft.sources, draft.triggerUrl];
  const hostOf = (url: string) => shortUrl(url).split('/')[0]!;
  let sources = allSources.map((s) => link(s, hostOf(s))).join(' · ');
  const build = () =>
    [
      `<b>${spec.name} · draft #${draft.id}</b> · ${PILLAR_NAMES[draft.pillar]} · ${draft.length}/${spec.maxLength}`,
      ...(statusLine(draft) ? [statusLine(draft)!] : []),
      ...(draft.title ? ['', `<b>Title:</b> ${escapeHtml(draft.title)}`] : []),
      '',
      textBlock,
      ...(scriptBlock.length > 0 ? ['', ...scriptBlock] : []),
      '',
      `<b>Why:</b> ${escapeHtml(draft.whyItMatters)}`,
      `<i>Sources: ${sources}</i>`,
      ...(assetLine(draft) ? [assetLine(draft)!] : []),
    ].join('\n');
  // A card must fit in one Telegram message. What does not fit goes first, in messages of its own: the text, then the
  // script; as a last resort, sources lose their links.
  const before: string[] = [];
  let text = build();
  if (text.length > MESSAGE_MAX) {
    before.push(`<pre>${escapeHtml(draft.text)}</pre>`);
    textBlock = `<i>The ${spec.textName} is in the message above.</i>`;
    text = build();
  }
  if (text.length > MESSAGE_MAX && draft.script) {
    before.push(...splitMessage(scriptLines(draft.script).join('\n')));
    scriptBlock = ['<i>The script is in the message above.</i>'];
    text = build();
  }
  if (text.length > MESSAGE_MAX) {
    sources = allSources.map((s) => escapeHtml(hostOf(s))).join(' · ');
    text = build();
  }
  const card: Card = { text, ...(before.length > 0 ? { before } : {}) };
  if (!pending) return card;

  // Telegram buttons either copy or open a link, never both. Where the network takes the text in its share link, Open is
  // enough; elsewhere, Copy comes first, then Open.
  const open = composeLink(draft.network, draft.text);
  const keyboard = new InlineKeyboard();
  if (!open.prefilled && copyable) keyboard.copyText('📋 Copy', draft.text);
  if (draft.title && fitsCopyButton(draft.title, copyMax)) keyboard.copyText('📋 Title', draft.title);
  keyboard.url(`↗️ Open in ${spec.name}`, open.url);
  if (open.prefilled && copyable) keyboard.copyText('📋 Copy', draft.text);
  keyboard.row();
  keyboard
    .text({ text: '✅ Posted', style: 'success' }, `d:${draft.id}:post`)
    .text('✏️ Edit', `d:${draft.id}:edit`)
    .text({ text: '❌ No', style: 'danger' }, `d:${draft.id}:no`);
  return { ...card, keyboard };
}

/** A video pitch: the hook and the angle, with Make the video and No while it waits for an answer. */
export function ideaCard(idea: VideoIdea): Card {
  const spec = NETWORK_SPECS[idea.network];
  const status =
    idea.status === 'accepted' ? '\n🎬 Accepted: the script and the video are on their way.' : idea.status === 'refused' ? '\n❌ Refused' : '';
  const lines = [
    `<b>${spec.name} · video idea #${idea.id}</b> · ${PILLAR_NAMES[idea.topic.pillar]}${status}`,
    '',
    `<b>Hook:</b> “${escapeHtml(idea.hook)}”`,
    `<b>Angle:</b> ${escapeHtml(idea.angle)}`,
    '',
    `<i>${escapeHtml(idea.topic.label)}${idea.sources.length > 0 ? ` · ${idea.sources.map((s) => link(s, shortUrl(s).split('/')[0]!)).join(' · ')}` : ''}</i>`,
  ];
  if (idea.status !== 'proposed') return { text: lines.join('\n') };
  const keyboard = new InlineKeyboard()
    .text({ text: '🎬 Make the video (~€0.10)', style: 'success' }, `i:${idea.id}:make`)
    .text({ text: '❌ No', style: 'danger' }, `i:${idea.id}:no`);
  return { text: lines.join('\n'), keyboard };
}

/** A card of "Asset requests": type, brief, duration, and the Asset ready button. */
export function assetCard(draft: Draft): Card {
  const lines = [
    `<b>Asset for ${NETWORK_SPECS[draft.network].name} draft #${draft.id}</b>${draft.status === 'posted' ? ' (posted)' : ''}`,
    assetLine(draft) ?? '',
    '',
    `<i>${escapeHtml(draft.title ?? draft.text)}</i>`,
  ];
  if (draft.assetReadyAt) return { text: lines.join('\n') };
  return { text: lines.join('\n'), keyboard: new InlineKeyboard().text('✅ Asset ready', `a:${draft.id}`) };
}

const ORIGIN_TITLES: Record<Reply['origin'], string> = {
  watchlist: 'Who to reply to',
  mention: 'Reply received',
  pasted: 'Pasted post',
};

function age(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

function freshnessLine(minutes: number | undefined): string {
  const tip = 'A reply works best on a post less than an hour old.';
  if (minutes === undefined) return `⏱ ${tip}`;
  return minutes < 60 ? `⏱ Post is ${age(minutes)} old. ${tip}` : `⏱ Post is ${age(minutes)} old: a reply will reach fewer people. ${tip}`;
}

function quote(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return escapeHtml(clean.length > max ? `${clean.slice(0, max - 1)}…` : clean);
}

/**
 * A reply card (X): the post (and the one it answers), the advice, the freshness reminder and 3 variants, each with
 * its own copy button when it fits. Open replies get Replied and Skip.
 */
export function replyCard(reply: Reply, now: Date, copyMax: number): Card {
  const minutes = replyAgeMinutes(reply, now);
  const verdict =
    reply.worthReplying === null
      ? '❔ No advice from Mistral.'
      : `${reply.worthReplying ? '👍 Worth a reply' : '👎 Not worth a reply'}${reply.reason ? `: ${escapeHtml(reply.reason)}` : '.'}`;
  const lines = [
    `<b>${ORIGIN_TITLES[reply.origin]}</b>${reply.author ? ` · @${escapeHtml(reply.author)}` : ''}${reply.postUrl ? ` · ${link(reply.postUrl, 'open on X')}` : ''}`,
    ...(reply.parentText ? [`↪️ In reply to: <i>${quote(reply.parentText, 300)}</i>`] : []),
    reply.postText ? `<blockquote>${quote(reply.postText)}</blockquote>` : '<i>Post text purged (older than 24 h).</i>',
    verdict,
    freshnessLine(minutes),
  ];
  if (reply.worthReplying && reply.variants.length === 0) {
    lines.push('No variant passed the checks (length, em dash, forbidden terms).');
  }
  reply.variants.forEach((variant, i) => {
    lines.push('', `<b>${i + 1}.</b> ${fitsCopyButton(variant, copyMax) ? escapeHtml(variant) : `<pre>${escapeHtml(variant)}</pre>`}`);
  });
  if (reply.status !== 'proposed') {
    lines.push('', reply.status === 'replied' ? '✅ Replied' : '➖ Skipped');
    return { text: lines.join('\n') };
  }
  const keyboard = new InlineKeyboard();
  // Each variant opens X's reply window on the post, the reply already in.
  if (reply.postId) {
    const postId = reply.postId;
    reply.variants.forEach((variant, i) => keyboard.url(`↩️ Reply ${i + 1}`, xReplyLink(postId, variant)));
    if (reply.variants.length > 0) keyboard.row();
  }
  reply.variants.forEach((variant, i) => {
    if (fitsCopyButton(variant, copyMax)) keyboard.copyText(`📋 ${i + 1}`, variant);
  });
  if (reply.variants.some((v) => fitsCopyButton(v, copyMax))) keyboard.row();
  keyboard.text({ text: '✅ Replied', style: 'success' }, `r:${reply.id}:done`).text('➖ Skip', `r:${reply.id}:skip`);
  return { text: lines.join('\n'), keyboard };
}

/** /start: one button per network, two per row; those not enabled in the config show as off, disabled. */
export function mainMenu(config: AppConfig): Card {
  const enabled = new Set(enabledNetworks(config));
  const keyboard = new InlineKeyboard();
  NETWORKS.forEach((network, i) => {
    const name = NETWORK_SPECS[network].name;
    if (enabled.has(network)) keyboard.text(name, `net:${network}`);
    else keyboard.disabled(`${name} · off`);
    if (i % 2 === 1) keyboard.row();
  });
  return { text: '<b>Social Copilot</b>\nPick a network.', keyboard };
}

export function networkMenu(network: Network, stats: DailyStats): Card {
  const spec = NETWORK_SPECS[network];
  const mine = stats.byNetwork[network] ?? { posted: 0, pending: 0, openAssets: 0 };
  const keyboard = new InlineKeyboard().text(`📝 Pending drafts (${mine.pending})`, `pend:${network}`).row();
  if (network === 'x') {
    keyboard.text('💬 Who to reply to', 'targets').row().text('📥 Replies received', 'mentions').row();
  }
  keyboard
    .text(`🎬 Asset requests (${mine.openAssets})`, `assets:${network}`)
    .row()
    .text('🤖 Talk to Mistral', `chat:${network}`)
    .row()
    .text('← Networks', 'home');
  const replies = network === 'x' ? `, ${stats.replied} repl${stats.replied === 1 ? 'y' : 'ies'} made` : '';
  return { text: `<b>${spec.name}</b>\nToday: ${mine.posted} posted${replies}.`, keyboard };
}

function money(amount: number, unit: '€' | '$'): string {
  return `${unit}${amount.toFixed(2)}`;
}

export function statsText(stats: DailyStats): string {
  const { mistral, x } = stats.spend;
  return [
    `<b>Today</b> (${stats.day})`,
    ...stats.networks.map((network) => {
      const s = stats.byNetwork[network]!;
      return `${NETWORK_SPECS[network].name}: ${s.posted} posted, ${s.pending} pending`;
    }),
    `Replies made on X: ${stats.replied}`,
    `Assets to produce: ${stats.openAssets}`,
    '',
    '<b>Spend, VAT included</b>',
    `Mistral: ${money(mistral.spent, '€')} of ${money(mistral.cap, '€')}`,
    `X: ${money(x.spent, '$')} of ${money(x.cap, '$')} (UTC day)`,
  ].join('\n');
}

export const HELP_TEXT = [
  '<b>Commands</b>',
  '/start: pick a network',
  '/stats: posts, replies and spend of the day',
  '/reset: forget the conversation with Mistral',
  '/advice &lt;text&gt;: "worth a reply" advice and 3 replies for a post pasted without a link',
  '/trends: what works in short videos this week, as the video scripts follow it',
  '/help: this help',
  '',
  '<b>On a draft card</b>',
  'Copy, then Posted once you have published it by hand. Edit: reply to the card with an instruction. No: optional reason, then a new topic.',
  '',
  '<b>Free messages</b>',
  'Any message goes to Mistral, with the account voice and the draft in progress of the network you last opened. A link to an X post gets the advice and 3 replies; words around the link are taken as an instruction.',
  '',
  'The service never publishes anything: you post by hand.',
].join('\n');

export function chatHint(network: Network): string {
  return (
    `Write to me directly: any free message goes to Mistral, with the account voice and the ${NETWORK_SPECS[network].name} draft in progress.\n` +
    'Paste a link to an X post for "worth a reply" advice and 3 replies.\n/reset forgets the conversation.'
  );
}

/** Splits a long answer on line breaks, under Telegram's message limit. */
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
