import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../../../..');
export const TASK = 'CT-06zzzzzzzb';
export const SPEC_PACKAGE = '@couli/spec-tests';
export const ROOT_TEST = 'turbo run test --env-mode=loose';
export const FAST_STEPS = ['pnpm run typecheck', 'pnpm run test', 'pnpm run guard:static'];

export function unitCommand(pkg = SPEC_PACKAGE): string {
  return `pnpm exec ${ROOT_TEST} --filter='!${pkg}'`;
}

export function specCommand(i: number, n: number, pkg = SPEC_PACKAGE): string {
  return `pnpm --filter ${pkg} run test --shard=${String(i)}/${String(n)}`;
}

export function job(id: string, ...commands: string[]): string {
  return [
    `  ${id}:`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...commands.map((command) => `      - run: ${command}`),
  ].join('\n');
}

export function workflow(...jobs: string[]): string {
  return ['name: Fixture CI', 'jobs:', ...jobs, ''].join('\n');
}

export function fastJobs(n: number, pkg = SPEC_PACKAGE): string[] {
  return [
    job('verify-unit', unitCommand(pkg)),
    ...Array.from({ length: n }, (_, i) =>
      job(`verify-spec-${String(i + 1)}`, specCommand(i + 1, n, pkg)),
    ),
  ];
}

export function packageJson(overrides: Record<string, string | null> = {}): string {
  return JSON.stringify({
    private: true,
    type: 'module',
    scripts: {
      test: ROOT_TEST,
      'verify:fast': FAST_STEPS.join(' && '),
      verify:
        'pnpm run verify:fast && pnpm run test:int && pnpm run test:browser && pnpm run db:check',
      ...overrides,
    },
  });
}
