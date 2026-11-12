import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// B1-01zzu brief (编排 D10-1288 / D10-1290) defines these local AC identifiers.
// Black-box rule tests for infra/staging/sync-aliyun-review.sh. Synthetic values only: HOME is a
// fixture directory, the source file and the node target live under the repository's .tmp, and
// ssh is a fake that runs the remote command on this machine. No real ~/.couli file, env file,
// node or ssh host is touched.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPT = join(ROOT, 'infra/staging/sync-aliyun-review.sh');

const ID_KEY = 'AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID';
const SECRET_KEY = 'AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET';
const ENDPOINT_KEY = 'AGENT_REVIEW_ALIYUN_ENDPOINT';
const KEYS = [ID_KEY, SECRET_KEY, ENDPOINT_KEY] as const;

// Synthetic values with markers that never overlap key names or status words.
const ID = 'IDFAKE123mno';
const SECRET = 'SKFAKE456pqr';
const ENDPOINT = 'https://EPFAKE789.test';
// Values already on the fake node; none of them may be printed either.
const OLD_ID = 'OLDIDFAKE000';
const OLD_ENDPOINT = 'https://OLDEPFAKE111.test';
const NODE_PASSWORD = 'NODEPASSFAKE222';
const DESTINATION = 'root@staging-node.invalid';

const VALID_SOURCE = [
  '# 阿里云内容安全（合成值）',
  '',
  `${ENDPOINT_KEY}=${ENDPOINT}`,
  `${ID_KEY}=${ID}`,
  '# comment between keys',
  `${SECRET_KEY}=${SECRET}`,
  '',
].join('\n');

const FAKE_SSH = `#!/bin/bash
set -u
printf 'call\\n' >> "$FAKE_SSH_CALLS"
printf '%s\\0' "$@" > "$FAKE_SSH_ARGS"
if [ "\${1:-}" = "-i" ]; then shift 2; fi
shift
cat > "$FAKE_SSH_STDIN"
case "\${FAKE_STDIN_MODE:-pass}" in
  pass) cp "$FAKE_SSH_STDIN" "$FAKE_SSH_STDIN.remote" ;;
  drop-secret) grep -v '^${SECRET_KEY}=' "$FAKE_SSH_STDIN" > "$FAKE_SSH_STDIN.remote" ;;
  extra-key) { cat "$FAKE_SSH_STDIN"; printf 'EXTRA_REMOTE_KEY=EXTRAREMOTEFAKE\\n'; } > "$FAKE_SSH_STDIN.remote" ;;
esac
# B1-01zzu Codex r1 S1: a file size limit with SIGXFSZ ignored makes a write fail part-way
# (as a full disk would) instead of killing the remote shell; both are inherited across exec.
if [ -n "\${FAKE_FSIZE_KB:-}" ]; then trap '' XFSZ; ulimit -f "$FAKE_FSIZE_KB"; fi
# Like ssh: the remote side sees the joined words and none of the local environment.
exec env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$FAKE_REMOTE_HOME" LC_ALL=C \\
  /bin/bash -c "$*" < "$FAKE_SSH_STDIN.remote"
`;

interface Fixture {
  directory: string;
  home: string;
  source: string;
  nodeDirectory: string;
  target: string;
  identity: string;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  lines: string[];
  sshCalls: number;
  sshArgs: string[];
  sshStdin: string | null;
}

function script(): string {
  // Missing script must produce an AssertionError on red, not ENOENT.
  expect(existsSync(SCRIPT), 'infra/staging/sync-aliyun-review.sh must exist').toBe(true);
  return SCRIPT;
}

function fixture(run: (f: Fixture) => void): void {
  const parent = join(ROOT, '.tmp/staging-aliyun-review');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'sync-'));
  try {
    const home = join(directory, 'home');
    const nodeDirectory = join(directory, 'node');
    mkdirSync(home);
    mkdirSync(join(directory, 'remote-home'));
    mkdirSync(nodeDirectory);
    writeFileSync(join(directory, 'fake-ssh'), FAKE_SSH, { mode: 0o755 });
    chmodSync(join(directory, 'fake-ssh'), 0o755);
    const identity = join(directory, 'id_fake');
    writeFileSync(identity, 'not a key\n', { mode: 0o600 });
    run({
      directory,
      home,
      source: join(directory, 'aliyun-review.env'),
      nodeDirectory,
      target: join(nodeDirectory, 'staging.env'),
      identity,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeMode(path: string, text: string, mode: number): void {
  writeFileSync(path, text);
  chmodSync(path, mode);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

// Every 6-character window of a value (scheme prefix dropped): no fragment may leak.
function fragments(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    const value = raw.replace(/^https?:\/\//, '');
    if (value.length <= 6) {
      if (value !== '') out.add(value);
      continue;
    }
    for (let i = 0; i + 6 <= value.length; i++) out.add(value.slice(i, i + 6));
  }
  return [...out];
}

function expectNoLeak(label: string, text: string, values: readonly string[]): void {
  for (const fragment of fragments(values)) {
    expect(text.includes(fragment), `${label} must not contain value fragment "${fragment}"`).toBe(
      false,
    );
  }
}

function sync(
  f: Fixture,
  args: string[],
  values: readonly string[],
  options: { envFile?: string | null; stdinMode?: string; fsizeKb?: number } = {},
): Run {
  const calls = join(f.directory, 'ssh-calls');
  const argsFile = join(f.directory, 'ssh-args');
  const stdinFile = join(f.directory, 'ssh-stdin');
  rmSync(calls, { force: true });
  rmSync(argsFile, { force: true });
  rmSync(stdinFile, { force: true });
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: f.home,
    LC_ALL: 'C',
    COULI_SYNC_SSH: join(f.directory, 'fake-ssh'),
    COULI_SYNC_TARGET: f.target,
    FAKE_SSH_CALLS: calls,
    FAKE_SSH_ARGS: argsFile,
    FAKE_SSH_STDIN: stdinFile,
    FAKE_REMOTE_HOME: join(f.directory, 'remote-home'),
    FAKE_STDIN_MODE: options.stdinMode ?? 'pass',
  };
  if (options.envFile !== null) env['COULI_SYNC_ENV_FILE'] = options.envFile ?? f.source;
  if (options.fsizeKb !== undefined) env['FAKE_FSIZE_KB'] = String(options.fsizeKb);
  const result = spawnSync('/bin/bash', [script(), ...args], {
    cwd: f.directory,
    // Do not inherit developer credentials or shell startup hooks.
    env,
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.error, 'script process must finish normally').toBeUndefined();
  expect(result.signal).toBeNull();
  const sshArgsText = existsSync(argsFile) ? readFileSync(argsFile, 'utf8') : '';
  const all = [...values, OLD_ID, OLD_ENDPOINT, NODE_PASSWORD];
  expectNoLeak('stdout', result.stdout, all);
  expectNoLeak('stderr', result.stderr, all);
  expectNoLeak('ssh arguments', sshArgsText, all);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lines: result.stdout.split('\n').filter((line) => line.trim() !== ''),
    sshCalls: existsSync(calls)
      ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length
      : 0,
    sshArgs: sshArgsText === '' ? [] : sshArgsText.replace(/\0$/, '').split('\0'),
    sshStdin: existsSync(stdinFile) ? readFileSync(stdinFile, 'utf8') : null,
  };
}

function lineFor(run: Run, prefix: string): string {
  const matches = run.lines.filter((line) => line.startsWith(`${prefix}:`));
  expect(matches, `exactly one "${prefix}:" line in stdout`).toHaveLength(1);
  return matches[0] ?? '';
}

function expectCheckFailed(run: Run): void {
  expect(run.status).toBe(1);
  expect(run.lines.at(-1)).toBe('check: failed');
  expect(run.sshCalls, 'a failed local check never calls ssh').toBe(0);
}

function sourceWith(replace: Partial<Record<(typeof KEYS)[number], string | null>>): string {
  const values: Record<string, string> = {
    [ID_KEY]: ID,
    [SECRET_KEY]: SECRET,
    [ENDPOINT_KEY]: ENDPOINT,
  };
  const lines = ['# synthetic'];
  for (const key of KEYS) {
    const override = replace[key];
    if (override === null) continue;
    lines.push(`${key}=${override ?? values[key] ?? ''}`);
  }
  return `${lines.join('\n')}\n`;
}

it('[AC-B1-01zzu#1] --check 合法源文件：exit 0、文件与三个键全为 yes/ok、最后一行 check: ok，不调用 ssh、不输出值', () => {
  fixture((f) => {
    writeMode(f.source, VALID_SOURCE, 0o600);
    const run = sync(f, ['--check'], [ID, SECRET, ENDPOINT]);
    expect(run.status).toBe(0);
    expect(lineFor(run, 'file')).toBe('file: exists=yes regular=yes mode600=yes');
    for (const key of KEYS) expect(lineFor(run, key)).toBe(`${key}: present=yes format=ok`);
    expect(run.lines.at(-1)).toBe('check: ok');
    expect(run.sshCalls).toBe(0);
    expect(run.stderr).not.toMatch(/command not found|syntax error|unbound variable/);
  });
});

it('[AC-B1-01zzu#2] 未设 COULI_SYNC_ENV_FILE 时读 $HOME/.couli/aliyun-review.env（HOME 为夹具目录）', () => {
  fixture((f) => {
    mkdirSync(join(f.home, '.couli'), { mode: 0o700 });
    writeMode(join(f.home, '.couli/aliyun-review.env'), VALID_SOURCE, 0o600);
    const ok = sync(f, ['--check'], [ID, SECRET, ENDPOINT], { envFile: null });
    expect(ok.status).toBe(0);
    expect(ok.lines.at(-1)).toBe('check: ok');
    expect(ok.sshCalls).toBe(0);
    rmSync(join(f.home, '.couli/aliyun-review.env'));
    const missing = sync(f, ['--check'], [ID, SECRET, ENDPOINT], { envFile: null });
    expectCheckFailed(missing);
    expect(lineFor(missing, 'file')).toMatch(/^file: exists=no\b/);
  });
});

const FILE_CASES = [
  {
    name: '权限 644',
    prepare: (f: Fixture) => writeMode(f.source, VALID_SOURCE, 0o644),
    expected: /^file: exists=yes\b.*\bmode600=no\b/,
  },
  {
    name: '权限 640',
    prepare: (f: Fixture) => writeMode(f.source, VALID_SOURCE, 0o640),
    expected: /^file: exists=yes\b.*\bmode600=no\b/,
  },
  {
    name: '文件不存在',
    prepare: () => undefined,
    expected: /^file: exists=no\b/,
  },
  {
    name: '是目录',
    prepare: (f: Fixture) => mkdirSync(f.source, { mode: 0o700 }),
    expected: /\bregular=no\b/,
  },
  {
    name: '是指向目录的链接',
    prepare: (f: Fixture) => {
      mkdirSync(join(f.directory, 'a-directory'), { mode: 0o700 });
      symlinkSync(join(f.directory, 'a-directory'), f.source);
    },
    expected: /\bregular=no\b/,
  },
];

it.each(FILE_CASES)(
  '[AC-B1-01zzu#3] --check 源文件本身不合格（$name）→ exit 1、check: failed、文件行相应为 no，不调用 ssh',
  ({ prepare, expected }) => {
    fixture((f) => {
      prepare(f);
      const run = sync(f, ['--check'], [ID, SECRET, ENDPOINT]);
      expectCheckFailed(run);
      expect(lineFor(run, 'file')).toMatch(expected);
    });
  },
);

interface ContentCase {
  name: string;
  text: string;
  values: string[];
  key: string | null;
  expected: RegExp | null;
}

const CONTENT_CASES: ContentCase[] = [
  {
    name: '缺 ID 键',
    text: sourceWith({ [ID_KEY]: null }),
    values: [SECRET, ENDPOINT],
    key: ID_KEY,
    expected: /\bpresent=no\b/,
  },
  {
    name: '缺接入点键',
    text: sourceWith({ [ENDPOINT_KEY]: null }),
    values: [ID, SECRET],
    key: ENDPOINT_KEY,
    expected: /\bpresent=no\b/,
  },
  {
    name: 'Secret 键出现两次',
    text: `${sourceWith({})}${SECRET_KEY}=SKFAKE999dup\n`,
    values: [ID, SECRET, ENDPOINT, 'SKFAKE999dup'],
    key: SECRET_KEY,
    expected: null,
  },
  {
    name: '多一个别的键',
    text: `${sourceWith({})}EXTRA_SETTING=EXTRAFAKE654\n`,
    values: [ID, SECRET, ENDPOINT, 'EXTRAFAKE654'],
    key: null,
    expected: null,
  },
  {
    name: '一行既非键值也非注释',
    text: `${sourceWith({})}MALFORMEDFAKE321\n`,
    values: [ID, SECRET, ENDPOINT, 'MALFORMEDFAKE321'],
    key: null,
    expected: null,
  },
  {
    name: '等号前后有空格',
    text: sourceWith({ [ID_KEY]: null }).replace('# synthetic', `# synthetic\n${ID_KEY} = ${ID}`),
    values: [ID, SECRET, ENDPOINT],
    key: ID_KEY,
    expected: null,
  },
  {
    name: 'ID 含 $',
    text: sourceWith({ [ID_KEY]: 'IDFAKE$123mno' }),
    values: ['IDFAKE$123mno', SECRET, ENDPOINT],
    key: ID_KEY,
    expected: /\bformat=bad\b/,
  },
  {
    name: 'ID 含 -',
    text: sourceWith({ [ID_KEY]: 'IDFAKE-123mno' }),
    values: ['IDFAKE-123mno', SECRET, ENDPOINT],
    key: ID_KEY,
    expected: /\bformat=bad\b/,
  },
  {
    name: 'Secret 含 $',
    text: sourceWith({ [SECRET_KEY]: 'SKFAKE$456pqr' }),
    values: [ID, 'SKFAKE$456pqr', ENDPOINT],
    key: SECRET_KEY,
    expected: /\bformat=bad\b/,
  },
  {
    name: 'Secret 为空',
    text: sourceWith({ [SECRET_KEY]: '' }),
    values: [ID, ENDPOINT],
    key: SECRET_KEY,
    expected: /\bformat=bad\b/,
  },
  {
    name: '接入点是 http',
    text: sourceWith({ [ENDPOINT_KEY]: 'http://EPFAKE789.test' }),
    values: [ID, SECRET, 'http://EPFAKE789.test'],
    key: ENDPOINT_KEY,
    expected: /\bformat=bad\b/,
  },
  {
    name: '接入点含空格',
    text: sourceWith({ [ENDPOINT_KEY]: 'https://EPFAKE789 .test' }),
    values: [ID, SECRET, 'https://EPFAKE789 .test'],
    key: ENDPOINT_KEY,
    expected: /\bformat=bad\b/,
  },
  {
    name: '接入点含 $',
    text: sourceWith({ [ENDPOINT_KEY]: 'https://EPFAKE$789.test' }),
    values: [ID, SECRET, 'https://EPFAKE$789.test'],
    key: ENDPOINT_KEY,
    expected: /\bformat=bad\b/,
  },
  {
    name: '接入点含引号',
    text: sourceWith({ [ENDPOINT_KEY]: '"https://EPFAKE789.test"' }),
    values: [ID, SECRET, '"https://EPFAKE789.test"'],
    key: ENDPOINT_KEY,
    expected: /\bformat=bad\b/,
  },
];

it.each(CONTENT_CASES)(
  '[AC-B1-01zzu#4] --check 源文件内容不合格（$name）→ exit 1、check: failed、相应键行不为 yes/ok，不调用 ssh、不输出值或该行内容',
  ({ text, values, key, expected }) => {
    fixture((f) => {
      writeMode(f.source, text, 0o600);
      const run = sync(f, ['--check'], values);
      expectCheckFailed(run);
      expect(lineFor(run, 'file')).toBe('file: exists=yes regular=yes mode600=yes');
      if (key !== null) {
        const line = lineFor(run, key);
        expect(line).not.toBe(`${key}: present=yes format=ok`);
        expect(line).toMatch(/\bpresent=no\b|\bformat=bad\b/);
        if (expected !== null) expect(line).toMatch(expected);
      }
    });
  },
);

// Node file with comments, blank lines, `$`, quotes, backslashes, tabs, a commented-out key and
// keys that merely share a prefix: everything but the exact key lines must survive byte for byte.
const NODE_BEFORE = [
  '# staging env — keep $HOME literal',
  `DATABASE_URL=postgres://couli:${NODE_PASSWORD}@db:5432/couli`,
  '',
  `${ID_KEY}=${OLD_ID}`,
  'PRICE_NOTE=costs $5 and "quoted" \\n not a newline',
  `# ${SECRET_KEY}=commented-out-not-a-key`,
  `${ENDPOINT_KEY}_BACKUP=keep-me`,
  '\tINDENTED=tab before',
  `${ENDPOINT_KEY}=${OLD_ENDPOINT}`,
  `${ID_KEY}_OLD=keep-me-too`,
  'LAST=1',
  '',
].join('\n');

const NODE_AFTER = [
  '# staging env — keep $HOME literal',
  `DATABASE_URL=postgres://couli:${NODE_PASSWORD}@db:5432/couli`,
  '',
  `${ID_KEY}=${ID}`,
  'PRICE_NOTE=costs $5 and "quoted" \\n not a newline',
  `# ${SECRET_KEY}=commented-out-not-a-key`,
  `${ENDPOINT_KEY}_BACKUP=keep-me`,
  '\tINDENTED=tab before',
  `${ENDPOINT_KEY}=${ENDPOINT}`,
  `${ID_KEY}_OLD=keep-me-too`,
  'LAST=1',
  `${SECRET_KEY}=${SECRET}`,
  '',
].join('\n');

function withoutFinalNewline(text: string): string {
  return text.replace(/\n$/, '');
}

function expectStdinIsThreeLines(run: Run): void {
  expect(run.sshStdin, 'ssh must receive the values on standard input').not.toBeNull();
  const lines = withoutFinalNewline(run.sshStdin ?? '').split('\n');
  expect([...lines].sort()).toEqual(
    [`${ENDPOINT_KEY}=${ENDPOINT}`, `${ID_KEY}=${ID}`, `${SECRET_KEY}=${SECRET}`].sort(),
  );
}

it('[AC-B1-01zzu#5] --apply 合法（带 --identity）：值只经标准输入，同名行原位替换、缺的追加、其余行逐字不变，无备份与临时文件残留，权限仍 600；再跑一次全为替换', () => {
  fixture((f) => {
    writeMode(f.source, VALID_SOURCE, 0o600);
    writeMode(f.target, NODE_BEFORE, 0o600);
    const run = sync(f, ['--apply', DESTINATION, '--identity', f.identity], [ID, SECRET, ENDPOINT]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      `apply: ${f.target}: replaced 2, added 1, other lines unchanged; backup removed`,
    );
    expect(run.sshCalls).toBe(1);
    expect(run.sshArgs.slice(0, 3)).toEqual(['-i', f.identity, DESTINATION]);
    // The fake runs the remote words under `env -i`, so updating f.target below proves the
    // target travelled as a remote argument (it may be shell-quoted, so no literal match here).
    expect(run.sshArgs.length, 'a remote command follows the destination').toBeGreaterThan(3);
    expectStdinIsThreeLines(run);
    expect(withoutFinalNewline(readFileSync(f.target, 'utf8'))).toBe(
      withoutFinalNewline(NODE_AFTER),
    );
    expect(mode(f.target)).toBe(0o600);
    expect(readdirSync(f.nodeDirectory)).toEqual(['staging.env']);

    const again = sync(
      f,
      ['--apply', DESTINATION, '--identity', f.identity],
      [ID, SECRET, ENDPOINT],
    );
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(
      `apply: ${f.target}: replaced 3, added 0, other lines unchanged; backup removed`,
    );
    expect(withoutFinalNewline(readFileSync(f.target, 'utf8'))).toBe(
      withoutFinalNewline(NODE_AFTER),
    );
    expect(mode(f.target)).toBe(0o600);
    expect(readdirSync(f.nodeDirectory)).toEqual(['staging.env']);
  });
});

it('[AC-B1-01zzu#6] --apply 不带 --identity：ssh 第一个参数就是目的地；目标末行无换行时追加的键另起一行，原有行不变', () => {
  fixture((f) => {
    writeMode(f.source, VALID_SOURCE, 0o600);
    const before = `# node\nDATABASE_URL=postgres://couli:${NODE_PASSWORD}@db/couli\nLAST=$1`;
    writeMode(f.target, before, 0o600);
    const run = sync(f, ['--apply', DESTINATION], [ID, SECRET, ENDPOINT]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      `apply: ${f.target}: replaced 0, added 3, other lines unchanged; backup removed`,
    );
    expect(run.sshCalls).toBe(1);
    expect(run.sshArgs[0]).toBe(DESTINATION);
    expect(run.sshArgs).not.toContain('-i');
    expectStdinIsThreeLines(run);
    const after = withoutFinalNewline(readFileSync(f.target, 'utf8')).split('\n');
    expect(after.slice(0, 3)).toEqual(before.split('\n'));
    expect(after.slice(3).sort()).toEqual(
      [`${ENDPOINT_KEY}=${ENDPOINT}`, `${ID_KEY}=${ID}`, `${SECRET_KEY}=${SECRET}`].sort(),
    );
    expect(mode(f.target)).toBe(0o600);
    expect(readdirSync(f.nodeDirectory)).toEqual(['staging.env']);
  });
});

const REMOTE_CASES = [
  { name: '目标不存在', text: null, targetMode: 0o600 },
  { name: '目标权限 644', text: NODE_BEFORE, targetMode: 0o644 },
  {
    name: '目标里同一键有两行',
    text: `${NODE_BEFORE}${ID_KEY}=${OLD_ID}\n`,
    targetMode: 0o600,
  },
];

it.each(REMOTE_CASES)(
  '[AC-B1-01zzu#7] --apply 节点前提不满足（$name）→ 非零退出、目标逐字不变、目录里没有新文件',
  ({ text, targetMode }) => {
    fixture((f) => {
      writeMode(f.source, VALID_SOURCE, 0o600);
      if (text !== null) writeMode(f.target, text, targetMode);
      const listing = readdirSync(f.nodeDirectory);
      const run = sync(f, ['--apply', DESTINATION], [ID, SECRET, ENDPOINT]);
      expect(run.status).not.toBe(0);
      expect(run.status).not.toBeNull();
      expect(run.sshCalls, 'the local check passed, so ssh was called').toBe(1);
      expect(run.stdout).not.toMatch(/backup removed/);
      expect(readdirSync(f.nodeDirectory)).toEqual(listing);
      if (text === null) {
        expect(existsSync(f.target)).toBe(false);
      } else {
        expect(readFileSync(f.target, 'utf8')).toBe(text);
        expect(mode(f.target)).toBe(targetMode);
      }
    });
  },
);

it.each([
  { name: '缺 Secret 行', stdinMode: 'drop-secret' },
  { name: '多出别的键', stdinMode: 'extra-key' },
])(
  '[AC-B1-01zzu#8] --apply 节点脚本只认三个键（标准输入$name）→ 非零退出、目标逐字不变、目录里没有新文件',
  ({ stdinMode }) => {
    fixture((f) => {
      writeMode(f.source, VALID_SOURCE, 0o600);
      writeMode(f.target, NODE_BEFORE, 0o600);
      const run = sync(f, ['--apply', DESTINATION], [ID, SECRET, ENDPOINT, 'EXTRAREMOTEFAKE'], {
        stdinMode,
      });
      expect(run.status).not.toBe(0);
      expect(run.status).not.toBeNull();
      expect(run.sshCalls).toBe(1);
      expect(readFileSync(f.target, 'utf8')).toBe(NODE_BEFORE);
      expect(mode(f.target)).toBe(0o600);
      expect(readdirSync(f.nodeDirectory)).toEqual(['staging.env']);
    });
  },
);

it.each([
  { name: '源文件权限 644', text: VALID_SOURCE, sourceMode: 0o644, values: [ID, SECRET, ENDPOINT] },
  {
    name: 'ID 含 -',
    text: sourceWith({ [ID_KEY]: 'IDFAKE-123mno' }),
    sourceMode: 0o600,
    values: ['IDFAKE-123mno', SECRET, ENDPOINT],
  },
  {
    name: '缺接入点键',
    text: sourceWith({ [ENDPOINT_KEY]: null }),
    sourceMode: 0o600,
    values: [ID, SECRET],
  },
])(
  '[AC-B1-01zzu#9] --apply 本地核对不过（$name）→ exit 1、check: failed、不调用 ssh、目标不变',
  ({ text, sourceMode, values }) => {
    fixture((f) => {
      writeMode(f.source, text, sourceMode);
      writeMode(f.target, NODE_BEFORE, 0o600);
      const run = sync(f, ['--apply', DESTINATION, '--identity', f.identity], values);
      expectCheckFailed(run);
      expect(run.sshStdin).toBeNull();
      expect(readFileSync(f.target, 'utf8')).toBe(NODE_BEFORE);
      expect(readdirSync(f.nodeDirectory)).toEqual(['staging.env']);
    });
  },
);

it.each([
  { name: '无参数', args: [] as string[] },
  { name: '--apply 缺目的地', args: ['--apply'] },
  { name: '未知参数', args: ['--frobnicate'] },
  { name: '--check 带多余参数', args: ['--check', DESTINATION] },
  { name: '--check 与 --apply 同用', args: ['--apply', DESTINATION, '--check'] },
  { name: '--apply 多一个位置参数', args: ['--apply', DESTINATION, 'extra'] },
  { name: '--identity 缺文件名', args: ['--apply', DESTINATION, '--identity'] },
])('[AC-B1-01zzu#10] 用法错误（$name）→ exit 2、不调用 ssh、目标不变', ({ args }) => {
  fixture((f) => {
    writeMode(f.source, VALID_SOURCE, 0o600);
    writeMode(f.target, NODE_BEFORE, 0o600);
    const run = sync(f, args, [ID, SECRET, ENDPOINT]);
    expect(run.status).toBe(2);
    expect(run.sshCalls).toBe(0);
    expect(readFileSync(f.target, 'utf8')).toBe(NODE_BEFORE);
  });
});

it('[AC-B1-01zzu#12] 节点上生成临时文件时写到一半失败（如磁盘满）：非零退出、不报成功、目标逐字不变、不留备份与临时文件（Codex r1 S1）', () => {
  fixture((f) => {
    // New values much longer than the old ones: the backup (a copy of the target) fits under the
    // limit, the new file does not, and its write fails among the lines after the three keys.
    const longId = 'IDLONGFAKE'.repeat(120);
    const longSecret = 'SKLONGFAKE'.repeat(120);
    writeMode(
      f.source,
      `${ID_KEY}=${longId}\n${SECRET_KEY}=${longSecret}\n${ENDPOINT_KEY}=${ENDPOINT}\n`,
      0o600,
    );
    const filler = Array.from(
      { length: 30 },
      (_, i) => `OTHER_SETTING_${String(i).padStart(2, '0')}=${'x'.repeat(80)}`,
    );
    const before = [
      `${ID_KEY}=${OLD_ID}`,
      `${SECRET_KEY}=OLDSKFAKE333`,
      `${ENDPOINT_KEY}=${OLD_ENDPOINT}`,
      `DATABASE_URL=postgres://couli:${NODE_PASSWORD}@db:5432/couli`,
      ...filler,
      '',
    ].join('\n');
    writeMode(f.target, before, 0o600);
    const limitKb = 4;
    expect(Buffer.byteLength(before), 'the backup must fit under the limit').toBeLessThan(
      limitKb * 1024,
    );
    expect(
      Buffer.byteLength(before) + longId.length + longSecret.length,
      'the new file must not fit',
    ).toBeGreaterThan(limitKb * 1024 + 1024);
    const run = sync(f, ['--apply', DESTINATION], [longId, longSecret, ENDPOINT], {
      fsizeKb: limitKb,
    });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('apply: ');
    // Nothing of the node file may come back either: a failed buffered write must not be flushed
    // to the remote shell's standard output later (it would carry the file's other settings).
    expect(run.stdout).not.toContain('OTHER_SETTING_');
    expect(run.stderr).not.toContain('OTHER_SETTING_');
    expect(readFileSync(f.target, 'utf8')).toBe(before);
    expect(mode(f.target)).toBe(0o600);
    expect(readdirSync(f.nodeDirectory)).toEqual(['staging.env']);
  });
});

it('[AC-B1-01zzu#11] 脚本可执行、bash 语法通过、显式 set +x，文本里没有 set -x / xtrace', () => {
  const path = script();
  expect(statSync(path).mode & 0o111, 'script must be executable').not.toBe(0);
  const text = readFileSync(path, 'utf8');
  expect(text.split('\n')[0]).toMatch(/^#!.*\bbash\b/);
  expect(text).toMatch(/(^|[\s;])set \+x\b/m);
  expect(text).not.toMatch(/\bset\s+-[A-Za-z]*x/);
  expect(text).not.toMatch(/\bbash\s+-[A-Za-z]*x/);
  expect(text).not.toContain('xtrace');
  const syntax = spawnSync('/bin/bash', ['-n', path], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(syntax.status, syntax.stderr).toBe(0);
});
