// B2-09l order-of-checks rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch, D10-591 — the route schema first, also for a caller without the permission
// point or a step-up token (20001 data.fields naming the field); then payout.execute (10403
// data.reason=admin_permission_denied; a super admin holds every point) → step-up totp (10003
// data.tier=totp) → the duplicate check (20001 data.fields=[withdrawal_ids]). The login token is checked
// before the body is parsed (platform/http/request-checks.ts), so no login token is always 10001. Every
// refusal writes nothing. Requests go through the real admin entry (batch-harness.ts). Top-level it()
// only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  EXECUTE,
  PLENTY,
  REVIEW,
  VIEW,
  answer,
  approved,
  denied,
  expectExecuted,
  fieldsError,
  fixture,
  newKey,
  payee,
  rowOf,
  seedW,
  stepUpRequired,
  suite,
  withBatchAdmin,
  world,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#36] 权限：只持 withdraw.review、只持 fund.view、两个都持、没有权限点 → 10403 data.reason=admin_permission_denied，带不带 step-up 都一样，也先于重复 id 的检查；不带登录令牌 → 10001；什么都不写', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const before = await world(f);
    const outsiders = [h.reviewer, h.viewer, await h.caller([REVIEW, VIEW]), await h.caller([])];
    for (const caller of outsiders) {
      await denied(await h.execute([w.id], { caller }));
      await denied(await h.execute([w.id], { caller, stepUp: null }));
      await denied(await h.execute([w.id, w.id], { caller }));
      await denied(await h.execute([w.id, w.id], { caller, stepUp: null }));
    }
    await answer(await h.execute([w.id], { caller: null }), 10001);
    expect(await world(f)).toEqual(before);
    expect(await rowOf(f, w)).toEqual(w);
  });
});

it('[AC-B2-09l#37] 二次验证（动态码档）：不带令牌、令牌是别的账号的、令牌是短信档的 → 10003 data.tier=totp，先于重复 id 的检查；什么都不写；令牌不进请求体哈希，拿到令牌后用同一 Idempotency-Key 重试即执行', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const before = await world(f);
    const key = newKey();
    const colleague = await h.caller([EXECUTE]);

    await stepUpRequired(await h.execute([w.id], { key, stepUp: null }));
    await stepUpRequired(await h.execute([w.id], { key, stepUp: await h.stepUp(colleague) }));
    await stepUpRequired(
      await h.execute([w.id], { key, stepUp: await h.stepUp(h.executor, 'sms') }),
    );
    await stepUpRequired(await h.execute([w.id, w.id], { stepUp: null }));
    expect(await world(f)).toEqual(before);

    await expectExecuted(await h.execute([w.id], { key }), { paying: [w.id] });
  });
});

it('[AC-B2-09l#38] 重复 id（有权限且带令牌）→ 20001 data.fields=[withdrawal_ids]，一单都不执行、什么都不写；重复的是非 UUID 也一样', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const first = await approved(f, h, await payee(f, h));
    const second = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const before = await world(f);

    await fieldsError(await h.execute([first.id, second.id, first.id]), ['withdrawal_ids']);
    await fieldsError(await h.execute(['not-a-uuid', 'not-a-uuid']), ['withdrawal_ids']);

    expect(await world(f)).toEqual(before);
  });
});

it('[AC-B2-09l#39] 校验顺序（D10-591）：不合格请求体（缺字段、空数组、201 个、多余字段、元素不是字符串或超长、不是数组）在无权限、不带 step-up 时也是 20001 且 data.fields 恰为该字段；有权限的也一样；什么都不写', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const before = await world(f);
    const cases: readonly (readonly [unknown, string])[] = [
      [{}, 'withdrawal_ids'],
      [{ withdrawal_ids: [] }, 'withdrawal_ids'],
      [{ withdrawal_ids: Array.from({ length: 201 }, () => randomUUID()) }, 'withdrawal_ids'],
      [{ withdrawal_ids: randomUUID() }, 'withdrawal_ids'],
      [{ withdrawal_ids: [1] }, 'withdrawal_ids.0'],
      [{ withdrawal_ids: ['x'.repeat(65)] }, 'withdrawal_ids.0'],
      [{ withdrawal_ids: [''] }, 'withdrawal_ids.0'],
      [{ withdrawal_ids: [randomUUID()], executor_id: randomUUID() }, 'executor_id'],
    ];
    const nobody = await h.caller([]);
    for (const [body, field] of cases) {
      await fieldsError(await h.executeBody(body, { caller: nobody, stepUp: null }), [field]);
      await fieldsError(await h.executeBody(body, { caller: h.viewer }), [field]);
      await fieldsError(await h.executeBody(body, { stepUp: null }), [field]);
      await fieldsError(await h.executeBody(body), [field]);
    }
    expect(await world(f)).toEqual(before);
  });
});

it('[AC-B2-09l#40] 能执行的账号：只持 payout.execute；超管没有权限点行也能，executor_id 与 created_by 是超管；超管同样要动态码档（无令牌 10003）', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const root = await h.caller([], { superAdmin: true });
    const byRoot = await approved(f, h, await payee(f, h));
    const byExecutor = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });

    await stepUpRequired(await h.execute([byRoot.id], { caller: root, stepUp: null }));
    expect(await rowOf(f, byRoot)).toEqual(byRoot);

    await expectExecuted(await h.execute([byRoot.id], { caller: root }), { paying: [byRoot.id] });
    expect(await rowOf(f, byRoot)).toMatchObject({ status: 'PAYING', executor_id: root.id });
    await expectExecuted(await h.execute([byExecutor.id]), { paying: [byExecutor.id] });
    expect(await rowOf(f, byExecutor)).toMatchObject({
      status: 'PAYING',
      executor_id: h.executor.id,
    });
  });
});

it('[AC-B2-09l#41] 恰好 200 个 id 通过 schema（未知 id 和非 UUID 填满），每个都有结果；一张可打的照常 PAYING', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const unknown = Array.from({ length: 100 }, () => randomUUID());
    const strays = Array.from({ length: 99 }, (_, index) => `stray-${index}`);
    const rest = [...unknown, ...strays];

    await expectExecuted(await h.execute([w.id, ...rest]), {
      paying: [w.id],
      left: rest.map((id) => [id, 'not_approved']),
    });
  });
});

it('[AC-B2-09l#42] 一个动态码档令牌覆盖整批；令牌成功后被消费，再用 → 10003，单不动', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const rows = [await approved(f, h, await payee(f, h)), await approved(f, h, await payee(f, h))];
    await seedW(f, { fen: PLENTY });
    const stepUp = await h.stepUp(h.executor);
    const ids = rows.map((row) => row.id);

    await expectExecuted(await h.execute(ids, { stepUp }), { paying: ids });

    const next = await approved(f, h, await payee(f, h));
    await stepUpRequired(await h.execute([next.id], { stepUp }));
    expect(await rowOf(f, next)).toEqual(next);
  });
});
