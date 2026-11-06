// B2-12f access (claude-independent): adminListBadDebtWriteoffs — permission point fund.writeoff or
// fund.view (04 §11.1, §11.2), no step-up, reading writes no audit record; adminApproveBadDebtWriteoff —
// fund.writeoff (10403 data.reason=admin_permission_denied) → step-up sms tier (10003 data.tier=sms;
// an account without a verify phone also data.reason=verify_phone_missing; super admins too,
// BR-ID-34; BR-FUND-12「超管或被勾选核销权限的账号 step-up 后批准，一人可完成」) → body (20001) → id
// (20001 data.fields=[id], unknown or of another app, no 404). D10-590 ⑥: the no-permission cases
// use a valid body. Every refusal writes nothing. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  SINCE,
  WRITEOFF,
  audits,
  credit,
  denied,
  everything,
  expectWrittenOff,
  fixture,
  negativeMember,
  newAppId,
  schemaRefused,
  seedCandidate,
  stepUpRequired,
  suite,
  unknownCandidate,
  withWriteoffAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-12f#11] 列表不要 step-up：fund.view、fund.writeoff、超管都能读；只有 fund.adjust 的账号 → 10403；不带令牌 → 10001；读不写审计', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    await seedCandidate(f, m);
    const boss = await h.caller([], { superAdmin: true });
    const adjuster = await h.caller(['fund.adjust']);
    const before = await everything(f);
    for (const who of [h.viewer, h.writer, boss]) {
      const sent = await h.list({}, who);
      expect(sent.statusCode, sent.body).toBe(200);
      expect(sent.json().code, sent.body).toBe(0);
    }
    expect(await audits(f), '读不写审计').toEqual([]);
    await denied(await h.list({}, adjuster));
    const anonymous = await h.list({}, null);
    expect(anonymous.statusCode, anonymous.body).toBe(401);
    expect(anonymous.json().code).toBe(10001);
    expect(await everything(f), '读不写任何东西').toEqual(before);
  });
});

it('[AC-B2-12f#12] 批准要 fund.writeoff：只有 fund.view 的、只有 fund.adjust 的、没有任何权限点的账号用合法请求体（各带自己的短信档令牌）→ 10403 admin_permission_denied；不带令牌 → 10001；都不写任何东西；之后 fund.writeoff 账号批准生效', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const adjuster = await h.caller(['fund.adjust']);
    const nobody = await h.caller([]);
    const before = await everything(f);
    for (const who of [h.viewer, adjuster, nobody]) {
      await denied(await h.approve(row.id, {}, { caller: who }));
    }
    const anonymous = await h.approve(row.id, {}, { caller: null });
    expect(anonymous.statusCode, anonymous.body).toBe(401);
    expect(anonymous.json().code).toBe(10001);
    expect(await everything(f), '拒绝不留痕').toEqual(before);

    await expectWrittenOff(f, await h.approve(row.id), {
      row,
      m,
      adminId: h.writer.id,
      amount: 800n,
      frozen: 0n,
    });
  });
});

it('[AC-B2-12f#13] 短信档 step-up：fund.writeoff 账号与超管不带令牌、带动态码档令牌 → 10003 tier=sms；没登记验证手机号的（超管也一样）→ 10003 verify_phone_missing；都不写任何东西；之后带短信档令牌一人即可批准（超管也可以）', async () => {
  const f = fixture(s);
  await withWriteoffAdmin(f, async (h) => {
    const m1 = await negativeMember(f, { available: -800n, since: SINCE });
    const m2 = await negativeMember(f, { available: -400n, since: SINCE });
    const first = await seedCandidate(f, m1);
    const second = await seedCandidate(f, m2);
    const boss = await h.caller([], { superAdmin: true });
    const noPhone = await h.caller([WRITEOFF], { phone: false });
    const bossNoPhone = await h.caller([], { superAdmin: true, phone: false });
    const before = await everything(f);

    for (const who of [h.writer, boss]) {
      await stepUpRequired(await h.approve(first.id, {}, { caller: who, stepUp: null }));
      await stepUpRequired(
        await h.approve(first.id, {}, { caller: who, stepUp: await h.stepUp(who, 'totp') }),
      );
    }
    for (const who of [noPhone, bossNoPhone]) {
      await stepUpRequired(await h.approve(first.id, {}, { caller: who, stepUp: null }), true);
      await stepUpRequired(
        await h.approve(first.id, {}, { caller: who, stepUp: await h.stepUp(who, 'sms') }),
        true,
      );
    }
    expect(await everything(f), 'step-up 拒绝不留痕').toEqual(before);

    await expectWrittenOff(f, await h.approve(first.id, {}, { caller: h.writer }), {
      row: first,
      m: m1,
      adminId: h.writer.id,
      amount: 800n,
      frozen: 0n,
    });
    await expectWrittenOff(f, await h.approve(second.id, {}, { caller: boss }), {
      row: second,
      m: m2,
      adminId: boss.id,
      amount: 400n,
      frozen: 0n,
    });
  });
});

it('[AC-B2-12f#14] 请求体与 id：控制台不送金额，带 amount_fen 的请求体 → 20001（fields 含 amount_fen）；不存在的 id、别的 app 的候选单 → 20001 data.fields=[id]（不是 404）；都不写任何东西；之后空对象请求体按批准时余额核销', async () => {
  const f = fixture(s);
  const otherApp = newAppId();
  await withWriteoffAdmin(f, async (h) => {
    const m = await negativeMember(f, { available: -800n, since: SINCE });
    const row = await seedCandidate(f, m);
    const stranger = await negativeMember(f, { available: -500n, since: SINCE, appId: otherApp });
    const foreign = await seedCandidate(f, stranger);
    await credit(f, m, 500n);
    const before = await everything(f);
    const foreignBefore = await everything(f, otherApp);

    await schemaRefused(await h.approve(row.id, { amount_fen: 300 }), 'amount_fen');
    await unknownCandidate(await h.approve(randomUUID()));
    await unknownCandidate(await h.approve(foreign.id));
    expect(await everything(f)).toEqual(before);
    expect(await everything(f, otherApp), '别的 app 不动').toEqual(foreignBefore);

    await expectWrittenOff(f, await h.approve(row.id, {}), {
      row,
      m,
      adminId: h.writer.id,
      amount: 300n,
      frozen: 0n,
    });
  });
});
