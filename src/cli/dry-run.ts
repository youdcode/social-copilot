import { enabledNetworks } from '../config.ts';
import { generateDraft } from '../generation/generator.ts';
import type { Draft } from '../drafts.ts';
import { mediaDir, mediaKind, produceMedia } from '../media/studio.ts';
import { isNetwork, NETWORK_SPECS, NETWORKS } from '../networks.ts';
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
    if (outcome.draft) {
      console.log(`\n${formatDraftCard(outcome.draft)}`);
      // The images or video the bot would send, made for real and left in data/media/dry-run-<network>.
      const d = outcome.draft;
      const draft: Draft = {
        id: 0, network, slotAt: slot.toISOString(), pillar: d.pillar, topic: d.topic, text: d.text, length: d.length,
        title: d.title, script: d.script, whyItMatters: d.why_it_matters, sources: d.sources, assetRequest: d.asset_request,
        assetReadyAt: null, triggerUrl: d.triggerUrl, status: 'proposed', refusalReason: null, postedUrl: null, telegramMessageId: null,
      };
      if (deps.config.media.enabled && mediaKind(draft)) {
        const media = await produceMedia(deps, draft, mediaDir(deps.config.paths.database, `dry-run-${network}`));
        if (!media) console.log(`\nNo ${NETWORK_SPECS[network].name} visual: the carousel did not pass the checks.`);
        else if (media.kind === 'video') console.log(`\nVideo (${media.seconds.toFixed(1)} s): ${media.file}`);
        else console.log(`\nImages:\n${media.files.map((f) => `  ${f}`).join('\n')}`);
      }
    }
    const now = deps.now();
    console.log(
      `\nSpend today (VAT incl.): Mistral €${spentToday(deps.db, deps.config, 'mistral', now).toFixed(4)} of €${deps.config.mistral.dailyCapEur}, X $${spentToday(deps.db, deps.config, 'x', now).toFixed(4)} of $${deps.config.x.dailyCapUsd}`,
    );
  } finally {
    deps.release();
  }
});
