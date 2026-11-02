// B1-02zx §9 #5 · the audit record (contract adminAddUserReverifiedDevice): every request that passes
// the permission, step-up and body checks writes one user_reverified_device_add record with the
// admin, the reason, user_id, device_id and the result code, refusals included; never the
// device_hash. The reason is kept trimmed (D10-585). Requests stopped by those three checks are in
// access.int.test.ts and order.int.test.ts, a user_id or device_id that is not a UUID in
// targets.int.test.ts. The record's layout is the implementation's: these cases read the whole row
// as text, and the result code through resultCodes(). admin's audit writer does not redact a key
// named device_hash (audit-redaction.ts has no such fragment), so nothing but the operation keeps
// it out.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import {
  ACTION,
  DELETING,
  PERMISSION,
  REASON,
  REVOKED,
  account,
  added,
  auditText,
  audits,
  body,
  deleted,
  deleting,
  deviceOf,
  member,
  noHash,
  ok,
  record,
  recorded,
  rejected,
  resultCodes,
  revoke,
  setup,
  unowned,
  user,
  type AuditRow,
  type Device,
  type Setup,
  type Target,
} from './kit.ts';

const h = useHarness();

function common(
  entry: AuditRow,
  s: Setup,
  expected: {
    readonly adminId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly code: number;
    readonly reason?: string;
  },
) {
  expect(entry).toMatchObject({ app_id: s.appId, admin_id: expected.adminId, action: ACTION });
  expect(entry.at).toEqual(s.clock.now());
  const text = auditText(entry);
  expect(text).toContain(expected.reason ?? REASON);
  expect(entry.target === expected.userId || text.includes(expected.userId)).toBe(true);
  expect(entry.target === expected.deviceId || text.includes(expected.deviceId)).toBe(true);
  expect(resultCodes(entry), `${expected.code} 结果码`).toContain(String(expected.code));
}

it.each([true, false])(
  '[AC-B1-02zx#34] 成功（超管=%s）写一条 user_reverified_device_add：操作人、原因、user_id、device_id、结果码，没有 device_hash',
  async (isSuper) => {
    const s = await setup(h);
    const admin = isSuper ? undefined : await member(s, [PERMISSION]);
    const { target, device } = await account(s);
    const before = await audits(h, s.appId);
    const response = await record(
      s,
      target.id,
      body(device),
      admin === undefined ? {} : { as: admin },
    );
    await ok(response);
    const rows = added(before, await audits(h, s.appId));
    expect(rows).toHaveLength(1);
    common(rows[0]!, s, {
      adminId: admin?.who.id ?? s.actor.id,
      userId: target.id,
      deviceId: device.id,
      code: 0,
    });
    expect(auditText(rows[0]!)).not.toContain(device.hash);
    noHash(s, [device], [response]);
  },
);

it('[AC-B1-02zx#35] 已记录的设备（created:false）也写一条，结果码 0，没有 device_hash', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  await recorded(s, target, device, 'self', s.clock.now());
  const before = await audits(h, s.appId);
  expect((await ok(await record(s, target.id, body(device)))).created).toBe(false);
  const rows = added(before, await audits(h, s.appId));
  expect(rows).toHaveLength(1);
  common(rows[0]!, s, { adminId: s.actor.id, userId: target.id, deviceId: device.id, code: 0 });
  expect(auditText(rows[0]!)).not.toContain(device.hash);
});

const REFUSALS: readonly {
  case: string;
  code: number;
  data: object;
  /** The user and the device of the request. */
  arrange: (s: Setup) => Promise<{ target: Target; device: Pick<Device, 'id'> }>;
}[] = [
  {
    case: 'user_id 未知',
    code: 20001,
    data: { fields: ['user_id'] },
    arrange: async (s) => ({
      target: { id: randomUUID(), appId: s.appId },
      device: await unowned(s),
    }),
  },
  {
    case: '设备未知',
    code: 20001,
    data: { fields: ['device_id'] },
    arrange: async (s) => ({
      target: (await account(s)).target,
      device: { id: randomUUID() },
    }),
  },
  {
    case: '设备已吊销',
    code: 20001,
    data: { fields: ['device_id'] },
    arrange: async (s) => {
      const { target, device } = await account(s);
      await revoke(s, device);
      return { target, device };
    },
  },
  {
    case: '设备是别人的',
    code: 20001,
    data: { fields: ['device_id'] },
    arrange: async (s) => ({
      target: (await account(s)).target,
      device: await deviceOf(s, await user(h, s.appId)),
    }),
  },
  {
    case: '账号已注销',
    code: 30419,
    data: { reason: 'account_deleted' },
    arrange: async (s) => {
      const target = await deleted(s);
      return { target, device: await deviceOf(s, target, REVOKED) };
    },
  },
  {
    case: '账号注销中',
    code: 30419,
    data: DELETING,
    arrange: (s) => deleting(s),
  },
  {
    case: '账号无标记',
    code: 30419,
    data: { reason: 'reverify_not_pending' },
    arrange: async (s) => {
      const target = await user(h, s.appId);
      return { target, device: await deviceOf(s, target) };
    },
  },
];

it.each(REFUSALS)(
  '[AC-B1-02zx#36] 过了三关后被拒（$case）也写一条，带结果码，没有 device_hash',
  async ({ arrange, code, data }) => {
    const s = await setup(h);
    const { target, device } = await arrange(s);
    const stored = await s.h.db
      .selectFrom('devices')
      .select('device_hash')
      .where('id', '=', device.id)
      .executeTakeFirst();
    const before = await audits(h, s.appId);
    const response = await record(s, target.id, body(device));
    await rejected(response, code, data);
    const rows = added(before, await audits(h, s.appId));
    expect(rows).toHaveLength(1);
    common(rows[0]!, s, {
      adminId: s.actor.id,
      userId: target.id,
      deviceId: device.id,
      code,
    });
    if (stored !== undefined) {
      expect(auditText(rows[0]!)).not.toContain(stored.device_hash);
      noHash(s, [{ hash: stored.device_hash }], [response]);
    }
  },
);

it('[AC-B1-02zx#47] 审计存去首尾空白后的原因：登记成功和过了三关后被拒都是', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const padded = ` ${REASON}　\n`;
  const before = await audits(h, s.appId);
  await rejected(await record(s, target.id, body({ id: randomUUID() }, padded)), 20001, {
    fields: ['device_id'],
  });
  await ok(await record(s, target.id, body(device, padded)));
  const rows = added(before, await audits(h, s.appId));
  expect(rows).toHaveLength(2);
  for (const entry of rows) {
    const text = auditText(entry);
    expect(text).toContain(REASON);
    expect(text).not.toContain(` ${REASON}`);
    expect(text).not.toContain(`${REASON}　`);
    expect(text).not.toContain(`${REASON}\\n`);
  }
});

it('[AC-B1-02zx#37] 不带 Idempotency-Key：重试自然幂等，每次都多一条审计，各带自己的原因，不写幂等记录', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const before = await audits(h, s.appId);
  const responses: Response[] = [];
  const again = `${REASON}（二次核对）`;
  for (const reason of [REASON, again]) {
    responses.push(await record(s, target.id, body(device, reason)));
  }
  expect((await ok(responses[0]!)).created).toBe(true);
  expect((await ok(responses[1]!)).created).toBe(false);
  const rows = added(before, await audits(h, s.appId));
  expect(rows).toHaveLength(2);
  expect(auditText(rows[0]!)).not.toContain('（二次核对）');
  expect(auditText(rows[1]!)).toContain(again);
  const kept = await h.db
    .selectFrom('idempotency_keys')
    .select('path')
    .where('app_id', '=', s.appId)
    .execute();
  expect(kept).toEqual([]);
  noHash(s, [device], responses);
});
