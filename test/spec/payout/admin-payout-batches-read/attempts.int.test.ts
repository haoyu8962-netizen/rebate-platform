// B2-07g rule test (claude-independent, SPEC_REF ba6655b1): has_transfer_attempt and last_attempt of
// a batch member (contracts/openapi.yaml getAdminPayoutBatch, CT-24zzo; 08 BR-WDR-12 ②, BR-WDR-14;
// ruling D10-2017 ②). has_transfer_attempt: a kind=transfer payout_attempts row of any result —
// a definite failure included — the same test as BR-WDR-12 ②; only query (or other) attempts do not
// count. last_attempt: the newest attempt of any kind (`at`, then the attempt id), only kind, result
// and at; never the request or response bodies or the response codes; null without an attempt.
// Attempts are inserted as couli_payout, the way the payout process records them. Expected values
// are written by hand (instants as epoch milliseconds). Top-level it() only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  MINUTE,
  SECOND,
  ago,
  detailOf,
  fixture,
  member,
  memberOf,
  memberView,
  orderedIds,
  payingOn,
  plus,
  seedAttemptWithId,
  seedBatch,
  suite,
  withBatches,
} from './kit.ts';

const s = suite();

it('[AC-B2-07g#5] has_transfer_attempt：明确失败（FAILED）的转账也算 true；成功后有查询的（PAID_API）为 true；只有 kind=query 尝试的为 false；last_attempt 取任何 kind 最新一条（含 cancel），只给 kind / result / at', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const executedAt = ago(f, 60);
    const batch = await seedBatch(f, { kind: 'manual', created_at: executedAt, by: h.executor.id });
    const t = plus(executedAt, 2 * SECOND);

    const failed = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: executedAt,
      seed: { status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST' },
    });
    await seedAttemptWithId(f, failed, {
      id: randomUUID(),
      kind: 'transfer',
      result: 'fail',
      at: t,
    });

    const paid = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, 1),
      seed: { status: 'PAID_API', paid_at: plus(t, 5 * MINUTE), channel_order_id: 'CH7001' },
    });
    await seedAttemptWithId(f, paid, {
      id: randomUUID(),
      kind: 'transfer',
      result: 'unknown',
      at: t,
    });
    await seedAttemptWithId(f, paid, {
      id: randomUUID(),
      kind: 'query',
      result: 'success',
      at: plus(t, 5 * MINUTE),
    });

    const queriedOnly = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, 2),
      seed: {
        status: 'PAID_MANUAL',
        paid_at: plus(t, 30 * MINUTE),
        manual_resolution: 'paid',
      },
    });
    await seedAttemptWithId(f, queriedOnly, {
      id: randomUUID(),
      kind: 'query',
      result: 'success',
      at: plus(t, 40 * MINUTE),
    });

    const wechat = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, 3),
      seed: {
        method: 'wechat',
        channel_state: 'canceling',
        confirm_deadline: plus(t, 24 * 60 * MINUTE),
      },
    });
    await seedAttemptWithId(f, wechat, {
      id: randomUUID(),
      kind: 'transfer',
      result: 'pending',
      at: t,
    });
    await seedAttemptWithId(f, wechat, {
      id: randomUUID(),
      kind: 'query',
      result: 'unknown',
      at: plus(t, 1 * MINUTE),
    });
    await seedAttemptWithId(f, wechat, {
      id: randomUUID(),
      kind: 'cancel',
      result: 'pending',
      at: plus(t, 50 * MINUTE),
    });

    const detail = await detailOf(await h.detail(batch.id));
    expect(memberOf(detail, failed)).toEqual(
      memberView(failed, {
        result: 'paying',
        last_attempt: { kind: 'transfer', result: 'fail', at: t.getTime() },
        next_query_at: null,
        has_transfer_attempt: true,
      }),
    );
    expect(memberOf(detail, paid)).toEqual(
      memberView(paid, {
        result: 'paying',
        last_attempt: { kind: 'query', result: 'success', at: t.getTime() + 5 * MINUTE },
        next_query_at: null,
        has_transfer_attempt: true,
      }),
    );
    expect(memberOf(detail, queriedOnly)).toEqual(
      memberView(queriedOnly, {
        result: 'paying',
        last_attempt: { kind: 'query', result: 'success', at: t.getTime() + 40 * MINUTE },
        next_query_at: null,
        has_transfer_attempt: false,
      }),
    );
    expect(memberOf(detail, wechat)).toEqual(
      memberView(wechat, {
        result: 'paying',
        last_attempt: { kind: 'cancel', result: 'pending', at: t.getTime() + 50 * MINUTE },
        next_query_at: null,
        has_transfer_attempt: true,
      }),
    );
  });
});

it('[AC-B2-07g#5] last_attempt 同一时刻按尝试 id 取较大的一条：转账 id 小、查询 id 大 → 查询；转账 id 大、查询 id 小 → 转账；next_query_at 仍以转账的 at 为 T（已过 3 分 → T+5 分）', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const executedAt = ago(f, 4);
    const batch = await seedBatch(f, { kind: 'manual', created_at: executedAt, by: h.executor.id });
    const t = ago(f, 3);
    const queryWins = await payingOn(f, h, who, batch, { executedAt, itemAt: executedAt });
    const [low1, high1] = orderedIds();
    await seedAttemptWithId(f, queryWins, { id: low1, kind: 'transfer', result: 'unknown', at: t });
    await seedAttemptWithId(f, queryWins, { id: high1, kind: 'query', result: 'unknown', at: t });
    const transferWins = await payingOn(f, h, who, batch, {
      executedAt,
      itemAt: plus(executedAt, 1),
    });
    const [low2, high2] = orderedIds();
    await seedAttemptWithId(f, transferWins, {
      id: high2,
      kind: 'transfer',
      result: 'unknown',
      at: t,
    });
    await seedAttemptWithId(f, transferWins, { id: low2, kind: 'query', result: 'fail', at: t });

    const detail = await detailOf(await h.detail(batch.id));
    expect(detail['members']).toEqual([
      memberView(queryWins, {
        result: 'paying',
        last_attempt: { kind: 'query', result: 'unknown', at: t.getTime() },
        next_query_at: t.getTime() + 5 * MINUTE,
        has_transfer_attempt: true,
      }),
      memberView(transferWins, {
        result: 'paying',
        last_attempt: { kind: 'transfer', result: 'unknown', at: t.getTime() },
        next_query_at: t.getTime() + 5 * MINUTE,
        has_transfer_attempt: true,
      }),
    ]);
  });
});

it('[AC-B2-07g#5] 不返回请求与应答报文：尝试的 request / response / resp_code / resp_sub_code 里的内容一律不出现在详情与列表的应答里；last_attempt 恰好只有 kind、result、at 三个键', async () => {
  const f = fixture(s);
  await withBatches(f, async (h) => {
    const who = await member(f, h);
    const executedAt = ago(f, 10);
    const batch = await seedBatch(f, { kind: 'manual', created_at: executedAt, by: h.executor.id });
    const row = await payingOn(f, h, who, batch, { executedAt, itemAt: executedAt });
    const marker = `bodymarker${randomUUID().replaceAll('-', '')}`;
    await seedAttemptWithId(f, row, {
      id: randomUUID(),
      kind: 'transfer',
      result: 'unknown',
      at: ago(f, 9),
      marker,
    });
    await seedAttemptWithId(f, row, {
      id: randomUUID(),
      kind: 'query',
      result: 'unknown',
      at: ago(f, 8),
      marker,
    });
    const detailSent = await h.detail(batch.id);
    const detail = await detailOf(detailSent);
    expect(Object.keys(memberOf(detail, row)['last_attempt'] as object).sort()).toEqual([
      'at',
      'kind',
      'result',
    ]);
    const listSent = await h.list();
    expect(listSent.statusCode).toBe(200);
    expect(detailSent.body.includes(marker)).toBe(false);
    expect(listSent.body.includes(marker)).toBe(false);
  });
});
