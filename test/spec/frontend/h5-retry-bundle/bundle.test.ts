// DSX-47a (FU-H5-RETRY-BUNDLE): the App entry's route bundles get 5 KiB of headroom under the frozen
// 150 KiB limit of test/spec/frontend/h5-shell/entries.test.ts ([AC-F1-01c-BUILD#1]), so that
// components/retry/retry-page.tsx can use the base Button. Measured exactly like that test: a
// `vite build --mode app` with apps/h5/vite.config.ts (write: false), for every lazily loaded chunk
// the static import closure of the entry chunk plus the static closure of that chunk, each chunk's
// code gzipped on its own (gzipSync) and summed.
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { REPO, repoPath } from './support.ts';

afterEach(() => vi.unstubAllEnvs());

/** Builds are slow; the one App build is shared by the tests of this file. */
const TIMEOUT = 120_000;
/** The find-order claim form (找回订单), the heaviest route at DSX-47 (about 149.5 KiB). */
const CLAIM_FORM = /\/entries\/app\/pages\/find-order\/claim-form\.tsx(?:\?|$)/;

async function buildApp() {
  const result = await build({
    configFile: resolve(REPO, 'apps/h5/vite.config.ts'),
    mode: 'app',
    logLevel: 'silent',
    build: { write: false },
  });
  expect(Array.isArray(result)).toBe(false);
  expect('output' in result).toBe(true);
  if (!('output' in result)) throw new Error('unreachable after output assertion');
  return result.output;
}

type Output = Awaited<ReturnType<typeof buildApp>>;
type Chunk = Extract<Output[number], { type: 'chunk' }>;

let pending: Promise<Output> | undefined;

function appOutput(): Promise<Output> {
  vi.stubEnv('APP_ENV', 'staging');
  pending ??= buildApp();
  return pending;
}

interface RouteSize {
  /** Repo-relative module behind the lazy chunk (or its file name). */
  route: string;
  /** gzip bytes of entry closure + route closure. */
  bytes: number;
  /** Module ids bundled in those chunks. */
  modules: string[];
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
    const modules = files.flatMap((file) => Object.keys(byFile.get(file)?.modules ?? {}));
    const facade = chunk.facadeModuleId;
    return { route: facade === null ? chunk.fileName : repoPath(facade), bytes, modules };
  });
}

function overLimit(sizes: readonly RouteSize[]): string[] {
  return sizes
    .filter((size) => size.bytes > 145 * 1024)
    .map((size) => `${size.route}: ${size.bytes} B gzip > ${145 * 1024} B`);
}

it(
  '[AC-DSX-47a-BUNDLE#1] App 入口每个懒加载路由的「入口静态闭包 + 路由静态闭包」JS gzip 都 ≤ 145 KiB（冻结上限 150 KiB 再留 5 KiB 余量）',
  async () => {
    const sizes = routeSizes(await appOutput());
    expect(overLimit(sizes), 'lazy routes over 145 KiB gzip').toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-DSX-47a-BUNDLE#2] 找回订单 claim-form 所在路由的「入口 + 路由」JS gzip ≤ 145 KiB',
  async () => {
    const sizes = routeSizes(await appOutput());
    const claimForm = sizes.filter((size) => size.modules.some((id) => CLAIM_FORM.test(id)));
    expect(claimForm.length, 'routes that load pages/find-order/claim-form.tsx').toBeGreaterThan(0);
    expect(overLimit(claimForm), 'claim-form routes over 145 KiB gzip').toEqual([]);
  },
  TIMEOUT,
);
