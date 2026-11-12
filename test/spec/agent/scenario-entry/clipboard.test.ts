// B3-05q · BR-AI-01 细则「情境入口」context.text（剪贴板文本，首版不用）: a message carrying it is
// handled as one without context — the text is not read, not stored, not given to the model. Here:
// nothing the run hands to the model, to a data port (call contexts included), to the review, to
// the trace or to the logger contains the clipboard text, and the reply equals the same message's
// without context. Storage is checked against PostgreSQL in clipboard.int.test.ts.
import { expect, it } from 'vitest';
import { content, comparable, kit, says, serialized, typesOf, type Step } from './kit.ts';

const CLIPBOARD = '合成剪贴板原文-请勿读取-Q7X';
const QUESTION = '帮我找合成纸巾';
const STEPS: readonly Step[] = [
  { calls: [{ name: 'search_products', args: { q: '合成纸巾' } }] },
  says('找到几款纸巾，可以看看卡片。'),
];

async function answer(mode: 'model' | 'no_model', context?: Readonly<Record<string, unknown>>) {
  const h = kit();
  if (mode === 'no_model') h.state.noModel = true;
  else h.say(QUESTION, STEPS);
  const view = await h.run(QUESTION, context === undefined ? {} : { context });
  return { h, view };
}

it.each(['model', 'no_model'] as const)(
  '[AC-B3-05q#16][BR-AI-01][BR-ID-16] 带 context.text 的消息（%s）按没有 context 处理：模型输入、各端口收到的调用（含调用上下文）、审核、留痕与日志里都没有剪贴板原文，答复与不带 context 的同一条消息相同',
  async (mode) => {
    const plain = await answer(mode);
    const clipped = await answer(mode, { text: CLIPBOARD });

    // The run did search (so the call contexts below were really handed out).
    expect(clipped.h.searchProducts).toHaveBeenCalled();
    expect(clipped.h.cards).toHaveBeenCalled();
    expect(serialized(clipped.h.complete.mock.calls)).not.toContain(CLIPBOARD);
    expect(serialized(clipped.h.received())).not.toContain(CLIPBOARD);
    expect(serialized(clipped.view.events)).not.toContain(CLIPBOARD);

    expect(clipped.view.result).toEqual(plain.view.result);
    expect(typesOf(clipped.view)).toEqual(typesOf(plain.view));
    expect(clipped.view.text).toBe(plain.view.text);
    // Same frames apart from card numbers and server-made ids of the result sets.
    expect(comparable(content(clipped.view)).length).toBe(comparable(content(plain.view)).length);
  },
);
