import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/clock/index.ts';
import type { AdminRevocations } from '../infra/admin-revocations.ts';
import type { SystemAuditWriter } from '../infra/system-audit.ts';

export interface OperatorTotpResetTarget {
  readonly appId: string;
  readonly loginName: string;
}

export interface OperatorTotpResetRequest extends OperatorTotpResetTarget {
  readonly reason: string;
}

export type OperatorTotpResetResult =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'refused';
      readonly reason: 'unknown' | 'not_super' | 'another_usable_super' | 'invalid_reason';
    };

export interface OperatorTotpReset {
  inspect(target: OperatorTotpResetTarget): Promise<{ readonly totpBound: boolean } | null>;
  reset(request: OperatorTotpResetRequest): Promise<OperatorTotpResetResult>;
}

export interface OperatorTotpResetDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly audit: Pick<SystemAuditWriter, 'appendAction'>;
  readonly revocations: Pick<AdminRevocations, 'voidBefore'>;
}

export function createOperatorTotpReset(deps: OperatorTotpResetDeps): OperatorTotpReset {
  void deps;
  throw new Error('NotImplemented: createOperatorTotpReset');
}
