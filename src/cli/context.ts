import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/database.ts';
import { loadForbiddenTerms } from '../filters/forbidden-terms.ts';
import { acquireLock } from '../lock.ts';
import { createMistralGateway } from '../mistral/gateway.ts';
import { consoleNotifier } from '../notifier.ts';
import { requireSecrets } from '../secrets.ts';
import type { ServiceDeps } from '../service.ts';
import { loadVoice } from '../voice.ts';
import { createXClient, createXUserClient, type XUserClient } from '../x/client.ts';

const ACCOUNT_TOKENS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const;

/** The account's read-only tokens are optional: without any, mentions are not read; with only some, it is an error. */
function accountClient(): XUserClient | undefined {
  if (ACCOUNT_TOKENS.every((name) => !process.env[name]?.trim())) return undefined;
  const tokens = requireSecrets(ACCOUNT_TOKENS);
  return createXUserClient({
    credentials: {
      consumerKey: tokens.X_API_KEY,
      consumerSecret: tokens.X_API_SECRET,
      token: tokens.X_ACCESS_TOKEN,
      tokenSecret: tokens.X_ACCESS_TOKEN_SECRET,
    },
  });
}

/** Builds everything the service needs. Fails fast, with a readable message, on any missing piece. */
export function buildServiceDeps(): ServiceDeps & { release(): void } {
  const config = loadConfig();
  const secrets = requireSecrets(['MISTRAL_API_KEY']);
  // X is optional: without its app token, the watch reads RSS feeds and Hacker News only.
  const bearerToken = process.env.X_BEARER_TOKEN?.trim();
  const filter = loadForbiddenTerms(config.paths.forbiddenTerms);
  const voice = loadVoice(config.paths.voice);
  const xUser = accountClient();
  const lock = acquireLock(config.paths.lock);
  const db = openDatabase(config.paths.database);
  return {
    db,
    config,
    filter,
    voice,
    gateway: createMistralGateway(secrets.MISTRAL_API_KEY),
    ...(bearerToken ? { x: createXClient({ bearerToken }) } : {}),
    ...(xUser ? { xUser } : {}),
    notifier: consoleNotifier,
    now: () => new Date(),
    log: (message) => console.log(`${new Date().toISOString()} ${message}`),
    release: () => {
      db.close();
      lock.release();
    },
  };
}

/** Runs a command, printing only the message of a failure. */
export async function runCli(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
