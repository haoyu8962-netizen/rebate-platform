import { createTestDatabase } from '@couli/db/testing';
import type { KyselyPlugin, QueryId } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { recordEvents, type EventProps } from '../../../../apps/api/src/modules/analytics/index.ts';
import { batch, close, event, keys, open, rows, TIMEOUT, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-CT-13g#7] 先插去重行再写事件；提交前两表对另一连接不可见，事件写完后失败整体回滚', async () => {
  const input = batch([event(), event()]);
  const failure = new Error('CT-13g injected failure after event INSERT');
  const inserts: string[] = [];
  const observed: Array<{ events: number; dedup: number }> = [];
  const eventQueries = new WeakSet<QueryId>();
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'InsertQueryNode') {
        const table = node.into?.table.identifier.name;
        if (table === 'events' || table === 'event_dedup') inserts.push(table);
        if (table === 'events') eventQueries.add(queryId);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      if (eventQueries.has(queryId)) {
        observed.push({
          events: (await rows(h.other, input.appId)).length,
          dedup: (await keys(h.other, input.appId)).length,
        });
        throw failure;
      }
      return result;
    },
  };
  await expect(recordEvents(h.db.withPlugin(plugin), input)).rejects.toBe(failure);
  expect(inserts[0]).toBe('event_dedup');
  expect(inserts).toContain('events');
  expect(observed).toEqual([{ events: 0, dedup: 0 }]);
  expect(await rows(h.other, input.appId)).toEqual([]);
  expect(await keys(h.other, input.appId)).toEqual([]);
  expect(await recordEvents(h.other, input)).toEqual({ accepted: 2, duplicates: 0 });
  expect(await rows(h.db, input.appId)).toHaveLength(2);
  expect(await keys(h.db, input.appId)).toHaveLength(2);
});

it('[AC-CT-13g#8] 去重写入失败时不写事件、不报成功，恢复后同一批可以全部接受', async () => {
  const input = batch([event(), event()]);
  const failure = new Error('CT-13g dedup unavailable');
  const inserts: string[] = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (node.kind === 'InsertQueryNode') {
        const table = node.into?.table.identifier.name;
        if (table !== undefined) inserts.push(table);
        if (table === 'event_dedup') throw failure;
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
  await expect(recordEvents(h.db.withPlugin(plugin), input)).rejects.toBe(failure);
  expect(inserts).toEqual(['event_dedup']);
  expect(await rows(h.other, input.appId)).toEqual([]);
  expect(await keys(h.other, input.appId)).toEqual([]);
  expect(await recordEvents(h.other, input)).toEqual({ accepted: 2, duplicates: 0 });
});

it.each([
  ['null', null],
  ['array', []],
  ['string', 'payload'],
  ['number', 42],
  ['boolean', true],
])(
  '[AC-CT-13g#9] props 为 %s 时整批拒绝，之前的新事件也回滚，既有行保持不变',
  async (_label, invalid) => {
    const existing = event();
    const input = batch([existing]);
    expect(await recordEvents(h.db, input)).toEqual({ accepted: 1, duplicates: 0 });
    const before = await rows(h.db, input.appId);
    const beforeKeys = await keys(h.db, input.appId);
    const first = event();
    const bad = event({ props: invalid as unknown as EventProps });
    await expect(
      recordEvents(h.db, { ...input, events: [existing, first, bad] }),
    ).rejects.toThrow();
    expect(await rows(h.other, input.appId)).toEqual(before);
    expect(await keys(h.other, input.appId)).toEqual(beforeKeys);
    expect(
      await recordEvents(h.other, { ...input, events: [first, { ...bad, props: {} }] }),
    ).toEqual({ accepted: 2, duplicates: 0 });
    expect(await rows(h.db, input.appId)).toHaveLength(3);
    expect(await keys(h.db, input.appId)).toHaveLength(3);
  },
);
