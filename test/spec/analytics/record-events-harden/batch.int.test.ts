import { createTestDatabase } from '@couli/db/testing';
import { ValueNode, ValuesNode, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recordEvents } from '../../../../apps/api/src/modules/analytics/index.ts';
import { batch, close, event, keys, open, rows, TIMEOUT, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-CT-13i#5] 入库前批内去重并按完整键升序提交，重复保留首条且逐条计数', async () => {
  const prefix = event().eventId.slice(0, -12);
  const low = `${prefix}000000000001`;
  const high = `${prefix}000000000002`;
  const first = event({ eventType: 'z_event', eventId: low, props: { first: true } });
  const middle = event({ eventType: 'a_event', eventId: high });
  const smallest = event({ eventType: 'a_event', eventId: low });
  const input = batch([
    first,
    middle,
    { ...first, props: { first: false }, clientAt: '2026-11-15T00:00:00.000Z' },
    smallest,
    middle,
  ]);
  const submitted: unknown[][] = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (node.kind === 'InsertQueryNode' && node.into?.table.identifier.name === 'event_dedup') {
        // Observe actual VALUES sent to PostgreSQL, including DO NOTHING attempts.
        // Handles one-row and multi-row INSERTs, without constraining SQL column order.
        const values = node.values;
        expect(values?.kind, 'dedup writes must expose their submitted VALUES to the probe').toBe(
          'ValuesNode',
        );
        if (values && ValuesNode.is(values)) {
          const columns = node.columns?.map((column) => column.column.name) ?? [];
          for (const row of values.values) {
            const items =
              row.kind === 'PrimitiveValueListNode'
                ? row.values
                : row.values.map((value) => (ValueNode.is(value) ? value.value : undefined));
            submitted.push(
              ['app_id', 'event_type', 'event_id'].map((name) => items[columns.indexOf(name)]),
            );
          }
        }
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  await expect(recordEvents(h.left.withPlugin(plugin), input)).resolves.toEqual({
    accepted: 3,
    duplicates: 2,
  });
  expect(submitted).toEqual([
    [input.appId, 'a_event', low],
    [input.appId, 'a_event', high],
    [input.appId, 'z_event', low],
  ]);
  const stored = await rows(h.observer, input.appId);
  expect(stored).toHaveLength(3);
  expect(stored.find((row) => row.event_type === first.eventType)).toMatchObject({
    props: { first: true },
    client_at: new Date(first.clientAt),
  });
  expect(await keys(h.observer, input.appId)).toHaveLength(3);
  // Input order/content must remain usable by the caller after sorting and deduplication.
  expect(input.events).toEqual([
    first,
    middle,
    { ...first, props: { first: false }, clientAt: '2026-11-15T00:00:00.000Z' },
    smallest,
    middle,
  ]);
});
