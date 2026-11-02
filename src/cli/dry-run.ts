import { generateDraft } from '../generation/generator.ts';
import { formatDraftCard } from '../notifier.ts';
import { createServiceState, runPoll } from '../service.ts';
import { spentToday } from '../spend.ts';
import { currentSlot } from '../time.ts';
import { buildServiceDeps, runCli } from './context.ts';

// Test à blanc : one real poll and one real draft, printed here, never stored nor sent anywhere.

await runCli(async () => {
  const deps = buildServiceDeps();
  try {
    const report = await runPoll(deps, createServiceState());
    console.log(
      `Veille : X ${report.x ? `${report.x.newPosts} post(s) sur ${report.x.polled} compte(s)` : 'non lu'}, mentions ${report.mentions ?? 'non lues'}, RSS ${report.rssNew} nouveau(x), HN ${report.hnNew} nouveau(x)`,
    );
    report.problems.forEach((p) => console.log(`  ${p}`));

    const slot = currentSlot(deps.now(), deps.config.slots, deps.config.timezone);
    const outcome = await generateDraft(deps, slot, { save: false });
    console.log(`\nRésultat : ${outcome.status} (${outcome.detail})`);
    if (outcome.topic) console.log(`Sujet : ${outcome.topic.label}, déclencheur ${outcome.topic.trigger.url}`);
    outcome.attempts.forEach((a, i) =>
      console.log(
        `  Tentative ${i + 1} (${a.mode === 'single' ? 'appel unique' : 'deux appels'}) : ${a.toolCalls} recherche(s), ${a.references} référence(s), JSON ${a.jsonParsed ? 'lu' : 'illisible'}${a.errors.length ? `, rejets : ${a.errors.join(' | ')}` : ''}`,
      ),
    );
    if (outcome.draft) console.log(`\n${formatDraftCard(outcome.draft)}`);
    const now = deps.now();
    console.log(
      `\nDépense du jour : Mistral ${spentToday(deps.db, deps.config, 'mistral', now).toFixed(4)} € / ${deps.config.mistral.dailyCapEur} €, X ${spentToday(deps.db, deps.config, 'x', now).toFixed(4)} $ / ${deps.config.x.dailyCapUsd} $ (TTC)`,
    );
  } finally {
    deps.release();
  }
});
