// DSX-48d (编排 D10-1032 ⑦): the H5 transitions cost every App route at most 3 KiB gzip, and every
// route stays under the frozen 150 KiB of test/spec/frontend/h5-shell/entries.test.ts
// ([AC-F1-01c-BUILD#1]).
//
// Measured like that test, h5-retry-bundle/bundle.test.ts and h5-image/bundle.test.ts: a
// `vite build --mode app` with apps/h5/vite.config.ts (write: false); for every lazily loaded
// chunk, the static import closure of the entry chunk plus the static closure of that chunk, each
// chunk's code gzipped on its own (gzipSync) and summed.
//
// Main-branch baseline, in the same run (the container has no .git, so `git show` is not
// available): a second build of the same tree in which every file under the task's paths
// (apps/h5/src/components/base/**, apps/h5/src/shared/** and
// apps/h5/src/entries/app/pages/find-order/**, the only paths the implementation may change) is
// served from its main-branch copy in ./trunk/<repo path>.txt (main b9f5a222a, 2026-11-09; the
// .ts / .tsx / .css sources, unit tests left out). Relative imports that land in those paths are
// resolved against the copies (so a file the implementation added, moved or deleted does not
// matter), and the trimmed text dictionary of the baseline is collected from a scratch copy of
// apps/h5/src holding the main-branch files (the trim-texts plugin reads the work tree from disk).
// The first test checks the baseline really read every bundled module under those paths from
// ./trunk/. On main both builds would be equal, so each test first asserts that the transitions
// are in (components/base or shared reference the motion tokens they need, as
// [AC-DSX-48d-SOURCE#1]); on main the tests are red at that assertion and no build starts.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'vite';
import { collectH5Texts, type TrimTextDictionary } from '../../../../apps/h5/build/trim-texts.ts';
import { HERE, REPO, missingTokens, repoPath } from './node-kit.ts';

afterEach(() => vi.unstubAllEnvs());

/** Two App builds run in this file. */
const TIMEOUT = 300_000;
const LIMIT = 150 * 1024;
const INCREASE = 3 * 1024;

const SHARED = ['apps/h5/src/components/base', 'apps/h5/src/shared'];

/** The paths the implementation may change (task ledger `paths`), repo relative. */
const TASK_PATHS = [
  'apps/h5/src/components/base/',
  'apps/h5/src/shared/',
  'apps/h5/src/entries/app/pages/find-order/',
] as const;

/** Files the transitions touch first; the baseline must serve each of them from ./trunk/. */
const CORE_FILES = [
  'apps/h5/src/components/base/index.ts',
  'apps/h5/src/components/base/ModalFrame.tsx',
  'apps/h5/src/components/base/Dialog.tsx',
  'apps/h5/src/components/base/Sheet.tsx',
  'apps/h5/src/components/base/Toast.tsx',
  'apps/h5/src/components/base/Tabs.tsx',
  'apps/h5/src/entries/app/pages/find-order/find-order-page.tsx',
  'apps/h5/src/entries/app/pages/find-order/claim-records.tsx',
];

const SOURCE_ROOT = 'apps/h5/src';
const DICTIONARY = 'contracts/texts.default.json';
/** Query of the dictionary import the trim-texts plugin replaces (apps/h5/build/trim-texts-plugin.ts). */
const TEXTS_QUERY = 'h5-texts';

/** Main-branch copies: ./trunk/<repo path>.txt. */
const TRUNK_DIR = resolve(HERE, 'trunk');
const COPY_SUFFIX = '.txt';
/** How a relative import without an extension finds its file (as the H5 sources write them). */
const IMPORT_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function isTaskPath(path: string): boolean {
  return TASK_PATHS.some((prefix) => path.startsWith(prefix));
}

/** Repo path → absolute path of its main-branch copy, for every file under ./trunk/apps/. */
function trunkCopies(): Map<string, string> {
  const copies = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (name.endsWith(COPY_SUFFIX)) {
        const path = relative(TRUNK_DIR, full).split(sep).join('/');
        copies.set(path.slice(0, -COPY_SUFFIX.length), full);
      }
    }
  };
  const root = join(TRUNK_DIR, 'apps');
  if (existsSync(root)) visit(root);
  return copies;
}

/**
 * The dictionary subset the trim-texts plugin keeps when apps/h5/src holds the main-branch
 * copies: the collector runs over a scratch copy of apps/h5/src whose task paths are replaced by
 * the copies.
 */
function baselineTexts(copies: ReadonlyMap<string, string>): TrimTextDictionary {
  const scratch = mkdtempSync(join(tmpdir(), 'dsx-48d-trunk-'));
  try {
    const root = join(scratch, 'src');
    cpSync(resolve(REPO, SOURCE_ROOT), root, { recursive: true });
    const inRoot = (path: string): string => join(root, path.slice(SOURCE_ROOT.length + 1));
    for (const prefix of TASK_PATHS) rmSync(inRoot(prefix), { recursive: true, force: true });
    for (const [path, copy] of copies) {
      const target = inRoot(path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(copy));
    }
    const dictionary = JSON.parse(
      readFileSync(resolve(REPO, DICTIONARY), 'utf8'),
    ) as TrimTextDictionary;
    return collectH5Texts({ sourceRoot: root, dictionary });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface Served {
  /** Task-path modules the baseline build read from ./trunk/. */
  copies: Set<string>;
  /** Task-path modules the baseline build found no copy for (read from the work tree). */
  fromTree: Set<string>;
  /** The baseline's trimmed dictionary came from the main-branch sources. */
  texts: boolean;
}

function trunkSources(
  copies: ReadonlyMap<string, string>,
  texts: TrimTextDictionary,
  served: Served,
): Plugin {
  const dictionaryFile = resolve(REPO, DICTIONARY);
  return {
    name: 'dsx-48d-trunk-sources',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined || !source.startsWith('.')) return null;
      const at = source.indexOf('?');
      const bare = at < 0 ? source : source.slice(0, at);
      const query = at < 0 ? '' : source.slice(at);
      const target = resolve(dirname(importer.split('?')[0] ?? importer), bare);
      for (const suffix of IMPORT_SUFFIXES) {
        const path = repoPath(target + suffix);
        if (copies.has(path)) return resolve(REPO, path) + query;
      }
      return null;
    },
    load(id) {
      const file = id.split('?')[0] ?? id;
      if (file.startsWith('\0')) return null;
      const path = repoPath(file);
      if (!isTaskPath(path)) return null;
      const copy = copies.get(path);
      if (copy === undefined) {
        served.fromTree.add(path);
        return null;
      }
      served.copies.add(path);
      return readFileSync(copy, 'utf8');
    },
    // Before Vite's JSON handling: the trimmed dictionary as the main-branch sources select it.
    transform(code, id) {
      const at = id.indexOf('?');
      if (at < 0 || id.slice(0, at) !== dictionaryFile) return null;
      if (!new URLSearchParams(id.slice(at + 1)).has(TEXTS_QUERY)) return null;
      served.texts = true;
      return { code: JSON.stringify(texts), map: null };
    },
  };
}

async function buildApp(plugins: Plugin[]) {
  const result = await build({
    configFile: resolve(REPO, 'apps/h5/vite.config.ts'),
    mode: 'app',
    logLevel: 'silent',
    plugins,
    build: { write: false },
  });
  expect(Array.isArray(result)).toBe(false);
  expect('output' in result).toBe(true);
  if (!('output' in result)) throw new Error('unreachable after output assertion');
  return result.output;
}

type Output = Awaited<ReturnType<typeof buildApp>>;
type Chunk = Extract<Output[number], { type: 'chunk' }>;

interface RouteSize {
  /** Repo-relative module behind the lazy chunk (or its file name). */
  route: string;
  /** gzip bytes of entry closure + route closure. */
  bytes: number;
}

interface Builds {
  current: RouteSize[];
  baseline: RouteSize[];
  /** Main-branch copies available in ./trunk/ (repo paths). */
  copies: string[];
  /** What the baseline build served. */
  served: Served;
  /** TS / TSX modules under the task paths bundled into the baseline's JS chunks. */
  bundled: string[];
}

function routeSizes(output: Output): RouteSize[] {
  const chunks = output.filter((item): item is Chunk => item.type === 'chunk');
  const entries = chunks.filter((item) => item.isEntry);
  expect(entries, 'one App entry chunk').toHaveLength(1);
  const byFile = new Map(chunks.map((item) => [item.fileName, item] as const));

  function staticClosure(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return seen;
    const chunk = byFile.get(file);
    expect(chunk, `local JS chunk ${file}`).toBeDefined();
    seen.add(file);
    for (const imported of chunk?.imports ?? []) staticClosure(imported, seen);
    return seen;
  }

  const initial = staticClosure(entries[0]?.fileName ?? '');
  const lazy = chunks.filter((item) => item.isDynamicEntry);
  expect(lazy.length, 'real lazy route chunks').toBeGreaterThan(0);
  return lazy.map((chunk) => {
    const files = [...new Set([...initial, ...staticClosure(chunk.fileName)])];
    const bytes = files.reduce(
      (size, file) => size + gzipSync(byFile.get(file)?.code ?? '').byteLength,
      0,
    );
    const facade = chunk.facadeModuleId;
    return { route: facade === null ? chunk.fileName : repoPath(facade), bytes };
  });
}

/** Task-path TS / TSX modules bundled into any JS chunk of `output`. */
function bundledTaskModules(output: Output): string[] {
  const paths = new Set<string>();
  for (const item of output) {
    if (item.type !== 'chunk') continue;
    for (const id of Object.keys(item.modules)) {
      const path = repoPath(id.split('?')[0] ?? id);
      if (isTaskPath(path) && /\.tsx?$/.test(path)) paths.add(path);
    }
  }
  return [...paths].sort();
}

let pending: Promise<Builds> | undefined;

async function buildBoth(): Promise<Builds> {
  const current = routeSizes(await buildApp([]));
  const copies = trunkCopies();
  const served: Served = { copies: new Set(), fromTree: new Set(), texts: false };
  const output = await buildApp([trunkSources(copies, baselineTexts(copies), served)]);
  return {
    current,
    baseline: routeSizes(output),
    copies: [...copies.keys()].sort(),
    served,
    bundled: bundledTaskModules(output),
  };
}

/** Both builds, once per file, run one after the other. */
function builds(): Promise<Builds> {
  vi.stubEnv('APP_ENV', 'staging');
  pending ??= buildBoth();
  return pending;
}

/** The transitions are in: components/base or shared reference the motion tokens they take. */
function expectTransitionsIn(): void {
  expect(
    missingTokens(SHARED),
    'motion tokens of the overlay transitions not referenced by components/base or shared',
  ).toEqual([]);
}

it(
  '[AC-DSX-48d-BUNDLE#1] 过渡已接入（base / shared 引用弹层与减弱动态令牌）；主干基线构建里 base / shared / 找回页三处路径下打进包的每个模块都读自 trunk 主干副本（无一读自工作区），字典裁剪也按主干源码，两次构建的懒加载路由相同',
  async () => {
    expectTransitionsIn();
    const { current, baseline, copies, served, bundled } = await builds();
    expect(
      copies.filter((path) => !isTaskPath(path) || !/\.(?:ts|tsx|css)$/.test(path)),
      'trunk copies outside the task paths or not .ts / .tsx / .css',
    ).toEqual([]);
    expect(
      CORE_FILES.filter((path) => !served.copies.has(path)),
      'core files not served from ./trunk/ in the baseline build',
    ).toEqual([]);
    expect(
      [...served.fromTree].sort(),
      'task-path modules the baseline build read from the work tree',
    ).toEqual([]);
    expect(bundled.length, 'task-path modules bundled in the baseline').toBeGreaterThan(0);
    expect(
      bundled.filter((path) => !served.copies.has(path)),
      'task-path modules bundled in the baseline but not served from ./trunk/',
    ).toEqual([]);
    expect(served.texts, 'baseline dictionary trimmed from the main-branch sources').toBe(true);
    expect(current.map((size) => size.route).sort(), 'same lazy routes as the baseline').toEqual(
      baseline.map((size) => size.route).sort(),
    );
  },
  TIMEOUT,
);

it(
  '[AC-DSX-48d-BUNDLE#2] 各 App 路由「入口 + 路由」JS gzip ≤ 150 KiB，且相对主干基线每条路由增量 ≤ 3 KiB',
  async () => {
    expectTransitionsIn();
    const { current, baseline } = await builds();
    const before = new Map(baseline.map((size) => [size.route, size.bytes] as const));
    expect(current.map((size) => size.route).sort(), 'same lazy routes as the baseline').toEqual(
      [...before.keys()].sort(),
    );
    const over = current
      .filter((size) => size.bytes > LIMIT)
      .map((size) => `${size.route}: ${size.bytes} B gzip > ${LIMIT} B`);
    expect(over, 'routes over 150 KiB gzip').toEqual([]);
    const grown = current
      .map((size) => ({ route: size.route, increase: size.bytes - (before.get(size.route) ?? 0) }))
      .filter((size) => size.increase > INCREASE)
      .map((size) => `${size.route}: +${size.increase} B gzip > ${INCREASE} B`);
    expect(grown, 'routes grown by more than 3 KiB gzip').toEqual([]);
  },
  TIMEOUT,
);
