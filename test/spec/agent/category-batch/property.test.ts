// B1-04zzzv (D10-946) property: for any round of candidates started together (two apps, three
// platforms, with or without a category, titles with or without keywords), any active rows of each
// app and any port outcome per app (kept, thrown, rejected), the port is called once per app with
// that app's candidates in the order they were started; with a working port every verdict equals
// the candidate judged alone (by the same assembly one at a time, and by catalog's rule function),
// with a failing one the app's whole batch is blocked and logs exactly one warn line (event,
// sorted distinct platforms, error name; no product value). The first example always has an app
// with several candidates. Synthetic values only.
// Run count (D10-750): PROP_RUNS scaled by 1/100 with a floor of 50; the seed is PROP_SEED. The
// production assembly, the port and the logger are built once (plain objects, no vi.fn per run,
// #2682) and reset at the start of every run.
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';
import { APP_A, APP_B, candidate, productionCategoryAllowed } from '../category-blocklist/kit.ts';
import {
  BLOCKLIST_EVENT,
  ERROR_NAME,
  ITEM_FIELDS,
  batchPort,
  judgedAlone,
  oneByOne,
  platformsOf,
  productValues,
  sent,
  together,
  warnFields,
  type Judgement,
} from './kit.ts';

afterEach(() => vi.restoreAllMocks());

const APPS = [APP_A, APP_B] as const;
const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;
const CATEGORIES = ['', '9300001', '9300002', '9300003'] as const;
const FRAGMENTS = ['合成禁词', 'a.b', 'axb'] as const;

const rule = fc.record({
  platform: fc.constantFrom(...PLATFORMS),
  categoryId: fc.constantFrom('9300001' as const, '9300002' as const),
  keyword: fc.constantFrom(null, '合成禁词' as const, 'a.b' as const),
});
const request = fc.record({
  app: fc.constantFrom(...APPS),
  platform: fc.constantFrom(...PLATFORMS),
  categoryId: fc.constantFrom(...CATEGORIES),
  fragments: fc.subarray([...FRAGMENTS]),
});
const outcome = fc.constantFrom('ok' as const, 'throw' as const, 'reject' as const);

const byPlatform = (left: Record<string, unknown>, right: Record<string, unknown>): number =>
  String(left['platform']) < String(right['platform']) ? -1 : 1;

it('[AC-B1-04zzzv#6] 任意一轮并发候选、任意名单与端口成败：每个应用恰一次端口调用且项依发起顺序；端口正常时结果逐一等于逐个判定与单独按规则判的结果，失败时该应用整批判禁且每批恰一条只含事件、平台、错误名的 warn', async () => {
  const catalog = batchPort();
  const { allowed, logs } = productionCategoryAllowed(catalog.port);
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(request, { minLength: 2, maxLength: 10 }),
      fc.array(rule, { maxLength: 4 }),
      fc.array(rule, { maxLength: 4 }),
      outcome,
      outcome,
      async (specs, rulesA, rulesB, outcomeA, outcomeB) => {
        catalog.calls.splice(0);
        catalog.failing.clear();
        catalog.rules.set(APP_A, rulesA);
        catalog.rules.set(APP_B, rulesB);
        const outcomes = new Map<string, 'ok' | 'throw' | 'reject'>([
          [APP_A, outcomeA],
          [APP_B, outcomeB],
        ]);
        if (outcomeA !== 'ok') catalog.failing.set(APP_A, outcomeA);
        if (outcomeB !== 'ok') catalog.failing.set(APP_B, outcomeB);
        logs.lines.splice(0);

        const requests = specs.map((spec, index): Judgement => [
          spec.app,
          candidate(`p${index}`, {
            platform: spec.platform,
            categoryId: spec.categoryId,
            title: [`合成商品 p${index}`, ...spec.fragments].join(' '),
          }),
        ]);
        const rowsOf = (app: string) =>
          requests.filter(([appId]) => appId === app).map(([, row]) => row);
        const apps = APPS.filter((app) => rowsOf(app).length > 0);

        const batched = await together(allowed, requests);

        // One call per app of the round, holding that app's candidates in the order started.
        expect(catalog.calls).toHaveLength(apps.length);
        for (const app of apps) {
          const rows = rowsOf(app);
          expect(catalog.calls.filter((call) => call.appId === app)).toEqual([
            { appId: app, fields: rows.map(() => ITEM_FIELDS), items: rows.map(sent) },
          ]);
        }

        // Verdicts: a working port judges each candidate as alone; a failing one blocks the batch.
        const expected = requests.map(
          ([appId, row]) =>
            outcomes.get(appId) === 'ok' && judgedAlone(appId === APP_A ? rulesA : rulesB, row),
        );
        expect(batched).toEqual(expected);

        // Exactly one warn line per failing batch, naming no product.
        const failing = apps.filter((app) => outcomes.get(app) !== 'ok');
        const warnings = logs.warnings();
        expect(warnings).toHaveLength(failing.length);
        expect(warnings.map((line) => warnFields(line)).sort(byPlatform)).toEqual(
          failing
            .map((app) => ({
              event: BLOCKLIST_EVENT,
              platform: platformsOf(rowsOf(app)),
              error_name: ERROR_NAME,
            }))
            .sort(byPlatform),
        );
        for (const line of warnings) {
          for (const [, row] of requests) {
            for (const value of productValues(row)) expect(line).not.toContain(value);
          }
        }

        // The same requests one at a time give the same verdicts.
        expect(await oneByOne(allowed, requests)).toEqual(batched);
        checked += 1;
        return true;
      },
    ),
    {
      numRuns: Math.max(50, Math.floor(propRuns() / 100)),
      seed: propSeed(),
      examples: [
        [
          [
            { app: APP_A, platform: 'taobao', categoryId: '9300001', fragments: [] },
            { app: APP_A, platform: 'taobao', categoryId: '', fragments: ['合成禁词'] },
            { app: APP_B, platform: 'jd', categoryId: '9300002', fragments: ['axb'] },
            { app: APP_A, platform: 'jd', categoryId: '9300001', fragments: ['a.b'] },
            { app: APP_B, platform: 'pdd', categoryId: '', fragments: [] },
          ],
          [
            { platform: 'taobao', categoryId: '9300001', keyword: null },
            { platform: 'taobao', categoryId: '9300002', keyword: '合成禁词' },
            { platform: 'jd', categoryId: '9300001', keyword: 'a.b' },
          ],
          [{ platform: 'jd', categoryId: '9300002', keyword: null }],
          'ok',
          'reject',
        ],
      ],
    },
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
