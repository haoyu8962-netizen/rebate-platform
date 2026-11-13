// B3-05q · BR-AI-01 细则「情境入口」: context.text (剪贴板文本) is not used in the first version. A
// message carrying it is handled as one without it: not read, not stored, not given to the model
// (BR-ID-16). The HTTP layer drops it before the run input exists, the orchestrator core once more
// for any other caller of the run body. No imports: shared by http and orchestrator/core.

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The context without its `text` member; undefined when nothing else is left. */
export function contextWithoutClipboard(
  context: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(context) || !Object.hasOwn(context, 'text')) return context;
  const rest = Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'text'));
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/** `input` with contextWithoutClipboard applied (the same object when there is no text). */
export function withoutClipboard<
  T extends { readonly context?: Readonly<Record<string, unknown>> },
>(input: T): T {
  const context = input.context;
  const kept = contextWithoutClipboard(context);
  if (kept === context) return input;
  const { context: dropped, ...rest } = input;
  void dropped;
  return (kept === undefined ? rest : { ...rest, context: kept }) as T;
}
