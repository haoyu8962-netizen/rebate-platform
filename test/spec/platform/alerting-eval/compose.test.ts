import { expect, it } from 'vitest';
import { environment, list, record, services } from '../../infra/staging/kit.ts';
import { ENTRIES, metricsPort, port } from './kit.ts';

it('[AC-B1-25b#3] 三个抓取进程显式配置不同指标端口，容器内监听可经宿主发布端口访问', () => {
  const all = services();
  const ports = ENTRIES.map((entry) => metricsPort(entry));
  expect(new Set(ports).size, 'no host port collisions between metrics listeners').toBe(3);
  for (const entry of ENTRIES) {
    const service = record(all[entry]);
    expect(service['network_mode'], entry).toBeUndefined();
    const env = environment(service['environment']);
    // METRICS_HOST defaults to container loopback; publishing that listener cannot reach it.
    expect(['0.0.0.0', '::'], `${entry}: IPv4 wildcard or Node dual-stack wildcard`).toContain(
      env['METRICS_HOST'],
    );
    expect(
      Object.keys(env).filter((key) =>
        /(?:DATABASE.*URL|REDIS|PASSWORD|SECRET|TOKEN|PRIVATE_KEY)/i.test(key),
      ),
      `${entry}: credentials and connection strings still come from env_file`,
    ).toEqual([]);
  }
});

it('[AC-B1-25b#4] 指标端口以相同 published/target 只发布到 127.0.0.1，现有端口也不对外', () => {
  const all = services();
  const hostPorts: number[] = [];
  for (const entry of ENTRIES) {
    const expected = metricsPort(entry);
    const published = list(record(all[entry])['ports']).map((value) => {
      if (typeof value === 'string') {
        expect(value, `${entry}: existing short port bindings remain local`).toMatch(
          /^127\.0\.0\.1:[^:]+:[^:]+$/,
        );
        return {
          host_ip: '127.0.0.1',
          published: value.split(':')[1],
          target: value.split(':')[2],
        };
      }
      const binding = record(value);
      expect(binding['host_ip'], entry).toBe('127.0.0.1');
      return binding;
    });
    const matches = published.filter((binding) => String(binding['target']) === String(expected));
    expect(matches, `${entry}: exactly one metrics port publication`).toHaveLength(1);
    const binding = record(matches[0]);
    expect(port(binding['published']), entry).toBe(expected);
    expect(binding['protocol'] ?? 'tcp', entry).toBe('tcp');
    hostPorts.push(port(binding['published']));
  }
  expect(new Set(hostPorts).size).toBe(3);
});
