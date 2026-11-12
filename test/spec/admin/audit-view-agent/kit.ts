// B1-10s rule-test kit (claude-independent, SPEC_REF ea7850e2): the audit console (contract
// adminListAuditLogs / adminGetAuditLog, CT-24c) derives target_type / target_id / permission of the
// two Agent admin actions (编排 D10-1341 ③; 08 BR-AI-19 后台查看 trace 需要 agent.trace、查看操作记审计;
// BR-ID-15 ④ 举报处理写审计):
//   agent_trace_view    `agent_sessions:<session_id>` → agent_session / <session_id> / agent.trace
//   agent_report_handle `agent_messages:<message_id>` → agent_message / <message_id> / agent.report
// Real pieces: the admin entry and PostgreSQL through the audit-query kit (../audit-query/kit.ts).
// Synthetic: the devices / agent_sessions rows (columns as in db/schema.sql on main), admin
// accounts and appended audit rows. No real user data.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Harness } from '../auth/kit.ts';
import type { Detail, Item } from '../audit-query/kit.ts';

export const TRACE_VIEW = 'agent_trace_view';
export const REPORT_HANDLE = 'agent_report_handle';
export const SESSION_PREFIX = 'agent_sessions:';
export const MESSAGE_PREFIX = 'agent_messages:';
export const SESSION_TYPE = 'agent_session';
export const MESSAGE_TYPE = 'agent_message';
/** specs/permissions.yaml (CT-24zzi). */
export const TRACE = 'agent.trace';
export const REPORT = 'agent.report';
/** contract adminGetAgentSession (B1-10q, on main). */
export const TRACE_SESSIONS = '/admin/v1/agent-traces/sessions';
/** The day of the harness clock (auth kit NOW = 2026-10-09T02:00:00Z), for rows the app writes. */
export const CLOCK_DAY = { from: '2026-10-09T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z' };

/** The derived part of a list item or a detail. */
export function derived(item: Item | Detail) {
  return {
    action: item.action,
    target_type: item.target_type,
    target_id: item.target_id,
    permission: item.permission,
  };
}

/** `at` inside the audit-query kit's FROM–TO window, `minute` minutes after FROM. */
export function inWindow(minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, '0');
  const minutes = String(minute % 60).padStart(2, '0');
  return `2026-10-08T${hours}:${minutes}:00.000Z`;
}

/** A synthetic guest agent session (device + agent_sessions rows) of `appId`; returns its id. */
export async function seedAgentSession(h: Harness, appId: string): Promise<string> {
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const startedAt = '2026-10-09T01:00:00.000Z';
  const lastActiveAt = '2026-10-09T01:30:00.000Z';
  await sql`INSERT INTO app.devices
    (id, app_id, user_id, install_secret_cipher, device_hash, id_source, platform, app_version,
     last_seen_at)
    VALUES (${deviceId}, ${appId}, ${null}, ${Buffer.from('synthetic-install-secret')},
      ${randomBytes(32).toString('hex')}, 'idfv', 'ios', 'synthetic@1', ${startedAt})`.execute(
    h.db,
  );
  await sql`INSERT INTO app.agent_sessions
    (id, app_id, user_id, device_id, started_at, last_active_at, expired_at, user_hash, card_seq,
     created_at, updated_at)
    VALUES (${sessionId}, ${appId}, ${null}, ${deviceId}, ${startedAt}, ${lastActiveAt}, ${null},
      ${null}, 0, ${startedAt}, ${lastActiveAt})`.execute(h.db);
  return sessionId;
}
