import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/database.ts';
import { loadForbiddenTerms } from '../filters/forbidden-terms.ts';
import { acquireLock } from '../lock.ts';
import { createMistralGateway } from '../mistral/gateway.ts';
import { consoleNotifier } from '../notifier.ts';
import { requireSecrets } from '../secrets.ts';
import type { ServiceDeps } from '../service.ts';
import { loadVoice } from '../voice.ts';
import { createXClient } from '../x/client.ts';

/** Builds everything the service needs. Fails fast, with a readable message, on any missing piece. */
export function buildServiceDeps(): ServiceDeps & { release(): void } {
  const config = loadConfig();
  const secrets = requireSecrets(['MISTRAL_API_KEY', 'X_BEARER_TOKEN']);
  const filter = loadForbiddenTerms(config.paths.forbiddenTerms);
  const voice = loadVoice(config.paths.voice);
  const lock = acquireLock(config.paths.lock);
  const db = openDatabase(config.paths.database);
  return {
    db,
    config,
    filter,
    voice,
    gateway: createMistralGateway(secrets.MISTRAL_API_KEY),
    x: createXClient({ bearerToken: secrets.X_BEARER_TOKEN }),
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
