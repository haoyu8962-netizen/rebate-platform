import { posix } from 'node:path';
import { expect, it } from 'vitest';
import { asset, list, record, string } from '../../infra/staging/kit.ts';
import { durationMs, ENTRIES, yaml } from '../alerting-eval/kit.ts';

const MONITORING = 'infra/monitoring';

function flag(file: string, name: string): string {
  const prefix = `-${name}=`;
  const values = asset(`${MONITORING}/scrape/${file}`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  expect(values, `${file} -${name}`).toHaveLength(1);
  expect(values[0], `${file} -${name}`).not.toBe('');
  return values[0]!;
}

it('[AC-B1-25d#9] 使用独立队列目录的 vmagent 为宕机组提供两个 exporter 的抓取状态', () => {
  const appAgent = 'vmagent.args';
  const exporterAgent = 'vmagent-exporters.args';
  const queuePath = 'remoteWrite.tmpDataPath';
  const appQueue = flag(appAgent, queuePath);
  const exporterQueue = flag(exporterAgent, queuePath);
  expect(posix.isAbsolute(appQueue)).toBe(true);
  expect(posix.isAbsolute(exporterQueue)).toBe(true);
  expect(posix.resolve(exporterQueue)).not.toBe(posix.resolve(appQueue));

  const scrapeConfig = 'promscrape.config';
  expect(posix.basename(flag(appAgent, scrapeConfig))).toBe('couli.yml');
  const exporterConfig = posix.basename(flag(exporterAgent, scrapeConfig));
  expect(exporterConfig).toBe('exporters.yml');
  const jobs = list(yaml(`${MONITORING}/scrape/${exporterConfig}`)['scrape_configs']).map((job) =>
    string(record(job)['job_name']),
  );
  expect(jobs.sort()).toEqual(['couli-pg', 'couli-redis']);

  const groups = list(yaml(`${MONITORING}/rules/outage.yaml`)['groups']).map(record);
  const outageGroups = groups.filter((group) => group['name'] === 'couli-outage');
  expect(outageGroups).toHaveLength(1);
  const expected = [...ENTRIES.map((entry) => `couli-${entry}`), ...jobs].sort();
  const monitored = new Set<string>();
  for (const rule of list(outageGroups[0]!['rules']).map(record)) {
    const expression = string(rule['expr']).trim();
    if (!/^up\b/.test(expression)) continue;
    const match = /^up\s*\{\s*job\s*(=~|=)\s*"([^"]+)"\s*\}\s*==\s*0$/.exec(expression);
    expect(match, expression).not.toBeNull();
    const selected = match?.[1] === '=~' ? (match[2] ?? '').split('|') : [match?.[2] ?? ''];
    for (const name of selected) {
      expect(expected, expression).toContain(name);
      monitored.add(name);
    }
    const labels = record(rule['labels']);
    expect(durationMs(rule['for'])).toBe(120_000);
    expect(labels['severity']).toBe('critical');
    expect(labels['fund']).not.toBe('true');
    if (selected.some((name) => jobs.includes(name))) {
      const summary = string(record(rule['annotations'])['summary']);
      expect(summary).toMatch(/exporter/i);
      expect(summary).toMatch(/抓取失败|抓不到|抓取不到|无法抓取|采集失败|无法采集/);
    }
  }
  expect([...monitored].sort()).toEqual(expected);
});
