// B3-08l · BR-AI-02 ① / BR-AI-07 T6 / BR-AI-03 on the production stream assembly
// (createProductionStreamAssembly over real PG through ../stream-assembly-orders/kit.ts, the same
// entry as [AC-B3-08g]). search_rules reads app.agent_rule_chunks' active rows of the caller's app
// (agent's own table) and agent.rag.min_score through content's configuration (default 0.2).
// Chunk rows are written directly here, as an earlier sync left them.
// 标题是 MVP 时 7 个的原文，按 D10-1234 断言已改为 8 个，标题待 FU-MODIFY-EXISTING-RETITLE 合并后更正。
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import {
  callTool,
  definitionNames,
  freshAppId,
  ordersFixture,
} from '../stream-assembly-orders/kit.ts';
import { allowlistNames, sameSet } from '../stream-assembly-orders/scan.ts';
import { newGuest, newMember, setConfig, usePgEach } from '../stream-mount/kit.ts';
import {
  ALL_AUDIENCE_TOOLS,
  MIN_SCORE,
  SEARCH_RULES_SWITCH,
  TOOLS,
  appIdOf,
  cardsIn,
  insertChunk,
  ruleRefCards,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** 问句（BR-AI-07 例「提现最低多少」）；字二元组 {提现, 现最, 最低, 低多, 多少}。 */
const QUESTION = '提现最低多少';
/** BR-AI-07 例「你们和别家比怎么样」：与本 app 任何 active 块都没有共同的字二元组。 */
const UNRELATED = '你们和别家比怎么样';

it('[AC-B3-08l#1][BR-AI-02] 生产流装配（与 [AC-B3-08g] 同一入口）注册的工具集合 = specs/agent-tools.allowlist 行集合（7 个，含 search_rules）；游客与未绑手机也见 search_rules（audience all）', async () => {
  const f = await ordersFixture(pg.db);
  await setConfig(pg.db, f.caller.appId, SEARCH_RULES_SWITCH, true);
  const assembly = f.build();
  const names = await definitionNames(assembly, f.caller);
  const allowlist = allowlistNames();

  expect([...names].sort()).toEqual([...TOOLS].sort());
  expect(names).toContain('search_rules');
  expect(new Set(names).size, 'no duplicate registration').toBe(names.length);
  expect(sameSet(names, allowlist)).toBe(true);

  const guest = await newGuest(pg.db);
  const unbound = await newMember(pg.db, { phoneBound: false });
  for (const subject of [guest, unbound]) {
    expect((await definitionNames(assembly, subject)).sort()).toEqual(
      [...ALL_AUDIENCE_TOOLS].sort(),
    );
  }
}, 120_000);

it.each(['false', 'missing'] as const)(
  '[AC-B3-08l#1][BR-AI-02] agent.tools.search_rules.enabled 为 %s → 不下发 search_rules、其余 6 个不变；改为 true 后重新装配 → 7 个',
  async (state) => {
    // 'missing': a phone-bound member of an app made up for this case (the key is never written).
    const caller =
      state === 'missing' ? await newMember(pg.db, { appId: freshAppId() }) : undefined;
    const f = await ordersFixture(pg.db, {
      ...(caller === undefined ? {} : { caller }),
      switches: { search_rules: state },
    });
    if (state === 'false') await setConfig(pg.db, f.caller.appId, SEARCH_RULES_SWITCH, false);
    const off = await definitionNames(f.build(), f.caller);
    expect(off.sort()).toEqual(TOOLS.filter((name) => name !== 'search_rules').sort());

    await setConfig(pg.db, f.caller.appId, SEARCH_RULES_SWITCH, true);
    const on = await definitionNames(f.build(), f.caller);
    expect(on.sort()).toEqual([...TOOLS].sort());
  },
  120_000,
);

it('[AC-B3-08l#2][BR-AI-03][BR-AI-07] 真库检索：只出本 app active 块的 rule_ref 卡（≤3 张、按得分降序、字段取自块）；本 app 退役块与他 app 块不出；他 app 用户只见他 app 的块；参数伪造 app → rejected', async () => {
  const f = await ordersFixture(pg.db);
  const appA = f.caller.appId;
  const appB = appIdOf('b');
  await setConfig(pg.db, appA, SEARCH_RULES_SWITCH, true);
  await setConfig(pg.db, appB, SEARCH_RULES_SWITCH, true);

  // Dice over character bigrams of title + text against QUESTION (BR-AI-07, D10-218):
  // 10/11, 6/12, 6/13, then 6/16 (a hit cut by the top-3 limit), then 0.
  const best = await insertChunk(pg.db, {
    appId: appA,
    title: '提现最低多少',
    text: '提现最低多少',
  });
  const second = await insertChunk(pg.db, {
    appId: appA,
    title: '最低多少',
    text: '起提金额',
  });
  const third = await insertChunk(pg.db, {
    appId: appA,
    title: '提现最低',
    text: '手续费说明',
  });
  const fourth = await insertChunk(pg.db, {
    appId: appA,
    title: '提现规则',
    text: '提现最低金额为一元',
  });
  const unrelated = await insertChunk(pg.db, {
    appId: appA,
    title: '账号注销',
    text: '注销后数据保留三十天',
  });
  const retired = await insertChunk(pg.db, {
    appId: appA,
    title: '提现最低多少',
    text: '提现最低多少（旧版）',
    status: 'retired',
  });
  const otherApp = await insertChunk(pg.db, {
    appId: appB,
    title: '提现最低多少',
    text: '提现最低多少',
  });

  const assembly = f.build();
  const cards = cardsIn(
    await callTool(assembly.tools, f.contextOf(f.caller), 'search_rules', { question: QUESTION }),
  );
  expect(cards).toEqual(ruleRefCards([best, second, third]));
  const shown = JSON.stringify(cards);
  for (const hidden of [fourth, unrelated, retired, otherApp]) {
    expect(shown).not.toContain(hidden.chunk_id);
  }

  // A user of app B: only app B's active chunk (the app comes from the server context).
  const memberB = await newMember(pg.db, { appId: appB });
  const fromB = cardsIn(
    await callTool(assembly.tools, f.contextOf(memberB), 'search_rules', { question: QUESTION }),
  );
  expect(fromB).toEqual(ruleRefCards([otherApp]));

  // BR-AI-03: an app in the arguments is refused by the registry, never searched with.
  for (const field of ['app_id', 'appId']) {
    const forged = await callTool(assembly.tools, f.contextOf(f.caller), 'search_rules', {
      question: QUESTION,
      [field]: appB,
    });
    expect(forged, field).toEqual({ kind: 'rejected', modelView: { error: 'invalid_args' } });
  }
}, 120_000);

it('[AC-B3-08l#2][BR-AI-07] 无命中（问句与本 app 任何 active 块都无共同二元组；只有退役块或他 app 块能匹配）→ 恰 1 张 handoff 卡、无 rule_ref', async () => {
  const f = await ordersFixture(pg.db);
  const appA = f.caller.appId;
  await setConfig(pg.db, appA, SEARCH_RULES_SWITCH, true);
  await insertChunk(pg.db, { appId: appA, title: '提现规则', text: '提现最低金额为一元' });
  await insertChunk(pg.db, { appId: appA, title: UNRELATED, text: UNRELATED, status: 'retired' });
  await insertChunk(pg.db, { appId: appIdOf('b'), title: UNRELATED, text: UNRELATED });

  const outcome = await callTool(f.build().tools, f.contextOf(f.caller), 'search_rules', {
    question: UNRELATED,
  });
  expect(cardsIn(outcome).map((card) => card.type)).toEqual(['handoff']);
}, 120_000);

it('[AC-B3-08l#3][BR-AI-07] agent.rag.min_score 未配置 → 按默认 0.2（得分恰 0.2 的块命中、2/11 的块不命中）；经 content 配置改成 0.1 → 两块都命中', async () => {
  const f = await ordersFixture(pg.db);
  const appA = f.caller.appId;
  await setConfig(pg.db, appA, SEARCH_RULES_SWITCH, true);
  // Question 'abcd' has 3 bigrams; 'ab'+'xyzuvw' has 7 sharing 1 → 2/10; 'ab'+'xyzuvwx' 8 → 2/11.
  const equal = await insertChunk(pg.db, { appId: appA, title: 'ab', text: 'xyzuvw' });
  const below = await insertChunk(pg.db, { appId: appA, title: 'ab', text: 'xyzuvwx' });

  const unset = cardsIn(
    await callTool(f.build().tools, f.contextOf(f.caller), 'search_rules', { question: 'abcd' }),
  );
  expect(unset).toEqual(ruleRefCards([equal]));

  await setConfig(pg.db, appA, MIN_SCORE, 0.1);
  const lowered = cardsIn(
    await callTool(f.build().tools, f.contextOf(f.caller), 'search_rules', { question: 'abcd' }),
  );
  expect(lowered).toEqual(ruleRefCards([equal, below]));
}, 120_000);

it('[AC-B3-08l#3][BR-AI-07] agent.rag.min_score 经 content 配置为 0.9 → 原本命中的问句变为无命中（handoff 卡）', async () => {
  const f = await ordersFixture(pg.db);
  const appA = f.caller.appId;
  await setConfig(pg.db, appA, SEARCH_RULES_SWITCH, true);
  // 6/16 against QUESTION: a hit at the default 0.2.
  const row = await insertChunk(pg.db, {
    appId: appA,
    title: '提现规则',
    text: '提现最低金额为一元',
  });

  const before = cardsIn(
    await callTool(f.build().tools, f.contextOf(f.caller), 'search_rules', { question: QUESTION }),
  );
  expect(before).toEqual(ruleRefCards([row]));

  await setConfig(pg.db, appA, MIN_SCORE, 0.9);
  const after = cardsIn(
    await callTool(f.build().tools, f.contextOf(f.caller), 'search_rules', { question: QUESTION }),
  );
  expect(after.map((card) => card.type)).toEqual(['handoff']);
}, 120_000);
