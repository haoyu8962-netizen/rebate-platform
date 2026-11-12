// B2-10a（BR-FUND-02 可入账事件）：规格取值、生成物与生成器的结构校验。不连库。
import { expect, it } from 'vitest';
import { creditableEventsSource } from '../../../../apps/api/src/modules/settlement/specs/scripts/generate-creditable-events.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  EXPECTED_EVENTS,
  P1_PLATFORMS,
  SPEC_FILE,
  generatedValue,
  platformsOf,
  readGenerated,
  readSpec,
  readSpecText,
  renderError,
  renderFixture,
} from './kit.ts';

it('[AC-B2-10a#1] specs/creditable-events.yaml 与 08 BR-FUND-02 一致：恰好 taobao、jd、pdd = confirm_receipt，meituan = complete_or_verify；P1 vip、douyin、eleme 不登记', async () => {
  const text = await readSpecText();
  // 文件注释引 08 原文的出处。
  expect(text).toContain('BR-FUND-02');
  const entries = platformsOf(await readSpec());
  expect(entries).toHaveLength(4);
  const platforms = entries.map((entry) => entry.platform);
  expect(new Set(platforms).size).toBe(platforms.length);
  expect(Object.fromEntries(entries.map((entry) => [entry.platform, entry.event]))).toStrictEqual(
    EXPECTED_EVENTS,
  );
  for (const p1 of P1_PLATFORMS) expect(platforms, p1).not.toContain(p1);
});

it('[AC-B2-10a#2] creditable-events.gen.ts 已入库，CREDITABLE_EVENTS 与 YAML 全量一致（版本、字段、顺序），缺失或漂移必须失败', async () => {
  const value = generatedValue(await readGenerated());
  expect(value).toStrictEqual(await readSpec());
});

it('[AC-B2-10a#3] 由入库规格重新生成的文本与已入库的 creditable-events.gen.ts 逐字一致', async () => {
  const checkedIn = await readGenerated();
  expect(await creditableEventsSource(SPEC_FILE)).toBe(checkedIn);
});

// Synthetic specification only: not a platform sample and not a production rule.
const ORDERED_YAML = `# synthetic fixture
version: '0042'
platforms:
  - platform: meituan
    event: complete_or_verify
  - platform: pdd
    event: confirm_receipt
  - platform: taobao
    event: confirm_receipt
`;

it('[AC-B2-10a#4] 合成规格渲染后 CREDITABLE_EVENTS 保留版本字符串、全部字段与平台顺序', async () => {
  const source = await renderFixture(ORDERED_YAML);
  expect(generatedValue(source)).toStrictEqual(parseYamlLite(ORDERED_YAML));
});

const VALID_YAML = `version: '0001'
platforms:
  - platform: taobao
    event: confirm_receipt
  - platform: meituan
    event: complete_or_verify
`;

const INVALID: ReadonlyArray<readonly [string, string]> = [
  [
    'event 不在两种取值内',
    `version: '0001'
platforms:
  - platform: taobao
    event: settled
`,
  ],
  [
    'event 大小写不符',
    `version: '0001'
platforms:
  - platform: taobao
    event: CONFIRM_RECEIPT
`,
  ],
  [
    '缺 event',
    `version: '0001'
platforms:
  - platform: taobao
`,
  ],
  [
    '缺 platform',
    `version: '0001'
platforms:
  - event: confirm_receipt
`,
  ],
  [
    'platform 不是字符串',
    `version: '0001'
platforms:
  - platform: 7
    event: confirm_receipt
`,
  ],
  [
    '平台重复（同一事件）',
    `version: '0001'
platforms:
  - platform: jd
    event: confirm_receipt
  - platform: jd
    event: confirm_receipt
`,
  ],
  [
    '平台重复（不同事件）',
    `version: '0001'
platforms:
  - platform: meituan
    event: complete_or_verify
  - platform: meituan
    event: confirm_receipt
`,
  ],
  [
    '缺 version',
    `platforms:
  - platform: taobao
    event: confirm_receipt
`,
  ],
  [
    '缺 platforms',
    `version: '0001'
`,
  ],
  [
    'platforms 不是列表',
    `version: '0001'
platforms:
  taobao: confirm_receipt
`,
  ],
];

it('[AC-B2-10a#5] 结构不合法（event 取值不合法、缺 platform / event / version / platforms、平台重复）渲染失败，合法规格照常渲染', async () => {
  // Positive control first: a refusal only counts when a valid specification renders.
  expect(generatedValue(await renderFixture(VALID_YAML))).toStrictEqual(parseYamlLite(VALID_YAML));
  for (const [label, yaml] of INVALID) {
    const error = await renderError(yaml);
    expect(error, label).toBeInstanceOf(Error);
    expect((error as Error).message, label).not.toMatch(/NotImplemented/);
  }
});
