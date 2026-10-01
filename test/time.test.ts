import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { currentSlot, utcDay, zonedDay, zonedTimeToUtc } from '../src/time.ts';

const PARIS = 'Europe/Paris';
const SLOTS = ['09:00', '13:00', '17:00', '21:00'];

describe('days', () => {
  test('the Paris day and the UTC day can differ', () => {
    const lateEvening = new Date('2026-10-01T22:30:00Z');
    assert.equal(zonedDay(lateEvening, PARIS), '2026-10-02');
    assert.equal(utcDay(lateEvening), '2026-10-01');
  });
});

describe('zonedTimeToUtc', () => {
  test('uses summer and winter offsets', () => {
    assert.equal(zonedTimeToUtc(2026, 7, 1, 9, 0, PARIS).toISOString(), '2026-07-01T07:00:00.000Z');
    assert.equal(zonedTimeToUtc(2026, 12, 1, 9, 0, PARIS).toISOString(), '2026-12-01T08:00:00.000Z');
  });

  test('handles the days clocks change', () => {
    assert.equal(zonedTimeToUtc(2026, 3, 29, 9, 0, PARIS).toISOString(), '2026-03-29T07:00:00.000Z');
    assert.equal(zonedTimeToUtc(2026, 10, 25, 9, 0, PARIS).toISOString(), '2026-10-25T08:00:00.000Z');
  });
});

describe('currentSlot', () => {
  test('is the latest slot already started today', () => {
    // 13:40 in Paris (UTC+2 in October): the 13:00 slot, 11:00 UTC.
    assert.equal(currentSlot(new Date('2026-10-01T11:40:00Z'), SLOTS, PARIS).toISOString(), '2026-10-01T11:00:00.000Z');
  });

  test('starts exactly at the slot time', () => {
    assert.equal(currentSlot(new Date('2026-10-01T07:00:00Z'), SLOTS, PARIS).toISOString(), '2026-10-01T07:00:00.000Z');
  });

  test('before the first slot, it is still yesterday evening', () => {
    assert.equal(currentSlot(new Date('2026-10-01T05:00:00Z'), SLOTS, PARIS).toISOString(), '2026-09-30T19:00:00.000Z');
  });

  test('after a long sleep, only the slot in progress counts', () => {
    // Asleep from 08:00 to 16:30 Paris time: 09:00 and 13:00 were missed, 13:00 is the one in progress.
    assert.equal(currentSlot(new Date('2026-10-01T14:30:00Z'), SLOTS, PARIS).toISOString(), '2026-10-01T11:00:00.000Z');
  });
});
