import type { DraftJson } from './generation/draft.ts';

export type ProposedDraft = DraftJson & { id?: number; weightedLength: number; triggerUrl: string };

/** Where drafts, alerts and notices go: the Telegram bot when the service runs, the console for the dry run. */
export type Notifier = {
  draftProposed(draft: ProposedDraft): Promise<void> | void;
  alert(message: string): Promise<void> | void;
  /** Information that needs no action, such as new mentions. */
  notice(message: string): Promise<void> | void;
};

export function formatDraftCard(draft: ProposedDraft): string {
  const asset = draft.asset_request
    ? `Matière : ${draft.asset_request.type}, ${draft.asset_request.duration_s} s. ${draft.asset_request.brief}`
    : 'Matière : aucune';
  return [
    `Brouillon${draft.id ? ` n° ${draft.id}` : ''} · pilier ${draft.pillar} · ${draft.weightedLength}/280`,
    '',
    draft.tweet,
    '',
    `Pourquoi : ${draft.why_it_matters}`,
    `Sujet : ${draft.topic}`,
    `Déclencheur : ${draft.triggerUrl}`,
    'Sources :',
    ...draft.sources.map((s) => `  ${s}`),
    asset,
  ].join('\n');
}

export const consoleNotifier: Notifier = {
  draftProposed(draft) {
    console.log(`\n${formatDraftCard(draft)}\n`);
  },
  alert(message) {
    console.error(`[alerte] ${message}`);
  },
  notice(message) {
    console.log(message);
  },
};
