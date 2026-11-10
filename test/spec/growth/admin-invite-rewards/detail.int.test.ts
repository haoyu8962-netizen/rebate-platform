// B2-16d §10 #5 · one record by invitee (contract adminGetInviteReward): the record of the console's
// app with the same fields and masking as its row in the list; an invitee without a record (unknown,
// of another app, or never qualified) → 404 / 30701; an invitee_id outside the Id schema → 20001
// fields [invitee_id]; one within it that is no UUID → a 4XX in the contract's error shape.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { DETAIL } from './schema.ts';
import {
  VIEW,
  detail,
  member,
  normal,
  noSecrets,
  pageOf,
  person,
  quietLogs,
  readOnly,
  rejected,
  reward,
  setup,
  shown,
  view,
} from './kit.ts';

const h = useHarness();

it('[AC-B2-16d#31] 本 App 有记录 → 与存储逐字段一致，且与列表里该受邀人的那一行完全相同（同样脱敏）', async () => {
  const s = await setup(h);
  const inviter = await person(s, { phone: '13800005678' });
  const records = [
    await reward(s, { inviter, status: 'processed', inviterSkip: 'risk_restricted' }),
    await reward(s, { inviter, status: 'voided', voidReason: 'order_clawed_back' }),
    await reward(s, { status: 'qualified', invitee: await person(s, { phone: null }) }),
    await reward(s, { status: 'deferred', bindSource: 'landing', amountFen: 1200n }),
    await reward(s, { status: 'expired', eligibilityDays: 14 }),
  ];
  const admin = await member(s, [VIEW]);
  const page = await pageOf(s, {}, { as: admin });
  for (const seeded of records) {
    const response = await detail(s, seeded.invitee.id, { as: admin });
    const item = await shown(response);
    expect(normal(item)).toEqual(view(seeded));
    const row = page.items.find((entry) => entry.invitee_id === seeded.invitee.id);
    expect(item).toEqual(row);
    noSecrets(response, [seeded]);
  }
  quietLogs(s, records);
});

it('[AC-B2-16d#32] 没有记录 → 404 / 30701：未知用户、别的 App 的受邀人、本 App 从未取得资格的用户（含邀请人本人）', async () => {
  const s = await setup(h);
  const other = `b2-16d-other-${randomUUID()}`;
  const mine = await reward(s, { status: 'processed' });
  const theirs = await reward(s, { appId: other, status: 'processed' });
  const never = await person(s);
  // Every login happens before the snapshot: a login writes its own admin.login audit row.
  const theirAdmin = await member(s, [VIEW], other);
  const nothingChanged = await readOnly(s);
  for (const id of [randomUUID(), theirs.invitee.id, never.id, mine.inviter.id]) {
    const response = await detail(s, id);
    await rejected(DETAIL, response, 30701);
    const text = JSON.stringify(response.json());
    expect(text).not.toContain(theirs.inviter.id);
    expect(text).not.toContain('invitee_phone_masked');
  }
  // The other app's own console finds its record.
  const item = await shown(await detail(s, theirs.invitee.id, { as: theirAdmin }));
  expect(normal(item)).toEqual(view(theirs));
  await nothingChanged();
});

it('[AC-B2-16d#33] invitee_id 超出 Id 模式（65 个字符）→ 400 / 20001，data.fields=[invitee_id]', async () => {
  const s = await setup(h);
  await reward(s);
  await rejected(DETAIL, await detail(s, 'a'.repeat(65)), 20001, { fields: ['invitee_id'] });
});

it.each(['not-a-uuid', 'a'.repeat(64), 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'])(
  '[AC-B2-16d#34] 不是 UUID 的 invitee_id（%s）→ 契约的错误形状（20001 或 30701），不是 5xx，不漏记录',
  async (id) => {
    const s = await setup(h);
    const seeded = await reward(s);
    const response = await detail(s, id);
    expect(response.statusCode, JSON.stringify(response.json())).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    const code = response.json().code;
    expect([20001, 30701]).toContain(code);
    await rejected(DETAIL, response, code);
    expect(JSON.stringify(response.json())).not.toContain(seeded.invitee.id);
  },
);
