import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/database.ts';
import { acquireLock } from '../lock.ts';
import { requireSecrets } from '../secrets.ts';
import { spentToday } from '../spend.ts';
import { createXClient } from '../x/client.ts';
import { resolveWatchedAccounts } from '../x/watch.ts';
import { runCli } from './context.ts';

// Resolves the numeric ids of watched accounts not resolved yet (0.01 $ each, once) and prints what X
// says about each one, so a handle that points to the wrong account can be spotted and removed.

await runCli(async () => {
  const config = loadConfig();
  const { X_BEARER_TOKEN } = requireSecrets(['X_BEARER_TOKEN']);
  const lock = acquireLock(config.paths.lock);
  const db = openDatabase(config.paths.database);
  try {
    const now = new Date();
    const { resolved, notFound } = await resolveWatchedAccounts(db, config, createXClient({ bearerToken: X_BEARER_TOKEN }), now);
    if (resolved.length === 0 && notFound.length === 0) console.log('Tous les comptes suivis sont déjà résolus.');
    for (const user of resolved) {
      const followers = user.public_metrics?.followers_count ?? '?';
      const badge = user.verified_type && user.verified_type !== 'none' ? user.verified_type : user.verified ? 'verified' : 'non vérifié';
      const bio = (user.description ?? '').replace(/\s+/g, ' ').slice(0, 90);
      console.log(`@${user.username} | ${user.name} | ${badge} | ${followers} abonnés | ${user.url ?? ''} | ${bio}`);
    }
    if (notFound.length > 0) console.log(`Introuvables : ${notFound.join(', ')}`);
    console.log(`Dépense X du jour : ${spentToday(db, config, 'x', now).toFixed(4)} $ TTC`);
  } finally {
    db.close();
    lock.release();
  }
});
