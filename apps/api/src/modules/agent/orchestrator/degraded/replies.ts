// B3-05n: fixed replies shared by the keyword path (createDegradedPath) and the routed path
// (routing.ts). Copy comes from the run texts by key; the keys A9 adds to the dictionary
// (agent.reply.empty, agent.suggest.empty.1–3) fall back to 08 BR-TEXT-22's defaults while the
// dictionary has no entry (a lookup that fails, is empty or answers the key itself).
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type { AgentRunTexts } from '../core/ports.ts';

type Done = Extract<RunBodyResult, { kind: 'done' }>;

/** 08 BR-TEXT-22 defaults of the keys added on 2026-11-12. */
const PENDING_DEFAULTS: Readonly<Record<string, string>> = {
  'agent.reply.empty': '没太听明白。可以说说想买什么，或者把商品链接发给我。',
  'agent.suggest.empty.1': '帮我找蓝牙耳机',
  'agent.suggest.empty.2': '查一下我的订单',
  'agent.suggest.empty.3': '怎么联系客服',
};

export function welcomeKey(): string {
  return 'agent.welcome';
}

export function replyEmptyKey(): string {
  return 'agent.reply.empty';
}

export function prohibitedKey(): string {
  return 'agent.refuse.prohibited';
}

export function degradedEmptyKey(): string {
  return 'agent.degraded.empty';
}

function suggestKeys(): readonly string[] {
  return [1, 2, 3].map((n) => `agent.suggest.empty.${n}`);
}

export async function copyOf(
  texts: Pick<AgentRunTexts, 'text'>,
  appId: string,
  key: string,
): Promise<string> {
  const fallback = PENDING_DEFAULTS[key];
  if (fallback === undefined) return texts.text(appId, key);
  try {
    const text = await texts.text(appId, key);
    return typeof text === 'string' && text !== '' && text !== key ? text : fallback;
  } catch {
    return fallback;
  }
}

export async function noticeCard(
  texts: Pick<AgentRunTexts, 'text'>,
  appId: string,
  key: string,
): Promise<UnnumberedCard> {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: key, actions: [] },
    fallback_text: await copyOf(texts, appId, key),
  };
}

/**
 * BR-AI-14 细则 ⑥: nothing left to search. Only greetings → agent.welcome, anything else →
 * agent.reply.empty; both with the three quick questions agent.suggest.empty.1–3, done stop.
 */
export async function emptyReply(
  texts: Pick<AgentRunTexts, 'text'>,
  appId: string,
  ctx: RunContext,
  greeting: boolean,
): Promise<Done> {
  const text = await copyOf(texts, appId, greeting ? welcomeKey() : replyEmptyKey());
  if (ctx.signal.aborted) return { kind: 'done', finishReason: 'stop' };
  const items: { text: string; send_text: string }[] = [];
  for (const key of suggestKeys()) {
    const item = await copyOf(texts, appId, key);
    items.push({ text: item, send_text: item });
  }
  if (ctx.signal.aborted) return { kind: 'done', finishReason: 'stop' };
  ctx.text(text);
  ctx.suggestions(items);
  return { kind: 'done', finishReason: 'stop' };
}

/** BR-AI-18: a prohibited query or a result set emptied by the category blocklist. */
export function isProhibited(cards: readonly UnnumberedCard[]): boolean {
  return cards.some((card) => card.type === 'notice' && card.data['text_key'] === prohibitedKey());
}
