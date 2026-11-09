// B1-06x: GET /v1/unions/bindings refreshes the Pinduoduo filing (备案) before answering
// (BR-ID-22: the binding is active only once the authority query answers authorized; BR-ID-17 细则
// 「授权管理页」: the page lists taobao and pdd {platform, status} only, pdd being the projection of
// the self_buy slot's authorization, D7-3 ⑨). POST bind is createUnionBindings' unchanged.
//
// For the logged-in caller (appId / userId from callerContext), the pdd item only:
// - stored active or blocked → never queried (the registry is not even asked for the adapter);
// - otherwise (no row, unbound, pending_auth, invalid, released): the site authorization of the
//   account this authorization uses (reads.authAccountId: the unreleased binding's, else the
//   self_buy slot's, else the platform's earliest registered account by created_at, id) must be
//   usable (BR-ID-24 ④: the query depending on it is not made), then the
//   self_buy identity (custom_parameters {app:'n', uid=attr_code, sc:'self_buy'}, never a user_id)
//   is sent to UnionAdapter.queryPddAuthority. Authorized → one short transaction, opened only after
//   the query returned (the query never holds a connection), writes the binding active through
//   pdd-authority.ts activatePddBinding — the open's single entry (approvals #26:
//   canTransitionBinding + row_version CAS, savepoint retries on a lost unique race, blocked never
//   overwritten) — and resolves the user's unresolved pdd conflict rows in the same transaction
//   (BR-ID-18 补句, bound_active). Not authorized → nothing written: no 30111, no state, no
//   union_auth_sessions row.
// - Any failure (site authorization unavailable, no active self_buy slot, attr_code missing or
//   malformed, the port missing / failing / answering malformed, the write failing) is never an
//   error of this read: a warn is logged (flat fields, no attr_code, no user identity) and the page
//   answers the stored projection with 200. Nothing here writes link_logs.
// B1-06zb: the self_buy slot is the account in use's (pddAuthorityIdentity unionAccountId, as the
// open does); that account having none is the no-slot failure above, never another account's slot.
// Taobao is never queried. No concurrency cap or timeout is added to the query yet (followup:
// before the real pdd adapter); same-user concurrent GETs converge on the unique index + CAS.
// B1-06zi (BR-ID-22 「授权状态按 (user_id, pid) 记录」): an authorized answer whose activation leaves
// the binding active also records the queried self_buy slot's filing (app.union_pdd_pid_filings,
// insert-if-absent, filed_at = the clock) in that same transaction; blocked / banned write no row.
import type { PddAuthLinkOpenOptions } from './link-open-pdd-auth.ts';
import {
  PDD,
  activatePddBinding,
  pddAuthorityIdentity,
  queryPddAuthority,
} from './pdd-authority.ts';
import { recordPddPidFiling } from '../infra/pdd-pid-filings.ts';
import {
  createUnionBindings,
  type UnionBindingsOptions,
  type UnionBindingsService,
} from './union-bindings.ts';

/** B1-06x: list refreshes the self_buy PDD filing; bind retains its existing contract. */
export type PddQueryBindingsOptions = UnionBindingsOptions &
  Pick<PddAuthLinkOpenOptions, 'registry' | 'pids' | 'attrCodes' | 'config' | 'appEnv'>;

const EVENTS = 'linking.bindings';
/** The authorization page's pdd item is the self-purchase slot's authorization (D7-3 ⑨). */
const SCENE = 'self_buy';

export function createUnionBindingsWithPddQuery(
  options: PddQueryBindingsOptions,
): UnionBindingsService {
  const { db, clock, callerContext, reads, logger, registry, pids, attrCodes } = options;
  const base = createUnionBindings(options);

  function skipped(event: string, appId: string, traceId: string, extra = {}): void {
    logger.warn(
      { event: `${EVENTS}.${event}`, app_id: appId, platform: PDD, trace_id: traceId, ...extra },
      'linking: pdd filing not refreshed; the stored binding is listed',
    );
  }

  /** Brings the stored pdd binding up to the filing; never throws. */
  async function refresh(appId: string, userId: string, traceId: string): Promise<void> {
    try {
      const { status, accountId: bound } = await reads.binding(appId, userId, PDD);
      if (status === 'active' || status === 'blocked') return;
      const accountId = await reads.authAccountId(appId, PDD, bound);
      if (accountId === null || !(await reads.siteAuthAvailable(appId, PDD, accountId))) {
        skipped('site_auth_unavailable', appId, traceId);
        return;
      }
      const identity = await pddAuthorityIdentity(
        { pids, attrCodes, logger },
        { appId, userId, pidScene: SCENE, unionAccountId: accountId, traceId, events: EVENTS },
      );
      if (typeof identity === 'string') return;
      const authorized = await queryPddAuthority(
        { registry, logger },
        { appId, identity, traceId, events: EVENTS },
      );
      if (authorized !== true) return;
      const custom = JSON.stringify(identity.custom_parameters);
      await db.transaction().execute(async (trx) => {
        const written = await activatePddBinding(trx, clock, { appId, userId, accountId, custom });
        if (written.kind !== 'active') return;
        await recordPddPidFiling(trx, {
          appId,
          userId,
          pid: identity.claims.promotionSlot,
          unionAccountId: accountId,
          filedAt: clock.now(),
        });
      });
    } catch (error) {
      skipped('pdd_refresh_failed', appId, traceId, {
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  return {
    bind: (input) => base.bind(input),
    async list(input) {
      const caller = await callerContext.current();
      if (caller.userId !== null) await refresh(caller.appId, caller.userId, input.traceId);
      // The projection as stored now (10001 for a guest, as before).
      return base.list(input);
    },
  };
}
