// B3-08g · BR-AI-01 / BR-AI-02 ① ② on the production stream assembly (createProductionStreamAssembly
// over real PG; product and order ports are stand-ins). Registered = the definitions a phone-bound
// user gets with every switch on; offered = registered ∩ switched on ∩ allowed for the subject.
// 标题是 MVP 时 7 个的原文，按 D10-1234 断言已改为 8 个，标题待 FU-MODIFY-EXISTING-RETITLE 合并后更正。
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { newGuest, newMember, usePgEach } from '../stream-mount/kit.ts';
import {
  APP,
  callTool,
  cardsOf,
  definitionNames,
  freshAppId,
  hasConfigRow,
  ordersFixture,
  type SwitchState,
} from './kit.ts';
import {
  DENYLIST,
  EXPECTED_TOOLS,
  NEVER_OFFERED,
  NEW_TOOLS,
  REGISTRY_DIR,
  ROOT,
  allowlistNames,
  allowlistText,
  definitionStrings,
  filesUnder,
  sameSet,
  switchKey,
} from './scan.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const PRODUCT_TOOLS = ['search_products', 'get_rebate_quote'];

it('[AC-B3-08g#1][BR-AI-02] 生产装配注册的工具集合与 specs/agent-tools.allowlist 行集合精确相等（7 个），无重复；含 search_rules；不含 get_my_earnings 与内部步骤、意图', async () => {
  const f = await ordersFixture(pg.db);
  const assembly = f.build();
  const names = await definitionNames(assembly, f.caller);
  const allowlist = allowlistNames();

  expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
  expect([...allowlist].sort()).toEqual([...EXPECTED_TOOLS].sort());
  expect(new Set(names).size, 'no duplicate registration').toBe(names.length);
  expect(new Set(allowlist).size, 'no duplicate allowlist line').toBe(allowlist.length);
  expect(sameSet(names, allowlist)).toBe(true);
  for (const name of NEVER_OFFERED) {
    expect(names, name).not.toContain(name);
    expect(allowlist, name).not.toContain(name);
  }
  // The comparison itself: one more or one less on either side is a failure.
  expect(sameSet([...names, 'get_balance'], allowlist)).toBe(false);
  expect(sameSet(names.slice(1), allowlist)).toBe(false);
  expect(sameSet(names, [...allowlist, 'search_rules'])).toBe(false);
  expect(sameSet(names, allowlist.slice(0, -1))).toBe(false);
  expect(sameSet([...names, names[0]!], [...allowlist, allowlist[0]!])).toBe(false);
}, 120_000);

it('[AC-B3-08g#2][BR-AI-02] denylist 两处扫描均不命中：(a) tools/registry/** 全部源码与 allowlist 文件；(b) 全开关、已绑手机主体下发的全部定义（名称、description、递归 schema）', async () => {
  // (a) Source: every file of the registry directory and the allowlist file (which lists the eight).
  expect([...allowlistNames()].sort()).toEqual([...EXPECTED_TOOLS].sort());
  const sources = filesUnder(REGISTRY_DIR);
  expect(sources.length).toBeGreaterThan(0);
  for (const path of sources) {
    expect(readFileSync(path, 'utf8'), relative(ROOT, path)).not.toMatch(DENYLIST);
  }
  expect(allowlistText()).not.toMatch(DENYLIST);

  // (b) Assembled definitions, every switch on, phone-bound subject: the full set the model can get.
  const f = await ordersFixture(pg.db);
  const definitions = await f.build().tools.definitions(APP, f.caller);
  expect(definitions.map((d) => d.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  for (const definition of definitions) {
    expect(definition.name).not.toMatch(DENYLIST);
    expect(definition.description, definition.name).not.toMatch(DENYLIST);
    const strings = definitionStrings(definition);
    expect(strings, definition.name).toEqual(expect.arrayContaining([definition.name]));
    for (const text of strings) expect(text, definition.name).not.toMatch(DENYLIST);
    expect(JSON.stringify(definition), definition.name).not.toMatch(DENYLIST);
  }
  // The scan reaches nested property names, enum values and descriptions.
  const probe = {
    name: 'synthetic_probe',
    description: '合成',
    parameters: {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/hidden' },
        b: { type: 'string', enum: ['ok', 'Payout_Account'] },
      },
      $defs: { hidden: { type: 'object', properties: { my_balance: { type: 'string' } } } },
    },
  };
  const probed = definitionStrings(probe);
  expect(probed).toEqual(expect.arrayContaining(['my_balance', 'Payout_Account']));
  expect(probed.filter((text) => DENYLIST.test(text)).length).toBeGreaterThan(0);
}, 120_000);

it('[AC-B3-08g#3][BR-AI-01][BR-AI-02] 下发 = 注册 ∩ 开启 ∩ 主体：游客与未绑手机只见 handoff_to_human、search_rules 与商品两工具，已绑手机见全部 7 个；对未绑主体直接调用订单类工具 → rejected 且不触达任何订单端口', async () => {
  const f = await ordersFixture(pg.db);
  const guest = await newGuest(pg.db);
  const unbound = await newMember(pg.db, { phoneBound: false });
  const assembly = f.build();

  expect((await definitionNames(assembly, f.caller)).sort()).toEqual([...EXPECTED_TOOLS].sort());
  for (const subject of [guest, unbound]) {
    // B3-08l (D10-327 / D10-808 (b)): search_rules is audience all, so guests and unbound users see
    // it too.
    expect((await definitionNames(assembly, subject)).sort()).toEqual(
      [...PRODUCT_TOOLS, 'handoff_to_human', 'search_rules'].sort(),
    );
  }

  // handoff_to_human is for everyone: a guest gets exactly the one handoff card.
  const handoff = await callTool(assembly.tools, f.contextOf(guest), 'handoff_to_human', {});
  expect(cardsOf(handoff).map((card) => card.type)).toEqual(['handoff']);

  const calls: readonly (readonly [string, Record<string, unknown>])[] = [
    ['list_my_orders', { date_from: '2026-10-01', date_to: '2026-10-06' }],
    ['explain_order', { order_no: '3900112233445566778', platform: 'taobao' }],
    ['explain_order', { card_id: 'c1' }],
    ['prefill_claim', { platform: 'taobao', order_no: '3900112233445566778' }],
  ];
  for (const subject of [guest, unbound]) {
    for (const [name, args] of calls) {
      const outcome = await callTool(assembly.tools, f.contextOf(subject), name, args);
      expect(outcome, `${name} ${String(subject.userId)}`).toEqual({
        kind: 'rejected',
        modelView: { error: 'invalid_args' },
      });
    }
  }
  expect(f.orderPortCalls(), 'no order port reached for a refused subject').toBe(0);
}, 120_000);

type OffState = Exclude<SwitchState, 'on'>;
const STATES: readonly OffState[] = ['false', 'missing', 'string', 'throws'];
const SWITCH_CASES: [string, OffState][] = NEW_TOOLS.flatMap((tool) =>
  STATES.map((state): [string, OffState] => [tool, state]),
);

it.each(SWITCH_CASES)(
  '[AC-B3-08g#3][BR-AI-02] 开关 agent.tools.%s.enabled 为 %s（false / 缺失 / 非布尔 / 读取抛错）→ 已绑手机主体只少这一个工具',
  async (tool, state) => {
    // 'missing': a phone-bound member of an app made up for this case, where the key is never
    // written (no config_items row is deleted; couli_app has no DELETE on it).
    const caller =
      state === 'missing' ? await newMember(pg.db, { appId: freshAppId() }) : undefined;
    const f = await ordersFixture(pg.db, {
      ...(caller === undefined ? {} : { caller }),
      switches: { [tool]: state },
    });
    if (state === 'missing') {
      const written = await hasConfigRow(pg.db, f.caller.appId, switchKey(tool));
      expect(written, 'key never written').toBe(false);
    }
    const names = await definitionNames(f.build(), f.caller);
    expect(names.sort()).toEqual(EXPECTED_TOOLS.filter((name) => name !== tool).sort());
  },
  120_000,
);
