// DSX-48c: static reads of the H5 sources. The image component lives under components/base and is
// exported from base/index.ts; its source writes no Chinese (texts come from the dictionary or from
// the caller). The article body and the invite page render their images only through it: no raw
// <img> JSX is left in article-body.tsx or invite-page.tsx.
import { expect, it } from 'vitest';
import ts from 'typescript';
import { CJK, IMAGE_EXPORT } from './contract.ts';
import { ARTICLE_BODY, INVITE_PAGE, imageModule, parse, walk } from './node-kit.ts';

/** Every string, template part and JSX text of a TS / TSX source. */
function literalTexts(source: ts.SourceFile): string[] {
  const out: string[] = [];
  walk(source, (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push(node.text);
    }
  });
  return out;
}

/** Tag names of the intrinsic JSX elements a source renders. */
function jsxTags(source: ts.SourceFile): string[] {
  const out: string[] = [];
  walk(source, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      out.push(node.tagName.getText(source));
    }
  });
  return out;
}

/** Names a source imports from components/base/index.ts. */
function baseImports(source: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!/components\/base\/index\.ts$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) out.push((element.propertyName ?? element.name).text);
  }
  return out;
}

it('[AC-DSX-48c-SOURCE#1] base/index.ts 从 components/base 下的模块转出 AsyncImage，该模块源码不写死中文', () => {
  const file = imageModule();
  expect(file, `apps/h5/src/components/base/index.ts re-exports ${IMAGE_EXPORT}`).not.toBeNull();
  expect(file!.startsWith('apps/h5/src/components/base/')).toBe(true);
  const chinese = literalTexts(parse(file!)).filter((text) => CJK.test(text));
  expect(chinese, `${file}: inline Chinese`).toEqual([]);
});

it('[AC-DSX-48c-SOURCE#2] 正文 article-body.tsx 与邀请页 invite-page.tsx 从 base/index.ts 引入 AsyncImage，不再直接渲染 <img>', () => {
  for (const file of [ARTICLE_BODY, INVITE_PAGE]) {
    const source = parse(file);
    expect(baseImports(source), `${file} imports from components/base/index.ts`).toContain(
      IMAGE_EXPORT,
    );
    expect(jsxTags(source), `${file} raw <img>`).not.toContain('img');
  }
});
