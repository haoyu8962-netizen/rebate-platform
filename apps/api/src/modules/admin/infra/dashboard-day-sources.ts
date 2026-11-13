// B1-34q skeleton (01 F-ADM-26 ②; D10-1401, D10-1403): the production sources of the four
// figures, through the linking / orders / identity / settlement index.ts exports (the estimated
// rebate prices shares the way the wallet does). The body throws NotImplemented until the
// implementation lands.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { DashboardDaySources } from '../application/dashboard-days.ts';

export function createDashboardDaySources(deps: {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}): DashboardDaySources {
  void deps;
  throw new Error('NotImplemented: createDashboardDaySources');
}
