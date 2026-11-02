import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { explainTelegramError, privateChatsFromUpdates } from '../src/telegram/updates.ts';

describe('privateChatsFromUpdates', () => {
  test('keeps private chats once each, in arrival order, and ignores groups', () => {
    const updates = [
      { update_id: 1, message: { chat: { id: -100, type: 'supergroup' } } },
      { update_id: 2, message: { chat: { id: 42, type: 'private', username: 'someone', first_name: 'Jane' } } },
      { update_id: 3, edited_message: { chat: { id: 42, type: 'private' } } },
      { update_id: 4, message: { chat: { id: 7, type: 'private' } } },
      { update_id: 5 },
    ];
    assert.deepEqual(privateChatsFromUpdates(updates), [
      { chatId: 42, username: 'someone', firstName: 'Jane' },
      { chatId: 7 },
    ]);
  });

  test('returns nothing when no one wrote', () => {
    assert.deepEqual(privateChatsFromUpdates([]), []);
  });
});

describe('explainTelegramError', () => {
  test('points to the token on 401 and to a second instance on 409', () => {
    assert.match(explainTelegramError(401), /TELEGRAM_BOT_TOKEN/);
    assert.match(explainTelegramError(409), /Another instance/);
    assert.equal(explainTelegramError(500, 'Internal'), 'Telegram error 500: Internal');
  });
});
