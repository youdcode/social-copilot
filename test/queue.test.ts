import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSerialQueue } from '../src/queue.ts';

describe('createSerialQueue', () => {
  test('runs jobs one at a time, in order, and survives a failing job', async () => {
    const queue = createSerialQueue();
    const events: string[] = [];
    const job = (name: string, fail = false) => async () => {
      events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    };
    const a = queue.run(job('a'));
    const b = queue.run(job('b', true));
    const c = queue.run(job('c'));
    assert.equal(queue.busy, true);
    assert.equal(await a, 'a');
    await assert.rejects(b, /b/);
    assert.equal(await c, 'c');
    await queue.idle();
    assert.equal(queue.busy, false);
    assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });
});
