// B1-06zm (CT-10a; approvals #26 superseded): linking's binding-status-transitions.ts stays as the
// thin forwarder CT-10a's compat test imports, but no longer carries a transition table of its own;
// the「blocked on CT-10」TODOs are gone from every writer.
import { expect, it } from 'vitest';
import { CT10_TODO_FILES, TRANSITIONS_FILE, code, source } from './kit.ts';

it('[AC-B1-06zm#1] binding-status-transitions.ts 只转发生成物：从 @couli/domain 导入 transitionUnionBinding，不再自带 NEXT 表或状态到状态的字面映射', () => {
  const text = code(TRANSITIONS_FILE);
  expect(text).toMatch(
    /import\s*\{[^}]*\btransitionUnionBinding\b[^}]*\}\s*from\s*['"]@couli\/domain['"]/,
  );
  expect(text).not.toMatch(/\bNEXT\b/);
  expect(text).not.toMatch(/Record<\s*BindingStatus\s*,\s*readonly\s+BindingStatus\s*\[\s*\]\s*>/);
  // A status key followed by a list of statuses (`active: ['invalid', …]`, `Object.freeze([…])`).
  expect(text).not.toMatch(
    /\b(?:unbound|pending_auth|active|invalid|blocked|released)['"]?\s*:\s*(?:Object\.freeze\(\s*)?\[/,
  );
});

it.each(CT10_TODO_FILES)(
  '[AC-B1-06zm#2] %s 不再带「换用生成的 transition() — blocked on CT-10」TODO',
  (path) => {
    const text = source(path);
    expect(text).not.toContain('blocked on CT-10');
    expect(text).not.toMatch(/TODO\(规划\/11 §4\.5\):\s*换用生成的 transition\(\)/);
  },
);
