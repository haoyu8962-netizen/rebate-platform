// DSX-48c (D10-1032): wiring the image component into the article body and the invite poster
// costs every App route at most 3 KiB gzip, and every route stays under the frozen 150 KiB of
// test/spec/frontend/h5-shell/entries.test.ts ([AC-F1-01c-BUILD#1]).
//
// Measured exactly like that test and h5-retry-bundle/bundle.test.ts: a `vite build --mode app`
// with apps/h5/vite.config.ts (write: false); for every lazily loaded chunk, the static import
// closure of the entry chunk plus the static closure of that chunk, each chunk's code gzipped on its
// own (gzipSync) and summed.
//
// Main-branch baseline, in the same run (the container has no .git, so `git show` is not
// available): a second build of the same tree in which the three files the wiring changes are
// served as their main-branch copies in ./trunk/ (main 0cac27eee, 2026-11-08): base/index.ts,
// article-body.tsx and invite-page.tsx. The image module is then unused and drops out, so
// "current − baseline" per route is what the wiring adds. On main itself both builds would be
// equal, so each test first asserts the wiring is there (base/index.ts re-exports AsyncImage and
// the article / invite routes bundle it): on main the tests are red at that assertion.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'vite';
import {
  ARTICLE_BODY,
  BASE_INDEX,
  HERE,
  INVITE_PAGE,
  REPO,
  imageModule,
  repoPath,
} from './node-kit.ts';

afterEach(() => vi.unstubAllEnvs());

/** Two App builds run in this file. */
const TIMEOUT = 300_000;
const LIMIT = 150 * 1024;
const INCREASE = 3 * 1024;

/** Main-branch copies served in the baseline build (repo path → file in this directory). */
const TRUNK: Readonly<Record<string, string>> = {
  [BASE_INDEX]: 'trunk/base-index.ts.txt',
  [ARTICLE_BODY]: 'trunk/article-body.tsx.txt',
  [INVITE_PAGE]: 'trunk/invite-page.tsx.txt',
};

function trunkSources(served: Set<string>): Plugin {
  return {
    name: 'dsx-48c-trunk-sources',
    enforce: 'pre',
    load(id) {
      const path = repoPath(id.split('?')[0] ?? id);
      const copy = TRUNK[path];
      if (copy === undefined) return null;
      served.add(path);
      return readFileSync(resolve(HERE, copy), 'utf8');
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
  /** Repo-relative module paths bundled in those chunks. */
  modules: Set<string>;
}

interface Builds {
  current: RouteSize[];
  baseline: RouteSize[];
  /** Main-branch copies the baseline build actually served. */
  served: Set<string>;
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
    const modules = new Set(
      files.flatMap((file) =>
        Object.keys(byFile.get(file)?.modules ?? {}).map((id) => repoPath(id.split('?')[0] ?? id)),
      ),
    );
    const facade = chunk.facadeModuleId;
    return { route: facade === null ? chunk.fileName : repoPath(facade), bytes, modules };
  });
}

let pending: Promise<Builds> | undefined;

async function buildBoth(): Promise<Builds> {
  const current = routeSizes(await buildApp([]));
  const served = new Set<string>();
  const baseline = routeSizes(await buildApp([trunkSources(served)]));
  return { current, baseline, served };
}

/** Both builds, once per file, run one after the other. */
function builds(): Promise<Builds> {
  vi.stubEnv('APP_ENV', 'staging');
  pending ??= buildBoth();
  return pending;
}

/** The image module re-exported by base/index.ts; asserted before any build. */
function wiredImageModule(): string {
  const file = imageModule();
  expect(file, `${BASE_INDEX} re-exports AsyncImage`).not.toBeNull();
  return file!;
}

/** Routes that bundle `module`. */
function routesWith(sizes: readonly RouteSize[], module: string): RouteSize[] {
  return sizes.filter((size) => size.modules.has(module));
}

/** The article-body and invite routes of the current build all bundle the image module. */
function expectWired(current: readonly RouteSize[], image: string): void {
  for (const page of [ARTICLE_BODY, INVITE_PAGE]) {
    const routes = routesWith(current, page);
    expect(routes.length, `routes that load ${page}`).toBeGreaterThan(0);
    expect(
      routes.filter((size) => !size.modules.has(image)).map((size) => size.route),
      `routes loading ${page} without ${image}`,
    ).toEqual([]);
  }
}

it(
  '[AC-DSX-48c-BUNDLE#1] 接入后正文与邀请页所在路由都打进图片件；主干基线构建（三处主干原文）服务了全部原文且任何路由都不含图片件',
  async () => {
    const image = wiredImageModule();
    const { current, baseline, served } = await builds();
    expectWired(current, image);
    expect([...served].sort(), 'main-branch copies served').toEqual(Object.keys(TRUNK).sort());
    expect(
      routesWith(baseline, image).map((size) => size.route),
      'baseline routes bundling the image module',
    ).toEqual([]);
    for (const page of [ARTICLE_BODY, INVITE_PAGE]) {
      const routes = routesWith(baseline, page);
      expect(routes.length, `baseline routes that load ${page}`).toBeGreaterThan(0);
    }
  },
  TIMEOUT,
);

it(
  '[AC-DSX-48c-BUNDLE#2] 各 App 路由「入口 + 路由」JS gzip ≤ 150 KiB，且相对主干基线每条路由增量 ≤ 3 KiB',
  async () => {
    const image = wiredImageModule();
    const { current, baseline } = await builds();
    expectWired(current, image);
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
