// The Owner rule of ./index.ts (BR-AI-20) as one query, shared by the session store and B3-08zf's
// message feedback store (./feedback/index.ts) so that ownership has a single definition. Not part
// of the agent module's public entry.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

// Defined here (and re-exported unchanged by ./index.ts) so that this file never imports ./index.ts.
export type AgentOwner =
  | {
      readonly kind: 'user';
      readonly appId: string;
      readonly userId: string;
      /** The device of the request; written as device_id when a session is created. */
      readonly deviceId: string;
    }
  | { readonly kind: 'device'; readonly appId: string; readonly deviceId: string };

/** The agent_sessions rows `owner` owns, scoped by app_id; `connection` carries the app schema. */
export function ownerSessions(connection: Kysely<DB>, owner: AgentOwner) {
  const query = connection.selectFrom('agent_sessions').where('app_id', '=', owner.appId);
  return owner.kind === 'user'
    ? query.where('user_id', '=', owner.userId)
    : query
        .where('user_id', 'is', null)
        .where('user_hash', 'is', null)
        .where('device_id', '=', owner.deviceId);
}
