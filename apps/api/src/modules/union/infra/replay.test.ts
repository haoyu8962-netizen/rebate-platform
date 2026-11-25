import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionEndpoint } from '../domain/types.ts';
import {
  createUnionFileReplay,
  createUnionReplayClient,
  parseUnionRecordingProvenance,
  type UnionRecordingProvenance,
  type UnionTransport,
  type UnionTransportRequest,
} from './replay.ts';

const response = { status: 200, headers: {}, body: 'synthetic-response' };

function endpoints(baseUrl: string): readonly UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => ({
    platform,
    mode: 'replay',
    baseUrl,
    quotaKey: `synthetic:${platform}`,
  }));
}

const provenance = {
  source: 'synthetic',
  capabilityId: 'CAP-SYNTHETIC',
  probeRunId: null,
  capturedAt: '2030-01-02T03:04:05.000Z',
  originalSha256: '0'.repeat(64),
  sanitizerVersion: 'synthetic-none',
};

describe('union replay client', () => {
  it('[AC-B1-04c-UNIT#1] keeps the base path prefix when the base URL has no trailing slash', async () => {
    const transport = vi.fn<UnionTransport>().mockResolvedValue(response);
    const client = createUnionReplayClient({
      endpoints: endpoints('https://jd.synthetic.invalid/synthetic-api'),
      transport,
    });
    await client.send('jd', { method: 'GET', path: 'echo', scenario: 'synthetic-smoke' });
    expect(transport.mock.calls[0]![0].url).toBe('https://jd.synthetic.invalid/synthetic-api/echo');
  });

  it.each(['a/%2e%2e/%2e%2e/escape', 'a/%2fescape', 'mailto:x'])(
    '[AC-B1-04c-UNIT#2] refuses encoded escapes %s',
    async (path) => {
      const transport = vi.fn<UnionTransport>();
      const client = createUnionReplayClient({
        endpoints: endpoints('https://jd.synthetic.invalid/synthetic-api/'),
        transport,
      });
      await expect(
        client.send('jd', { method: 'GET', path, scenario: 'synthetic-smoke' }),
      ).rejects.toMatchObject({ code: 'invalid_replay_request' });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('[AC-B1-04c-UNIT#3] refuses an unsafe scenario before calling the transport', async () => {
    const transport = vi.fn<UnionTransport>();
    const client = createUnionReplayClient({
      endpoints: endpoints('https://jd.synthetic.invalid/'),
      transport,
    });
    await expect(
      client.send('jd', { method: 'GET', path: 'echo', scenario: '../synthetic' }),
    ).rejects.toMatchObject({ code: 'invalid_replay_request' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('union recording provenance', () => {
  it.each([
    { capturedAt: '2030-02-31T00:00:00.000Z' },
    { probeRunId: 'synthetic-run' },
    { extra: 'synthetic' },
    { originalSha256: 'A'.repeat(64) },
  ])('[AC-B1-04c-UNIT#4] rejects %j', (override) => {
    expect(() => parseUnionRecordingProvenance({ ...provenance, ...override })).toThrow(
      expect.objectContaining({ code: 'invalid_provenance' }),
    );
  });

  it('[AC-B1-04c-UNIT#5] accepts an offset instant and a leap day', () => {
    expect(
      parseUnionRecordingProvenance({ ...provenance, capturedAt: '2028-02-29T12:00:00+08:00' }),
    ).toMatchObject({ capturedAt: '2028-02-29T12:00:00+08:00' });
  });
});

const instant = '2031-02-03T04:05:06.789Z';
const envelope = {
  request: { method: 'POST', path: '/synthetic-api/echo', body: 'synthetic-input' },
  response: { status: 202, headers: {}, body: 'synthetic-output' },
};

function metadata(source: UnionRecordingProvenance['source']): UnionRecordingProvenance {
  return {
    ...provenance,
    source,
    probeRunId: source === 'probe' ? 'synthetic-run' : null,
  } as UnionRecordingProvenance;
}

function replayRequest(scenario: string, body = 'synthetic-input'): UnionTransportRequest {
  return {
    platform: 'jd',
    url: 'https://synthetic.invalid/synthetic-api/echo',
    method: 'POST',
    headers: { 'X-Scenario': scenario },
    body,
  };
}

// Scratch recordings go under the repository's .tmp/ (AGENTS.md §9), not the system temp directory.
const SCRATCH = fileURLToPath(
  new URL('../../../../../../.tmp/union-replay-unit/', import.meta.url),
);

async function withRecordings(
  run: (root: string, write: (scenario: string, meta: unknown) => Promise<string>) => Promise<void>,
): Promise<void> {
  await mkdir(SCRATCH, { recursive: true });
  const root = await mkdtemp(join(SCRATCH, 'run-'));
  const write = async (scenario: string, meta: unknown): Promise<string> => {
    const folder = join(root, 'jd', scenario);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'provenance.json'), JSON.stringify(meta));
    await writeFile(join(folder, 'recording.json'), JSON.stringify(envelope));
    return folder;
  };
  try {
    await run(root, write);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('union file replay report', () => {
  it('[AC-B1-04c-UNIT#6] registers a synthetic source even when its request does not match', async () => {
    await withRecordings(async (root, write) => {
      const probeDir = await write('synthetic-probe', metadata('probe'));
      const otherDir = await write('synthetic-other', metadata('synthetic'));
      const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
      await replay.transport(replayRequest('synthetic-probe'));
      expect(replay.report().acceptanceEligible).toBe(true);
      await expect(
        replay.transport(replayRequest('synthetic-other', 'synthetic-wrong-body')),
      ).rejects.toMatchObject({ code: 'recording_mismatch' });
      expect(replay.report()).toEqual({
        recordings: [
          {
            platform: 'jd',
            scenario: 'synthetic-probe',
            directory: probeDir,
            provenance: metadata('probe'),
            loadedAt: instant,
          },
          {
            platform: 'jd',
            scenario: 'synthetic-other',
            directory: otherDir,
            provenance: metadata('synthetic'),
            loadedAt: instant,
          },
        ],
        acceptanceEligible: false,
      });
    });
  });

  // B1-04ca (D10-380): the file I/O heaviest case here (three writes of both files, four reads);
  // its 12-case file takes 42–82 ms on a green CI run but once hit the 5 s default under a loaded
  // runner (#1599 run 40157563601, 5019 ms). Explicit limit only; the assertions are unchanged.
  it('[AC-B1-04c-UNIT#7] keeps a new entry when the same directory changes source', async () => {
    await withRecordings(async (root, write) => {
      const scenario = 'synthetic-swapped';
      const clock = new FixedClock(instant);
      const later = '2031-02-03T04:05:07.000Z';
      const folder = await write(scenario, metadata('probe'));
      const replay = createUnionFileReplay({ directory: root, clock });
      await replay.transport(replayRequest(scenario));
      await replay.transport(replayRequest(scenario));
      expect(replay.report().recordings).toHaveLength(1);
      await write(scenario, metadata('synthetic'));
      clock.set(later);
      await replay.transport(replayRequest(scenario));
      const entry = (source: UnionRecordingProvenance['source'], loadedAt: string) => ({
        platform: 'jd',
        scenario,
        directory: folder,
        provenance: metadata(source),
        loadedAt,
      });
      expect(replay.report()).toEqual({
        recordings: [entry('probe', instant), entry('synthetic', later)],
        acceptanceEligible: false,
      });
      // Restoring the probe files does not restore eligibility once a non-probe was loaded.
      await write(scenario, metadata('probe'));
      await replay.transport(replayRequest(scenario));
      expect(replay.report()).toEqual({
        recordings: [entry('probe', instant), entry('synthetic', later)],
        acceptanceEligible: false,
      });
    });
  }, 30_000);
});

describe('union file replay and archiveOmitParams', () => {
  it('[AC-B1-04zzzzo-UNIT#3] matches on the request as sent: archiveOmitParams neither loosens nor breaks matching', async () => {
    await withRecordings(async (root, write) => {
      await write('synthetic-omit', metadata('synthetic'));
      const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
      const omit = ['synthetic-input', 'content'];
      await expect(
        replay.transport({ ...replayRequest('synthetic-omit'), archiveOmitParams: omit }),
      ).resolves.toEqual({ status: 202, headers: {}, body: 'synthetic-output' });
      await expect(
        replay.transport({
          ...replayRequest('synthetic-omit', 'synthetic-other-input'),
          archiveOmitParams: omit,
        }),
      ).rejects.toMatchObject({ code: 'recording_mismatch' });
    });
  });
});
