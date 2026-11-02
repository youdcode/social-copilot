import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/database.ts';
import { purgeXPost } from '../x/watch.ts';
import { runCli } from './context.ts';

// Removes one X post from the database on request: npm run x:purge -- <post id>

await runCli(async () => {
  const postId = process.argv[2];
  if (!postId || !/^\d{1,19}$/.test(postId)) throw new Error('Usage: npm run x:purge -- <post id>');
  const config = loadConfig();
  const db = openDatabase(config.paths.database);
  try {
    const { posts, replies } = purgeXPost(db, postId, new Date());
    console.log(`Post ${postId}: ${posts} row(s) deleted, text erased in ${replies} reply(ies).`);
  } finally {
    db.close();
  }
});
