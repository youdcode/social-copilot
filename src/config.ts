import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NETWORKS, type Network } from './networks.ts';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'config.json');

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const xHandle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'invalid X handle (no @, 15 characters at most)');
const amount = z.number().nonnegative();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a color like #1a2b3c');
const vatMultiplier = z.number().min(1).max(2);

const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'unknown time zone');

const modelPrice = z.strictObject({
  inputPerMillion: amount,
  outputPerMillion: amount,
});

/** A network gets one draft per slot, at these times of the configured time zone, when enabled. */
const network = z.strictObject({
  enabled: z.boolean(),
  slots: z
    .array(clockTime)
    .min(1)
    .refine((slots) => new Set(slots).size === slots.length, 'duplicate slots'),
});

const configSchema = z.strictObject({
  timezone: timeZone,
  networks: z.strictObject(Object.fromEntries(NETWORKS.map((n) => [n, network])) as Record<Network, typeof network>),
  mistral: z
    .strictObject({
      models: z.strictObject({
        draft: z.string().min(1),
        cluster: z.string().min(1),
        chat: z.string().min(1),
      }),
      webSearchTool: z.enum(['web_search', 'web_search_premium']),
      draftMode: z.enum(['single', 'two_step']),
      dailyCapEur: amount.positive(),
      vatMultiplier,
      countConnectorTokensAsInput: z.boolean(),
      pricesEur: z.strictObject({
        models: z.record(z.string(), modelPrice),
        webSearchPerCall: amount,
        webSearchPremiumPerCall: amount,
      }),
    })
    .superRefine((mistral, ctx) => {
      for (const [role, model] of Object.entries(mistral.models)) {
        if (!(model in mistral.pricesEur.models)) {
          ctx.addIssue({
            code: 'custom',
            path: ['models', role],
            message: `no price for model ${model} in pricesEur.models`,
          });
        }
      }
    }),
  x: z.strictObject({
    pollIntervalMinutes: z.number().int().positive(),
    watchedAccounts: z
      .array(xHandle)
      .refine(
        (handles) => new Set(handles.map((h) => h.toLowerCase())).size === handles.length,
        'duplicate watched account',
      ),
    timelineExclude: z.array(z.enum(['retweets', 'replies'])),
    dailyCapUsd: amount.positive(),
    vatMultiplier,
    pricesUsd: z.strictObject({
      postRead: amount,
      userRead: amount,
      ownedRead: amount,
    }),
  }),
  sources: z.strictObject({
    rssFeeds: z.array(z.url()),
    hackerNews: z.strictObject({
      enabled: z.boolean(),
      topStories: z.number().int().min(1).max(100),
    }),
  }),
  generation: z.strictObject({
    maxAttempts: z.number().int().min(1).max(10),
    exclusionDays: z.number().int().nonnegative(),
    triggerMaxAgeHours: z.number().positive(),
  }),
  telegram: z.strictObject({
    copyButtonMaxChars: z.number().int().min(1).max(256),
  }),
  retention: z.strictObject({
    xTextHours: z.number().positive(),
  }),
  /** Images and videos made for drafts, on this computer. */
  media: z.strictObject({
    enabled: z.boolean(),
    /** ffmpeg assembles the videos: a command on the PATH, or a full path. */
    ffmpeg: z.string().min(1),
    fps: z.number().int().min(12).max(60),
    /** hyperframes: GSAP compositions rendered in Chrome (motion blur, richer motion); basic: drawn frames, no browser. */
    engine: z.enum(['hyperframes', 'basic']),
    keepDays: z.number().positive(),
    theme: z.strictObject({ background: color, text: color, muted: color, accent: color }),
    /** The English voiceover of videos: a Kokoro voice, run on this computer. */
    voice: z.strictObject({
      enabled: z.boolean(),
      name: z.string().regex(/^[a-z]{2}_[a-z]+$/, 'a Kokoro voice like af_heart'),
      speed: z.number().min(0.5).max(2),
    }),
    /** A music file of your own, under the voice. Empty: none. Mind its license. */
    music: z.string(),
  }),
  paths: z.strictObject({
    database: z.string().min(1),
    lock: z.string().min(1),
    forbiddenTerms: z.string().min(1),
    voice: z.string().min(1),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

/** Networks switched on in the config, in display order. */
export function enabledNetworks(config: AppConfig): Network[] {
  return NETWORKS.filter((n) => config.networks[n].enabled);
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Validates a parsed config object. Relative paths are resolved against rootDir.
 */
export function parseConfig(raw: unknown, rootDir: string = PROJECT_ROOT): AppConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config:\n${details}`);
  }
  const config = result.data;
  return {
    ...config,
    paths: {
      database: path.resolve(rootDir, config.paths.database),
      lock: path.resolve(rootDir, config.paths.lock),
      forbiddenTerms: path.resolve(rootDir, config.paths.forbiddenTerms),
      voice: path.resolve(rootDir, config.paths.voice),
    },
  };
}

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Cannot read ${configPath}: ${(error as Error).message}`);
  }
  return parseConfig(raw, path.resolve(path.dirname(configPath), '..'));
}
