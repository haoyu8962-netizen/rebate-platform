// B1-01zzr rule-test kit (orchestrator brief w1-search-linking, D10-747 / D10-765 / D10-766 A).
// The metric names, the exclusion table and the fixture's expected values are written out here,
// independent of the code under test. The Prometheus text reader and the read-only session URL come
// from B1-01zzh's kit (read only, not changed). Streams are inserted straight into
// app.union_accounts / app.sync_cursors (db/schema.sql); the test database comes from the int
// tests (@couli/db/testing is allowed in *.int.test.ts only).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { families, samples } from '../metrics/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);

/** The injected clock's instant. The database's own now() is years earlier on purpose. */
export const NOW = '2031-04-05T06:07:08.000Z';

/** NOW shifted by (possibly fractional) seconds, as an ISO instant with milliseconds. */
export function at(offsetSeconds: number): string {
  return new Date(Date.parse(NOW) + Math.round(offsetSeconds * 1000)).toISOString();
}

/** The watermark lag gauge (B1-01zzh), one series per platform. */
export const LAG_METRIC = 'couli_sync_watermark_lag_seconds';

/** The new rescan position gauge, one series per (app_id, platform, query_kind). */
export const RESCAN_METRIC = 'couli_sync_rescan_position_seconds';

/** Brief point 1: the exclusion table of the watermark lag (not an allow list). */
export const EXCLUDED_KINDS = ['rescan', 'rights', 'manual'] as const;
export type ExcludedKind = (typeof EXCLUDED_KINDS)[number];

/** Brief point 2: the entries that never export the rescan gauge. */
export const OTHER_ENTRIES = ['api', 'stream', 'admin', 'payout'] as const;

/** The second App of the fixture (app_id is a label of the rescan gauge). */
export const OTHER_APP = 'couli-other';

// ---- Prometheus text ---------------------------------------------------------------------------

/** couli_sync_watermark_lag_seconds as { platform: value }; every series carries only `platform`. */
export function lagSeries(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === LAG_METRIC)) {
    expect(Object.keys(sample.labels), `${LAG_METRIC} labels`).toEqual(['platform']);
    const platform = sample.labels['platform']!;
    expect(Object.hasOwn(out, platform), `${LAG_METRIC}{platform="${platform}"} twice`).toBe(false);
    out[platform] = sample.value;
  }
  return out;
}

/** The key of one rescan series in rescanSeries(). */
export function rescanKey(appId: string, platform: string, queryKind = 'rescan'): string {
  return `${appId}|${platform}|${queryKind}`;
}

/**
 * couli_sync_rescan_position_seconds as { rescanKey(app_id, platform, query_kind): value }; every
 * series carries exactly the three labels app_id, platform and query_kind.
 */
export function rescanSeries(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === RESCAN_METRIC)) {
    expect(Object.keys(sample.labels).sort(), `${RESCAN_METRIC} labels`).toEqual([
      'app_id',
      'platform',
      'query_kind',
    ]);
    const key = rescanKey(
      sample.labels['app_id']!,
      sample.labels['platform']!,
      sample.labels['query_kind']!,
    );
    expect(Object.hasOwn(out, key), `${RESCAN_METRIC} ${key} twice`).toBe(false);
    out[key] = sample.value;
  }
  return out;
}

/** The `# TYPE` of a metric family in the text, or undefined. */
export function typeOf(text: string, name: string): string | undefined {
  return families(text).get(name);
}

/** Text names the rescan gauge anywhere (a sample, HELP or TYPE line). */
export function namesRescan(text: string): boolean {
  return new RegExp(`(^|[\\s{])${RESCAN_METRIC}([\\s{]|$)`, 'm').test(text);
}

// ---- database fixtures -------------------------------------------------------------------------

/** A new union account of `platform` under `appId`; returns its id. */
export async function insertAccount(
  db: Kysely<DB>,
  platform: string,
  appId = 'couli',
): Promise<string> {
  const accountId = randomUUID();
  await sql`
    INSERT INTO app.union_accounts (id, app_id, platform, account_name, status, auth_status)
    VALUES (${accountId}, ${appId}, ${platform}, ${`synthetic-${accountId}`}, 'active', 'active')
  `.execute(db);
  return accountId;
}

export interface Stream {
  readonly appId?: string;
  readonly platform: string;
  readonly accountId: string;
  readonly queryKind: string;
  readonly scene?: string;
  readonly cursorAt: string;
}

/** One app.sync_cursors row (one stream). */
export async function insertStream(db: Kysely<DB>, stream: Stream): Promise<void> {
  await sql`
    INSERT INTO app.sync_cursors
      (app_id, platform, union_account_id, query_kind, scene, cursor_at, updated_at)
    VALUES (${stream.appId ?? 'couli'}, ${stream.platform}, ${stream.accountId},
      ${stream.queryKind}, ${stream.scene ?? '-'}, ${stream.cursorAt}::timestamptz,
      ${stream.cursorAt}::timestamptz)
  `.execute(db);
}

/**
 * The fixture of the collection tests (offsets are seconds from NOW). Every platform has rescan,
 * rights or manual streams far older than its sync streams, so counting any of them in the lag
 * shows; pdd has only excluded streams. Returns the values expected at NOW.
 */
export async function seedStreams(db: Kysely<DB>) {
  const taobao1 = await insertAccount(db, 'taobao');
  const taobao2 = await insertAccount(db, 'taobao');
  const jd = await insertAccount(db, 'jd');
  const pdd = await insertAccount(db, 'pdd');
  const otherJd = await insertAccount(db, 'jd', OTHER_APP);
  const otherTaobao = await insertAccount(db, 'taobao', OTHER_APP);

  // [app_id, platform, union account, query_kind, scene, offset from NOW in seconds]
  const rows: readonly (readonly [string, string, string, string, string, number])[] = [
    // taobao: sync streams increment −100 and the frozen fixture's 'updated_at' −250.6 → lag 250
    // (whole seconds, rounded down). Its rescan streams on both accounts: the older, −90 000.
    ['couli', 'taobao', taobao1, 'increment', '-', -100],
    ['couli', 'taobao', taobao2, 'updated_at', '-', -250.6],
    ['couli', 'taobao', taobao1, 'rescan', '-', -90_000],
    ['couli', 'taobao', taobao2, 'rescan', '-', -40_000],
    // jd: sync streams increment −60 and another kind 'paid_time' −500 (counted: an exclusion
    // table, not "increment only") → lag 500; rescan in two scenes (older −50 000), rights
    // −70 000 and manual −80 000 are excluded. The other App's jd increment −10 does not lower
    // the minimum; its rescan −7200 is a series of its own app_id.
    ['couli', 'jd', jd, 'increment', '-', -60],
    ['couli', 'jd', jd, 'paid_time', '-', -500],
    ['couli', 'jd', jd, 'rescan', '-', -50_000],
    ['couli', 'jd', jd, 'rescan', 'x', -20_000],
    ['couli', 'jd', jd, 'rights', '-', -70_000],
    ['couli', 'jd', jd, 'manual', '-', -80_000],
    [OTHER_APP, 'jd', otherJd, 'increment', '-', -10],
    [OTHER_APP, 'jd', otherJd, 'rescan', '-', -7200],
    // pdd: only excluded streams → no lag series at all (not 0). Rescan position −3600.4 → 3600.
    ['couli', 'pdd', pdd, 'manual', '-', -99_999],
    ['couli', 'pdd', pdd, 'rights', '-', -5000],
    ['couli', 'pdd', pdd, 'rescan', '-', -3600.4],
    // The other App's taobao rescan stands 12 s after NOW: never negative, 0.
    [OTHER_APP, 'taobao', otherTaobao, 'rescan', '-', 12],
  ];
  for (const [appId, platform, accountId, queryKind, scene, offset] of rows) {
    await insertStream(db, { appId, platform, accountId, queryKind, scene, cursorAt: at(offset) });
  }

  return {
    lag: { taobao: 250, jd: 500 } as Record<string, number>,
    rescan: {
      [rescanKey('couli', 'taobao')]: 90_000,
      [rescanKey('couli', 'jd')]: 50_000,
      [rescanKey('couli', 'pdd')]: 3600,
      [rescanKey(OTHER_APP, 'jd')]: 7200,
      [rescanKey(OTHER_APP, 'taobao')]: 0,
    } as Record<string, number>,
    /** The same, 60 s later on the injected clock. */
    lagLater: { taobao: 310, jd: 560 } as Record<string, number>,
    rescanLater: {
      [rescanKey('couli', 'taobao')]: 90_060,
      [rescanKey('couli', 'jd')]: 50_060,
      [rescanKey('couli', 'pdd')]: 3660,
      [rescanKey(OTHER_APP, 'jd')]: 7260,
      [rescanKey(OTHER_APP, 'taobao')]: 48,
    } as Record<string, number>,
  };
}
