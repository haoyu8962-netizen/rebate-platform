import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../packages/domain/scripts/state-machines.ts';
import { GENERATED, SOURCE, readRequired, repoFile, yamlText } from './kit.ts';

async function fixture(): Promise<string> {
  // 先红先断言缺失资产；不能让文件复制或子进程用 ENOENT 代替业务断言。
  yamlText();
  readRequired(GENERATED);
  expect(MACHINES).toContain('union-binding');
  const files = MACHINES.flatMap((name) => [
    `specs/state-machines/${name}.yaml`,
    `packages/domain/src/state-machines/${name}.gen.ts`,
  ]).map((path) => ({ path, text: readRequired(path) }));
  const parent = fileURLToPath(repoFile('.tmp/CT-10a/'));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'generator-'));
  try {
    for (const { path, text } of files) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    for (const path of ['packages/domain/scripts/state-machines.ts', 'tools/lib/yaml-lite.ts']) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await cp(repoFile(path), join(root, path));
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function run(root: string, verify: boolean): number | null {
  const child = spawnSync(
    process.execPath,
    [join(root, 'packages/domain/scripts/state-machines.ts'), ...(verify ? ['--verify'] : [])],
    { cwd: root, encoding: 'utf8', timeout: 10_000 },
  );
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  expect(child.status, child.stderr).not.toBeNull();
  return child.status;
}

async function snapshot(root: string): Promise<Record<string, { text: string; mtime: number }>> {
  const files: Record<string, { text: string; mtime: number }> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path] = { text: await readFile(path, 'utf8'), mtime: (await stat(path)).mtimeMs };
  }
  return files;
}

it('[CT-10a#16] 含 union-binding 的全部当前生成物 --verify 退出 0，不改任何文件', async () => {
  const root = await fixture();
  try {
    const before = await snapshot(root);
    expect(run(root, true)).toBe(0);
    expect(await snapshot(root)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['source-changed', 'missing', 'stale'])(
  '[CT-10a#16] union-binding %s 时 --verify 退出 1 且不修复，生成后恢复',
  async (mode) => {
    const root = await fixture();
    try {
      let source = yamlText();
      if (mode === 'source-changed') {
        const changed = source.replace(/^(\s*guard:)\s*[^\r\n]+/m, "$1 'changed guard text'");
        expect(changed).not.toBe(source);
        source = changed;
        await writeFile(join(root, SOURCE), source);
      } else if (mode === 'missing') {
        await rm(join(root, GENERATED));
      } else {
        await writeFile(join(root, GENERATED), '// stale union-binding fixture\n');
      }
      const before = await snapshot(root);
      expect(run(root, true)).toBe(1);
      expect(await snapshot(root)).toEqual(before);
      expect(run(root, false)).toBe(0);
      expect(existsSync(join(root, GENERATED))).toBe(true);
      expect(await readFile(join(root, GENERATED), 'utf8')).toBe(renderStateMachine(source));
      expect(await readFile(join(root, SOURCE), 'utf8')).toBe(source);
      const repaired = await snapshot(root);
      for (const [path, contents] of Object.entries(before)) {
        if (path !== join(root, GENERATED)) expect(repaired[path]).toEqual(contents);
      }
      expect(run(root, true)).toBe(0);
      expect(await snapshot(root)).toEqual(repaired);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
