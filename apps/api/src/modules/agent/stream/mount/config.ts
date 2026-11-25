import type { ConfigValuesByKey, ContentConfig, ContentReader } from '../../../content/index.ts';
import type { Clock } from '../../../platform/index.ts';

// B3-08k (D10-294; rule tests: test/spec/agent/foreign-db-handoff/**): agent never builds another
// module's reader from its database handle. app.module (the composition root) assembles content's
// configuration reads and provides them as agentContentReaderToken() on the stream and worker
// entries; agent depends only on the reader interface (content's ContentReader type).
// createAgentConfigReader replaces createAgentSwitchReader with the same semantics and no handle.

/**
 * B3-08k: content's configuration reads as agent uses them, assembled by app.module.
 * configValue: content's process-wide reader (createContentReader over the primary handle, with
 *   its own cache): the consent version, the daily limits, every key other than agent.* and every
 *   read of the production assembly (search switches, page_guide routes, tool switches, review
 *   budget, order budget).
 * freshConfigValue: the config_items value and version of (appId, key) read anew on every call
 *   (no cache of its own; as createAgentSwitchReader's per-call createContentReader did); only
 *   createAgentConfigReader uses it, for agent.* keys (followup 23). Review r1 S1-2: app.module
 *   writes it in place as `(appId, key) => createContentReader({...}).configValue(appId, key)`
 *   (a reader built per call; rule test foreign-db-handoff/handoff.test.ts reads that form).
 */
export interface AgentContentReader {
  configValue(appId: string, key: string): Promise<ContentConfig | null>;
  freshConfigValue(appId: string, key: string): Promise<ContentConfig | null>;
  configValuesByKey?: ConfigValuesByKey;
}

const CONTENT_READER = Symbol('AGENT_CONTENT_READER');

/** B3-08k: DI token of the AgentContentReader app.module provides; one symbol on every call. */
export function agentContentReaderToken(): symbol {
  return CONTENT_READER;
}

export interface AgentConfigReaderDeps {
  readonly clock: Clock;
  readonly content: AgentContentReader;
}

/**
 * B3-08k: the reader through which access, identity and the run guard read the switches.
 * agent.* keys: content.freshConfigValue, kept per (appId, key) while its age on the injected clock
 * is in [0, 1 000) ms, the age counted from the start of the read (a slow read never extends the
 * window; a clock moved back reads again); a rejection rejects and keeps nothing. Every answer of
 * an agent.* key is a deep copy (structuredClone), so a caller changing it changes no later answer.
 * Any other key: content.configValue, as it is (not cached here).
 */
export function createAgentConfigReader(
  deps: AgentConfigReaderDeps,
): Pick<ContentReader, 'configValue'> {
  const { clock, content } = deps;
  const cache = new Map<string, { at: number; value: ContentConfig | null }>();
  return {
    async configValue(appId, key) {
      if (!key.startsWith('agent.')) return content.configValue(appId, key);
      const id = JSON.stringify([appId, key]);
      const at = clock.now().getTime();
      const hit = cache.get(id);
      if (hit && at >= hit.at && at - hit.at < 1_000) return structuredClone(hit.value);
      cache.delete(id);
      const value = await content.freshConfigValue(appId, key);
      // Age starts before the read: a slow read must not extend the freshness window.
      cache.set(id, { at, value });
      return structuredClone(value);
    },
  };
}
