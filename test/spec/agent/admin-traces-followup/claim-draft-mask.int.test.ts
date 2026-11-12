// B1-10r rule tests (claude-independent, SPEC_REF ea7850e2): adminGetAgentSession
// (GET /admin/v1/agent-traces/sessions/{session_id}, CT-24zzi), follow-up of B1-10q (#3256, 编排
// D10-1341 ②). 08 BR-AI-14 脱敏表「其他 ≥11 位连续数字……trace 存脱敏值（保留后 4 位）」: a
// claim_draft card is stored with the restored, whole order number in data.order_no; the admin
// detail shows it masked to its last four, in the same form the trace stores tool arguments in
// (preprocess/redact maskForTrace on a run of ≥ 11 digits). Every other card and every other field
// is shown as stored (long digit runs in other cards and in the claim card's fallback_text
// included), and the stored rows stay as they are. 08 BR-AI-19 (查看操作记审计): when the
// audit record cannot be written the read answers 50001 and carries no session content.
// How the audit write is made to fail: the admin entry is started on the suite's own couli_app
// handle wrapped in a Kysely plugin that throws on any INSERT into audit_logs (the statement never
// reaches PostgreSQL); no superuser, no migrator, no change to the implementation.
// Real admin entry (createHttpApp('admin')) and real database through ../admin-traces/kit.ts; the
// rows are synthetic. Top-level it() only (规划/11 §4.3).
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { sql, type KyselyPlugin } from 'kysely';
import { expect, it } from 'vitest';
import { maskForTrace } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import {
  AUDIT_ACTION,
  agentTables,
  ago,
  auditCount,
  auditRows,
  cardView,
  conforms,
  detailOf,
  doneRun,
  fixture,
  insertCard,
  insertMessage,
  insertRun,
  insertToolCall,
  leaksNone,
  messageView,
  plus,
  plus8,
  reply,
  seedMember,
  seedSession,
  suite,
  toolCallView,
  userMessage,
  withTraceAdmin,
  type CardRow,
  type Fixture,
  type ToolCallRow,
} from '../admin-traces/kit.ts';

const s = suite();

/** `n` random decimal digits. */
function digits(n: number): string {
  let out = '';
  while (out.length < n) out += String(randomInt(0, 10));
  return out;
}

/** The claim_draft card's submit action (tools/claim). */
const SUBMIT = { text_key: 'agent.card.claim_draft.submit', action: 'submit_claim' } as const;
const CLAIM_FALLBACK = '已为你准备好订单找回草稿，请在卡片中核对后提交。';

/** Makes every INSERT into audit_logs throw before it is sent; counts the attempts. */
function rejectAuditWrites(): { plugin: KyselyPlugin; attempts: () => number } {
  let attempts = 0;
  return {
    plugin: {
      transformQuery({ node }) {
        if (node.kind === 'InsertQueryNode' && node.into?.table.identifier.name === 'audit_logs') {
          attempts += 1;
          throw new Error('fixture: audit_logs insert refused');
        }
        return node;
      },
      transformResult({ result }) {
        return Promise.resolve(result);
      },
    },
    attempts: () => attempts,
  };
}

it('[AC-B1-10r#2] 明细 cards 里 claim_draft 卡的 order_no 只留后 4 位（BR-AI-14，与 trace 工具参数的 maskForTrace 遮法一致），响应全文查不到完整订单号；别的卡、claim_draft 的别的字段、消息与工具参数照库里原样，库里的卡片不变；非 claim_draft 卡里的 ≥11 位数字（product_list 的 item_ref、order_status 的 order_no）与 claim_draft 卡 fallback_text 里的 ≥11 位数字原样返回；审计写失败时回 50001、响应里没有任何会话内容（消息文本、卡片、工具参数都查不到），也不留审计记录', async () => {
  const f = fixture(s);
  const member = await seedMember(f);
  const session = await seedSession(f, {
    userId: member.id,
    startedAt: ago(f, 90),
    lastActiveAt: ago(f, 30),
  });
  const tag = randomBytes(4).toString('hex');
  // Whole order numbers as restored into the cards: 19 and 16 digits, neither a phone number nor
  // an ID card number, so the BR-AI-14 rule for other runs of ≥ 11 digits applies.
  const orderNo = `2310${digits(11)}7890`;
  const otherOrderNo = `5${digits(11)}1234`;
  expect(maskForTrace(orderNo)).toBe(`****${orderNo.slice(-4)}`);
  expect(maskForTrace(otherOrderNo)).toBe(`****${otherOrderNo.slice(-4)}`);
  // Runs of ≥ 11 digits outside claim_draft's order_no: a product's item_ref, an order_status
  // card's order_no, a number in a claim_draft card's fallback_text. Shown as stored.
  const itemRef = `6${digits(12)}`;
  const statusOrderNo = `3${digits(9)}5678`;
  const claimRef = `9${digits(11)}`;
  for (const raw of [itemRef, statusOrderNo, claimRef]) {
    expect(maskForTrace(raw), raw).not.toBe(raw);
    expect(maskForTrace(`工单 ${raw}`), raw).not.toBe(`工单 ${raw}`);
  }
  const claimFallbackWithRef = `工单 ${claimRef} 的找回草稿已备好，请核对后提交。`;

  const first = doneRun(ago(f, 80));
  const second = doneRun(ago(f, 50));
  for (const run of [first, second]) await insertRun(f, session, run);
  const question1 = `帮我找回订单 ${maskForTrace(orderNo) as string}（${tag}）`;
  const answer1 = `已为你准备好找回草稿（${tag}）`;
  const question2 = `京东那单 ${maskForTrace(otherOrderNo) as string} 也没跟上（${tag}）`;
  const answer2 = `这一单也准备好了（${tag}）`;
  const messages = [
    userMessage(first.id, first.acceptedAt, question1),
    reply(first.id, plus(first.acceptedAt, 2000), answer1, { cardIds: ['c1', 'c2', 'c3'] }),
    userMessage(second.id, second.acceptedAt, question2),
    reply(second.id, plus(second.acceptedAt, 2000), answer2, { cardIds: ['c4', 'c5'] }),
  ];
  for (const message of messages) await insertMessage(f, session, message);

  // Tool arguments are stored masked at write time (BR-AI-19); shown as stored.
  const calls: ToolCallRow[] = [
    {
      runId: first.id,
      seq: 1,
      name: 'prefill_claim',
      args: { platform: 'taobao', order_no: maskForTrace(orderNo) },
      status: 'ok',
      latencyMs: 40,
      createdAt: plus(first.acceptedAt, 900),
    },
    {
      runId: second.id,
      seq: 1,
      name: 'prefill_claim',
      args: { platform: 'jd', order_no: maskForTrace(otherOrderNo) },
      status: 'ok',
      latencyMs: 35,
      createdAt: plus(second.acceptedAt, 900),
    },
  ];
  for (const call of calls) await insertToolCall(f, session, call);

  const clicked = [plus8(ago(f, 60 * 24)), plus8(ago(f, 60 * 30))];
  const cards: CardRow[] = [
    {
      runId: first.id,
      cardId: 'c1',
      type: 'notice',
      schemaVersion: 1,
      data: { level: 'info', text: `订单找回需要先核对订单信息（${tag}）` },
      fallbackText: `订单找回需要先核对订单信息（${tag}）`,
      createdAt: plus(first.acceptedAt, 1000),
    },
    {
      runId: first.id,
      cardId: 'c2',
      type: 'claim_draft',
      schemaVersion: 1,
      data: {
        platform: 'taobao',
        order_no: orderNo,
        click_times: clicked,
        evidence_summary: null,
        submit_action: SUBMIT,
      },
      fallbackText: CLAIM_FALLBACK,
      createdAt: plus(first.acceptedAt, 1100),
    },
    {
      runId: first.id,
      cardId: 'c3',
      type: 'product_list',
      schemaVersion: 2,
      data: { items: [{ title: `手机壳 ${tag}`, item_ref: itemRef, final_price_fen: 1990 }] },
      fallbackText: `为你找到 1 件商品（${tag}）`,
      createdAt: plus(first.acceptedAt, 1200),
    },
    {
      runId: second.id,
      cardId: 'c4',
      type: 'claim_draft',
      schemaVersion: 1,
      data: {
        platform: 'jd',
        order_no: otherOrderNo,
        click_times: [],
        evidence_summary: null,
        submit_action: SUBMIT,
      },
      fallbackText: claimFallbackWithRef,
      createdAt: plus(second.acceptedAt, 1100),
    },
    {
      runId: second.id,
      cardId: 'c5',
      type: 'order_status',
      schemaVersion: 1,
      data: {
        order_id: randomUUID(),
        platform: 'jd',
        title: `蓝牙耳机 ${tag}`,
        is_other_product: false,
        display_status: 'WAITING',
        reason: null,
        est_rebate_fen: 120,
        expected_credit_period: '2026-12',
        order_no: statusOrderNo,
      },
      fallbackText: `订单状态：等待结算（${tag}）`,
      createdAt: plus(second.acceptedAt, 1200),
    },
  ];
  for (const index of [3, 4, 1, 0, 2]) await insertCard(f, session, cards[index]!);

  const masked = (card: CardRow, whole: string): Record<string, unknown> => ({
    ...cardView(card),
    data: { ...card.data, order_no: maskForTrace(whole) },
  });
  const expectedCards = [
    cardView(cards[0]!),
    masked(cards[1]!, orderNo),
    cardView(cards[2]!),
    masked(cards[3]!, otherOrderNo),
    cardView(cards[4]!),
  ];
  const stored = await agentTables(f.db);

  await withTraceAdmin(f, async (h) => {
    const sent = await h.detail(session.id);
    const data = await detailOf(sent);
    const shown = data['cards'] as Record<string, unknown>[];
    const claims = shown.filter((card) => card['type'] === 'claim_draft');
    expect(claims.map((card) => (card['data'] as Record<string, unknown>)['order_no'])).toEqual([
      maskForTrace(orderNo),
      maskForTrace(otherOrderNo),
    ]);
    expect(shown).toEqual(expectedCards);
    leaksNone(sent, [orderNo, otherOrderNo, orderNo.slice(0, 11), otherOrderNo.slice(0, 11)]);
    // Only claim_draft's order_no is masked: the other long numbers come back as stored.
    const byId = new Map(shown.map((card) => [card['card_id'], card]));
    const product = byId.get('c3')?.['data'] as { items: Record<string, unknown>[] } | undefined;
    const status = byId.get('c5')?.['data'] as Record<string, unknown> | undefined;
    expect(product?.items[0]?.['item_ref']).toBe(itemRef);
    expect(status?.['order_no']).toBe(statusOrderNo);
    expect(byId.get('c4')?.['fallback_text']).toBe(claimFallbackWithRef);
    for (const raw of [itemRef, statusOrderNo, claimRef]) {
      expect(sent.body.includes(raw), `shows ${raw} as stored`).toBe(true);
    }
    expect(data['messages']).toEqual(messages.map(messageView));
    expect(data['tool_calls']).toEqual(calls.map(toolCallView));
  });

  // Masked on the way out only: every agent row, the claim cards included, is as written.
  expect(await agentTables(f.db)).toEqual(stored);
  const { rows } = await sql<{ card_id: string; order_no: string }>`SELECT card_id,
      data->>'order_no' AS order_no FROM app.agent_cards
    WHERE app_id = ${f.appId} AND session_id = ${session.id} AND type = 'claim_draft'
    ORDER BY card_id`.execute(f.db);
  expect(rows).toEqual([
    { card_id: 'c2', order_no: orderNo },
    { card_id: 'c4', order_no: otherOrderNo },
  ]);
  const viewed = (await auditRows(f.db, f.appId)).filter((row) => row.action === AUDIT_ACTION);
  expect(viewed).toHaveLength(1);

  // The audit record cannot be written: 50001, no session content, no audit record.
  const refusal = rejectAuditWrites();
  const broken: Fixture = { ...f, db: f.db.withPlugin(refusal.plugin) };
  const auditBefore = await auditCount(f.db);
  await withTraceAdmin(broken, async (h) => {
    const sent = await h.detail(session.id);
    expect(refusal.attempts(), 'the audit insert was attempted').toBeGreaterThan(0);
    expect(sent.statusCode, sent.body).toBe(500);
    const body = sent.json();
    expect(body.code, sent.body).toBe(50001);
    expect(body.data ?? null, sent.body).toBeNull();
    await conforms(sent);
    leaksNone(sent, [
      tag,
      orderNo,
      otherOrderNo,
      itemRef,
      statusOrderNo,
      claimRef,
      maskForTrace(orderNo) as string,
      maskForTrace(otherOrderNo) as string,
      CLAIM_FALLBACK,
      SUBMIT.text_key,
      'prefill_claim',
      ...messages.map((m) => m.id),
      ...[first, second].map((run) => run.id),
    ]);
  });
  expect(await auditCount(f.db)).toBe(auditBefore);
  expect((await auditRows(f.db, f.appId)).filter((row) => row.action === AUDIT_ACTION)).toEqual(
    viewed,
  );
  expect(await agentTables(f.db)).toEqual(stored);
});
