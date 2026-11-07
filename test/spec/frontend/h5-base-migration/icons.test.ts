// DSX-47 (规划/05 §3.11.3, 编排 D10-837 ②): the chevron, document and alert icons that pages each
// drew for themselves are defined once, in a shared module outside the page entries (for example
// apps/h5/src/components/icons), and pages import that one. Static scan of the non-test sources
// under apps/h5/src/**.
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  H5_ENTRIES,
  H5_SRC,
  isUnder,
  lineAt,
  parse,
  readRepo,
  sourceFiles,
  walk,
} from './support.ts';

interface SharedIcon {
  /** Component name the pages use today. */
  name: string;
  /** Path data that draws it (the same in every copy today). */
  path: string;
}

const ICONS: readonly SharedIcon[] = [
  { name: 'ChevronIcon', path: 'm9.5 6 6 6-6 6' },
  { name: 'DocumentIcon', path: 'M7 3.5h7l4 4v13H7v-17Z' },
  { name: 'AlertIcon', path: 'M12 7.5v5.5M12 16.2v.3' },
];

/** `file:line` of every function, class or variable declared with `name`. */
function declarations(files: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (const file of files) {
    const source = parse(file);
    walk(source, (node) => {
      const declared =
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name
          ? node
          : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
            ? node
            : undefined;
      if (declared !== undefined) out.push(`${file}:${lineAt(source, declared)}`);
    });
  }
  return out;
}

it('[AC-DSX-47-ICON#1] Chevron / Document / Alert 图标组件在 apps/h5/src 只声明一处，且在页面入口目录之外', () => {
  const files = sourceFiles(H5_SRC);
  const problems: string[] = [];
  for (const icon of ICONS) {
    const found = declarations(files, icon.name);
    if (found.length !== 1)
      problems.push(`${icon.name} declared ${found.length}×: ${found.join(', ')}`);
    for (const where of found) {
      if (isUnder(where, H5_ENTRIES))
        problems.push(`${icon.name} declared in a page entry: ${where}`);
    }
  }
  expect(problems).toEqual([]);
});

it('[AC-DSX-47-ICON#2] 这三种图标的路径数据在 apps/h5/src 只出现在一个文件里，且不在页面入口目录下（页面不再手写）', () => {
  const files = sourceFiles(H5_SRC);
  const problems: string[] = [];
  for (const icon of ICONS) {
    const holders = files.filter((file) => readRepo(file).includes(icon.path));
    if (holders.length !== 1)
      problems.push(`${icon.name} path drawn in ${holders.length} files: ${holders.join(', ')}`);
    for (const file of holders) {
      if (isUnder(file, H5_ENTRIES))
        problems.push(`${icon.name} path drawn in a page entry: ${file}`);
    }
  }
  expect(problems).toEqual([]);
});
