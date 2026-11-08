// B1-04zzzzb (FU-ADMIN-HOTWORDS-PROHIBITED-CHECK, D10-1064 / D10-1070) rule-test support: saving
// search.hot_words / search.keyword_routes through the real configuration center (admin entry as
// assembled for production) and reading them back through the real api entry. Built on the frozen
// kits (test/spec/admin/auth, test/spec/content/config-items, test/spec/catalog/hot-words), which
// are only imported here.
//
// How a refusal surfaces (config-item-admin.ts, frozen by AC-B1-05m#28 / #32): a batch answers
// 20001 with the refused configuration keys in data.fields, a single update answers 20001 with
// fields [value]. So "fields holds the key" is asserted on the batch route.
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { fixture, type Harness, type Response } from '../../admin/auth/kit.ts';
import {
  auditsSince,
  batch,
  rejected,
  snapshot,
  stepUp,
  success,
  update,
  type Item,
  type Setup,
  type Snapshot,
} from '../../content/config-items/kit.ts';
import { PATH, expectContract } from '../hot-words/kit.ts';

/** One entry of a batch write. */
export interface Write {
  readonly key: string;
  readonly value: unknown;
  readonly expected_version: number;
}

/** A batch write with a fresh totp step-up (config.business). */
export async function saveBatch(f: Setup, items: readonly Write[]): Promise<Response> {
  return batch(f, { items }, { stepUp: await stepUp(f) });
}

/** A single update with a fresh totp step-up (config.business). */
export async function saveOne(
  f: Setup,
  name: string,
  value: unknown,
  expectedVersion: number,
): Promise<Response> {
  return update(f, name, { value, expected_version: expectedVersion }, { stepUp: await stepUp(f) });
}

/** data.fields of a refused write. */
export function fieldsOf(response: Response): readonly string[] {
  return response.json<{ data: { fields: readonly string[] } }>().data.fields;
}

/** The batch is 20001 and data.fields is exactly `names`, in any order. */
export async function refusedBatch(response: Response, names: readonly string[]): Promise<void> {
  await rejected(response, 'batch', 20001);
  const fields = fieldsOf(response);
  expect(fields).toHaveLength(names.length);
  expect(fields).toEqual(expect.arrayContaining([...names]));
}

/** A single update succeeds and leaves `value` at the next version. */
export async function saved(
  f: Setup,
  name: string,
  value: unknown,
  expectedVersion: number,
): Promise<void> {
  const item = await success<Item>(await saveOne(f, name, value, expectedVersion), 'update');
  expect(item).toMatchObject({ key: name, value, version: expectedVersion + 1 });
}

/** Since `before`: no row or history version changed and no configuration change was audited. */
export async function expectNothingSaved(h: Harness, f: Setup, before: Snapshot): Promise<void> {
  const after = await snapshot(h, f.appId);
  expect(after.items).toEqual(before.items);
  expect(after.versions).toEqual(before.versions);
  const changes = (await auditsSince(h, f.appId, before)).filter(
    (audit) => audit.action === 'config_item_change' || audit.action === 'config_item_rollback',
  );
  expect(changes).toEqual([]);
}

/** An app id the public entry accepts (the shape of test/spec/catalog/hot-words/read.int.test.ts). */
export const readerAppId = (): string => `b105m_${randomBytes(6).toString('hex')}`;

/** data of GET /v1/search/hot-words on the api entry as assembled for production. */
export async function servedLists(h: Harness, appId: string): Promise<unknown> {
  const api = await fixture(h, { entry: 'api' });
  const response = await api.app.inject({
    method: 'GET',
    url: PATH,
    headers: { 'x-app-id': appId, 'x-platform': 'ios', 'x-app-version': '1.2.3' },
  });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  const body = response.json<{ code: number; data: unknown }>();
  expect(body.code).toBe(0);
  await expectContract(body, 'SearchHotWordsResponse');
  return body.data;
}
