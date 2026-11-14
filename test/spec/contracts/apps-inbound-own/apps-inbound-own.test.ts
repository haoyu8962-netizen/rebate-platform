import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as bridge from '../../../../packages/contracts-ts/src/bridge.gen.ts';

// CT-17h / SPEC_REF 009592348c33b9fd5a32c6b37137ed3e99ebc52c:
// 06 Q-A5 fixes couli and l.couliapp.com; 04 §9 defines the inbound shape.
// The task ledger explicitly defers verified_link: the current shape requires
// verified=true, but Apple Team ID / Associated Domains (Q-C9 / N-04) are pending.
// AC-CT-17h#n are local acceptance groups, not new business ACs or BRs.

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as JsonObject;
}

function contract(): JsonObject {
  return object(
    JSON.parse(
      readFileSync(new URL('../../../../contracts/apps.json', import.meta.url), 'utf8'),
    ) as unknown,
  );
}

function ownScheme(doc: JsonObject): JsonObject {
  expect(Array.isArray(doc['inbound']), 'inbound 必须是数组').toBe(true);
  const entries = doc['inbound'] as unknown[];
  // Only the confirmed own scheme can be registered by this task. No invented
  // SDK callback, path prefix, or claim of completed domain verification.
  expect(entries, '本轮只登记一项自有 scheme，深链与 SDK 回调继续待补').toHaveLength(1);
  const entry = object(entries[0]);
  expect(entry['kind']).toBe('custom_scheme');
  expect(entry['scheme']).toBe('couli');
  return entry;
}

// Frozen pre-task external targets: CT-17h must not change apps or sdk_queries.
const EXISTING_APPS = {
  taobao: {
    name: '淘宝',
    platform: 'taobao',
    status: 'candidate',
    trade_only: true,
    source:
      '规划/09 CAP-TB-11（taobao:// / tbopen:// scheme 为候选，以官方为准）；鸿蒙走百川 HarmonyOS SDK，见 CAP-X-04',
    ios: { query_schemes: ['taobao', 'tbopen'] },
    android: { packages: [] },
    harmony: { query_schemes: [] },
  },
  jd: {
    name: '京东',
    platform: 'jd',
    status: 'candidate',
    trade_only: true,
    source: '规划/09 CAP-JD-11（openApp.jdMobile scheme，无官方公开文档）',
    ios: { query_schemes: ['openApp.jdMobile'] },
    android: { packages: [] },
    harmony: { query_schemes: [] },
  },
  pdd: {
    name: '拼多多',
    platform: 'pdd',
    status: 'candidate',
    trade_only: true,
    source:
      '规划/09 CAP-PDD-11（schema_url 由转链返回，三端须静态声明要检测的 scheme，取值待实测）',
    ios: { query_schemes: [] },
    android: { packages: [] },
    harmony: { query_schemes: [] },
  },
};

it('[AC-CT-17h#1] couli 只作为三端自有入站 scheme 登记，字段闭合且不改外跳目标和 SDK 查询项', () => {
  const doc = contract();
  const entry = ownScheme(doc);
  expect(Object.keys(entry).sort()).toEqual([
    'kind',
    'platforms',
    'purpose',
    'scheme',
    'source_sdk',
  ]);
  expect(entry['source_sdk']).toBeNull();
  expect(typeof entry['purpose']).toBe('string');
  expect(String(entry['purpose']).trim().length).toBeGreaterThan(0);
  expect(Array.isArray(entry['platforms'])).toBe(true);
  expect([...(entry['platforms'] as unknown[])].sort()).toEqual(['android', 'harmony', 'ios']);
  expect(doc['apps']).toEqual(EXISTING_APPS);
  expect(doc['sdk_queries']).toEqual([]);
});

it('[AC-CT-17h#2] 注释记录已定深链主域和待补条件，不把未验证域名或未提供的 SDK 参数登记为可用', () => {
  const doc = contract();
  expect(typeof doc['$comment']).toBe('string');
  const comment = String(doc['$comment']);
  expect(comment).toContain('l.couliapp.com');
  expect(comment).toContain('Q-A5');
  expect(comment).toMatch(/Apple\s+Team\s+ID/i);
  expect(comment).toMatch(/Associated\s+Domains/i);
  expect(comment).toContain('Q-C9');
  expect(comment).toContain('N-04');
  expect(comment).toContain('Q-C12');
  expect(comment).toContain('CAP-TB-11');
  expect(comment).toMatch(/待|等|pending|await|wait/i);
  expect(comment).toMatch(/安卓|android/i);
  expect(comment).toMatch(/包名|package/i);
  expect(comment).toMatch(/鸿蒙|harmony/i);
  expect(comment).toMatch(/bundle/i);
  expect(comment).not.toMatch(/sdk_queries and inbound stay empty/i);
  // Also reject verified=true, verified=false, made-up path prefixes, or SDK
  // templates even when the accompanying comment correctly describes the wait.
  ownScheme(doc);
});

it('[AC-CT-17h#3] 生成物包含同一项 couli 入站登记且不是模板，不把它变成 ext.openApp 目标或 SDK 查询项', () => {
  // Assert the generated value first: stale [] must fail even if the source JSON
  // is already populated. The existing generator adds template=false.
  const generated: unknown = bridge.inbound;
  expect(Array.isArray(generated)).toBe(true);
  expect(generated).toHaveLength(1);
  const entry = ownScheme(contract());
  expect(generated).toEqual([{ ...entry, template: false }]);
  expect(Object.keys(bridge.apps).sort()).toEqual(['jd', 'pdd', 'taobao']);
  expect(bridge.sdkQueries).toEqual([]);
});
