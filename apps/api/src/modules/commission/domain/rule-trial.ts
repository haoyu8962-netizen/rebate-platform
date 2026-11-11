// Pure logic of the rule publication service (B2-03k): time formatting for validateRuleVersion
// (BR-CALC-11, ISO 8601 +08:00, compared in whole seconds), the trial difference report
// (BR-CALC-22: per platform reserve_bp, reserve, own / direct / indirect shares and platform
// retain, recomputed for the current and the draft version through planSnapshot →
// splitCommission) and the deterministic sample digest. No I/O, no clock. Money only through
// @couli/money and @couli/domain.
//
// Erasable syntax only, `import type` for type-only imports, relative imports with `.ts`.
import { createHash } from 'node:crypto';
import type { components, UserLevel } from '@couli/contracts-ts';
import { addFen, fenToJsonNumber } from '@couli/money';
import type { RuleVersion } from './rules.ts';
import { planSnapshot, type SnapshotPerson } from './snapshot.ts';

type Platform = components['schemas']['PlatformCode'];

const CHINA_OFFSET_MS = 8 * 3_600_000;

/** True for a Date holding a finite instant. */
export function isValidInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** `instant` moved by `ms` as a new Date (the input is never modified, no wall clock read). */
export function shiftMs(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

/** ISO 8601 with a fixed +08:00 offset and milliseconds, as validateRuleVersion expects. */
export function toChinaIso(instant: Date): string {
  if (!isValidInstant(instant)) throw new TypeError('commission: instant is not a valid Date');
  const iso = shiftMs(instant, CHINA_OFFSET_MS).toISOString();
  if (!iso.endsWith('Z')) throw new RangeError('commission: instant is out of the ISO range');
  return `${iso.slice(0, -1)}+08:00`;
}

/** Whole UTC seconds (BR-CALC-11 compares to the second). */
export function wholeSeconds(instant: Date): number {
  return Math.floor(instant.getTime() / 1000);
}

/** One snapshotted order of the trial sample, with what the trial recomputes from. */
export interface TrialSample {
  readonly orderId: string;
  readonly platform: string;
  readonly orderType: 'self' | 'share';
  readonly rebateMode: 'none' | 'normal' | null;
  readonly rawNFen: bigint;
  readonly subsidyCommissionFen: bigint;
  readonly tljDeductFen: bigint;
  readonly owner: SnapshotPerson;
  readonly direct: SnapshotPerson | null;
  readonly indirect: SnapshotPerson | null;
}

export interface TrialTotals {
  readonly reserveBp: number;
  readonly reserveFen: number;
  readonly ownFen: number;
  readonly directFen: number;
  readonly indirectFen: number;
  readonly platformRetainFen: number;
}

export interface TrialPlatformRow {
  readonly platform: string;
  readonly current: TrialTotals | null;
  readonly draft: TrialTotals;
}

/** Recomputing a sample order failed (missing row / reserve, unsafe JSON amount, bad data). */
export class TrialComputationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrialComputationError';
  }
}

interface Sums {
  reserve: bigint;
  own: bigint;
  direct: bigint;
  indirect: bigint;
  retain: bigint;
}

function reserveBpOf(version: RuleVersion, platform: string): number | null {
  const rows = version.reserves.filter((r) => r.platform === platform);
  if (rows.length > 1) {
    throw new TrialComputationError(`rule version has duplicate reserves for ${platform}`);
  }
  return rows[0]?.reserve_bp ?? null;
}

/**
 * Per-platform totals of one version over the sample. Every sample order is recomputed with
 * this version's rows (owner / direct / indirect each by their own snapshot level); the stored
 * snapshot amounts are never copied. Any order that cannot be recomputed throws.
 */
function totalsOf(
  version: RuleVersion,
  platforms: readonly string[],
  samples: readonly TrialSample[],
): Map<string, Sums> {
  const sums = new Map<string, Sums>();
  for (const platform of platforms) {
    sums.set(platform, { reserve: 0n, own: 0n, direct: 0n, indirect: 0n, retain: 0n });
  }
  for (const sample of samples) {
    const sum = sums.get(sample.platform);
    if (sum === undefined) {
      throw new TrialComputationError(`sample platform ${sample.platform} is not configured`);
    }
    const plan = planSnapshot({
      version,
      platform: sample.platform as Platform,
      orderType: sample.orderType,
      rebateMode: sample.rebateMode,
      nBaseFen: sample.rawNFen,
      subsidyCommissionFen: sample.subsidyCommissionFen,
      tljDeductFen: sample.tljDeductFen,
      // Red packets do not enter the trial columns; 0 keeps planSnapshot free of the warning.
      tljRedpacketFen: 0n,
      people: { owner: sample.owner, direct: sample.direct, indirect: sample.indirect },
    });
    if (plan.kind === 'pending') throw new TrialComputationError(plan.reason);
    sum.reserve = addFen(sum.reserve, plan.reserve_fen);
    sum.retain = addFen(sum.retain, plan.platform_retain_fen);
    for (const b of plan.beneficiaries) {
      if (b.role === 'direct') sum.direct = addFen(sum.direct, b.amount_fen);
      else if (b.role === 'indirect') sum.indirect = addFen(sum.indirect, b.amount_fen);
      else sum.own = addFen(sum.own, b.amount_fen);
    }
  }
  return sums;
}

function json(sum: Sums, reserveBp: number): TrialTotals {
  return {
    reserveBp,
    reserveFen: fenToJsonNumber(sum.reserve),
    ownFen: fenToJsonNumber(sum.own),
    directFen: fenToJsonNumber(sum.direct),
    indirectFen: fenToJsonNumber(sum.indirect),
    platformRetainFen: fenToJsonNumber(sum.retain),
  };
}

export interface TrialReportInput {
  /** commission.platforms (deduplicated here, first occurrence order kept). */
  readonly platforms: readonly string[];
  /** The draft's base version; null for the first version (no current column). */
  readonly current: RuleVersion | null;
  readonly draft: RuleVersion;
  readonly samples: readonly TrialSample[];
}

/**
 * BR-CALC-22 / BR-CALC-05: one row per configured platform (also with an empty sample). The
 * current column is null without a base version, or when the base has no reserve for a platform
 * that the sample does not contain. The indirect column is always present (0 when disabled).
 * Throws TrialComputationError (or the money errors) when any amount cannot be produced.
 */
export function buildTrialReport(input: TrialReportInput): TrialPlatformRow[] {
  const platforms = [...new Set(input.platforms)];
  const draftSums = totalsOf(input.draft, platforms, input.samples);
  const currentSums =
    input.current === null ? null : totalsOf(input.current, platforms, input.samples);
  return platforms.map((platform): TrialPlatformRow => {
    const draftBp = reserveBpOf(input.draft, platform);
    if (draftBp === null) throw new TrialComputationError(`draft has no reserve for ${platform}`);
    const draft = json(draftSums.get(platform)!, draftBp);
    if (input.current === null || currentSums === null) return { platform, current: null, draft };
    const currentBp = reserveBpOf(input.current, platform);
    return {
      platform,
      current: currentBp === null ? null : json(currentSums.get(platform)!, currentBp),
      draft,
    };
  });
}

/** Stored snapshot facts that make up the sample digest. */
export interface DigestSplit {
  readonly orderId: string;
  readonly platform: string;
  readonly ruleVersionId: string;
  readonly orderType: string;
  readonly activityType: string | null;
  readonly rebateMode: string | null;
  readonly paidAtMs: number;
  readonly paidAtSource: string;
  readonly rawNFen: bigint;
  readonly subsidyCommissionFen: bigint;
  readonly reserveBp: number;
  readonly reserveFen: bigint;
  readonly tljDeductFen: bigint;
  readonly baseFen: bigint;
  readonly platformRetainFen: bigint;
  readonly beneficiaries: unknown;
}

export interface DigestAmount {
  readonly orderId: string;
  readonly commissionVersion: number;
  readonly userId: string;
  readonly role: string;
  readonly baseFen: bigint;
  readonly amountFen: bigint;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The amount rows of each order's latest commission_version only (orders without amount rows
 * contribute none). Older versions are history: BR-CALC-22 compares the shares as they now stand.
 */
function latestAmounts(amounts: readonly DigestAmount[]): DigestAmount[] {
  const latest = new Map<string, number>();
  for (const a of amounts) {
    const seen = latest.get(a.orderId);
    if (seen === undefined || a.commissionVersion > seen)
      latest.set(a.orderId, a.commissionVersion);
  }
  return amounts.filter((a) => a.commissionVersion === latest.get(a.orderId));
}

/**
 * Deterministic digest of the sample: the window, every snapshot row of the window and, per
 * order, the share rows (user, role, base, amount) of its latest amount version only, without the
 * version number. BR-CALC-22 (2026-11-11, D10-1258): a new version whose shares equal the previous
 * one item by item (subsidy only, BR-CALC-27) leaves the digest unchanged; any share change, also
 * one back to an older value, changes it. Input order does not matter; bigint fen are written as
 * decimal strings.
 *
 * Format v2 (v1 listed every version with its number): a trial stored under v1 never matches a v2
 * recomputation, so such a trial is conservatively treated as a changed sample and must be rerun.
 */
export function sampleDigest(input: {
  readonly fromMs: number;
  readonly toMs: number;
  readonly splits: readonly DigestSplit[];
  readonly amounts: readonly DigestAmount[];
}): string {
  const splits = [...input.splits].sort((a, b) => compare(a.orderId, b.orderId));
  const amounts = latestAmounts(input.amounts).sort(
    (a, b) =>
      compare(a.orderId, b.orderId) || compare(a.role, b.role) || compare(a.userId, b.userId),
  );
  const canonical = JSON.stringify({
    v: 2,
    window: [input.fromMs, input.toMs],
    splits: splits.map((s) => [
      s.orderId,
      s.platform,
      s.ruleVersionId,
      s.orderType,
      s.activityType,
      s.rebateMode,
      s.paidAtMs,
      s.paidAtSource,
      s.rawNFen.toString(),
      s.subsidyCommissionFen.toString(),
      s.reserveBp,
      s.reserveFen.toString(),
      s.tljDeductFen.toString(),
      s.baseFen.toString(),
      s.platformRetainFen.toString(),
      s.beneficiaries,
    ]),
    amounts: amounts.map((a) => [
      a.orderId,
      a.userId,
      a.role,
      a.baseFen.toString(),
      a.amountFen.toString(),
    ]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * BR-CALC-05 / BR-CALC-22: a snapshot made under a version without indirect has no indirect
 * person, yet a compared version (draft or current) that enables indirect pays one. Such a sample
 * needs the indirect person at paid_at from the beneficiary resolver; it is never read as "none".
 * Without a direct layer there is no indirect share (planSnapshot), so nothing is missing then.
 */
export function needsIndirectPerson(
  sample: TrialSample,
  versions: readonly (RuleVersion | null)[],
): boolean {
  if (sample.direct === null || sample.indirect !== null) return false;
  return versions.some((v) => v !== null && v.indirect_enabled);
}

function samePerson(a: SnapshotPerson, b: SnapshotPerson): boolean {
  return a.userId === b.userId && a.level === b.level && a.status === b.status;
}

function checkedPerson(raw: unknown, who: string): SnapshotPerson {
  if (typeof raw !== 'object' || raw === null) {
    throw new TrialComputationError(`resolved ${who} is not an object`);
  }
  const p = raw as Record<string, unknown>;
  const userId = p['userId'];
  const level = p['level'];
  const status = p['status'];
  const reason = p['forfeitReason'];
  if (typeof userId !== 'string' || userId === '') {
    throw new TrialComputationError(`resolved ${who} has no user id`);
  }
  if (level !== 'L1' && level !== 'L2' && level !== 'L3') {
    throw new TrialComputationError(`resolved ${who} level is not L1/L2/L3`);
  }
  if (status !== 'active' && status !== 'forfeited') {
    throw new TrialComputationError(`resolved ${who} status is not active/forfeited`);
  }
  if (reason !== null && typeof reason !== 'string') {
    throw new TrialComputationError(`resolved ${who} forfeit reason is not a string`);
  }
  return { userId, level, status, forfeitReason: reason };
}

/**
 * The sample with the indirect person the resolver gave for paid_at. The resolver must agree with
 * the stored snapshot on the owner and the direct person (same user, level and status); any
 * disagreement or malformed answer means the result is not certain and throws (the trial fails,
 * the indirect share is never taken as 0). A resolved indirect of null means none at paid_at.
 */
export function withResolvedIndirect(
  sample: TrialSample,
  resolved: { readonly owner: unknown; readonly direct: unknown; readonly indirect: unknown },
): TrialSample {
  if (sample.direct === null) {
    throw new TrialComputationError(
      `sample ${sample.orderId} has no direct person to resolve from`,
    );
  }
  if (typeof resolved !== 'object' || resolved === null) {
    throw new TrialComputationError(`resolver answer for ${sample.orderId} is not an object`);
  }
  const owner = checkedPerson(resolved.owner, 'owner');
  if (!samePerson(owner, sample.owner)) {
    throw new TrialComputationError(`resolver owner differs from snapshot ${sample.orderId}`);
  }
  if (resolved.direct === null || resolved.direct === undefined) {
    throw new TrialComputationError(`resolver has no direct person for snapshot ${sample.orderId}`);
  }
  const direct = checkedPerson(resolved.direct, 'direct');
  if (!samePerson(direct, sample.direct)) {
    throw new TrialComputationError(`resolver direct differs from snapshot ${sample.orderId}`);
  }
  if (resolved.indirect === undefined) {
    throw new TrialComputationError(`resolver gave no indirect answer for ${sample.orderId}`);
  }
  const indirect = resolved.indirect === null ? null : checkedPerson(resolved.indirect, 'indirect');
  return { ...sample, indirect };
}

/** Reads the people of a stored snapshot (commission_splits.beneficiaries). Bad data throws. */
export function peopleOfSnapshot(beneficiaries: unknown): {
  owner: SnapshotPerson;
  direct: SnapshotPerson | null;
  indirect: SnapshotPerson | null;
} {
  if (!Array.isArray(beneficiaries)) {
    throw new TrialComputationError('snapshot beneficiaries is not an array');
  }
  let owner: SnapshotPerson | null = null;
  let direct: SnapshotPerson | null = null;
  let indirect: SnapshotPerson | null = null;
  for (const raw of beneficiaries as unknown[]) {
    if (typeof raw !== 'object' || raw === null) {
      throw new TrialComputationError('snapshot beneficiary is not an object');
    }
    const b = raw as Record<string, unknown>;
    const level = b['level'];
    const status = b['initial_status'];
    const userId = b['user_id'];
    const reason = b['forfeit_reason'];
    if (level !== 'L1' && level !== 'L2' && level !== 'L3') {
      throw new TrialComputationError('snapshot beneficiary level is not L1/L2/L3');
    }
    if (status !== 'active' && status !== 'forfeited') {
      throw new TrialComputationError('snapshot beneficiary status is not active/forfeited');
    }
    if (typeof userId !== 'string') {
      throw new TrialComputationError('snapshot beneficiary user_id is not a string');
    }
    const person: SnapshotPerson = {
      userId,
      level: level satisfies UserLevel,
      status,
      forfeitReason: typeof reason === 'string' ? reason : null,
    };
    const role = b['role'];
    if (role === 'self' || role === 'share') {
      if (owner !== null) throw new TrialComputationError('snapshot has two owners');
      owner = person;
    } else if (role === 'direct') {
      if (direct !== null) throw new TrialComputationError('snapshot has two direct beneficiaries');
      direct = person;
    } else if (role === 'indirect') {
      if (indirect !== null) {
        throw new TrialComputationError('snapshot has two indirect beneficiaries');
      }
      indirect = person;
    } else {
      throw new TrialComputationError('snapshot beneficiary role is unknown');
    }
  }
  if (owner === null) throw new TrialComputationError('snapshot has no owner');
  return { owner, direct, indirect };
}
