// 打款队列的批量栏与【执行所选】（F1-08bb；契约 adminCreatePayoutBatch POST /admin/v1/payout-batches，
// payout.execute，totp 档 step-up，Idempotency-Key 必填；BR-WDR-11 / 12 / 13）。只在勾选了至少一张
// 待执行单时出现：统计「已选 N 张，合计实付」（aria-live）与【执行所选】；概览为打款开关关闭或队列
// 暂停时不放【执行所选】，写明原因。流程：执行确认（按列表顺序列本次执行的单与「执行前检查」，各项
// 全取打款概览，未满足不拦提交，服务端再查）→ 动态码 → 只发一次 POST（body 只有 withdrawal_ids）→
// executed：显示新批次号与逐单结果，清空已选并重新读队列与概览；rejected：显示整批原因，勾选保留。
// 幂等键：10003 重新验证、网络 / 40901 / 5xx 后不改勾选重提（含关闭再打开）沿用原键；rejected、
// 其他已确定的拒绝、executed 之后或勾选改变后换新键。任何错误都不自动重发。
import { addFen, formatYuanAdmin, parseFen, subFen } from '@couli/money';
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Descriptions,
  Flex,
  Modal,
  Table,
  Typography,
  message,
  theme,
  type TableColumnsType,
} from 'antd';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import {
  PAYOUT_BATCHES_URL,
  STEP_UP_URL,
  beijingTime,
  fieldsOf,
  isSettledRejection,
  money,
  nameOr,
  newRequestKey,
  waterLevelLabel,
  type PayoutBatchLeftItem,
  type PayoutBatchRequest,
  type PayoutBatchResult,
  type PayoutOverview,
  type WithdrawalRow,
} from './model.ts';

const t = withdrawalsTexts.execute;
const channelTitles = withdrawalsTexts.payouts.channelTitles;
const STEP_UP_REFUSED = 10003;

type Phase = 'preview' | 'verify' | 'sending' | 'done';

export interface PayoutExecuteProps {
  /** The ticked APPROVED rows, in list order, without duplicates. */
  readonly rows: readonly WithdrawalRow[];
  /** The payout overview (undefined while it is not read). */
  readonly overview: PayoutOverview | undefined;
  /** A batch was executed: clear the ticks and read the queue and the overview again. */
  readonly onFinished: () => void;
  /** Whether a step-up or the write is in progress (the queue locks its checkboxes). */
  readonly onBusyChange: (busy: boolean) => void;
}

/** What the pre-checks read of a withdrawal (a list row or the detail). */
export type CheckedRow = Pick<WithdrawalRow, 'payout_channel' | 'net_fen'>;

/** Sum of the net amounts (integer fen through @couli/money). */
function netTotal(rows: readonly CheckedRow[]): bigint {
  let total = parseFen(0);
  for (const row of rows) total = addFen(total, parseFen(row.net_fen));
  return total;
}

const channelName = (code: string): string => nameOr(channelTitles, code);

/** The 执行前检查 items, every one taken from the overview (no threshold of its own). */
export function checksOf(rows: readonly CheckedRow[], overview: PayoutOverview): string[] {
  const items = [
    t.check(t.payout, overview.payout_enabled ? t.payoutOn : t.payoutOff, overview.payout_enabled),
    t.check(
      t.queue,
      overview.queue_paused ? t.queuePaused : t.queueRunning,
      !overview.queue_paused,
    ),
  ];
  const used = new Set<string>(rows.map((row) => row.payout_channel));
  const known = overview.channels.map((channel) => channel.channel as string);
  for (const channel of overview.channels) {
    if (!used.has(channel.channel)) continue;
    const name = channelName(channel.channel);
    const watermark = channel.watermark;
    const level = channel.water_level;
    if (watermark === null) {
      items.push(t.check(t.balance(name), t.unentered, false));
    } else {
      const w = money(watermark.available_fen);
      const time = beijingTime(watermark.measured_at);
      items.push(
        level === null
          ? t.check(t.balance(name), t.stale(w, time), false)
          : t.check(t.balance(name), t.fresh(w, time), true),
      );
    }
    if (watermark === null || level === null) {
      items.push(t.check(t.level(name), t.noLevel, false));
    } else {
      const w = parseFen(watermark.available_fen);
      const p = parseFen(channel.forecast_withdrawal_fen);
      items.push(
        t.check(
          t.level(name),
          t.levelValue(formatYuanAdmin(w), formatYuanAdmin(p), waterLevelLabel(level)),
          w >= p,
        ),
      );
    }
  }
  for (const channel of used) {
    if (known.includes(channel)) continue;
    const name = channelName(channel);
    items.push(t.check(t.balance(name), t.unentered, false));
    items.push(t.check(t.level(name), t.noLevel, false));
  }
  const left = subFen(parseFen(overview.daily_cap_fen), parseFen(overview.daily_sent_fen));
  const sum = netTotal(rows);
  items.push(
    t.check(t.daily, t.dailyValue(formatYuanAdmin(left), formatYuanAdmin(sum)), sum <= left),
  );
  return items;
}

/** The notice of a whole batch refused. */
export function refusedText(result: PayoutBatchResult): string {
  const reason = result.reason ?? '';
  const text = t.refused[reason];
  if (text === undefined) return t.refusedOther(reason);
  return text(result.channel === null ? '' : channelName(result.channel));
}

/** The text of one item of an executed batch. */
export function itemText(
  id: string,
  paying: ReadonlySet<string>,
  left: ReadonlyMap<string, PayoutBatchLeftItem>,
): string {
  if (paying.has(id)) return t.paying;
  const item = left.get(id);
  if (item === undefined) return t.noResult;
  return t.left[item.reason] ?? t.leftOther(item.reason);
}

/** The notice of a failed submit (the dialog stays open, nothing is sent again). */
function failureNotice(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.kind === 'network') return t.network;
  if (cause.code === 10403) return t.forbidden;
  if (cause.code === 20001)
    return fieldsOf(cause).includes('withdrawal_ids') ? t.idsInvalid : t.invalid;
  return t.failed;
}

/** Why 【执行所选】 is not offered right now (empty: it is). */
function offNotes(overview: PayoutOverview | undefined): string[] {
  if (overview === undefined) return [t.noOverview];
  const notes: string[] = [];
  if (!overview.payout_enabled) notes.push(t.offPayout);
  if (overview.queue_paused) notes.push(t.offQueue);
  return notes;
}

export function PayoutExecute(props: PayoutExecuteProps): ReactElement {
  const { rows, overview, onFinished, onBusyChange } = props;
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [notify, contextHolder] = message.useMessage();
  const [snapshot, setSnapshot] = useState<readonly WithdrawalRow[]>();
  const [phase, setPhaseValue] = useState<Phase>('preview');
  const [again, setAgain] = useState(false);
  const [result, setResult] = useState<PayoutBatchResult>();
  const [refusal, setRefusal] = useState<string>();
  const phaseRef = useRef<Phase>('preview');
  const pendingKey = useRef<string | undefined>(undefined);
  /** The key of the last unconfirmed operation and the ids it was for. */
  const keyRef = useRef<{ readonly ids: string; readonly key: string } | undefined>(undefined);
  const entryRef = useRef<HTMLButtonElement>(null);
  const closedRef = useRef(false);
  const alive = useRef(true);
  const busy = phase === 'verify' || phase === 'sending';
  const signature = rows.map((row) => row.withdrawal_id).join(',');

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // A changed selection is a new operation: the next submit takes a new key.
  useEffect(() => {
    if (keyRef.current !== undefined && keyRef.current.ids !== signature)
      keyRef.current = undefined;
  }, [signature]);

  // 确认框关闭后焦点回到【执行所选】（入口已因清空勾选消失时不处理）。
  useEffect(() => {
    if (snapshot !== undefined || !closedRef.current) return;
    closedRef.current = false;
    const node = entryRef.current;
    if (node?.isConnected === true) node.focus();
  }, [snapshot]);

  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseValue(next);
  };

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  const keyFor = (ids: string): string => {
    if (keyRef.current?.ids === ids) return keyRef.current.key;
    const key = newRequestKey();
    keyRef.current = { ids, key };
    return key;
  };

  const notes = offNotes(overview);
  const offered = notes.length === 0;

  const openDialog = () => {
    if (snapshot !== undefined || rows.length === 0 || !offered) return;
    setResult(undefined);
    setRefusal(undefined);
    setAgain(false);
    setPhase('preview');
    setSnapshot(rows);
  };

  const close = () => {
    if (phaseRef.current === 'verify' || phaseRef.current === 'sending') return;
    closedRef.current = true;
    setSnapshot(undefined);
  };

  const submit = () => {
    if (phaseRef.current !== 'preview' || snapshot === undefined) return;
    pendingKey.current = keyFor(snapshot.map((row) => row.withdrawal_id).join(','));
    setAgain(false);
    setRefusal(undefined);
    setPhase('verify');
  };

  const cancelVerify = () => {
    if (phaseRef.current !== 'verify') return;
    setPhase('preview');
  };

  const verify = async (code: string): Promise<StepUpResult> => {
    const request: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await customOf()<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload: request,
      });
      return { ok: true, stepUpToken: response.data.step_up_token };
    } catch (cause) {
      if (cause instanceof AdminApiError)
        return cause.retryAfterSeconds === undefined
          ? { ok: false, code: cause.code }
          : { ok: false, code: cause.code, retryAfterSeconds: cause.retryAfterSeconds };
      return { ok: false, code: 0 };
    }
  };

  const send = async (
    items: readonly WithdrawalRow[],
    key: string,
    stepUpToken: string,
  ): Promise<void> => {
    const payload: PayoutBatchRequest = { withdrawal_ids: items.map((row) => row.withdrawal_id) };
    try {
      const response = await customOf()<PayoutBatchResult>({
        url: PAYOUT_BATCHES_URL,
        method: 'post',
        payload,
        meta: { stepUpToken, idempotencyKey: key },
      });
      if (!alive.current) return;
      // 服务端已给出结论（executed 或 rejected）：下一次提交是新操作，换新键。
      keyRef.current = undefined;
      pendingKey.current = undefined;
      const answer = response.data;
      if (answer.outcome === 'executed') {
        setResult(answer);
        setPhase('done');
        onFinished();
        return;
      }
      setRefusal(refusedText(answer));
      setPhase('preview');
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // 凭证未被接受：重新验证后以新凭证、原幂等键与原请求体再发。
        setAgain(true);
        setPhase('verify');
        return;
      }
      pendingKey.current = undefined;
      // 只有服务端确定拒绝（4xx 业务错误，40901 除外）才清空幂等键；网络错误、40901、5xx 等结果
      // 未确定的失败保留原键，不改勾选手动重提时服务端返回首次结果。任何错误都不自动重发。
      if (isSettledRejection(cause)) keyRef.current = undefined;
      setPhase('preview');
      void notify.error(failureNotice(cause));
    }
  };

  const onVerified = (stepUpToken: string) => {
    const key = pendingKey.current;
    if (phaseRef.current !== 'verify' || key === undefined || snapshot === undefined) return;
    setPhase('sending');
    void send(snapshot, key, stepUpToken);
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const done = phase === 'done' && result !== undefined;
  const paying = new Set(result?.paying ?? []);
  const left = new Map((result?.left ?? []).map((item) => [item.withdrawal_id, item]));

  const columns: TableColumnsType<WithdrawalRow> = [
    {
      key: 'number',
      title: t.number,
      render: (_, row) => <span style={code}>{row.out_biz_no}</span>,
    },
    {
      key: 'user',
      title: t.user,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.user.user_id}</span>
          {row.user.phone_masked === null ? null : <span>{row.user.phone_masked}</span>}
        </Flex>
      ),
    },
    {
      key: 'net',
      title: t.net,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.net_fen)}</span>,
    },
    ...(done
      ? [
          {
            key: 'result',
            title: t.result,
            render: (_: unknown, row: WithdrawalRow) => (
              <Typography.Text type={paying.has(row.withdrawal_id) ? 'success' : 'warning'}>
                {itemText(row.withdrawal_id, paying, left)}
              </Typography.Text>
            ),
          },
        ]
      : []),
  ];

  let body: ReactElement | null = null;
  if (snapshot !== undefined) {
    if (done) {
      const count = snapshot.filter((row) => paying.has(row.withdrawal_id)).length;
      body = (
        <>
          <Descriptions
            bordered
            size="small"
            column={1}
            items={[
              {
                key: 'batch',
                label: t.batch,
                children: <span style={code}>{result.batch_id ?? withdrawalsTexts.dash}</span>,
              },
            ]}
          />
          <Table<WithdrawalRow>
            rowKey="withdrawal_id"
            size="small"
            columns={columns}
            dataSource={snapshot as WithdrawalRow[]}
            pagination={false}
          />
          <Typography.Text type="secondary">
            {t.summary(count, snapshot.length - count)}
          </Typography.Text>
        </>
      );
    } else {
      const checks = overview === undefined ? [] : checksOf(snapshot, overview);
      body = (
        <>
          {refusal === undefined ? null : (
            <Alert type="error" showIcon role="alert" message={refusal} />
          )}
          <Table<WithdrawalRow>
            rowKey="withdrawal_id"
            size="small"
            columns={columns}
            dataSource={snapshot as WithdrawalRow[]}
            pagination={false}
          />
          <Flex vertical gap={4}>
            <Typography.Text strong>{t.checkTitle}</Typography.Text>
            <ul style={{ margin: 0, paddingInlineStart: token.paddingLG }}>
              {checks.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {overview === undefined ? null : (
              <Typography.Text type="secondary">
                {t.recheck(beijingTime(overview.as_of))}
              </Typography.Text>
            )}
          </Flex>
          <Typography.Text type="secondary">{t.consequence}</Typography.Text>
        </>
      );
    }
  }

  return (
    <>
      {contextHolder}
      {rows.length === 0 ? null : (
        <Flex
          align="center"
          justify="space-between"
          gap={16}
          wrap
          style={{
            padding: `${token.paddingXS}px ${token.padding}px`,
            background: token.colorPrimaryBg,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <span aria-live="polite">{t.selected(rows.length, formatYuanAdmin(netTotal(rows)))}</span>
          {offered ? (
            <Button
              ref={entryRef}
              type="primary"
              autoInsertSpace={false}
              disabled={busy}
              onClick={openDialog}
            >
              {t.entry}
            </Button>
          ) : (
            <Flex vertical gap={2}>
              {notes.map((note) => (
                <Typography.Text key={note} type="warning">
                  {note}
                </Typography.Text>
              ))}
            </Flex>
          )}
        </Flex>
      )}
      {snapshot === undefined ? null : (
        <Modal
          open
          width={760}
          title={done ? t.resultTitle(snapshot.length) : t.title(snapshot.length)}
          destroyOnHidden
          maskClosable={false}
          keyboard={!busy}
          closable={!busy}
          onCancel={close}
          footer={
            done ? (
              <Flex justify="end">
                <Button autoInsertSpace={false} type="primary" onClick={close}>
                  {t.close}
                </Button>
              </Flex>
            ) : (
              <Flex justify="end" gap={8}>
                <Button autoInsertSpace={false} disabled={busy} onClick={close}>
                  {t.cancel}
                </Button>
                <Button autoInsertSpace={false} type="primary" disabled={busy} onClick={submit}>
                  {t.submit}
                </Button>
              </Flex>
            )
          }
        >
          <Flex vertical gap={token.marginSM} style={{ paddingTop: token.paddingXS }}>
            {body}
          </Flex>
        </Modal>
      )}
      <StepUpModal
        open={snapshot !== undefined && phase === 'verify'}
        tier="totp"
        operation={t.operation}
        details={[t.stepUpTarget(snapshot?.length ?? 0), ...(again ? [t.stepUpAgain] : [])]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </>
  );
}
