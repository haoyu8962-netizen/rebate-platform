// 提现审核列表的【批量自动打款】与【一键组批】（F1-08an；契约 adminCreatePayoutBatch POST
// /admin/v1/payout-batches，payout.execute，totp 档 step-up，Idempotency-Key 必填；BR-WDR-11 / 12）。
// 持 payout.execute（超管持全部点）时出现工具条：【一键组批】不勾选也可用，纯前端按列表已有字段选中本页
// 可执行的待执行单（APPROVED 且没有提现阻断 blocked_reason；自动批次上受阻的单与经 W9 退回、仍挂旧批次
// 的单都算可执行，服务端在同一事务里改挂到新批次），不发写请求；勾到待执行单时出现【批量自动打款】。
// 流程：确认对话框（按列表顺序列将执行的单与实付金额、勾选中的待审核单标「未审核」不进请求体，「执行前
// 检查」取打款概览、未满足不拦提交）→ 动态码 → 只发一次 POST（body 只有 withdrawal_ids）→ executed：逐单
// 显示「已发起打款」或留下原因，并交给列表「执行结果」列，清空勾选、重读列表与页签计数；rejected：显示整批
// 原因全文，勾选保留，下次提交换新键。
// 结果未知（D10-1731 / D10-1739，照 DetailPayoutActions 的【执行打款】）：网络错误、无法解析的响应、40901、
// 带外壳的 5xx → 「上次提交结果未知」，对话框关不掉，只剩【重试】（重新动态码后原键、同一请求体）与
// 【去列表核对】；不自动重发。重试收到 10403，或 10003 + verify_phone_missing，仍是结果未知（D10-2060 /
// D10-2061）；20001 等确定拒绝解锁、下次换新键；普通 10003 重新验证后原键原体。进入结果未知时记
// unknown-marker（page=withdrawals），拿到确定结果时只清本实例那一份（D10-2075）。
// 对话框里没有任何输入框，只有按钮（D10-2050）。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Modal, Table, Typography, theme, type TableColumnsType } from 'antd';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { endsSession, useUnknownMarker } from '../../components/unknown-marker/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import { executeFailure, keepsUnknown, verifyAgain } from './DetailPayoutActions.tsx';
import { MARKER_PAGE, type ManualPaidClock } from './ManualPaid.tsx';
import { checksOf, itemText, refusedText } from './PayoutExecute.tsx';
import {
  OVERVIEW_URL,
  PAYOUT_BATCHES_URL,
  STEP_UP_URL,
  beijingTime,
  canExecute,
  isSettledRejection,
  money,
  newRequestKey,
  type PayoutBatchRequest,
  type PayoutBatchResult,
  type PayoutOverview,
  type WithdrawalRow,
} from './model.ts';

const t = withdrawalsTexts.batchPayout;
const te = withdrawalsTexts.execute;
/** adminCreatePayoutBatch: 1–200 withdrawal_ids. */
export const MAX_BATCH = 200;

type Phase = 'edit' | 'verify' | 'sending' | 'unknown' | 'done';

type OverviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: PayoutOverview }
  | { readonly status: 'failed' };

/**
 * 【一键组批】 picks it: APPROVED without a withdrawal block (BR-WDR-05). A row left on an auto
 * batch (execute_blocked) or returned by W9 (hold_reason, still on its old batch) is executable:
 * BR-WDR-12 moves it onto the new manual batch.
 */
export const groupable = (row: WithdrawalRow): boolean =>
  canExecute(row) && row.blocked_reason === null;

/** The result of every withdrawal of the batch, as the list's 「执行结果」 column shows it. */
export function resultTexts(
  rows: readonly WithdrawalRow[],
  result: PayoutBatchResult,
): ReadonlyMap<string, string> {
  const paying = new Set(result.paying);
  const left = new Map(result.left.map((item) => [item.withdrawal_id, item]));
  return new Map(
    rows.map((row) => [
      row.withdrawal_id,
      canExecute(row) ? itemText(row.withdrawal_id, paying, left) : t.unreviewed,
    ]),
  );
}

export interface BatchPayoutProps {
  /** The ticked rows (APPROVED, and PENDING_REVIEW for an account that may tick those), list order. */
  readonly rows: readonly WithdrawalRow[];
  /** The rows of the current list answer (【一键组批】 picks among them). */
  readonly listed: readonly WithdrawalRow[];
  readonly clock: ManualPaidClock;
  /** 【一键组批】: tick exactly these withdrawals. */
  readonly onGroup: (ids: readonly string[]) => void;
  /** The batch was executed: its per-withdrawal results, for the list's 「执行结果」 column. */
  readonly onExecuted: (results: ReadonlyMap<string, string>) => void;
  /** Executed, or left to the list (【去列表核对】): clear the ticks, read the list and the counts. */
  readonly onFinished: () => void;
  /** Whether a step-up, the write or an unknown result is open (the list locks its checkboxes). */
  readonly onBusyChange: (busy: boolean) => void;
  /** Another batch of the list is busy: 【一键组批】 waits. */
  readonly locked: boolean;
}

export function BatchPayout(props: BatchPayoutProps): ReactElement {
  const { rows, listed, clock, onGroup, onExecuted, onFinished, onBusyChange, locked } = props;
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const marker = useUnknownMarker(MARKER_PAGE, clock);
  /** The ticked rows as they were when the dialog opened. */
  const [snapshot, setSnapshot] = useState<readonly WithdrawalRow[]>();
  const [overview, setOverview] = useState<OverviewState>({ status: 'loading' });
  const [phase, setPhaseValue] = useState<Phase>('edit');
  const [again, setAgain] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [result, setResult] = useState<PayoutBatchResult>();
  const phaseRef = useRef<Phase>('edit');
  /** The body and key of the open operation; undefined: the next submit is a new one. */
  const bodyRef = useRef<PayoutBatchRequest | undefined>(undefined);
  const keyRef = useRef<string | undefined>(undefined);
  /** An earlier send under this key got no settled answer: it may have taken effect. */
  const uncertainRef = useRef(false);
  const entryRef = useRef<HTMLButtonElement>(null);
  const closedRef = useRef(false);
  const alive = useRef(true);
  const busy = phase === 'verify' || phase === 'sending' || phase === 'unknown';
  const executable = rows.filter(canExecute);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // 对话框关闭后焦点回到【批量自动打款】（入口已因清空勾选消失时不处理）。
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

  const forget = () => {
    bodyRef.current = undefined;
    keyRef.current = undefined;
    uncertainRef.current = false;
  };

  const group = () => {
    if (locked || busy || snapshot !== undefined) return;
    onGroup(listed.filter(groupable).map((row) => row.withdrawal_id));
  };

  const open = () => {
    if (snapshot !== undefined || executable.length === 0) return;
    forget();
    setNotice(undefined);
    setResult(undefined);
    setAgain(false);
    setPhase('edit');
    setSnapshot(rows);
    setOverview({ status: 'loading' });
    customOf()<PayoutOverview>({ url: OVERVIEW_URL, method: 'get' }).then(
      (response) => {
        if (alive.current) setOverview({ status: 'ready', data: response.data });
      },
      () => {
        if (alive.current) setOverview({ status: 'failed' });
      },
    );
  };

  const close = () => {
    if (phaseRef.current !== 'edit' && phaseRef.current !== 'done') return;
    closedRef.current = true;
    forget();
    setSnapshot(undefined);
    setPhase('edit');
  };

  /** 【去列表核对】: leave the unknown submission to the list (read again). */
  const toList = () => {
    if (phaseRef.current !== 'unknown') return;
    closedRef.current = true;
    // F1-08at: the given-up submission keeps holding the marker until 【关闭】 of the banner.
    marker.leave();
    forget();
    setSnapshot(undefined);
    setPhase('edit');
    onFinished();
  };

  const toSend = snapshot?.filter(canExecute) ?? [];
  const sendable = toSend.length > 0 && toSend.length <= MAX_BATCH;

  const submit = () => {
    if (phaseRef.current !== 'edit' || snapshot === undefined || !sendable) return;
    if (bodyRef.current === undefined || keyRef.current === undefined) {
      bodyRef.current = { withdrawal_ids: toSend.map((row) => row.withdrawal_id) };
      keyRef.current = newRequestKey();
    }
    uncertainRef.current = false;
    setNotice(undefined);
    setAgain(false);
    setPhase('verify');
  };

  const retry = () => {
    if (phaseRef.current !== 'unknown') return;
    if (bodyRef.current === undefined || keyRef.current === undefined) return;
    setAgain(false);
    setPhase('verify');
  };

  const cancelVerify = () => {
    if (phaseRef.current !== 'verify') return;
    if (uncertainRef.current) {
      setPhase('unknown');
      return;
    }
    // Nothing under this key can have taken effect: the next submission takes a new key.
    forget();
    setPhase('edit');
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

  const unknown = () => {
    if (!uncertainRef.current) marker.mark();
    uncertainRef.current = true;
    setPhase('unknown');
  };

  const send = async (
    body: PayoutBatchRequest,
    key: string,
    stepUpToken: string,
    sent: readonly WithdrawalRow[],
  ): Promise<void> => {
    try {
      const response = await customOf()<PayoutBatchResult>({
        url: PAYOUT_BATCHES_URL,
        method: 'post',
        payload: body,
        meta: { stepUpToken, idempotencyKey: key },
      });
      if (!alive.current) return;
      const answer = response.data as Partial<PayoutBatchResult> | undefined;
      if (
        answer?.outcome === 'executed' &&
        Array.isArray(answer.paying) &&
        Array.isArray(answer.left)
      ) {
        if (uncertainRef.current) marker.clear();
        forget();
        setNotice(undefined);
        setResult(answer as PayoutBatchResult);
        setPhase('done');
        onExecuted(resultTexts(sent, answer as PayoutBatchResult));
        onFinished();
        return;
      }
      if (answer?.outcome === 'rejected') {
        // 整批拒绝已确定：显示原因全文、解锁，勾选保留；下一次执行是新操作，换新键。
        if (uncertainRef.current) marker.clear();
        forget();
        setNotice(refusedText(answer as PayoutBatchResult));
        setPhase('edit');
        return;
      }
      // An answer that does not say what happened is no answer: stay locked.
      setNotice(undefined);
      unknown();
    } catch (cause) {
      if (!alive.current) return;
      if (verifyAgain(cause)) {
        // 凭证未被接受：重新验证后以新凭证、原幂等键与原请求体再发。
        setAgain(true);
        setPhase('verify');
        return;
      }
      if (uncertainRef.current && keepsUnknown(cause)) {
        setNotice(executeFailure(cause));
        setPhase('unknown');
        return;
      }
      if (isSettledRejection(cause)) {
        // A settled refusal settles an unknown submission; an ended session (10001) settles nothing.
        if (endsSession(cause)) marker.leave();
        else marker.clear();
        forget();
        setNotice(executeFailure(cause));
        setPhase('edit');
        return;
      }
      // 网络错误、无法解析、40901（同键仍在处理）、5xx：结果未知，锁定。
      setNotice(undefined);
      unknown();
    }
  };

  const onVerified = (stepUpToken: string) => {
    const body = bodyRef.current;
    const key = keyRef.current;
    if (phaseRef.current !== 'verify' || body === undefined || key === undefined) return;
    if (snapshot === undefined) return;
    setPhase('sending');
    void send(body, key, stepUpToken, snapshot);
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const done = phase === 'done' && result !== undefined;
  const texts = done && snapshot !== undefined ? resultTexts(snapshot, result) : undefined;
  const paying = new Set(result?.paying ?? []);

  const columns: TableColumnsType<WithdrawalRow> = [
    {
      key: 'number',
      title: te.number,
      render: (_, row) => <span style={code}>{row.out_biz_no}</span>,
    },
    {
      key: 'user',
      title: te.user,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.user.user_id}</span>
          {row.user.phone_masked === null ? null : <span>{row.user.phone_masked}</span>}
        </Flex>
      ),
    },
    {
      key: 'net',
      title: te.net,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.net_fen)}</span>,
    },
    {
      key: 'plan',
      title: done ? te.result : t.plan,
      render: (_, row) => {
        if (!canExecute(row))
          return <Typography.Text type="warning">{t.unreviewed}</Typography.Text>;
        if (texts === undefined) return <span>{t.willExecute}</span>;
        return (
          <Typography.Text type={paying.has(row.withdrawal_id) ? 'success' : 'warning'}>
            {texts.get(row.withdrawal_id)}
          </Typography.Text>
        );
      },
    },
  ];

  let checks: ReactElement | null = null;
  if (snapshot !== undefined && !done) {
    let list: ReactElement;
    if (overview.status === 'loading')
      list = (
        <Typography.Text type="secondary">
          {withdrawalsTexts.detailPayout.overviewLoading}
        </Typography.Text>
      );
    else if (overview.status === 'failed')
      list = (
        <Typography.Text type="warning">
          {withdrawalsTexts.detailPayout.overviewFailed}
        </Typography.Text>
      );
    else
      list = (
        <>
          <ul style={{ margin: 0, paddingInlineStart: token.paddingLG }}>
            {checksOf(toSend, overview.data).map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
          <Typography.Text type="secondary">
            {te.recheck(beijingTime(overview.data.as_of))}
          </Typography.Text>
        </>
      );
    checks = (
      <Flex vertical gap={4}>
        <Typography.Text strong>{te.checkTitle}</Typography.Text>
        {list}
      </Flex>
    );
  }

  let summary: string | undefined;
  if (done && snapshot !== undefined) {
    const sent = snapshot.filter(canExecute);
    const count = sent.filter((row) => paying.has(row.withdrawal_id)).length;
    summary = t.summary(count, sent.length - count, snapshot.length - sent.length);
  }

  let footer: ReactElement;
  if (done)
    footer = (
      <Flex justify="end">
        <Button autoInsertSpace={false} type="primary" onClick={close}>
          {te.close}
        </Button>
      </Flex>
    );
  else if (phase === 'unknown')
    footer = (
      <Flex justify="end" gap={8}>
        <Button autoInsertSpace={false} type="primary" onClick={retry}>
          {withdrawalsTexts.detailPayout.retry}
        </Button>
        <Button autoInsertSpace={false} onClick={toList}>
          {t.toList}
        </Button>
      </Flex>
    );
  else
    footer = (
      <Flex justify="end" gap={8}>
        <Button autoInsertSpace={false} disabled={busy} onClick={close}>
          {te.cancel}
        </Button>
        <Button
          autoInsertSpace={false}
          type="primary"
          disabled={busy || !sendable}
          onClick={submit}
        >
          {te.submit}
        </Button>
      </Flex>
    );

  const unreviewed = snapshot?.some((row) => !canExecute(row)) === true;

  return (
    <>
      <Flex
        align="center"
        justify="flex-end"
        gap={16}
        wrap
        style={{
          padding: `${token.paddingXS}px ${token.padding}px`,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Flex gap={8}>
          <Button autoInsertSpace={false} disabled={locked || busy} onClick={group}>
            {t.group}
          </Button>
          {executable.length === 0 ? null : (
            <Button
              ref={entryRef}
              type="primary"
              autoInsertSpace={false}
              disabled={busy}
              onClick={open}
            >
              {t.entry}
            </Button>
          )}
        </Flex>
      </Flex>
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
          footer={footer}
        >
          <Flex vertical gap={token.marginSM} style={{ paddingTop: token.paddingXS }}>
            {phase === 'unknown' ? (
              <Alert
                type="warning"
                showIcon
                message={t.unknownTitle}
                description={t.unknownDescription}
              />
            ) : null}
            {notice === undefined || (phase !== 'edit' && phase !== 'unknown') ? null : (
              <Alert type="error" showIcon role="alert" message={notice} />
            )}
            {toSend.length > MAX_BATCH && phase === 'edit' ? (
              <Alert type="warning" showIcon message={t.tooMany(MAX_BATCH)} />
            ) : null}
            <Table<WithdrawalRow>
              rowKey="withdrawal_id"
              size="small"
              columns={columns}
              dataSource={snapshot as WithdrawalRow[]}
              pagination={false}
            />
            {unreviewed && !done ? (
              <Typography.Text type="warning">{t.unreviewedNote}</Typography.Text>
            ) : null}
            {checks}
            <Typography.Text type="secondary">{done ? summary : t.consequence}</Typography.Text>
          </Flex>
        </Modal>
      )}
      <StepUpModal
        open={snapshot !== undefined && phase === 'verify'}
        tier="totp"
        operation={te.operation}
        details={[te.stepUpTarget(toSend.length), ...(again ? [te.stepUpAgain] : [])]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </>
  );
}
