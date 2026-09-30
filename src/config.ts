import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'config.json');

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'format HH:MM attendu');
const xHandle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'pseudo X invalide (sans @, 15 caractères au plus)');
const amount = z.number().nonnegative();
const vatMultiplier = z.number().min(1).max(2);

const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'fuseau horaire inconnu');

const modelPrice = z.strictObject({
  inputPerMillion: amount,
  outputPerMillion: amount,
});

const network = z.strictObject({ enabled: z.boolean() });

const configSchema = z.strictObject({
  timezone: timeZone,
  slots: z
    .array(clockTime)
    .min(1)
    .refine((slots) => new Set(slots).size === slots.length, 'créneaux en double'),
  networks: z.strictObject({
    x: network,
    instagram: network,
    tiktok: network,
    youtube: network,
  }),
  mistral: z
    .strictObject({
      models: z.strictObject({
        draft: z.string().min(1),
        cluster: z.string().min(1),
        chat: z.string().min(1),
      }),
      webSearchTool: z.enum(['web_search', 'web_search_premium']),
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
            message: `pas de tarif pour le modèle ${model} dans pricesEur.models`,
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
        'compte suivi en double',
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
    hackerNews: z.strictObject({ enabled: z.boolean() }),
  }),
  generation: z.strictObject({
    maxAttempts: z.number().int().min(1).max(10),
    exclusionDays: z.number().int().nonnegative(),
    triggerMaxAgeHours: z.number().positive(),
    tweetMaxWeightedLength: z.number().int().min(1).max(280),
  }),
  telegram: z.strictObject({
    copyButtonMaxChars: z.number().int().min(1).max(256),
  }),
  retention: z.strictObject({
    xTextHours: z.number().positive(),
  }),
  paths: z.strictObject({
    database: z.string().min(1),
    forbiddenTerms: z.string().min(1),
    voice: z.string().min(1),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

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
      .map((issue) => `- ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Config invalide :\n${details}`);
  }
  const config = result.data;
  return {
    ...config,
    paths: {
      database: path.resolve(rootDir, config.paths.database),
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
    throw new ConfigError(`Lecture de ${configPath} impossible : ${(error as Error).message}`);
  }
  return parseConfig(raw, path.resolve(path.dirname(configPath), '..'));
}
