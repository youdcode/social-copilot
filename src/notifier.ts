import type { DraftJson } from './generation/draft.ts';
import { NETWORK_SPECS, type Network } from './networks.ts';

export type ProposedDraft = DraftJson & { id?: number; network: Network; length: number; triggerUrl: string };

/** Where drafts, alerts and notices go: the Telegram bot when the service runs, the console for the dry run. */
export type Notifier = {
  draftProposed(draft: ProposedDraft): Promise<void> | void;
  alert(message: string): Promise<void> | void;
  /** Information that needs no action, such as new mentions. */
  notice(message: string): Promise<void> | void;
};

export function formatDraftCard(draft: ProposedDraft): string {
  const spec = NETWORK_SPECS[draft.network];
  const asset = draft.asset_request
    ? `Asset: ${draft.asset_request.type}, ${draft.asset_request.duration_s} s. ${draft.asset_request.brief}`
    : 'Asset: none';
  const script = draft.script
    ? [
        `Script (${draft.script.duration_s} s), hook: ${draft.script.hook}`,
        ...draft.script.shots.map(
          (shot, i) => `  ${i + 1}. ${shot.visual} | says: ${shot.voiceover} | on screen: ${shot.on_screen_text}`,
        ),
      ]
    : [];
  return [
    `${spec.name} draft${draft.id ? ` #${draft.id}` : ''} · pillar ${draft.pillar} · ${draft.length}/${spec.maxLength}`,
    ...(draft.title ? ['', `Title: ${draft.title}`] : []),
    '',
    draft.text,
    ...(script.length > 0 ? ['', ...script] : []),
    '',
    `Why: ${draft.why_it_matters}`,
    `Topic: ${draft.topic}`,
    `Trigger: ${draft.triggerUrl}`,
    'Sources:',
    ...draft.sources.map((s) => `  ${s}`),
    asset,
  ].join('\n');
}

export const consoleNotifier: Notifier = {
  draftProposed(draft) {
    console.log(`\n${formatDraftCard(draft)}\n`);
  },
  alert(message) {
    console.error(`[alert] ${message}`);
  },
  notice(message) {
    console.log(message);
  },
};
