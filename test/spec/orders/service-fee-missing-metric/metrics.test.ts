// B1-08zy（FU-TB-FEE-MISSING-METRIC，编排 D10-741 ⑤、D10-992 ①选 (a)）：/metrics 新增进程内计数器
// couli_service_fee_missing_total，只带一个标签 platform（pdd / taobao），不带金额、单号。
// 测试第 2 轮（编排 D10-1003）：照标准带标签计数器，计过一次才出该平台的序列，从未计过的平台不出序列
// （冻结的 [AC-B1-01zzh#5] 要求 worker /metrics 不留 platform="pdd" 的旧序列）。
// 测试第 4 轮（编排 D10-1051）：冻结的 [AC-B1-25b#8] 要求告警引用的指标启动即有样本行，故启动即导出
// {platform="taobao"} 0；pdd 仍是计过才出（[AC-B1-01zzh#5] 不变）。
import { expect, it, vi } from 'vitest';
import {
  countServiceFeeMissing,
  createMetricsRegistry,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';

const METRIC = 'couli_service_fee_missing_total';
const PLATFORMS = ['pdd', 'taobao'] as const;

interface Sample {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/** {a="x",b="y"} → { a: 'x', b: 'y' }；只认这个指标的写法（值里没有逗号和引号）。 */
function parseLabels(text: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (text === undefined) return labels;
  for (const pair of text.slice(1, -1).split(',')) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)="(.*)"$/.exec(pair.trim());
    expect(match, `label pair ${pair}`).not.toBeNull();
    labels[match![1]!] = match![2]!;
  }
  return labels;
}

/** /metrics 文本里这个指标的样本行；没有样本为空数组。 */
function samples(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    const match = /^couli_service_fee_missing_total(\{.*\})? (\S+)$/.exec(line);
    if (match !== null) out.push({ labels: parseLabels(match[1]), value: Number(match[2]) });
  }
  return out;
}

/** platform → 值；两个平台的序列都必须在，各只有一条。 */
function byPlatform(text: string): Record<(typeof PLATFORMS)[number], number> {
  const all = samples(text);
  const values = Object.fromEntries(
    PLATFORMS.map((platform) => {
      const found = all.filter((sample) => sample.labels['platform'] === platform);
      expect(found, `${METRIC}{platform="${platform}"} 恰有一条`).toHaveLength(1);
      return [platform, found[0]!.value];
    }),
  );
  return values as Record<(typeof PLATFORMS)[number], number>;
}

/** 样本按 platform 排序，便于整表比较。 */
function sortedSamples(text: string): Sample[] {
  return samples(text).sort((a, b) =>
    (a.labels['platform'] ?? '').localeCompare(b.labels['platform'] ?? ''),
  );
}

it('[AC-B1-08zy#1] /metrics 的 couli_service_fee_missing_total 是 counter：未计数时只有 platform="taobao" 一条且值 0、没有 platform="pdd" 序列；计 pdd 后出现 pdd=1、taobao 仍 0；再计 taobao 后 taobao=1，只带 platform 一个标签', async () => {
  // 重新加载模块，等于新进程：计数从零开始，不受本文件其他用例的计数影响。
  vi.resetModules();
  const fresh = await import('../../../../apps/api/src/modules/platform/metrics/index.ts');
  const registry = fresh.createMetricsRegistry({ entry: 'worker' });

  // 启动即有 taobao 样本行（D10-1051，[AC-B1-25b#8]）；pdd 未计过不出（[AC-B1-01zzh#5]）。
  const before = await registry.render();
  expect(before).toContain(`# TYPE ${METRIC} counter`);
  expect(before).toMatch(new RegExp(`^# HELP ${METRIC} \\S`, 'm'));
  expect(samples(before)).toEqual([{ labels: { platform: 'taobao' }, value: 0 }]);

  fresh.countServiceFeeMissing('pdd');
  expect(sortedSamples(await registry.render())).toEqual([
    { labels: { platform: 'pdd' }, value: 1 },
    { labels: { platform: 'taobao' }, value: 0 },
  ]);

  fresh.countServiceFeeMissing('taobao');
  expect(sortedSamples(await registry.render())).toEqual([
    { labels: { platform: 'pdd' }, value: 1 },
    { labels: { platform: 'taobao' }, value: 1 },
  ]);
});

it('[AC-B1-08zy#2] 按平台计数：计 pdd 只有 pdd 序列 +1，计 taobao 只有 taobao 序列 +1，每次 +1', async () => {
  const registry = createMetricsRegistry({ entry: 'worker' });
  // 两个平台先各计一次，序列都出来后再比增量（计过才有序列，见 #1）。
  countServiceFeeMissing('pdd');
  countServiceFeeMissing('taobao');
  const start = byPlatform(await registry.render());

  countServiceFeeMissing('pdd');
  expect(byPlatform(await registry.render())).toEqual({ pdd: start.pdd + 1, taobao: start.taobao });

  countServiceFeeMissing('taobao');
  countServiceFeeMissing('taobao');
  expect(byPlatform(await registry.render())).toEqual({
    pdd: start.pdd + 1,
    taobao: start.taobao + 2,
  });

  countServiceFeeMissing('pdd');
  expect(byPlatform(await registry.render())).toEqual({
    pdd: start.pdd + 2,
    taobao: start.taobao + 2,
  });
});

it('[AC-B1-08zy#3][BR-ID-33] 计数之后标签里仍只有 platform（pdd / taobao）：没有金额、订单号、商品，标签值不是数字', async () => {
  const registry = createMetricsRegistry({ entry: 'worker' });
  countServiceFeeMissing('pdd');
  countServiceFeeMissing('taobao');
  const all = samples(await registry.render());
  expect(all.length).toBeGreaterThan(0);
  for (const sample of all) {
    expect(Object.keys(sample.labels)).toEqual(['platform']);
    expect(['pdd', 'taobao']).toContain(sample.labels['platform']);
    for (const [name, value] of Object.entries(sample.labels)) {
      expect(name).not.toMatch(/fen|amount|commission|fee|order|goods|item|sku|shop/i);
      expect(value).not.toMatch(/^[-\d.]+$/);
    }
  }
});
