import { posix } from 'node:path';
import { expect, it } from 'vitest';
import { list, record } from '../../infra/staging/kit.ts';
import { args, durationMs, oneArg, RULE_FILES, rules, yaml } from './kit.ts';

it('[AC-B1-25b#5] 专用 vmalert 只加载 couli.yaml 与 couli-fund.yaml，不加载 Pigsty 规则或通配符', () => {
  const paths = args().get('rule') ?? [];
  expect(paths).toHaveLength(2);
  expect(paths.map((path) => posix.basename(path)).sort()).toEqual([...RULE_FILES].sort());
  for (const path of paths) {
    expect(path, 'local explicit rule file').not.toMatch(/[:*?\[\]{},]/);
    expect(path, 'deployment path is absolute or repository-relative').toMatch(
      /^(?:\/|infra\/monitoring\/rules\/)/,
    );
    expect(posix.normalize(path), 'Pigsty rules remain separate').not.toMatch(/^\/infra\/rules\//);
  }
});

it('[AC-B1-25b#6] 求值读节点 VictoriaMetrics，只通知 couli Alertmanager，管理监听不对外', () => {
  const flags = args();
  expect(oneArg(flags, 'datasource.url')).toBe('http://127.0.0.1:8428');
  expect(oneArg(flags, 'notifier.url')).toBe('http://127.0.0.1:9093');
  expect(flags.has('notifier.config'), 'no second notifier source').toBe(false);
  const listen = oneArg(flags, 'httpListenAddr');
  expect(listen).toMatch(/^127\.0\.0\.1:[1-9]\d*$/);
  expect(Number(listen.split(':')[1])).toBeLessThanOrEqual(65535);
});

it('[AC-B1-25b#7] 求值间隔为正且不超过 1 分钟及两份规则的最短 for', () => {
  const interval = durationMs(oneArg(args(), 'evaluationInterval'));
  const holds = RULE_FILES.flatMap((file) => rules(file).map((rule) => durationMs(rule['for'])));
  expect(interval).toBeLessThanOrEqual(Math.min(60000, ...holds));
  // An explicit group interval overrides the global flag, so it must obey the same bound.
  for (const file of RULE_FILES) {
    for (const item of list(yaml(`infra/monitoring/rules/${file}`)['groups'])) {
      const group = record(item);
      if (group['interval'] !== undefined) {
        expect(durationMs(group['interval']), `${file}: group interval`).toBeLessThanOrEqual(
          Math.min(60000, ...holds),
        );
      }
    }
  }
});
