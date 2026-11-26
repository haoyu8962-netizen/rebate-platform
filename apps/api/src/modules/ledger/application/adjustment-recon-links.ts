// B2-17: what a manual adjustment does to the recon diffs it links (08 BR-FUND-24 ⑨ and 细则
// 「对外差错单的调账」, 负责人 2026-11-21 方案 B; 多受益人取 (c), 编排 D10-2317 ②; the task's §9.3 and
// §13.3, D10-2417 / D10-3185 / D10-3191 / D10-3226).
//
// - A person never links an external diff: type union_mismatch or channel_mismatch → 20001
//   adjust_ref_invalid (checked with the other refs, admin-adjustment.ts checkRefs).
// - Before the member's rows, every linked diff row is locked (ascending id); its status, type,
//   source, involved list and unreversed link rows are read under that lock.
// - Positive list (task §16.3, D10-3237 (五), D10-3239): only a diff of type ledger_mismatch takes
//   the steps below (20902, link row, status write, one unreversed link per member). A diff of any
//   other type a person may link (platform_restore, appeal_restore, blacklist_after_credit, …, and
//   any type added later) is only checked to be an existing diff of the app: its status is not
//   looked at, no link row is written and none of its columns changes (its own entry closes it).
// - Any linked ledger_mismatch diff not open / processing, or one the member already has an unreversed link to →
//   20902 data.resource=recon_diff, decided before anything is written (planNewFormDiffs).
// - Executing: one link row per diff; the diff → adjusted when every involved member is covered
//   (an unreversed link, or the member filing now; reason code, direction and amount do not count),
//   otherwise open → processing (a processing row is left as it is). Involved members: the
//   registered list, or only the member filing when the list is NULL or empty.
// - A reversal marks every unreversed link row of the original with its own adjust_id and sends each
//   adjusted diff back to processing (any other status untouched; ⑯ keeps it adjusted when another
//   unresolved ledger_mismatch of the same ref exists, the store decides that in its UPDATE).
// Every write runs on the submission's transaction (`trx`), in the order given here; a write that
// does not land as expected throws, which rolls the whole submission back (50001).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type {
  AdjustmentReconStore,
  LockedReconDiff,
} from '../infra/adjustment-recon-diffs-store.ts';

/** The recon diff types a person may never link (BR-FUND-24 细则「对外差错单的调账」). */
export const EXTERNAL_DIFF_TYPES: ReadonlySet<string> = new Set([
  'union_mismatch',
  'channel_mismatch',
]);

/**
 * The recon diff types an adjustment concludes (plan B, BR-FUND-24 ⑨): a positive list, so that a
 * type added later is left as it is by default (task §16.3).
 */
export const PLAN_B_DIFF_TYPES: ReadonlySet<string> = new Set(['ledger_mismatch']);

/** Whether linking this diff takes the plan B steps (20902, link row, status write). */
export function concludedByAdjustment(diff: Pick<LockedReconDiff, 'type'>): boolean {
  return PLAN_B_DIFF_TYPES.has(diff.type);
}

/**
 * The ids among `ids` (ascending, as locked) whose diff is concluded by an adjustment; the others
 * are only linked by refs. Every id must be in `diffs` (checked by checkRefs before).
 */
export function planBDiffIds(
  ids: readonly string[],
  diffs: ReadonlyMap<string, Pick<LockedReconDiff, 'type'>>,
): string[] {
  return ids.filter((id) => {
    const diff = diffs.get(id);
    if (diff === undefined) throw new Error(`ledger: linked recon diff ${id} was not locked`);
    return concludedByAdjustment(diff);
  });
}

/** The statuses a linked diff must be in for the form to execute. */
const LINKABLE: ReadonlySet<string> = new Set(['open', 'processing']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The well-formed recon_diff ids of the refs, lower case, unique, ascending (the lock order). */
export function linkedDiffIds(
  refs: readonly { readonly ref_type: string; readonly ref_id: string }[],
): string[] {
  const ids = refs
    .filter((ref) => ref.ref_type === 'recon_diff' && UUID.test(ref.ref_id))
    .map((ref) => ref.ref_id.toLowerCase());
  return [...new Set(ids)].sort();
}

/** Whether a person may link this diff at all (not R4, not an external type). */
export function personMayLink(diff: Pick<LockedReconDiff, 'source' | 'type'>): boolean {
  return diff.source !== 'R4' && !EXTERNAL_DIFF_TYPES.has(diff.type);
}

/** The involved members of a diff: its list, or only `userId` when the list is NULL or empty. */
export function involvedMembers(list: readonly string[] | null, userId: string): string[] {
  if (list === null || list.length === 0) return [userId.toLowerCase()];
  return [...new Set(list.map((id) => id.toLowerCase()))];
}

/** The status write a linked diff takes when the form executes. */
export type DiffWrite = 'adjusted' | 'processing' | 'none';

export interface DiffPlanItem {
  readonly id: string;
  readonly write: DiffWrite;
}

export type NewFormDiffPlan =
  { readonly ok: false } | { readonly ok: true; readonly items: readonly DiffPlanItem[] };

/**
 * The decision for a new form linking `ids` (all of them found in `diffs`, already checked by
 * personMayLink, and all of them ledger_mismatch: planBDiffIds): refused (20902 recon_diff) when any diff is not open / processing or `userId`
 * already holds an unreversed link to it; otherwise each diff's write. Covered members = those with
 * an unreversed link plus `userId`; nothing else (reason code, direction, amount) is looked at.
 */
export function planNewFormDiffs(
  ids: readonly string[],
  diffs: ReadonlyMap<string, Pick<LockedReconDiff, 'status' | 'involved_user_ids'>>,
  active: ReadonlyMap<string, ReadonlySet<string>>,
  userId: string,
): NewFormDiffPlan {
  const member = userId.toLowerCase();
  const items: DiffPlanItem[] = [];
  for (const id of ids) {
    const diff = diffs.get(id);
    if (diff === undefined) throw new Error(`ledger: linked recon diff ${id} was not locked`);
    const linked = active.get(id) ?? new Set<string>();
    if (!LINKABLE.has(diff.status) || linked.has(member)) return { ok: false };
    const covered = new Set([...linked, member]);
    const all = involvedMembers(diff.involved_user_ids, member).every((user) => covered.has(user));
    items.push({
      id,
      write: all ? 'adjusted' : diff.status === 'open' ? 'processing' : 'none',
    });
  }
  return { ok: true, items };
}

/**
 * The link rows and status writes of an executed new form, on `trx`: per diff (ascending id) its
 * link row, then its status write. Throws when a status write finds the row not as locked.
 */
export async function writeNewFormDiffs(
  store: AdjustmentReconStore,
  trx: Transaction<DB>,
  input: {
    readonly appId: string;
    readonly adjustId: string;
    readonly userId: string;
    readonly handlerId: string;
    readonly at: Date;
    readonly items: readonly DiffPlanItem[];
  },
): Promise<void> {
  const { appId, at } = input;
  for (const item of input.items) {
    await store.insertLink(trx, {
      appId,
      adjustId: input.adjustId,
      reconDiffId: item.id,
      userId: input.userId,
      at,
    });
    if (item.write === 'adjusted') {
      const written = await store.markAdjusted(trx, {
        appId,
        id: item.id,
        handlerId: input.handlerId,
        at,
      });
      if (!written) throw new Error(`ledger: recon diff ${item.id} left open / processing`);
    } else if (item.write === 'processing') {
      const written = await store.markProcessing(trx, { appId, id: item.id, at });
      if (!written) throw new Error(`ledger: recon diff ${item.id} is no longer open`);
    }
  }
}

/**
 * A reversal of `originalId` on `trx`: its unreversed link rows take `reversalId`, then each of
 * their diffs that is adjusted goes back to processing (the store leaves it in any other status
 * and under ⑯). An original without link rows touches no diff.
 */
export async function writeReversalDiffs(
  store: AdjustmentReconStore,
  trx: Transaction<DB>,
  input: {
    readonly appId: string;
    readonly originalId: string;
    readonly reversalId: string;
    readonly at: Date;
  },
): Promise<void> {
  const ids = await store.markLinksReversed(trx, {
    appId: input.appId,
    adjustId: input.originalId,
    reversalId: input.reversalId,
  });
  for (const id of ids) {
    await store.sendBack(trx, { appId: input.appId, id, at: input.at });
  }
}
