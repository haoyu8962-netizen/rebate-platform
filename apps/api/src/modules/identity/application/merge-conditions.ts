// The BR-ID-06 merge conditions (规划/08 BR-ID-06 正文「并号」; task B1-20c, orchestrator D10-1099),
// one judgement for both places that apply them: the merge offer of POST /v1/me/phone (bind-phone.ts,
// B1-20a / B1-20e) and the merge itself (merge-account.ts, judged again on the rows read after the
// users rows are locked, 02 §18). Read only; every read runs on the caller's transaction.
//
// The source (the current account) qualifies when it registered with wechat / apple / huawei, has
// no phone, is status normal, has no parent and no child, AccountAssetsPort reports no order, no
// claim and no ledger entry, and (D10-1099) it has no app.admin_adjustments row whatever its status
// (Q-3: an adjustment approved later would post to the tombstone) and no blocked(admin_disable)
// union binding (Q-4: a merge releases bindings without cooling, which would wash the console's
// penalty off the relation id), and is not banned (risk's fresh state, appealing after banned
// counts; the offer's request is refused at ⑤ before, the merge needs it under its locks). The target (the account of the number) qualifies when it is status
// normal, is not in the deletion process (identity's deletion stage: cooling or processing
// refuses), has no user_oauth row of a provider the source has and is not banned (risk's fresh
// state; appealing after banned counts as banned). A frozen target is merged (D10-1099 Q-5).
//
// AccountMergePort is assembled by app.module (IdentityModule.forRoot option `accountMerge`) so
// identity reads and writes no other module's table: hasAdjustments reads app.admin_adjustments,
// hasDisabledBindings is linking's hasAdminDisabledBinding, lockRelationWrites is growth's relation
// write lock and releaseBindings linking's releaseForMerge (B1-20c).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { createDeletionStageReader } from '../ports/deletion-stage.ts';

/** One account of one app. */
export interface AccountRef {
  readonly app_id: string;
  readonly user_id: string;
}

/**
 * Read-only footprint of an account outside identity (BR-ID-06 merge conditions), assembled by
 * app.module (IdentityModule.forRoot option `accountAssets`). `db` is the caller's executor.
 */
export interface AccountAssetsPort {
  /** Rows of app.orders whose user_id is the account, whatever their status. */
  countOrders(db: Kysely<DB>, account: AccountRef): Promise<number>;
  /** True when the account has any order claim (找回申请) as the applicant, whatever its status. */
  hasClaims(db: Kysely<DB>, account: AccountRef): Promise<boolean>;
  /** True when the account's balance has any ledger entry (entries netting to zero included). */
  hasLedgerEntries(db: Kysely<DB>, account: AccountRef): Promise<boolean>;
}

/** Assembled through risk's public reader, including the pre-appeal ban state. */
export interface AccountRiskPort {
  isBanned(db: Transaction<DB>, account: AccountRef): Promise<boolean>;
}

/** The cross-module ports of the merge, assembled by app.module. `db` is the caller's executor. */
export interface AccountMergePort {
  /** D10-1099 Q-3: true when the account has any app.admin_adjustments row, whatever its status. */
  hasAdjustments(db: Kysely<DB>, account: AccountRef): Promise<boolean>;
  /** D10-1099 Q-4: true when the account has a blocked(admin_disable) union binding. */
  hasDisabledBindings(db: Kysely<DB>, account: AccountRef): Promise<boolean>;
  /** growth's relation write lock of the app (the invite binder's), on the merge transaction. */
  lockRelationWrites(trx: Transaction<DB>, appId: string): Promise<void>;
  /** linking's releaseForMerge: the source's bindings released without cooling. */
  releaseBindings(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userId: string; readonly at: Date },
  ): Promise<void>;
}

/** The two reads of AccountMergePort the merge offer needs too. */
export type MergeBarrierPort = Pick<AccountMergePort, 'hasAdjustments' | 'hasDisabledBindings'>;

export interface MergeConditionPorts {
  readonly assets: AccountAssetsPort;
  readonly risk: AccountRiskPort;
  readonly barriers: MergeBarrierPort;
}

/** The source's users row as read by the caller (under its lock for the merge). */
export interface MergeSourceRow {
  readonly id: string;
  readonly register_method: string;
  readonly phone_hmac: string | null;
  readonly parent_id: string | null;
  readonly status: string;
}

/** The target's users row as read by the caller. */
export interface MergeTargetRow {
  readonly id: string;
  readonly status: string;
}

const THIRD_PARTY_METHODS: ReadonlySet<string> = new Set(['wechat', 'apple', 'huawei']);

/** True when every BR-ID-06 merge condition holds for merging `source` into `target`. */
export async function mergeConditionsHold(
  trx: Transaction<DB>,
  appId: string,
  source: MergeSourceRow,
  target: MergeTargetRow,
  ports: MergeConditionPorts,
): Promise<boolean> {
  const app = trx.withSchema('app');
  const account: AccountRef = { app_id: appId, user_id: source.id };
  if (
    !THIRD_PARTY_METHODS.has(source.register_method) ||
    source.phone_hmac !== null ||
    source.status !== 'normal' ||
    source.parent_id !== null ||
    target.status !== 'normal' ||
    source.id === target.id
  ) {
    return false;
  }
  // BR-ID-06: a target in the deletion process (cooling period or processing) is not merged.
  const stages = await createDeletionStageReader({ db: app }).read(app, {
    appId,
    userIds: [target.id],
  });
  const stage = stages.get(target.id) ?? 'none';
  if (stage === 'cooling' || stage === 'processing') return false;
  if (
    (await ports.assets.countOrders(app, account)) !== 0 ||
    (await ports.assets.hasClaims(app, account)) ||
    (await ports.assets.hasLedgerEntries(app, account)) ||
    (await ports.barriers.hasAdjustments(app, account)) ||
    (await ports.barriers.hasDisabledBindings(app, account))
  ) {
    return false;
  }
  const child = await app
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', appId)
    .where('parent_id', '=', source.id)
    .executeTakeFirst();
  if (child !== undefined) return false;
  const collision = await app
    .selectFrom('user_oauth as source')
    .innerJoin('user_oauth as target', (join) =>
      join
        .onRef('source.app_id', '=', 'target.app_id')
        .onRef('source.provider', '=', 'target.provider'),
    )
    .select('source.provider')
    .where('source.app_id', '=', appId)
    .where('source.user_id', '=', source.id)
    .where('target.user_id', '=', target.id)
    .executeTakeFirst();
  if (collision !== undefined) return false;
  // Codex money review r1 S0: the source's risk state too, read after the caller's locks — a ban
  // committed while the merge waited for the source's row (the ban takes that row first) is seen
  // here, so a banned identity never moves. The same reading as the target's.
  if (await ports.risk.isBanned(app, { app_id: appId, user_id: source.id })) return false;
  return !(await ports.risk.isBanned(app, { app_id: appId, user_id: target.id }));
}
