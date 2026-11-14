// B1-10w skeleton (rule-test phase): the workbench of GET /admin/v1/dashboard (adminGetDashboard,
// contracts/openapi.yaml; 编排 D10-1401 / D10-1402 / D10-1403 ③). Read only: todo[] trimmed to the
// account's card points (each count through the owning module's exported count function),
// yesterday through readDashboardYesterday, status only with fund.view. Not implemented yet.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

/** The response data (AdminDashboard). */
export type AdminDashboardView = Schema<'AdminDashboard'>;

/** Who asks: the app and the account's permission points (a super admin holds every point). */
export interface AdminDashboardPrincipal {
  readonly appId: string;
  readonly isSuper: boolean;
  readonly permissions: readonly string[];
}

/** What the assembly reads with: the business database and the injected clock. */
export interface AdminDashboardDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

/** The workbench of `principal`, trimmed to its points. */
export function readAdminDashboard(
  deps: AdminDashboardDeps,
  principal: AdminDashboardPrincipal,
): Promise<AdminDashboardView> {
  void deps;
  void principal;
  throw new Error('NotImplemented: readAdminDashboard');
}
