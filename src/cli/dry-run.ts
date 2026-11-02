import { enabledNetworks } from '../config.ts';
import { generateDraft } from '../generation/generator.ts';
import { isNetwork, NETWORKS } from '../networks.ts';
import { formatDraftCard } from '../notifier.ts';
import { createServiceState, runPoll } from '../service.ts';
import { spentToday } from '../spend.ts';
import { currentSlot } from '../time.ts';
import { buildServiceDeps, runCli } from './context.ts';

// Dry run: one real poll and one real draft for one network (npm run dry-run -- linkedin), printed here,
// never stored nor sent anywhere. Without a network, the first enabled one.

await runCli(async () => {
  const requested = process.argv[2];
  if (requested !== undefined && !isNetwork(requested)) {
    throw new Error(`Unknown network "${requested}". Pick one of: ${NETWORKS.join(', ')}.`);
  }
  const deps = buildServiceDeps();
  try {
    const network = requested ?? enabledNetworks(deps.config)[0] ?? 'x';
    const report = await runPoll(deps, createServiceState());
    console.log(
      `Watch: X ${report.x ? `${report.x.newPosts} post(s) from ${report.x.polled} account(s)` : 'not read'}, mentions ${report.mentions ?? 'not read'}, RSS ${report.rssNew} new, HN ${report.hnNew} new`,
    );
    report.problems.forEach((p) => console.log(`  ${p}`));

    const slot = currentSlot(deps.now(), deps.config.networks[network].slots, deps.config.timezone);
    const outcome = await generateDraft(deps, network, slot, { save: false });
    console.log(`\nResult for ${network}: ${outcome.status} (${outcome.detail})`);
    if (outcome.topic) console.log(`Topic: ${outcome.topic.label}, trigger ${outcome.topic.trigger.url}`);
    outcome.attempts.forEach((a, i) =>
      console.log(
        `  Attempt ${i + 1} (${a.mode === 'single' ? 'single call' : 'two calls'}): ${a.toolCalls} search(es), ${a.references} reference(s), JSON ${a.jsonParsed ? 'read' : 'unreadable'}${a.errors.length ? `, rejected: ${a.errors.join(' | ')}` : ''}`,
      ),
    );
    if (outcome.draft) console.log(`\n${formatDraftCard(outcome.draft)}`);
    const now = deps.now();
    console.log(
      `\nSpend today (VAT incl.): Mistral €${spentToday(deps.db, deps.config, 'mistral', now).toFixed(4)} of €${deps.config.mistral.dailyCapEur}, X $${spentToday(deps.db, deps.config, 'x', now).toFixed(4)} of $${deps.config.x.dailyCapUsd}`,
    );
  } finally {
    deps.release();
  }
});
