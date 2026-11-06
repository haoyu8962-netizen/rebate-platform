import { posix } from 'node:path';
import { expect, it } from 'vitest';
import { asset } from '../../infra/staging/kit.ts';
import { oneArg, port } from './kit.ts';

it('[AC-B1-25b#9] couli 专用 vmagent 加载 couli.yml，仅写入节点 VictoriaMetrics 且管理监听不对外', () => {
  // asset asserts existence before reading: missing implementation is assertion-red.
  const flags = new Map<string, string[]>();
  for (const raw of asset('infra/monitoring/scrape/vmagent.args').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    expect(line, 'one -flag=value per line, no shell quoting or expansion').toMatch(
      /^-[A-Za-z][A-Za-z0-9.]*=[^\s'"`$]+$/,
    );
    const split = line.indexOf('=');
    const key = line.slice(1, split);
    flags.set(key, [...(flags.get(key) ?? []), line.slice(split + 1)]);
  }

  const config = oneArg(flags, 'promscrape.config');
  expect(posix.basename(config)).toBe('couli.yml');
  expect(config, 'one local file, not a URL, glob or comma-separated list').not.toMatch(
    /[:*?\[\]{},]/,
  );
  // oneArg checks cardinality, rejecting even a repeated identical destination.
  expect(oneArg(flags, 'remoteWrite.url')).toBe('http://127.0.0.1:8428/api/v1/write');
  const listen = oneArg(flags, 'httpListenAddr');
  expect(listen).toMatch(/^127\.0\.0\.1:[1-9]\d*$/);
  expect(port(listen.split(':')[1])).toBeGreaterThan(0);
});
