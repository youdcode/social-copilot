import twitterText from 'twitter-text';

/** Networks the service writes drafts for. Sources stay the same for all: X (read only), RSS and Hacker News. */
export const NETWORKS = ['x', 'threads', 'bluesky', 'linkedin', 'instagram', 'tiktok', 'youtube'] as const;
export type Network = (typeof NETWORKS)[number];

export type NetworkSpec = {
  /** Display name. */
  name: string;
  /** What the main text is called on this network. */
  textName: string;
  /** Hard limit of the main text, in the network's own unit. */
  maxLength: number;
  /** Length as the network counts it. */
  measure(text: string): number;
  /** A short video: the draft carries a shot-by-shot script. */
  video: boolean;
  /** YouTube needs a title. */
  title: boolean;
  /** Instagram needs a visual: the asset request is mandatory. */
  assetRequired: boolean;
  /**
   * Where to post by hand. With {text}, the network's official share link opens its compose window with the text
   * already in; without it, the page only opens and the text has to be copied first.
   */
  composeUrl: string;
  /** Writing rules sent to Mistral, one per line. */
  rules: string[];
};

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Characters as a person sees them: an emoji or an accented letter counts once. */
export function graphemeLength(text: string): number {
  return [...graphemes.segment(text)].length;
}

/** Length as X counts it: a URL is 23, an emoji 2. */
export function xLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}

/** Short videos are made automatically: motion design and an English voice. Past 30 s, people swipe. */
export const MAX_VIDEO_SECONDS = 30;
/** About 2.5 words a second of voice. */
export const MAX_SPOKEN_WORDS = 75;
/** Text on screen is a key word or number, never a sentence. */
export const MAX_SCREEN_WORDS = 4;
export const MIN_SHOTS = 3;
export const MAX_SHOTS = 6;

const VIDEO_RULES = [
  `A vertical video of ${MAX_VIDEO_SECONDS} seconds at most, made automatically: motion design with an English voiceover. Write its script.`,
  `${MAX_SPOKEN_WORDS} spoken words at most in total, in short punchy sentences: nobody reads or listens to more.`,
  'The hook is spoken and on screen in the first 2 seconds: a bold claim, a number, or a question.',
  `${MIN_SHOTS + 1} to ${MAX_SHOTS} shots, each a new beat every 3 to 5 seconds. voiceover: one short sentence. on_screen_text: 1 to ${MAX_SCREEN_WORDS} words, the key word or number of that sentence, never the sentence itself. visual: what the motion design shows, in a few words.`,
  'worth_a_video: false when the news has nothing punchy enough for a short video; no video is made that day, and that is fine.',
];
/** Characters of a whole video script (hook and shots): what fits in a short video, and in a Telegram message. */
export const MAX_SCRIPT_LENGTH = 1200;
export const MAX_TITLE_LENGTH = 100;

export const NETWORK_SPECS: Record<Network, NetworkSpec> = {
  x: {
    name: 'X',
    textName: 'tweet',
    maxLength: 280,
    measure: xLength,
    video: false,
    title: false,
    assetRequired: false,
    composeUrl: 'https://x.com/intent/post?text={text}',
    rules: [
      'One tweet, 280 characters max as X counts them. No hashtags unless essential. One emoji at most.',
      'One or two sentences: a take on the news, not a summary of it.',
    ],
  },
  threads: {
    name: 'Threads',
    textName: 'post',
    maxLength: 500,
    measure: graphemeLength,
    video: false,
    title: false,
    assetRequired: false,
    composeUrl: 'https://www.threads.com/intent/post?text={text}',
    rules: [
      'One Threads post, 500 characters max. Conversational, can end on a question. No hashtags. One emoji at most.',
    ],
  },
  bluesky: {
    name: 'Bluesky',
    textName: 'post',
    maxLength: 300,
    measure: graphemeLength,
    video: false,
    title: false,
    assetRequired: false,
    composeUrl: 'https://bsky.app/intent/compose?text={text}',
    rules: ['One Bluesky post, 300 characters max. Plain and direct, no hashtags. One emoji at most.'],
  },
  linkedin: {
    name: 'LinkedIn',
    textName: 'post',
    maxLength: 1500,
    measure: graphemeLength,
    video: false,
    title: false,
    assetRequired: false,
    composeUrl: 'https://www.linkedin.com/feed/?shareActive=true&text={text}',
    rules: [
      'One LinkedIn post, 1,500 characters max, in short paragraphs separated by blank lines.',
      'Open with a first line that makes people click "see more": the take, not the announcement. Then what shipped, who it helps, and one practical takeaway.',
      'At most 3 hashtags, at the very end. No emojis as bullet points. No engagement bait ("Agree?", "Thoughts?").',
    ],
  },
  instagram: {
    name: 'Instagram',
    textName: 'caption',
    maxLength: 1000,
    measure: graphemeLength,
    video: false,
    title: false,
    assetRequired: true,
    composeUrl: 'https://www.instagram.com/',
    rules: [
      'One Instagram caption, 1,000 characters max. The first line must stand alone: it is all people see before "more".',
      'At most 5 relevant hashtags, at the end.',
      'asset_request is mandatory: describe the image or the carousel (slide by slide in the brief) that carries the post.',
    ],
  },
  tiktok: {
    name: 'TikTok',
    textName: 'caption',
    maxLength: 300,
    measure: graphemeLength,
    video: true,
    title: false,
    assetRequired: false,
    composeUrl: 'https://www.tiktok.com/upload',
    rules: [...VIDEO_RULES, 'The caption (text field) is 300 characters max, with at most 3 hashtags.'],
  },
  youtube: {
    name: 'YouTube Shorts',
    textName: 'description',
    maxLength: 1000,
    measure: graphemeLength,
    video: true,
    title: true,
    assetRequired: false,
    composeUrl: 'https://studio.youtube.com/',
    rules: [
      ...VIDEO_RULES,
      `A title of ${MAX_TITLE_LENGTH} characters max, specific and searchable, no clickbait.`,
      'The description (text field) is 1,000 characters max and lists the sources.',
    ],
  },
};

/** Longest share link we hand to Telegram: past it, the page opens empty and the text is copied instead. */
export const MAX_COMPOSE_URL = 2000;

/**
 * The link that opens the network's compose window, with the text already in when the network allows it and the link
 * stays short enough. prefilled says whether the text is in.
 */
export function composeLink(network: Network, text: string): { url: string; prefilled: boolean } {
  const template = NETWORK_SPECS[network].composeUrl;
  if (!template.includes('{text}')) return { url: template, prefilled: false };
  const url = template.replace('{text}', encodeURIComponent(text));
  if (url.length <= MAX_COMPOSE_URL) return { url, prefilled: true };
  return { url: template.replace(/[?&][^?&]*\{text\}.*$/, ''), prefilled: false };
}

/** The X compose window answering one post, with the reply already in. */
export function xReplyLink(postId: string, text: string): string {
  return `https://x.com/intent/post?in_reply_to=${encodeURIComponent(postId)}&text=${encodeURIComponent(text)}`;
}

export function isNetwork(value: string): value is Network {
  return (NETWORKS as readonly string[]).includes(value);
}
