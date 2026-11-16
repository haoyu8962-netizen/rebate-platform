// B1-34r rule-test kit (claude-independent, SPEC_REF 6674cd02): the audit console (contract
// adminListAuditLogs / adminGetAuditLog, CT-24c) derives target_type / target_id / permission of the
// risk module's appeal console actions (编排 D10-1759 / D10-1760, task §9 table):
//   appeal_register / _claim / _resolve  <appeal_id>     → appeal / <id> / risk.appeal
//   blocklist_remove                     <blocklist_id>  → blocklist / <id> / risk.appeal
//   blocked_request_lookup               null            → null / null / risk.appeal
// The stored target is the bare id (risk/application/admin-appeals-write.ts, admin-appeals-read.ts).
// Real pieces: the admin entry and PostgreSQL through the audit-query kit (../audit-query/kit.ts).
// Synthetic: admin accounts and appended audit rows (no appeals / blocklist rows are needed; the
// derivation reads only the audit row). No real user data.
import { expect } from 'vitest';
import {
  detail,
  FROM,
  page,
  TO,
  type Detail,
  type Item,
  type Query,
  type Setup,
} from '../audit-query/kit.ts';

export const REGISTER = 'appeal_register';
export const CLAIM = 'appeal_claim';
export const RESOLVE = 'appeal_resolve';
export const BLOCKLIST_REMOVE = 'blocklist_remove';
export const LOOKUP = 'blocked_request_lookup';
export const APPEAL_TYPE = 'appeal';
export const BLOCKLIST_TYPE = 'blocklist';
/** specs/permissions.yaml: the one point guarding all five actions (task §9). */
export const APPEAL = 'risk.appeal';
export const WINDOW = { from: FROM, to: TO };

/** `at` inside the audit-query kit's FROM–TO window, `minute` minutes after FROM. */
export function inWindow(minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, '0');
  const minutes = String(minute % 60).padStart(2, '0');
  return `2026-10-08T${hours}:${minutes}:00.000Z`;
}

export type View = Pick<Item, 'action' | 'target_type' | 'target_id' | 'permission'>;

export function view(
  action: string,
  target_type: string | null,
  target_id: string | null,
  permission: Item['permission'],
): View {
  return { action, target_type, target_id, permission };
}

export function derived(item: Item | Detail): View {
  return view(item.action, item.target_type, item.target_id, item.permission);
}

function sorted(rows: readonly View[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

/**
 * The list under `query` (inside WINDOW unless the query says otherwise) holds exactly `expected`
 * (as a multiset); every row carries the filtered values, and its detail reads the same derived
 * fields as the list row.
 */
export async function expectRows(
  f: Setup,
  query: Query,
  expected: readonly View[],
): Promise<Item[]> {
  const result = await page(f, { ...WINDOW, page_size: 200, ...query });
  expect(result.total).toBe(expected.length);
  expect(result.items).toHaveLength(expected.length);
  expect(sorted(result.items.map(derived))).toEqual(sorted(expected));
  for (const row of result.items) {
    for (const key of ['target_type', 'target_id', 'permission'] as const) {
      if (query[key] !== undefined) expect(row[key]).toBe(query[key]);
    }
    const one = await detail(f, row.id);
    expect(one).toMatchObject(row);
    expect(derived(one)).toEqual(derived(row));
  }
  return result.items;
}
