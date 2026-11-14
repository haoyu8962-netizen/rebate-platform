import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { batch, close, event, keys, open, overlap, rows, TIMEOUT, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(['same-type', 'different-types'] as const)(
  '[AC-CT-13i#4] 反序批次 [A,B]/[B,A]（%s）真实重叠仍均成功，无 40P01 且每键仅一行',
  async (shape) => {
    // Exercise both UUID and type conflicts; batch.int.test.ts separately pins tuple order.
    const prefix = event().eventId.slice(0, -12);
    const a = event({ eventId: `${prefix}000000000002`, eventType: 'a_event' });
    const b = event({
      eventId: `${prefix}000000000001`,
      eventType: shape === 'same-type' ? 'a_event' : 'z_event',
    });
    const left = batch([a, b].map((item) => ({ ...item, props: { writer: 'left' } })));
    const right = {
      ...left,
      events: [b, a].map((item) => ({ ...item, props: { writer: 'right' } })),
    };
    const observed = await overlap(h, left, right);
    // A raw PostgreSQL rejection is data here: the old 40P01 becomes an assertion failure.
    expect(observed.results).toEqual([
      { status: 'fulfilled', value: { accepted: 2, duplicates: 0 } },
      { status: 'fulfilled', value: { accepted: 0, duplicates: 2 } },
    ]);
    const stored = await rows(h.observer, left.appId);
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => [row.event_type, row.event_id]).sort()).toEqual(
      [a, b].map((item) => [item.eventType, item.eventId]).sort(),
    );
    expect(stored.map((row) => row.props)).toEqual([{ writer: 'left' }, { writer: 'left' }]);
    expect(
      (await keys(h.observer, left.appId)).map((row) => [row.event_type, row.event_id]).sort(),
    ).toEqual(stored.map((row) => [row.event_type, row.event_id]).sort());
  },
  TIMEOUT,
);
