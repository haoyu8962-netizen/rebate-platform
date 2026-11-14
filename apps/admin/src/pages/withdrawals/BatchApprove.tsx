// 提现审核列表的批量栏与【批量通过】（规格 admin-withdrawals.md §2「批量通过确认」、§4 批量栏 /
// 批量通过对话框、§6；契约 CT-24y adminBatchApproveWithdrawals，BR-WDR-10 批量审核、BR-WDR-05、
// BR-ID-34 动态码档）。只在勾选了至少一张待审核单时出现：统计「已选 N 张，合计实付」（aria-live）
// 与【批量通过】。流程：确认框（按列表顺序逐单列本次处理：将通过；受阻待审单写明会被跳过及原因）
// → 动态码（totp 档）→ 只发一次 batch-approve（body 只有 withdrawal_ids，带 X-Step-Up-Token 与
// Idempotency-Key）→ 确认框里逐单显示结果，清空已选并重新拉列表。余额为负等阻断只由服务端判。
// 幂等键：10003 重新验证与网络错误后不改勾选重提沿用原键；一批完成后或勾选改变后换新键。
// 其余失败提示后保留确认框与勾选，不自动重发。提交中确认框保留、入口与提交按钮禁用；
// 关闭后焦点回【批量通过】。
import type { Schema } from '@couli/contracts-ts';
import { addFen, formatYuanAdmin, parseFen } from '@couli/money';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
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
  APPROVE_URL,
  STEP_UP_URL,
  fieldsOf,
  money,
  newRequestKey,
  type WithdrawalRow,
} from './model.ts';

const t = withdrawalsTexts.batchApprove;
const review = withdrawalsTexts.review;
const STEP_UP_REFUSED = 10003;
const IN_FLIGHT = 40901;

/**
 * 服务端已确定拒绝本次操作（HTTP 4xx 的业务错误，40901 除外）：同键再发只会得到同样的拒绝，
 * 键可以清空。网络错误、40901、5xx 及其他无法判定的失败，结果都未确定，返回 false。
 */
function isSettledRejection(cause: unknown): boolean {
  return (
    cause instanceof AdminApiError &&
    cause.kind === 'api' &&
    cause.code !== IN_FLIGHT &&
    cause.httpStatus >= 400 &&
    cause.httpStatus < 500
  );
}

type ApprovePayload = Schema<'AdminWithdrawalBatchApproveRequest'>;
type ApproveResult = Schema<'AdminWithdrawalBatchApprove'>;
type ResultItem = Schema<'AdminWithdrawalBatchApproveItem'>;
type Phase = 'preview' | 'verify' | 'sending' | 'done';

export interface BatchApproveProps {
  /** The selected PENDING_REVIEW rows, in list order, without duplicates. */
  readonly rows: readonly WithdrawalRow[];
  /** A batch has an answer: clear the selection and read the list again. */
  readonly onFinished: () => void;
  /** Whether a step-up or the write is in progress (the list locks its checkboxes). */
  readonly onBusyChange: (busy: boolean) => void;
}

/** Sum of the net amounts (integer fen through @couli/money). */
function netTotal(rows: readonly WithdrawalRow[]): string {
  let total = parseFen(0);
  for (const row of rows) total = addFen(total, parseFen(row.net_fen));
  return formatYuanAdmin(total);
}

/** The text of one item's answer (skips by their contract reason, never shown as approved). */
function outcomeText(item: ResultItem | undefined): string {
  if (item === undefined) return t.noResult;
  if (item.result === 'approved') return t.approved;
  const reason = item.reason ?? null;
  if (reason === null) return t.noResult;
  return review.skipped[reason] ?? review.skippedOther(reason);
}

/** The notice of a refused batch (the dialog stays open, nothing is sent again). */
function failureNotice(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return review.failed;
  if (cause.kind === 'network') return review.network;
  if (cause.code === 10403) return review.forbidden;
  if (cause.code === 20001)
    return fieldsOf(cause).includes('withdrawal_ids') ? review.idsInvalid : review.invalid;
  return review.failed;
}

export function BatchApprove({ rows, onFinished, onBusyChange }: BatchApproveProps): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [notify, contextHolder] = message.useMessage();
  const [snapshot, setSnapshot] = useState<readonly WithdrawalRow[]>();
  const [phase, setPhaseValue] = useState<Phase>('preview');
  const [again, setAgain] = useState(false);
  const [results, setResults] = useState<ReadonlyMap<string, ResultItem>>();
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

  // 确认框关闭后焦点回到【批量通过】（入口已因清空勾选消失时不处理）。
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

  const openDialog = () => {
    if (snapshot !== undefined || rows.length === 0) return;
    setResults(undefined);
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
    const payload: ApprovePayload = { withdrawal_ids: items.map((row) => row.withdrawal_id) };
    try {
      const response = await customOf()<ApproveResult>({
        url: APPROVE_URL,
        method: 'post',
        payload,
        meta: { stepUpToken, idempotencyKey: key },
      });
      if (!alive.current) return;
      keyRef.current = undefined;
      pendingKey.current = undefined;
      setResults(new Map(response.data.items.map((item) => [item.withdrawal_id, item])));
      setPhase('done');
      onFinished();
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // 凭证未被接受：重新验证后以新凭证、原幂等键与原请求体再发。
        setAgain(true);
        setPhase('verify');
        return;
      }
      pendingKey.current = undefined;
      // 只有服务端确定拒绝（4xx 业务错误，如 10403、20001、20901）才清空幂等键。
      // 结果未确定的失败——网络错误、40901（同键仍在处理）、5xx（已通过的保留、同键重跑其余）
      // 以及其他无法判定的错误——都保留原键：不改勾选手动重提沿用原键，服务端返回首次结果，
      // 不会因换新键把已通过的单显示成 not_pending 跳过。任何错误都不自动重发。
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
  const done = phase === 'done' && results !== undefined;

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
      key: 'amount',
      title: t.amount,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.amount_fen)}</span>,
    },
    {
      key: 'plan',
      title: done ? t.result : t.plan,
      render: (_, row) => {
        if (done) {
          const item = results.get(row.withdrawal_id);
          return (
            <Typography.Text type={item?.result === 'approved' ? 'success' : 'warning'}>
              {outcomeText(item)}
            </Typography.Text>
          );
        }
        return row.blocked_reason === null ? (
          t.willApprove
        ) : (
          <Typography.Text type="warning">
            {outcomeText({
              withdrawal_id: row.withdrawal_id,
              result: 'skipped',
              reason: 'blocked',
            })}
          </Typography.Text>
        );
      },
    },
  ];

  let summary: string | undefined;
  if (done && snapshot !== undefined) {
    const approved = snapshot.filter(
      (row) => results.get(row.withdrawal_id)?.result === 'approved',
    ).length;
    summary = t.summary(approved, snapshot.length - approved);
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
          <span aria-live="polite">{t.selected(rows.length, netTotal(rows))}</span>
          <Button
            ref={entryRef}
            type="primary"
            autoInsertSpace={false}
            disabled={busy}
            onClick={openDialog}
          >
            {t.entry}
          </Button>
        </Flex>
      )}
      {snapshot === undefined ? null : (
        <Modal
          open
          width={720}
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
            <Table<WithdrawalRow>
              rowKey="withdrawal_id"
              size="small"
              columns={columns}
              dataSource={snapshot as WithdrawalRow[]}
              pagination={false}
            />
            <Typography.Text type="secondary">{done ? summary : t.consequence}</Typography.Text>
          </Flex>
        </Modal>
      )}
      <StepUpModal
        open={snapshot !== undefined && phase === 'verify'}
        tier="totp"
        operation={t.operation}
        details={[t.stepUpTarget(snapshot?.length ?? 0), ...(again ? [review.stepUpAgain] : [])]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </>
  );
}
