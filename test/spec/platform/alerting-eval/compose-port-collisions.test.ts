import { expect, it } from 'vitest';
import { environment, list, record, services } from '../../infra/staging/kit.ts';
import { ENTRIES, metricsPort, port } from './kit.ts';

function defaults(value: unknown): string {
  expect(['string', 'number'], 'port configuration is a scalar').toContain(typeof value);
  // Check committed defaults without reading env_file or the host environment.
  // Resolve before splitting short port syntax: the default operator contains a colon.
  const result = String(value).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^{}]+)\}/g, '$1');
  expect(result, 'port must have a statically checkable value/default').not.toMatch(/[$}{]/);
  return result;
}

function portRange(value: unknown): [number, number] {
  const text = defaults(value);
  expect(text, 'single port or inclusive published port range').toMatch(/^\d+(?:-\d+)?$/);
  const [start, end] = text.split('-');
  const lower = port(start);
  const upper = port(end ?? start);
  expect(upper).toBeGreaterThanOrEqual(lower);
  return [lower, upper];
}

function binding(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' && typeof value !== 'number') return record(value);
  const parts = defaults(value)
    .replace(/\/(?:tcp|udp|sctp)$/, '')
    .split(':');
  // A target-only short binding has an ephemeral host port, not a reserved fixed port.
  return { published: parts.length > 1 ? parts.at(-2) : undefined, target: parts.at(-1) };
}

it('[AC-B1-25b#11] 三个指标端口不与任何服务的已发布端口或其他 *_PORT 默认值冲突', () => {
  const all = services();
  for (const entry of ENTRIES) {
    const metrics = metricsPort(entry);
    let ownPublicationCount = 0;
    for (const [name, value] of Object.entries(all)) {
      const service = record(value);
      for (const [key, configured] of Object.entries(environment(service['environment']))) {
        if (!key.endsWith('_PORT') || (name === entry && key === 'METRICS_PORT')) continue;
        expect(
          port(defaults(configured)),
          `${entry} METRICS_PORT collides with ${name}.${key}`,
        ).not.toBe(metrics);
      }
      for (const item of list(service['ports'] ?? [])) {
        const published = binding(item);
        if (published['published'] === undefined) continue;
        const [lower, upper] = portRange(published['published']);
        // Exempt only this listener's own exact mapping, once. Other services' metrics
        // bindings, duplicate publications and application ports must still be checked.
        if (
          name === entry &&
          lower === metrics &&
          upper === metrics &&
          defaults(published['target']) === String(metrics)
        ) {
          ownPublicationCount += 1;
          continue;
        }
        expect(
          metrics < lower || metrics > upper,
          `${entry} METRICS_PORT ${metrics} collides with ${name} published ${lower}-${upper}`,
        ).toBe(true);
      }
    }
    expect(ownPublicationCount, `${entry}: exactly one own metrics publication exempted`).toBe(1);
  }
});
