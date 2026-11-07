// B1-08zi rule-test kit (claude-independent). Only synthetic setup and observations; the path under
// test is the assembled worker of ../settle-diff-sync/kit.ts (real sync → monthly bill → R5), with
// the order's first report carrying `patch`. Every order is pdd (see ../settlement-records/kit.ts);
// quantity / refunded_quantity in a report are synthetic, because orders reads only the normalized
// UnionOrder and never branches on the platform (orders/AGENTS.md rule 1).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { observations, type Worker } from '../settle-diff-sync/kit.ts';
import { BILL_AT, SYNCED, settled } from '../settlement-records/kit.ts';

export {
  MEMBER_ROLE,
  TIMEOUT,
  databaseFixture,
  settled,
  touched,
  withSync,
} from '../settle-diff-sync/kit.ts';

/** Real sync → monthly bill → R5 for one new app, the order's reports carrying `patch`. */
export async function creditedWith(
  db: Kysely<DB>,
  w: Worker,
  patch: Partial<UnionOrder>,
  n = 1000n,
) {
  w.clock.set(SYNCED);
  const app = await w.app();
  await w.setConfig(app, 'credit.enabled.pdd', true);
  const o = w.order(app, { est_commission_fen: n, commission_fen: n, ...patch });
  await o.sync(settled(n));
  const beforeCredit = await o.row();
  w.clock.set(BILL_AT);
  await w.bill(app);
  await w.confirmAndExecute(app);
  expect(await o.row()).toMatchObject({ rebate_status: 'CREDITED', booked_n_fen: n });
  return { app, o, beforeCredit, read: observations(db, app, o) };
}
