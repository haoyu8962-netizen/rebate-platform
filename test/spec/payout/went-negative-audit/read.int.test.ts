import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture as adminFixture, useHarness } from '../../admin/auth/kit.ts';
import { detail, page, seed, signedIn } from '../../admin/audit-query/kit.ts';
import { open, close, TIMEOUT, changeAvailable, type Harness } from '../state/kit.ts';
import { audits, event, expectAudit, member, worker } from './fixtures.ts';

const auth = useHarness();
let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 180_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-09p#11] worker 实际写出的系统驳回可由 GET /admin/v1/audit-logs 读取，显示系统（打款）',
  async () => {
    const f = await member(h);
    const id = await f.startWithdrawal();
    await changeAvailable(f, -37n);
    const app = await worker(f);
    try {
      await app.handle(event(f));
      // The admin entry and worker share the provisioned DB; only the auth harness supplies Redis
      // and test keys. Neither audit rows nor the HTTP response are manually manufactured.
      const adminHarness = { ...auth, db: h.db };
      const http = await adminFixture(adminHarness);
      const admin = await seed(adminHarness, f.actor.appId, { isSuper: true });
      const session = await signedIn(http, admin);
      const reader = { ...http, token: session.admin_token };
      const result = await page(reader, {
        from: '2026-10-19T00:00:00.000Z',
        to: '2026-10-20T00:00:00.000Z',
      });
      // page()/detail() also check the actual OpenAPI response schema, including the actor enum.
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      const row = result.items[0]!;
      expect(row).toMatchObject({
        actor_id: null,
        actor_kind: 'system',
        system_actor: 'system:payout',
        actor_name: '系统（打款）',
        action: 'withdrawal_reject',
        ip: null,
        at: f.clock.now().toISOString(),
      });
      const stored = (await audits(f)).filter((item) => item.target === id);
      expect(stored).toHaveLength(1);
      expect(await detail(reader, row.id)).toMatchObject({
        ...row,
        before: { withdrawal_id: id, status: 'PENDING_REVIEW' },
        after: {
          withdrawal_id: id,
          status: 'REJECTED',
          reason_code: 'NEGATIVE_BALANCE',
          note: null,
        },
      });
      await expectAudit(f, id, 'PENDING_REVIEW');
    } finally {
      await app.close();
    }
  },
  TIMEOUT,
);
