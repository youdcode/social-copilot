import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MissingSecretError, requireSecrets } from '../src/secrets.ts';

describe('requireSecrets', () => {
  test('returns the requested variables, trimmed', () => {
    const secrets = requireSecrets(['MISTRAL_API_KEY'], { MISTRAL_API_KEY: ' test-value ' });
    assert.deepEqual(secrets, { MISTRAL_API_KEY: 'test-value' });
  });

  test('names every missing or blank variable without leaking any value', () => {
    const env = { X_BEARER_TOKEN: 'secret-value', TELEGRAM_BOT_TOKEN: '  ' };
    assert.throws(
      () => requireSecrets(['MISTRAL_API_KEY', 'X_BEARER_TOKEN', 'TELEGRAM_BOT_TOKEN'], env),
      (error: unknown) => {
        assert.ok(error instanceof MissingSecretError);
        assert.match(error.message, /MISTRAL_API_KEY, TELEGRAM_BOT_TOKEN/);
        assert.doesNotMatch(error.message, /secret-value/);
        return true;
      },
    );
  });
});
