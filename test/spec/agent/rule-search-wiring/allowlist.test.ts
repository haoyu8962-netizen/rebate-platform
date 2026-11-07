// B3-08l · BR-AI-02 ① ②: specs/agent-tools.allowlist after search_rules is wired (static: no
// database, no Nest). The production assembly's registered set is compared with the same file in
// search.int.test.ts ([AC-B3-08l#1]).
import { expect, it } from 'vitest';
import { DENYLIST, allowlistNames, allowlistText } from '../stream-assembly-orders/scan.ts';
import { TOOLS } from './kit.ts';

it('[AC-B3-08l#1][BR-AI-02] specs/agent-tools.allowlist 行集合 = 7 个 MVP 工具（含 search_rules），无重复、不含 get_my_earnings 与内部步骤 / 意图，不命中 denylist', () => {
  const names = allowlistNames();
  expect([...names].sort()).toEqual([...TOOLS].sort());
  expect(names).toContain('search_rules');
  expect(new Set(names).size, 'no duplicate line').toBe(names.length);
  for (const name of [
    'get_my_earnings',
    'parse_input',
    'resolve_link',
    'register_links',
    'clarify',
    'page_guide',
    'create_watch',
    'list_watches',
    'cancel_watch',
  ]) {
    expect(names, name).not.toContain(name);
  }
  expect(allowlistText()).not.toMatch(DENYLIST);
});
