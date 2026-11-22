// Container health push of the five couli staging containers (B1-25c; D10-2605 / D10-2612).
// Run on the node by couli-container-health.timer (every 60 s), never inside a container and never
// with docker.sock mounted anywhere: it only runs `docker inspect` (read-only) on the host.
// For each container it pushes couli_container_healthy{name="couli-staging-<entry>-1"} 1 when the
// container is running and its health check reports healthy, otherwise 0 (stopped, starting,
// unhealthy, missing or uninspectable), to the couli vmagent's push endpoint
// (127.0.0.1:8429, infra/monitoring/scrape/vmagent.args), which writes to the node VictoriaMetrics.
// A rejected push (non-2xx, network error, 5-second timeout) fails the run (non-zero exit).
// Node built-in modules only. Usage: node container-health.ts
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export interface ContainerState {
  Running: boolean;
  Health?: { Status: string };
}

export interface ContainerHealthOptions {
  inspect: (name: string) => Promise<ContainerState | null>;
  fetch: typeof fetch;
}

const ENTRIES = ['api', 'stream', 'worker', 'admin', 'payout'] as const;
export const CONTAINERS: readonly string[] = ENTRIES.map((entry) => `couli-staging-${entry}-1`);
export const PUSH_URL = 'http://127.0.0.1:8429/api/v1/import/prometheus';
const PUSH_TIMEOUT_MS = 5000;
const INSPECT_TIMEOUT_MS = 10_000;

export function healthy(state: ContainerState | null): boolean {
  return state !== null && state.Running && state.Health?.Status === 'healthy';
}

export async function publishContainerHealth(options: ContainerHealthOptions): Promise<void> {
  const lines: string[] = [];
  for (const name of CONTAINERS) {
    let state: ContainerState | null;
    try {
      state = await options.inspect(name);
    } catch {
      state = null;
    }
    lines.push(`couli_container_healthy{name="${name}"} ${healthy(state) ? 1 : 0}`);
  }
  let response: Response;
  try {
    response = await options.fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; version=0.0.4' },
      body: `${lines.join('\n')}\n`,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error('container health push to vmagent failed', { cause: error });
  }
  if (!response.ok) {
    throw new Error(`vmagent rejected the container health push: HTTP ${String(response.status)}`);
  }
}

/** `docker inspect` of one container's State; null when it does not exist or cannot be read. */
export function dockerInspect(name: string): Promise<ContainerState | null> {
  return new Promise((done) => {
    execFile(
      'docker',
      ['inspect', '--type', 'container', '--format', '{{json .State}}', name],
      { timeout: INSPECT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          done(null);
          return;
        }
        try {
          const state: unknown = JSON.parse(stdout);
          if (state === null || typeof state !== 'object') {
            done(null);
            return;
          }
          const record = state as { Running?: unknown; Health?: { Status?: unknown } };
          const status = record.Health?.Status;
          done({
            Running: record.Running === true,
            ...(typeof status === 'string' ? { Health: { Status: status } } : {}),
          });
        } catch {
          done(null);
        }
      },
    );
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  publishContainerHealth({ inspect: dockerInspect, fetch: globalThis.fetch }).then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'container health push failed');
      process.exitCode = 1;
    },
  );
}
