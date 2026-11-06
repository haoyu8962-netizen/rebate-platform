import { expect, it } from 'vitest';
import { list, record, string } from '../../infra/staging/kit.ts';
import { ENTRIES, metricsPort, scrapeJobs } from './kit.ts';

it('[AC-B1-25b#1] 专用抓取配置恰有 api、worker、admin，各只抓对应 METRICS_PORT 的回环 /metrics', () => {
  const jobs = scrapeJobs();
  for (const entry of ENTRIES) {
    const job = record(jobs.find((item) => item['job_name'] === `couli-${entry}`));
    expect(job['metrics_path'] ?? '/metrics', entry).toBe('/metrics');
    expect(job['scheme'] ?? 'http', entry).toBe('http');
    const targets = list(job['static_configs']).flatMap((config) =>
      list(record(config)['targets']),
    );
    expect(targets, `${entry}: one target, matching the published metrics port`).toEqual([
      `127.0.0.1:${metricsPort(entry)}`,
    ]);
  }
});

it('[AC-B1-25b#2] 内部抓取不带凭据、代理、额外发现源或改写抓取地址的规则', () => {
  for (const job of scrapeJobs()) {
    const name = string(job['job_name']);
    const forbidden = Object.keys(job).filter(
      (key) =>
        key.endsWith('_sd_configs') ||
        /^(?:basic_auth|authorization|oauth2|bearer_token|bearer_token_file|proxy_url|proxy_from_environment|http_headers|tls_config)$/.test(
          key,
        ),
    );
    expect(forbidden, `${name}: static local scraping without credentials or proxies`).toEqual([]);
    // Direct local /metrics needs no relabeling. In particular do not let __address__,
    // __scheme__ or __metrics_path__ override an apparently safe static target.
    expect(job['relabel_configs'] ?? [], name).toEqual([]);
    expect(job['metric_relabel_configs'] ?? [], 'do not drop alert inputs').toEqual([]);
    expect(job['params'] ?? {}, name).toEqual({});
    for (const config of list(job['static_configs'])) {
      const labels = record(record(config)['labels'] ?? {});
      expect(
        Object.keys(labels).filter((key) => key.startsWith('__')),
        name,
      ).toEqual([]);
    }
  }
});
