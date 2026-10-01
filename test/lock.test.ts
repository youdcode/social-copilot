import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { acquireLock, LockError } from '../src/lock.ts';

describe('acquireLock', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lock-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('refuses a second instance while the first holds the lock', () => {
    const file = path.join(dir, 'a.lock');
    const lock = acquireLock(file);
    assert.throws(() => acquireLock(file), LockError);
    lock.release();
    assert.equal(existsSync(file), false);
    acquireLock(file).release();
  });

  test('takes over a lock left by a dead process', () => {
    const file = path.join(dir, 'b.lock');
    writeFileSync(file, '2147483646');
    const lock = acquireLock(file);
    lock.release();
  });
});
