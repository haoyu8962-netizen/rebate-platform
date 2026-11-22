import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import {
  type ContainerState,
  publishContainerHealth,
} from '../../../../infra/monitoring/scripts/container-health.ts';
import { asset } from '../../infra/staging/kit.ts';
import { configuredContainers, CONTAINERS } from './staging-containers.ts';

const STATE = new Map<string, ContainerState | null>([
  ['couli-staging-api-1', { Running: true, Health: { Status: 'healthy' } }],
  ['couli-staging-stream-1', { Running: true, Health: { Status: 'unhealthy' } }],
  ['couli-staging-worker-1', { Running: true, Health: { Status: 'starting' } }],
  ['couli-staging-admin-1', { Running: false, Health: { Status: 'healthy' } }],
  ['couli-staging-payout-1', null],
]);
const SAMPLE = /^(couli_container_healthy\{name="[^"]+"\})[ \t]+([01])(?:[ \t]+\d+)?$/;
const CALENDAR = /^OnCalendar=(?:minutely|\*-\*-\* \*:\*:00)$/m;
const CADENCE = /^(?:OnUnitActiveSec|OnUnitInactiveSec)=(?:60(?:s|sec)?|1min)$/m;

function probe() {
  const accepted = () => Promise.resolve(new Response(null, { status: 204 }));
  return {
    inspect: vi.fn(async (name: string) => STATE.get(name) ?? null),
    fetch: vi.fn<typeof fetch>(accepted),
  };
}

it('[AC-B1-25c#11] 推送五个 staging 容器的健康值', async () => {
  const options = probe();
  await publishContainerHealth(options);

  expect(CONTAINERS.toSorted()).toEqual(configuredContainers().sort());
  expect(options.inspect.mock.calls.map(([name]) => name).sort()).toEqual(CONTAINERS.toSorted());
  const args = asset('infra/monitoring/scrape/vmagent.args');
  const listen = /^-httpListenAddr=(127\.0\.0\.1:[1-9]\d*)$/m.exec(args)?.[1];
  expect(listen, 'local vmagent ingestion address').toBeDefined();
  expect(options.fetch).toHaveBeenCalled();
  const samples: string[] = [];
  for (const call of options.fetch.mock.calls) {
    const request = new Request(...call);
    expect(request.url).toBe(`http://${listen}/api/v1/import/prometheus`);
    expect(request.method).toBe('POST');
    for (const line of (await request.text()).trim().split(/\r?\n/)) {
      if (line.startsWith('#') || line === '') continue;
      const sample = SAMPLE.exec(line);
      expect(sample, 'send only named container health samples').not.toBeNull();
      samples.push(`${sample?.[1]} ${sample?.[2]}`);
    }
  }
  const expected = CONTAINERS.map((name) => {
    const value = name === 'couli-staging-api-1' ? 1 : 0;
    return `couli_container_healthy{name="${name}"} ${value}`;
  });
  expect(samples.sort()).toEqual(expected.sort());
});

it('[AC-B1-25c#12] vmagent 拒收探测指标时推送任务报失败', async () => {
  const options = probe();
  options.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
  const failure = await publishContainerHealth(options).then(
    () => null,
    (error: unknown) => error,
  );
  expect(options.fetch).toHaveBeenCalled();
  expect(failure).toBeInstanceOf(Error);
});

it('[AC-B1-25c#13] systemd 每分钟启动健康推送', () => {
  const directory = new URL('../../../../infra/monitoring/scripts/', import.meta.url);
  const timers = globSync('*.timer', { cwd: fileURLToPath(directory) });
  const healthTimers = timers.filter((name) => /container.*health/.test(name));
  expect(healthTimers, 'one systemd timer for container health').toHaveLength(1);
  const timerFile = healthTimers[0]!;
  const timer = asset(`infra/monitoring/scripts/${timerFile}`);
  expect(timer).toMatch(/^\[Timer\]$/m);
  if (!CALENDAR.test(timer)) {
    expect(timer).toMatch(CADENCE);
    expect(timer).toMatch(/^On(?:Boot|Startup|Active)Sec=.+$/m);
  }
  const explicitUnit = /^Unit=([^/\n]+\.service)$/m.exec(timer)?.[1];
  const unit = explicitUnit ?? timerFile.replace(/\.timer$/, '.service');
  const service = asset(`infra/monitoring/scripts/${unit}`);
  expect(service).toMatch(/^\[Service\]$/m);
  expect(service).toMatch(/^ExecStart=.*\bcontainer-health\.ts(?:\s|$)/m);
  expect(service).not.toMatch(/^ExecStart=.*\bdocker\s+(?:run|exec)\b/m);
});
