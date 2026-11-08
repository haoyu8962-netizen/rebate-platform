// B2-09zg detail rule tests (claude-independent, SPEC_REF 39756e36): contracts/openapi.yaml
// getAdminWithdrawal, CT-24zzb (04 §11.1; D10-1042; FU-WITHDRAWALS-USER-LOOKUP). An account holding
// user.lookup but neither withdraw.review nor fund.view must pass `user_id` (without it 10403
// data.reason=admin_permission_denied, the same as an account holding none of the three points) and
// sees reject_note = null, auto_decision = null, risk_flags = [] and source_ref = null on every row
// of holds. When `user_id` is given by any account and the withdrawal belongs to another user the
// answer is 20001 data.fields=[withdrawal_id], the same as an unknown id or a withdrawal of another
// app; a `user_id` that is not UUID-shaped is 20001 data.fields=[user_id]. The writes keep their own
// points. Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
//
// Red on the code before this task: the account only holding user.lookup gets 10403 on everything
// and the detail ignores `user_id`, so every case asserts something that needs the change (the
// refusals and the unaffected accounts alone would already be green).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DETAIL_KEYS,
  MASKED_NAME,
  REVIEW,
  VIEW,
  ago,
  allAudits,
  answer,
  detailOf,
  detailView,
  expectNoSecrets,
  fixture,
  footprint,
  seedAttempt,
  seedBatch,
  seedHold,
  seedItem,
  seedMember,
  seedWithdrawal,
  suite,
  type Payee,
} from '../admin-withdrawals/kit.ts';
import {
  DENIED,
  FLAG_CODE,
  LOOKUP,
  NOTE_MARK,
  blankedDetail,
  refusal,
  richSeed,
  withLookupAdmin,
} from './kit.ts';

const s = suite();

/** The masked payee of the frozen kit's default alipay e-mail account. */
const PAYEE: Payee = {
  masked_account: 'sy***@example.test',
  masked_name: MASKED_NAME,
  bank_name: null,
};

it('[AC-B2-09zg#4] 提现单详情（只持 user.lookup，含另持 fund.recon 这类别的点）带本人 user_id → 200：reject_note、auto_decision 为 null，risk_flags 为 []，holds 每行 source_ref 为 null（holds 的 reason、时刻照常）；金额、状态、reject_reason_code、脱敏收款人、批次、转账尝试等其余字段照常，形状不变；库里这几项有真实值（持 withdraw.review 的账号读到真实值）；读取不写审计、不改任何行', async () => {
  const f = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const sourceRef = randomUUID();
    const referenced = await seedHold(f, m, {
      reason: 'recon_diff',
      sourceRef,
      created_at: ago(f, 300),
    });
    const plain = await seedHold(f, m, { reason: 'manual', created_at: ago(f, 200) });
    const holds = [referenced, plain];
    const rejected = await seedWithdrawal(f, h, m, richSeed(f, 90));
    const batch = await seedBatch(f, { kind: 'auto', created_at: ago(f, 49) });
    const paying = await seedWithdrawal(
      f,
      h,
      m,
      richSeed(f, 60, {
        status: 'PAYING',
        review_mode: 'auto',
        reject_reason_code: null,
        reject_note: null,
        executed_at: ago(f, 49),
        execute_seq: 1,
        batch_id: batch.id,
      }),
    );
    const item = await seedItem(f, paying, batch, { result: 'paying', at: ago(f, 49) });
    const attempt = await seedAttempt(f, paying, {
      kind: 'transfer',
      result: 'pending',
      at: ago(f, 48),
    });
    const cases = [
      {
        row: rejected,
        view: detailView(rejected, m, {
          payee: PAYEE,
          batch: null,
          items: [],
          attempts: [],
          holds,
        }),
      },
      {
        row: paying,
        view: detailView(paying, m, {
          payee: PAYEE,
          batch,
          items: [item],
          attempts: [attempt],
          holds,
        }),
      },
    ];
    const before = await footprint(f);
    for (const who of [h.lookup, await h.caller([LOOKUP, 'fund.recon'])]) {
      for (const { row, view } of cases) {
        const sent = await h.detail(row.id, { user_id: m.userId }, who);
        const data = await detailOf(sent);
        expect(Object.keys(data).sort(), sent.body).toEqual(DETAIL_KEYS);
        expect(data, sent.body).toEqual(blankedDetail(view));
        expect((data['holds'] as Record<string, unknown>[]).map((hold) => hold['reason'])).toEqual([
          'recon_diff',
          'manual',
        ]);
        expectNoSecrets(sent.body, [NOTE_MARK, FLAG_CODE, sourceRef]);
      }
    }
    for (const { row, view } of cases) {
      expect(await detailOf(await h.detail(row.id, {}, h.reviewer))).toEqual(view);
    }
    expect(await footprint(f)).toEqual(before);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09zg#5] 提现单详情（只持 user.lookup）：带本人 user_id 能读（且确实查了库）；不带 user_id → 10403 admin_permission_denied（提现单存在或不存在都一样，不暴露单号是否存在），应答与三个权限点都没有的账号完全相同，且不读提现相关表；没有任何点或只持 fund.recon 的账号带本人 user_id、持 user.lookup + fund.recon 不带 user_id 也是同样的 10403、不读提现相关表', async () => {
  const f = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const row = await seedWithdrawal(f, h, m, richSeed(f, 30));
    // The observation is live: the allowed read of the same account does reach the tables.
    const allowed = await h.observed(() => h.detail(row.id, { user_id: m.userId }, h.lookup));
    expect((await detailOf(allowed.sent))['withdrawal_id']).toBe(row.id);
    expect(allowed.reads).not.toEqual([]);

    const denied = await answer(await h.detail(row.id, {}, h.none), 10403, DENIED);
    for (const id of [row.id, randomUUID()]) {
      const refused = await h.observed(() => h.detail(id, {}, h.lookup));
      const body = await answer(refused.sent, 10403, DENIED);
      expect(refusal(body), id).toEqual(refusal(denied));
      expect(refused.reads, id).toEqual([]);
    }
    // user_id opens nothing without user.lookup, and another point does not stand in for user_id.
    const recon = await h.caller(['fund.recon']);
    const lookupRecon = await h.caller([LOOKUP, 'fund.recon']);
    for (const [label, request] of [
      ['no point, owner user_id', () => h.detail(row.id, { user_id: m.userId }, h.none)],
      ['fund.recon, owner user_id', () => h.detail(row.id, { user_id: m.userId }, recon)],
      ['user.lookup + fund.recon, no user_id', () => h.detail(row.id, {}, lookupRecon)],
    ] as const) {
      const refused = await h.observed(request);
      const body = await answer(refused.sent, 10403, DENIED);
      expect(refusal(body), label).toEqual(refusal(denied));
      expect(refused.reads, label).toEqual([]);
    }
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09zg#6] 提现单详情的 user_id 防探测：任何账号（只持 user.lookup、withdraw.review、fund.view、同时持两者、超管）给了 user_id 而该提现属别的用户（同应用的另一用户、未知用户、别的应用的用户）→ 20001 data.fields=[withdrawal_id]，与未知 withdrawal_id、别的应用的提现单的应答完全相同；user_id 是本人时各账号照常 200；读取不写审计、不改任何行', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const a = await seedMember(f, h);
    const b = await seedMember(f, h);
    const own = await seedWithdrawal(f, h, a, richSeed(f, 30));
    const stranger = await seedMember(other, h);
    const foreign = await seedWithdrawal(other, h, stranger, richSeed(other, 20));
    const before = await footprint(f);
    const accounts = [
      h.lookup,
      h.reviewer,
      h.viewer,
      await h.caller([LOOKUP, REVIEW]),
      await h.caller([], { superAdmin: true }),
    ];
    const seen: string[] = [];
    for (const who of accounts) {
      expect(
        (await detailOf(await h.detail(own.id, { user_id: a.userId }, who)))['withdrawal_id'],
      ).toBe(own.id);
      for (const [id, userId] of [
        [own.id, b.userId],
        [own.id, randomUUID()],
        [own.id, stranger.userId],
        [randomUUID(), a.userId],
        [foreign.id, stranger.userId],
        [foreign.id, a.userId],
      ] as const) {
        const body = await answer(await h.detail(id, { user_id: userId }, who), 20001, {
          fields: ['withdrawal_id'],
        });
        seen.push(JSON.stringify(refusal(body)));
      }
    }
    expect(new Set(seen).size).toBe(1);
    expect(await footprint(f)).toEqual(before);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09zg#7] 提现单详情的 user_id 不是 UUID 形状 → 20001 data.fields=[user_id]（只持 user.lookup、withdraw.review、fund.view、超管都一样；提现单存在也不例外），超过 64 字符同样 20001 [user_id]', async () => {
  const f = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const row = await seedWithdrawal(f, h, m, richSeed(f, 30));
    const accounts = [h.lookup, h.reviewer, h.viewer, await h.caller([], { superAdmin: true })];
    for (const who of accounts) {
      for (const userId of [
        'not-a-uuid',
        '123',
        'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
        m.userId.replaceAll('-', ''),
        'x'.repeat(65),
      ]) {
        await answer(await h.detail(row.id, { user_id: userId }, who), 20001, {
          fields: ['user_id'],
        });
      }
    }
  });
});

it('[AC-B2-09zg#8] 提现单详情：只持 user.lookup 的账号读到置空，而持 withdraw.review 或 fund.view（含同时持 user.lookup）的账号与超管不受影响——不带 user_id 与带本人 user_id 都是 200，reject_note、auto_decision、risk_flags 与 holds[].source_ref 都是真实值', async () => {
  const f = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const hold = await seedHold(f, m, {
      reason: 'recon_diff',
      sourceRef: randomUUID(),
      created_at: ago(f, 300),
    });
    const row = await seedWithdrawal(f, h, m, richSeed(f, 30));
    const view = detailView(row, m, {
      payee: PAYEE,
      batch: null,
      items: [],
      attempts: [],
      holds: [hold],
    });
    expect(await detailOf(await h.detail(row.id, { user_id: m.userId }, h.lookup))).toEqual(
      blankedDetail(view),
    );
    const accounts = [
      h.reviewer,
      h.viewer,
      await h.caller([REVIEW, LOOKUP]),
      await h.caller([VIEW, LOOKUP]),
      await h.caller([], { superAdmin: true }),
    ];
    for (const who of accounts) {
      expect(await detailOf(await h.detail(row.id, {}, who))).toEqual(view);
      expect(await detailOf(await h.detail(row.id, { user_id: m.userId }, who))).toEqual(view);
    }
  });
});

it('[AC-B2-09zg#9] 只持 user.lookup 的账号能读详情，但写操作不开放：驳回与批量通过 → 10403 admin_permission_denied（先于二次验证），提现单等各表不变', async () => {
  const f = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const m = await seedMember(f, h);
    const row = await seedWithdrawal(
      f,
      h,
      m,
      richSeed(f, 30, { status: 'PENDING_REVIEW', reject_reason_code: null, reject_note: null }),
    );
    expect(
      (await detailOf(await h.detail(row.id, { user_id: m.userId }, h.lookup)))['withdrawal_id'],
    ).toBe(row.id);
    const before = await footprint(f);
    for (const [path, body] of [
      [`/admin/v1/withdrawals/${row.id}/reject`, { reason_code: 'OTHER', note: '合成驳回备注' }],
      ['/admin/v1/withdrawals/batch-approve', { withdrawal_ids: [row.id] }],
    ] as const) {
      const sent = await h.write(path, body, h.lookup);
      expect(sent.statusCode, sent.body).toBe(403);
      const refused = sent.json();
      expect({ code: refused.code, data: refused.data }, sent.body).toEqual({
        code: 10403,
        data: DENIED,
      });
    }
    expect(await footprint(f)).toEqual(before);
  });
});
