// B2-10a（BR-FUND-02 可入账事件）反向验证：用合成规格渲染出的生成模块替换入库的 creditable-events.gen.ts，
// isCreditablePlatform 照这份结果判定。只用合成数据；入库的规格与生成文件都不改。
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type * as Rules from '../../../../apps/api/src/modules/settlement/rebate/domain/rules.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { GEN_FILE, generatedExports, generatedValue, platformsOf, renderFixture } from './kit.ts';

/** Load a fresh rules.ts whose generated module is the rendered fixture, then run the checks. */
async function withRendered(source: string, check: (rules: typeof Rules) => void): Promise<void> {
  const exports = generatedExports(source);
  const genPath = fileURLToPath(GEN_FILE);
  vi.resetModules();
  vi.doMock(genPath, () => exports);
  try {
    const rules =
      await import('../../../../apps/api/src/modules/settlement/rebate/domain/rules.ts');
    check(rules);
  } finally {
    vi.doUnmock(genPath);
    vi.resetModules();
  }
}

// Synthetic specification only: the 08 values with meituan removed.
const WITHOUT_MEITUAN = `version: '9001'
platforms:
  - platform: taobao
    event: confirm_receipt
  - platform: jd
    event: confirm_receipt
  - platform: pdd
    event: confirm_receipt
`;

it('[AC-B2-10a#8] 反向验证：合成规格去掉 meituan 渲染，生成常量里没有 meituan；isCreditablePlatform 照这份常量判定 meituan 不再可入账，taobao、jd、pdd 照旧', async () => {
  const source = await renderFixture(WITHOUT_MEITUAN);
  const value = generatedValue(source);
  expect(value).toStrictEqual(parseYamlLite(WITHOUT_MEITUAN));
  expect(platformsOf(value).map((entry) => entry.platform)).not.toContain('meituan');
  await withRendered(source, (rules) => {
    expect(rules.isCreditablePlatform('meituan')).toBe(false);
    for (const name of ['taobao', 'jd', 'pdd']) {
      expect(rules.isCreditablePlatform(name), name).toBe(true);
    }
  });
});

// Synthetic specification only: not a 规划/09 result. It shows the list is read, not hard-coded.
const WITH_SYNTHETIC_VIP = `version: '9002'
platforms:
  - platform: vip
    event: confirm_receipt
  - platform: meituan
    event: complete_or_verify
`;

it('[AC-B2-10a#9] 反向验证：合成规格只登记 vip、meituan 渲染后，isCreditablePlatform 照这份常量判定 vip、meituan 可入账，taobao、jd、pdd 不再可入账', async () => {
  const source = await renderFixture(WITH_SYNTHETIC_VIP);
  expect(generatedValue(source)).toStrictEqual(parseYamlLite(WITH_SYNTHETIC_VIP));
  await withRendered(source, (rules) => {
    for (const name of ['vip', 'meituan']) {
      expect(rules.isCreditablePlatform(name), name).toBe(true);
    }
    for (const name of ['taobao', 'jd', 'pdd', 'douyin', 'eleme']) {
      expect(rules.isCreditablePlatform(name), name).toBe(false);
    }
  });
});
