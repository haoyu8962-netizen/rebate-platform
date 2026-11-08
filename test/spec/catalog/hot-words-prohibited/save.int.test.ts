// B1-04zzzzb (FU-ADMIN-HOTWORDS-PROHIBITED-CHECK, D10-1064 / D10-1070): saving search.hot_words or
// search.keyword_routes through the configuration center is refused when a text / keyword hits the
// prohibited group of specs/agent-input-keywords.yaml (BR-AI-18 matching: NFKC, lower case, every
// whitespace removed, substring; a hit right after 「非」 does not count). Only new saves are
// stopped: rows already stored keep being served and can be replaced. Every test starts with a
// refusal, which is what the check under test adds. The word-by-word table is refusals.test.ts.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { current, putRow, rejected, setup, snapshot } from '../../content/config-items/kit.ts';
import {
  HOT_WORDS,
  KEYWORD_ROUTES,
  UNION_HOST_BLOCK,
  shortcut,
  validHotWords,
  validRoutes,
} from '../hot-words/kit.ts';
import {
  expectNothingSaved,
  fieldsOf,
  readerAppId,
  refusedBatch,
  saveBatch,
  saveOne,
  saved,
  servedLists,
  type Write,
} from './harness.ts';

const h = useHarness();

const HOT_RANK = { route: 'HotRankList', params: {} };
const OTHER_ITEM = 'payout.definite_fail_codes';
const OTHER_VALUE = [{ text: '' }];
const IDEO_SPACE = String.fromCodePoint(0x3000);

it('[AC-B1-04zzzzb#1] search.hot_words 含禁词 text → 批量 20001 fields=[search.hot_words]、单条 20001 [value]，旧值不变、无成功审计；库里已有含禁词的旧值读接口仍原样返回', async () => {
  const f = await setup(h);
  const old = [{ text: '洗衣液' }];
  await putRow(h, f.appId, HOT_WORDS, old, 1);
  const before = await snapshot(h, f.appId);
  const banned = [...validHotWords(), { text: '彩票' }];
  await refusedBatch(await saveBatch(f, [{ key: HOT_WORDS, value: banned, expected_version: 1 }]), [
    HOT_WORDS,
  ]);
  await rejected(await saveOne(f, HOT_WORDS, banned, 1), 'update', 20001, { fields: ['value'] });
  await expectNothingSaved(h, f, before);
  expect(await current(h, f.appId, HOT_WORDS)).toMatchObject({ value: old, version: 1 });

  const legacy = readerAppId();
  const stored = [{ text: '彩票' }, { text: '洗衣液' }];
  await putRow(h, legacy, HOT_WORDS, stored);
  expect(await servedLists(h, legacy)).toEqual({ hot_words: stored, keyword_routes: [] });
});

it('[AC-B1-04zzzzb#2] search.keyword_routes 含禁词 keyword → 批量 20001 fields=[search.keyword_routes]、单条 20001 [value]，旧值不变、无成功审计；库里已有含禁词的直达读接口仍原样返回', async () => {
  const f = await setup(h);
  const old = [shortcut('热销榜', HOT_RANK)];
  await putRow(h, f.appId, KEYWORD_ROUTES, old, 1);
  const before = await snapshot(h, f.appId);
  const banned = [...validRoutes(), shortcut('电子烟', HOT_RANK)];
  await refusedBatch(
    await saveBatch(f, [{ key: KEYWORD_ROUTES, value: banned, expected_version: 1 }]),
    [KEYWORD_ROUTES],
  );
  await rejected(await saveOne(f, KEYWORD_ROUTES, banned, 1), 'update', 20001, {
    fields: ['value'],
  });
  await expectNothingSaved(h, f, before);
  expect(await current(h, f.appId, KEYWORD_ROUTES)).toMatchObject({ value: old, version: 1 });

  const legacy = readerAppId();
  const stored = [shortcut('电子烟', HOT_RANK), shortcut('热销榜', HOT_RANK)];
  await putRow(h, legacy, KEYWORD_ROUTES, stored);
  expect(await servedLists(h, legacy)).toEqual({ hot_words: [], keyword_routes: stored });
});

it('[AC-B1-04zzzzb#3] 夹空白、全角、大小写混写、禁词在词中间，两个键都拦，都不写入', async () => {
  const f = await setup(h);
  const spellings = [
    '彩 票',
    '彩\t票',
    `彩${IDEO_SPACE}票`,
    'ＵＳＤＴ',
    'UsDt',
    '买彩票送券',
    '手机壳ＵＳＤＴ款',
  ];
  for (const spelling of spellings) {
    const response = await saveBatch(f, [
      { key: HOT_WORDS, value: [{ text: spelling }], expected_version: 0 },
      { key: KEYWORD_ROUTES, value: [shortcut(spelling, HOT_RANK)], expected_version: 0 },
    ]);
    await refusedBatch(response, [HOT_WORDS, KEYWORD_ROUTES]);
  }
  expect(await current(h, f.appId, HOT_WORDS)).toBeUndefined();
  expect(await current(h, f.appId, KEYWORD_ROUTES)).toBeUndefined();
});

it('[AC-B1-04zzzzb#4] 「处方药」被拒，「非处方药」放行、能保存（「非」后的命中不算）', async () => {
  const f = await setup(h);
  await refusedBatch(
    await saveBatch(f, [{ key: HOT_WORDS, value: [{ text: '处方药' }], expected_version: 0 }]),
    [HOT_WORDS],
  );
  await refusedBatch(
    await saveBatch(f, [
      { key: KEYWORD_ROUTES, value: [shortcut('处方药', HOT_RANK)], expected_version: 0 },
    ]),
    [KEYWORD_ROUTES],
  );
  await saved(f, HOT_WORDS, [{ text: '非处方药' }], 0);
  await saved(f, KEYWORD_ROUTES, [shortcut('非处方药', HOT_RANK)], 0);
});

it('[AC-B1-04zzzzb#5] 混了禁词的列表被拒；去掉禁词后同一列表照常保存', async () => {
  const f = await setup(h);
  await refusedBatch(
    await saveBatch(f, [
      { key: HOT_WORDS, value: [...validHotWords(), { text: '弹药' }], expected_version: 0 },
    ]),
    [HOT_WORDS],
  );
  await saved(f, HOT_WORDS, validHotWords(), 0);
  await refusedBatch(
    await saveBatch(f, [
      {
        key: KEYWORD_ROUTES,
        value: [...validRoutes(), shortcut('匕首', HOT_RANK)],
        expected_version: 0,
      },
    ]),
    [KEYWORD_ROUTES],
  );
  await saved(f, KEYWORD_ROUTES, validRoutes(), 0);
});

type Mixed = [label: string, writes: Write[], refused: string[]];

const MIXED: Mixed[] = [
  [
    '热词有禁词，直达与别的键合法',
    [
      { key: HOT_WORDS, value: [{ text: '香烟' }], expected_version: 0 },
      { key: KEYWORD_ROUTES, value: validRoutes(), expected_version: 0 },
      { key: OTHER_ITEM, value: OTHER_VALUE, expected_version: 0 },
    ],
    [HOT_WORDS],
  ],
  [
    '直达有禁词，热词与别的键合法',
    [
      { key: HOT_WORDS, value: validHotWords(), expected_version: 0 },
      { key: KEYWORD_ROUTES, value: [shortcut('香烟', HOT_RANK)], expected_version: 0 },
      { key: OTHER_ITEM, value: OTHER_VALUE, expected_version: 0 },
    ],
    [KEYWORD_ROUTES],
  ],
  [
    '两个键都有禁词',
    [
      { key: HOT_WORDS, value: [{ text: '香烟' }], expected_version: 0 },
      { key: KEYWORD_ROUTES, value: [shortcut('雪茄', HOT_RANK)], expected_version: 0 },
    ],
    [HOT_WORDS, KEYWORD_ROUTES],
  ],
];

it.each(MIXED)(
  '[AC-B1-04zzzzb#6] 一次写入混合（%s）：20001，禁词键在 fields 里且没保存',
  async (_label, writes, refused) => {
    const f = await setup(h);
    const response = await saveBatch(f, writes);
    await rejected(response, 'batch', 20001);
    const fields = fieldsOf(response);
    expect(fields).toEqual(expect.arrayContaining(refused));
    for (const name of refused) expect(await current(h, f.appId, name)).toBeUndefined();
  },
);

it('[AC-B1-04zzzzb#7] 只拦新保存：原样重存旧的禁词被拒；旧值含禁词时写别的键、换成干净列表都照常成功', async () => {
  const f = await setup(h);
  const words = [{ text: '彩票' }];
  const routes = [shortcut('彩票', HOT_RANK)];
  await putRow(h, f.appId, HOT_WORDS, words, 1);
  await putRow(h, f.appId, KEYWORD_ROUTES, routes, 1);
  await refusedBatch(await saveBatch(f, [{ key: HOT_WORDS, value: words, expected_version: 1 }]), [
    HOT_WORDS,
  ]);
  await refusedBatch(
    await saveBatch(f, [{ key: KEYWORD_ROUTES, value: routes, expected_version: 1 }]),
    [KEYWORD_ROUTES],
  );
  await saved(f, UNION_HOST_BLOCK, false, 0);
  await saved(f, HOT_WORDS, validHotWords(), 1);
  await saved(f, KEYWORD_ROUTES, validRoutes(), 1);
});
