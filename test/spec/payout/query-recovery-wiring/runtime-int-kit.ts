// The real payout runtime over the B2-06e query kit's database. Its handle is couli_payout, the
// role the payout process connects as (attemptsDb and handle are the same pool there), so the scan
// runs with production's grants. Nothing works the queue: register is a stub, send is the kit's
// real one, and the rows are read back from pgboss.job.
import { vi } from 'vitest';
import {
  createPayoutRuntime,
  type PayoutRuntimeOptions,
} from '../../../../apps/api/src/modules/payout/payout-runtime.ts';
import type { QueryFixture } from '../query/kit.ts';
import type { RecoverableRuntime } from './support.ts';

export function payoutRuntime(f: QueryFixture): RecoverableRuntime {
  const options = {
    db: f.h.payout,
    queue: {
      register: vi.fn(),
      send: f.send,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    eventBus: f.options.eventBus,
    clock: f.clock,
    logger: Object.assign(f.logger, { child: () => f.logger }),
    config: f.options.config,
    ledger: f.ledger,
    lockUsersForUpdate: f.options.lockUsersForUpdate,
    decryptPayee: f.decryptPayee,
  } as unknown as PayoutRuntimeOptions;
  return createPayoutRuntime(options) as RecoverableRuntime;
}
