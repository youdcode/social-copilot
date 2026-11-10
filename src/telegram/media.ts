import { InputFile, type Api } from 'grammy';
import type { AssistantDeps } from '../assistant.ts';
import { getDraft, markAssetReady } from '../drafts.ts';
import { mediaDir, mediaKind, produceMedia } from '../media/studio.ts';
import type { SerialQueue } from '../queue.ts';
import { BudgetExceededError } from '../spend.ts';
import { VIDEO_HEIGHT, VIDEO_WIDTH } from '../media/video.ts';

/** Makes a draft's images or video and sends them under its card. */
export type MediaDelivery = { deliver(draftId: number, cardMessageId: number): void };

/**
 * Media are made one at a time, apart from drafts and the bot, and sent as a reply to the draft card: images as files
 * so Telegram does not recompress them, the video as a video. Producing them fulfils the draft's asset request.
 * A failure is told in the chat, never thrown.
 */
export function createMediaDelivery(
  api: Api,
  chatId: number,
  deps: AssistantDeps,
  queue: SerialQueue,
): MediaDelivery {
  return {
    deliver(draftId, cardMessageId) {
      const draft = getDraft(deps.db, draftId);
      if (!deps.config.media.enabled || !draft || !mediaKind(draft)) return;
      const reply = { reply_parameters: { message_id: cardMessageId, allow_sending_without_reply: true } };
      void queue.run(async () => {
        try {
          await api.sendChatAction(chatId, mediaKind(draft) === 'video' ? 'upload_video' : 'upload_document').catch(() => {});
          const media = await produceMedia(deps, draft, mediaDir(deps.config.paths.database, String(draftId)));
          if (!media) {
            await api.sendMessage(chatId, `No carousel for draft #${draftId}: the slides did not pass the checks.`, reply);
            return;
          }
          if (media.kind === 'video') {
            await api.sendVideo(chatId, new InputFile(media.file), {
              ...reply,
              width: VIDEO_WIDTH,
              height: VIDEO_HEIGHT,
              duration: Math.round(media.seconds),
              supports_streaming: true,
              caption: `Video for draft #${draftId}, no sound: add a voice or music in the app if you like.`,
            });
          } else {
            await api.sendMediaGroup(
              chatId,
              media.files.map((file, i) => ({
                type: 'document' as const,
                media: new InputFile(file),
                ...(i === media.files.length - 1 ? { caption: `Carousel for draft #${draftId}, in posting order.` } : {}),
              })),
              reply,
            );
          }
          markAssetReady(deps.db, draftId, deps.now());
        } catch (error) {
          const message = error instanceof BudgetExceededError ? error.message : (error as Error).message;
          deps.log(`Media of draft #${draftId} failed: ${message}`);
          await api.sendMessage(chatId, `⚠️ No visual for draft #${draftId}: ${message}`, reply).catch(() => {});
        }
      });
    },
  };
}
