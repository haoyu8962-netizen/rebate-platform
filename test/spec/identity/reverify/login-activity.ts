// BR-WDR-01 细则「判定」: every login overwrites the account's activity columns (updated_at moves
// with them). The rest of the row stays equal field by field; other accounts stay equal entirely.
// The frozen login tests load this inside the test blocks D10-569 changed, so the code outside
// their tests stays as it was and red-check keeps judging them test by test.
import { expect } from 'vitest';

type Row = Record<string, unknown>;

const ACTIVITY_COLUMNS = new Set([
  'last_active_at',
  'last_login_device_hash',
  'reverify_flagged_at',
  'reverify_trusted',
  'updated_at',
]);

function withoutActivity(row: Row) {
  return Object.fromEntries(Object.entries(row).filter(([name]) => !ACTIVITY_COLUMNS.has(name)));
}

/** One account, before and after its login. `hash` is the device row's device_hash. */
export function expectRowOnlyLoginActivity(
  before: Row,
  after: Row,
  login: { at: Date; hash: string },
) {
  expect(withoutActivity(after)).toEqual(withoutActivity(before));
  expect(after).toMatchObject({
    last_active_at: login.at,
    last_login_device_hash: login.hash,
    reverify_flagged_at: before.reverify_flagged_at,
    reverify_trusted: before.reverify_trusted,
  });
}

/** Every account of the app: only the one that logged in may differ, and only as above. */
export function expectOnlyLoginActivity(
  before: readonly Row[],
  after: readonly Row[],
  login: { uid: string; at: Date; hash: string },
) {
  const others = (row: Row) => row.id !== login.uid;
  expect(after.filter(others)).toEqual(before.filter(others));
  expectRowOnlyLoginActivity(
    before.find((row) => row.id === login.uid)!,
    after.find((row) => row.id === login.uid)!,
    login,
  );
}
