// B3-16a · BR-AI-01 细则「收益查询」/ BR-AI-02 ③ / BR-AI-04 (D32): the earnings port of the stream
// entry, kept outside tools/registry/**. Rule tests: test/spec/agent/earnings-tool/**.
//
// AgentEarningsProvidedPorts: what app.module adds to the stream entry's AgentStreamProvidedPorts
//   for this tool. earningsReads is built by the composition root (apps/api/src/agent-earnings-
//   reads.ts createEarningsReads over its own db and clock, D10-1244), so this module imports
//   nothing of ledger or payout and hands no database handle to anyone (B3-08k); agent only calls
//   read(subject). createProductionStreamAssembly always registers get_my_earnings behind
//   agent.tools.get_my_earnings.enabled (BR-AI-02); without earningsReads it reads through
//   createUnavailableEarningsReads.
// createUnavailableEarningsReads(logger): EarningsReads whose read always rejects without reading
//   anything (the tool then answers 'unavailable', the same path as a failed read), with one warn
//   per call carrying no figure and no user text.
import type { RootLogger } from '../../../platform/index.ts';
import type { EarningsReads } from '../../tools/earnings/index.ts';

export interface AgentEarningsProvidedPorts {
  readonly earningsReads?: EarningsReads;
}

/** No earnings reads provided: every read rejects (no card), nothing is read. */
export function createUnavailableEarningsReads(logger: Pick<RootLogger, 'warn'>): EarningsReads {
  return {
    read() {
      logger.warn({ tool: 'get_my_earnings' }, 'agent.earnings_reads_not_provided');
      return Promise.reject(new Error('agent: get_my_earnings has no earnings reads'));
    },
  };
}
