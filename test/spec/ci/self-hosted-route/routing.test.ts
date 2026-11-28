import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import {
  checkWorkflows,
  SELF_HOSTED_JOBS,
  SELF_HOSTED_ROUTE,
} from '../../../../tools/ci/check-workflows.ts';
import { removeDir, scratchDir, writeFiles } from '../../../../tools/ops/test-helpers.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CI_FILE = '.github/workflows/ci.yml';
const HOSTED = 'ubuntu-latest';
const LAN = ['self-hosted', 'couli-ci'];
const ROUTE =
  "${{ (vars.SELF_HOSTED_CI == 'on' && vars.SELF_HOSTED_CI_IDLE == 'on' && " +
  "(github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository)) && " +
  'fromJSON(\'["self-hosted","couli-ci"]\') || \'ubuntu-latest\' }}';
const OLD_ROUTE = ROUTE.replace("vars.SELF_HOSTED_CI_IDLE == 'on' && ", '');
const SPEC_JOBS = ['verify-spec-1', 'verify-spec-2', 'verify-spec-3'];
const INT_JOBS = [
  'verify-int-1',
  'verify-int-2',
  'verify-int-3',
  'verify-int-4',
  'verify-int-5',
  'verify-int-6',
];
const ROUTED_JOBS = [...SPEC_JOBS, ...INT_JOBS];
const REQUIRED_HOSTED_JOBS = [
  'verify-props-sha-1',
  'verify-props-sha-2',
  'verify-props-sha-3',
  'guard-git',
  'ci-gate',
];

it('[AC-CT-06zzzzzzzp#1] ci.yml fixes runner placement and preserves timeouts', () => {
  const workflow = readFileSync(join(ROOT, CI_FILE), 'utf8');
  const jobsText = (workflow.split('\njobs:\n')[1] ?? '').split(/^[\w-]+:/m)[0] ?? '';
  const jobs = new Map(
    jobsText.split(/^(?= {2}[\w-]+:[ \t]*(?:#.*)?$)/m).flatMap((body) => {
      const id = /^ {2}([\w-]+):/.exec(body)?.[1];
      return id === undefined ? [] : [[id, body] as const];
    }),
  );

  expect.soft(SELF_HOSTED_ROUTE).toBe(ROUTE);
  expect.soft(SELF_HOSTED_JOBS).toEqual({ 'ci.yml': ROUTED_JOBS });
  for (const id of [...ROUTED_JOBS, ...REQUIRED_HOSTED_JOBS]) {
    expect.soft(jobs.has(id), `${id} exists in ci.yml`).toBe(true);
  }
  for (const [id, body] of jobs) {
    const routed = ROUTED_JOBS.includes(id);
    const runnerLines = body.match(/^ {4}runs-on:.*$/gm);
    expect.soft(runnerLines, `${id} runner`).toEqual([`    runs-on: ${routed ? ROUTE : HOSTED}`]);
    if (routed) {
      const minutes = SPEC_JOBS.includes(id) ? 30 : 40;
      const timeoutLines = body.match(/^ {4}timeout-minutes:.*$/gm);
      expect.soft(timeoutLines, `${id} timeout`).toEqual([`    timeout-minutes: ${minutes}`]);
    }
  }
  expect(checkWorkflows(ROOT)).toEqual([]);
});

const REPOSITORY = 'example/rebate-platform';

function evaluateRoute(
  eventName: string,
  headRepository: string | undefined,
  enabled: string | undefined,
  idle: string | undefined,
): unknown {
  // Evaluate only the two known literals. Missing GitHub context properties compare as empty
  // strings. The inputs here are lowercase, so GitHub and JS string equality agree.
  expect([ROUTE, OLD_ROUTE]).toContain(SELF_HOSTED_ROUTE);
  return runInNewContext(SELF_HOSTED_ROUTE.slice(3, -2), {
    vars: { SELF_HOSTED_CI: enabled ?? '', SELF_HOSTED_CI_IDLE: idle ?? '' },
    github: {
      event_name: eventName,
      repository: REPOSITORY,
      event: { pull_request: { head: { repo: { full_name: headRepository ?? '' } } } },
    },
    fromJSON: JSON.parse,
  });
}

it('[AC-CT-06zzzzzzzp#2] LAN routing requires both switches and an eligible event', () => {
  const eligible = [
    ['push', undefined],
    ['pull_request', REPOSITORY],
  ] as const;
  for (const [event, head] of eligible) {
    const enabled = evaluateRoute(event, head, 'on', 'on');
    const defaults = evaluateRoute(event, head, undefined, undefined);
    expect.soft(enabled, `${event} with both switches on`).toEqual(LAN);
    expect.soft(defaults, `${event} with neither switch`).toBe(HOSTED);
    for (const value of [undefined, '', 'off', 'true', 'on ']) {
      const enableOff = evaluateRoute(event, head, value, 'on');
      const idleOff = evaluateRoute(event, head, 'on', value);
      expect.soft(enableOff, `${event} with enable=${String(value)}`).toBe(HOSTED);
      expect.soft(idleOff, `${event} with idle=${String(value)}`).toBe(HOSTED);
    }
  }
  const hosted = [
    ['fork PR', 'pull_request', 'contributor/rebate-platform'],
    ['PR without head repo', 'pull_request', undefined],
    ['manual run', 'workflow_dispatch', undefined],
    ['scheduled run', 'schedule', undefined],
    ['merge queue', 'merge_group', undefined],
  ] as const;
  for (const [name, event, head] of hosted) {
    expect.soft(evaluateRoute(event, head, 'on', 'on'), name).toBe(HOSTED);
  }
});

const FIXTURE_CI = [
  'name: Fixture CI',
  'on:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  verify-spec-1:',
  `    runs-on: ${ROUTE}`,
  '    timeout-minutes: 30',
  '    steps:',
  '      - run: echo spec',
  '  ci-gate:',
  `    runs-on: ${HOSTED}`,
  '    if: always()',
  '    needs: [verify-spec-1]',
  '    steps:',
  '      - run: echo gate',
  '',
].join('\n');

function checkFixture(ci: string) {
  const root = scratchDir('self-hosted-route');
  try {
    mkdirSync(join(root, '.github'));
    cpSync(join(ROOT, '.github/workflows'), join(root, '.github/workflows'), { recursive: true });
    writeFiles(root, {
      [CI_FILE]: ci,
      'ops/branch-protection.json': readFileSync(join(ROOT, 'ops/branch-protection.json'), 'utf8'),
    });
    return checkWorkflows(root);
  } finally {
    removeDir(root);
  }
}

it('[AC-CT-06zzzzzzzp#3] the guard requires a timeout on the routed job itself', () => {
  expect.soft(checkFixture(FIXTURE_CI), 'routed job with a timeout').toEqual([]);
  const missing = FIXTURE_CI.replace('    timeout-minutes: 30\n', '');
  const stepOnly = missing.replace(
    '      - run: echo spec\n',
    '      - run: echo spec\n        timeout-minutes: 5\n',
  );
  const nearbyJobTimeouts = missing
    .replace(
      '  verify-spec-1:',
      [
        '  verify-static:',
        `    runs-on: ${HOSTED}`,
        '    timeout-minutes: 5',
        '    steps:',
        '      - run: echo static',
        '  verify-spec-1:',
      ].join('\n'),
    )
    .replace('    if: always()\n', '    if: always()\n    timeout-minutes: 5\n');
  const cases = [
    ['missing timeout', missing],
    ['step timeout only', stepOnly],
    ['job timeouts before and after the routed job', nearbyJobTimeouts],
  ] as const;
  const problem = expect.objectContaining({
    file: CI_FILE,
    message: expect.stringMatching(/\bverify-spec-1\b.*timeout|timeout.*\bverify-spec-1\b/i),
  });
  for (const [name, ci] of cases) {
    expect.soft(checkFixture(ci), name).toContainEqual(problem);
  }
});

it('[AC-CT-06zzzzzzzp#4] the guard confines the exact route to allowlisted jobs', () => {
  const cases = [
    [FIXTURE_CI.replace(ROUTE, OLD_ROUTE), 'runs-on'],
    [FIXTURE_CI.replace(ROUTE, ROUTE.replace(' || ', ' ||  ')), 'runs-on'],
    [FIXTURE_CI.replaceAll('verify-spec-1', 'verify-props-sha-1'), 'self-hosted-job'],
    [
      FIXTURE_CI.replace(`    runs-on: ${HOSTED}`, `    runs-on: ${ROUTE}\n    timeout-minutes: 5`),
      'self-hosted-job',
    ],
    [`${FIXTURE_CI}# Self-Hosted\n`, 'self-hosted-text'],
  ] as const;
  for (const [ci, code] of cases) {
    expect.soft(checkFixture(ci)).toContainEqual(expect.objectContaining({ file: CI_FILE, code }));
  }
});

it('[AC-CT-06zzzzzzzp#5] routed jobs reject privileged triggers, writes and secrets', () => {
  const cases = [
    [FIXTURE_CI.replace('  pull_request:', '  pull_request_target:'), 'self-hosted-trigger'],
    [
      FIXTURE_CI.replace(
        '  pull_request:',
        '  workflow_run:\n    workflows: [contracts]\n    types: [completed]',
      ),
      'self-hosted-trigger',
    ],
    [FIXTURE_CI.replace('contents: read', 'contents: write'), 'self-hosted-permissions'],
    [
      FIXTURE_CI.replace(
        '    timeout-minutes: 30',
        '    timeout-minutes: 30\n    permissions:\n      contents: write',
      ),
      'self-hosted-permissions',
    ],
    [
      FIXTURE_CI.replace(
        '    timeout-minutes: 30',
        '    timeout-minutes: 30\n    env:\n      TOKEN: ${{ secrets.FIXTURE_TOKEN }}',
      ),
      'self-hosted-secrets',
    ],
    [
      FIXTURE_CI.replace('\njobs:', '\nenv:\n  TOKEN: ${{ secrets.FIXTURE_TOKEN }}\njobs:'),
      'self-hosted-secrets',
    ],
  ] as const;
  for (const [ci, code] of cases) {
    expect.soft(checkFixture(ci)).toContainEqual(expect.objectContaining({ file: CI_FILE, code }));
  }
});
