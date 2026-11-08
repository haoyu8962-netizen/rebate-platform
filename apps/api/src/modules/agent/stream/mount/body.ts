// B3-05m: the one assembly of the agent run body, shared by the stream entry
// (createAgentStreamRuntime) and the local evaluation (orchestrator/eval/local.ts), so the two can
// never drift (BR-AI-21: the replayed agent is the production agent). Callers supply the
// infrastructure ports (model, tools, input check, review, texts, prompt, route and, on the
// stream entry's business assembly (B3-03j), the deterministic path and the intent port); this
// file owns the factories and fixed parts: createAgentRunBody over B3-05c createDegradedPath on the
// same tools and texts, orchestratorLimitsDefaults(), traceMask = maskForTrace∘restorePlaceholders
// (followup 22), and the run labels over the same route and prompt (createRunLabels).
// Production passes no onTrace: its run trace is the core's RunTraceSink (AgentRunBodyDeps.trace)
// plus the written card frames (./trace.ts, B3-08q); the evaluation wires its toolTrace there.
import type { AgentRunLabels, RunBodyInput } from '../../http/index.ts';
import {
  createAgentRunBody,
  createRunLabels,
  orchestratorLimitsDefaults,
} from '../../orchestrator/index.ts';
import { createDegradedPath } from '../../orchestrator/degraded/index.ts';
import type { AgentRunBodyDeps, ToolTraceFragment } from '../../orchestrator/core/ports.ts';
import type { ResolvedRoute } from '../../model-gateway/routing/index.ts';
import { maskForTrace, restorePlaceholders } from '../../preprocess/redact/index.ts';
import type { RunBody } from '../run/index.ts';

/** Shared assembly seam for stream production and local evaluations. Factories, limits,
 * text handling and trace masking have one owner; callers supply infrastructure ports.
 */
export interface AgentBodyAssemblyDeps extends Omit<
  AgentRunBodyDeps,
  'degraded' | 'limits' | 'traceMask'
> {
  errorMsg(appId: string, code: number): Promise<string>;
  onTrace?: (fragment: ToolTraceFragment) => void;
  /** The route the model port follows; the labels predict its first entry. */
  route(appId: string): Promise<ResolvedRoute>;
}

export interface AgentBodyAssembly {
  body(input: RunBodyInput): RunBody;
  traceMask(args: unknown, placeholders: Readonly<Record<string, string>>): unknown;
  /** meta prompt_version / model_label / ai_label over the same route and prompt. */
  readonly labels: AgentRunLabels;
}

/** Shown as meta.model_label when no model is routed (the stream entry's fixed route). */
function noModelLabel(): string {
  return '未调用模型';
}

export function createAgentBodyAssembly(deps: AgentBodyAssemblyDeps): AgentBodyAssembly {
  const { errorMsg, onTrace, route, ...ports } = deps;
  const traceMask = (args: unknown, table: Readonly<Record<string, string>>): unknown =>
    maskForTrace(restorePlaceholders(args, table));
  const degraded = createDegradedPath({
    tools: ports.tools,
    texts: ports.texts,
    errorMsg,
    ...(onTrace === undefined ? {} : { onTrace }),
  });
  const body = createAgentRunBody({
    ...ports,
    degraded,
    limits: orchestratorLimitsDefaults(),
    traceMask,
  });
  const labels = createRunLabels({
    route,
    prompt: ports.prompt,
    // A nonempty meta.model_label is required by the frame contract, also without a model.
    modelLabel: async (_appId, snapshot) => snapshot ?? noModelLabel(),
    aiLabel: (appId) => ports.texts.text(appId, 'ai_label'),
  });
  return { body, traceMask, labels };
}
