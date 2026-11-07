// B3-08l (FU-AGENT-SEARCH-RULES-WIRING): the two stale notes the wiring makes untrue are gone, and
// the composition root takes the sync's articles and app list from content's read-only entry
// instead of querying app.articles itself (source scan; no database).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(
    new URL(`../../../../apps/api/src/modules/agent/${path}`, import.meta.url),
    'utf8',
  );
}

it('[AC-B3-08l#6] rag/chunks/sync.ts 不再含「blocked on B3-08g」陈旧 TODO（B3-08g 已完成、同步已接线）', () => {
  const text = source('rag/chunks/sync.ts');
  expect(text).toContain('export async function syncRuleChunks');
  expect(text).not.toContain('blocked on B3-08g');
  expect(text).not.toContain('wiring with B3-08g');
});

it('[AC-B3-08l#4] 组合根 app.module.ts 经 content 只读入口装同步的文章与 app 列表（createPublishedArticlesReader、createPublishedArticleAppsReader），自己不查 app.articles', () => {
  const text = readFileSync(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url),
    'utf8',
  );
  expect(text).toContain('createPublishedArticlesReader');
  expect(text).toContain('createPublishedArticleAppsReader');
  expect(text).not.toMatch(/selectFrom\(\s*['"`](app\.)?articles\b/);
  expect(text).not.toMatch(/\bfrom\s+app\.articles\b/i);
});

it('[AC-B3-08l#6] stream/mount/assembly.ts 不再含「search_rules waits for its data source」陈旧注释（search_rules 已注册）', () => {
  const text = source('stream/mount/assembly.ts');
  expect(text).toContain('export function createAgentStreamAssembly');
  expect(text).not.toContain('search_rules waits for its data source');
});
