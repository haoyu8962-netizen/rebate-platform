import { expect, it } from 'vitest';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { harness, request, response } from '../archive/kit.ts';
import { ctx, win } from '../pdd-orders/kit.ts';
import { archiveDb } from './db-kit.ts';
import { envelope, pdd, reply, sourceRow, sources, value } from './kit.ts';

it.each([200, 503])(
  '[AC-B1-08e-ARCHIVE#1] HTTP %i 插入成功才回传真实 returning id，精度与原响应内容不变',
  async (status) => {
    const { db, statements } = archiveDb([9007199254740993n, 9007199254740995n]);
    try {
      const h = harness(db);
      const wrapped = createArchivingTransport(
        async () => ({ ...response('synthetic-body'), status }),
        h,
      );
      const first = await wrapped(request(h.appId));
      const second = await wrapped(request(h.appId));
      expect(value(first, 'raw_payload_id')).toBe('9007199254740993');
      expect(value(second, 'raw_payload_id')).toBe('9007199254740995');
      for (const result of [first, second]) {
        expect(result.status).toBe(status);
        expect(result.headers).toEqual({ 'x-synthetic': 'reply' });
        expect(result.body).toBe('synthetic-body');
      }
      expect(statements).toHaveLength(2);
      for (const statement of statements) {
        expect(statement.sql).toMatch(/^insert into "app"\."union_raw_payloads"/);
        expect(statement.sql).toMatch(/returning\s+"id"/i);
        expect(statement.parameters).toContain(h.appId);
      }
      expect(h.logger.error).not.toHaveBeenCalled();
    } finally {
      await db.destroy();
    }
  },
);

it('[AC-B1-08e-ARCHIVE#2] 同一包装器成功、失败、无上下文、恢复成功，只有成功插入回传本次 ID', async () => {
  const { db, statements } = archiveDb([
    9007199254741001n,
    new Error('synthetic insert refused'),
    9007199254741009n,
  ]);
  try {
    const h = harness(db);
    const wrapped = createArchivingTransport(async () => response('same-body'), h);
    const success = await wrapped(request(h.appId));
    const failed = await wrapped(request(h.appId));
    const { archive, ...noContext } = request(h.appId);
    void archive;
    const omitted = await wrapped(noContext);
    const recovered = await wrapped(request(h.appId));
    expect([
      value(success, 'raw_payload_id'),
      value(failed, 'raw_payload_id'),
      value(omitted, 'raw_payload_id'),
      value(recovered, 'raw_payload_id'),
    ]).toEqual(['9007199254741001', undefined, undefined, '9007199254741009']);
    expect(failed).not.toHaveProperty('raw_payload_id');
    expect(omitted).not.toHaveProperty('raw_payload_id');
    expect(failed).toEqual(response('same-body'));
    expect(omitted).toEqual(response('same-body'));
    expect(statements).toHaveLength(3);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  } finally {
    await db.destroy();
  }
});

it.each(sources)(
  '[AC-B1-08e-ARCHIVE#3] %s 归档插入失败仍返回完整订单，raw_payload_id 为 null',
  async (source) => {
    const { db } = archiveDb([new Error('synthetic insert refused')]);
    try {
      const h = harness(db);
      const transport = createArchivingTransport(
        async () => reply(envelope(source, sourceRow(source))),
        h,
      );
      const adapter = pdd(transport);
      const order =
        source === 'detail'
          ? await adapter.getPddOrderDetail('synthetic-detail', ctx)
          : (await adapter.listOrders(win, { queryMode: source }, ctx)).items[0]!;
      expect(order).toMatchObject({
        sub_order_id: '000000000000000000000000012345-SYN',
        raw_payload_id: null,
        est_commission_fen: 72222n,
        commission_fen: 76543n,
      });
      expect(h.logger.error).toHaveBeenCalledTimes(1);
    } finally {
      await db.destroy();
    }
  },
);
