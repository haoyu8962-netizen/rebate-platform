import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { OPS_DIR, writeFiles } from '../../../../tools/ops/test-helpers.ts';

export const TASK = 'CT-06zzzzzzzo';

// As in the verify-container unit fixtures, Docker only pretends the image and store are ready.
// For the actual browser command, run the entrypoint with its mounts mapped into the fixture.
const DOCKER = `#!/bin/bash
set -euo pipefail
case "$1" in
  version|image|volume|rm) exit 0 ;;
  run) ;;
  *) echo "unexpected Docker command: $*" >&2; exit 99 ;;
esac
if [ "\${!#}" = /store/.couli-fetch-ok ]; then exit 0; fi
if [ "\${!#}" != browser ]; then echo "unexpected Docker run: $*" >&2; exit 99; fi
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    -v)
      case "$2" in
        *:/src:ro) export BROWSER_MOUNT_SRC="\${2%:/src:ro}" ;;
        *:/out) export BROWSER_MOUNT_OUT="\${2%:/out}" ;;
      esac
      shift
      ;;
    -e) export "$2"; shift ;;
  esac
  shift
done
: "\${BROWSER_MOUNT_SRC:?missing /src mount}" "\${BROWSER_MOUNT_OUT:?missing /out mount}"
exec bash "$BROWSER_FIXTURE_ENTRYPOINT" browser
`;

// Fake only the pnpm calls made by the entrypoint. Test output appears during the project run,
// after prepare_repo has copied the snapshot, and the project may fail after creating it.
const PNPM = `#!/bin/bash
set -euo pipefail
if [ "$1" = install ]; then exit 0; fi
if [ "$1 $2 $3" != 'exec vitest run' ]; then exit 99; fi
for arg in "$@"; do
  case "$arg" in
    --outputFile.json=*) report="\${arg#*=}" ;;
  esac
done
case "\${report:?missing Vitest output path}" in
  */spec-browser.vitest-report.json)
    if [ -e "$BROWSER_FIXTURE_REPORT" ]; then
      mkdir -p .tmp
      cp -RP "$BROWSER_FIXTURE_REPORT" .tmp/visual-baseline
    fi
    if [ "$BROWSER_FIXTURE_SCREENSHOT" = yes ]; then
      printf 'browser screenshot' >"$COULI_BROWSER_SCREENSHOT_DIR/page.png"
    fi
    printf '{}\\n' >"$report"
    exit "$BROWSER_FIXTURE_EXIT"
    ;;
  */build-smoke.vitest-report.json) printf '{}\\n' >"$report" ;;
  *) echo "unexpected Vitest output path: $report" >&2; exit 99 ;;
esac
`;

function entrypointWithFixtureMounts(source: string): string {
  // Keep the entrypoint's commands and control flow. Quote mount paths in shell words so local
  // fixture directories can contain spaces. Expand mount variables inside quoted arguments.
  const shellWords =
    /"(?:\\.|[^"\\\n])*"|'[^'\n]*'|(?<![\w./$}])\/(?:src|work|store|out)(?![\w.-])(?:\/[\w./-]*)?/g;
  const mountRoots = /(?<![\w./$}])\/(src|work|store|out)(?![\w.-])/g;
  return source
    .replaceAll('"$HOME"', '"${BROWSER_FIXTURE_ROOT}/home"')
    .replace(shellWords, (word) => {
      const mapped = word.replace(mountRoots, (_, mount: string) => {
        return `\${BROWSER_MOUNT_${mount.toUpperCase()}}`;
      });
      if (word === mapped || word.startsWith('"')) return mapped;
      if (word.startsWith("'")) return `"${mapped.slice(1, -1)}"`;
      return `"${mapped}"`;
    });
}

export function runBrowser(root: string, projectExit: number, screenshot = true) {
  const trusted = join(root, 'trusted checkout');
  const trustedOps = join(trusted, 'tools', 'ops');
  const worktree = join(root, 'task checkout');
  const runs = join(root, 'runs');
  const runDir = join(runs, TASK, 'browser', '1');
  const entrypoint = join(root, 'fixture-entrypoint.sh');
  const bin = join(root, 'bin');

  writeFiles(trustedOps, {
    'verify-container.sh': readFileSync(join(OPS_DIR, 'verify-container.sh'), 'utf8'),
  });
  cpSync(join(OPS_DIR, 'verify-image'), join(trustedOps, 'verify-image'), { recursive: true });
  writeFiles(worktree, {
    'package.json': '{"name":"browser-fixture","private":true,"packageManager":"pnpm@11.0.0"}\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n  playwright@1.60.0: {}\n",
    'pnpm-workspace.yaml': 'packages: []\n',
    'test/package.json': '{"name":"browser-fixture-tests","private":true}\n',
  });
  writeFiles(root, {
    'bin/docker': DOCKER,
    'bin/pnpm': PNPM,
    'fixture-entrypoint.sh': entrypointWithFixtureMounts(
      readFileSync(join(trustedOps, 'verify-image', 'entrypoint.sh'), 'utf8'),
    ),
  });
  for (const name of ['docker', 'pnpm']) chmodSync(join(bin, name), 0o755);

  const cli = spawnSync(
    'bash',
    [join(trustedOps, 'verify-container.sh'), TASK, '--worktree', worktree, '--browser'],
    {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        COULI_RUNS: runs,
        COULI_TRUSTED_ROOT: realpathSync(trusted),
        COULI_VERIFY_TIMEOUT_SECS: '10',
        BROWSER_FIXTURE_ROOT: root,
        BROWSER_FIXTURE_ENTRYPOINT: entrypoint,
        BROWSER_FIXTURE_REPORT: join(root, 'generated report'),
        BROWSER_FIXTURE_EXIT: String(projectExit),
        BROWSER_FIXTURE_SCREENSHOT: screenshot ? 'yes' : 'no',
        BROWSER_MOUNT_WORK: join(root, 'container work'),
        BROWSER_MOUNT_STORE: join(root, 'offline store'),
        PLAYWRIGHT_BROWSERS_PATH: bin,
        XDG_CACHE_HOME: join(root, 'cache'),
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_STATE_HOME: join(root, 'state'),
      },
    },
  );
  const logPath = join(runDir, 'log.txt');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  return { cli, log, runDir };
}
