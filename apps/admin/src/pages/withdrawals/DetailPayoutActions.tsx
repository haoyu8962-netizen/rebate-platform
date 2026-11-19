// 提现单详情页的【执行打款】与【手动成功】（F1-08am）。一张单即一张单的批次：
// 【执行打款】走 adminCreatePayoutBatch（POST /admin/v1/payout-batches，payout.execute，body 只有
// withdrawal_ids=[这一张]；BR-WDR-12 EXECUTE）；【手动成功】走 adminBatchManualPaid（POST
// /admin/v1/withdrawals/batch-manual-paid，payout.manual_entry，items 只有这一张；BR-WDR-16 W8）。
// 两者都是动态码档 step-up（BR-ID-34），Idempotency-Key 必填。
// 入口：只对 APPROVED 单、按权限点出现（没有权限就不出现，不置灰）；有任何 kind=transfer 的转账尝试时
// 不出【执行打款】（BR-WDR-12 ②）；有 result ∈ {pending, success, unknown} 的转账尝试或微信零钱单
// （BR-WDR-33 ⑧）不出【手动成功】。暂扣、阻断等由服务端逐单判定，页面如实显示逐单结果。
// 进页不读打款概览；只在打开【执行打款】确认框后读一次，用于「执行前检查」（未满足不拦提交）。
// 结果未知（F1-08ce 做法，D10-1731 / D10-1739）：网络错误、无法解析的响应、40901、带外壳的 5xx →
// 「上次提交结果未知」，输入锁定、对话框关不掉，只剩【重试】（重新动态码后原键、同一请求体）与
// 【刷新详情核对】；不自动重发。结果未知后重试收到 10403，或 10003 + verify_phone_missing，仍是结果
// 未知（D10-2060 / D10-2061）；20001 等确定拒绝解锁、下次换新键；普通 10003 重新验证后原键原体。
// 手动成功的三项打开时为空，页面不预填、不提供把应付或当前时间填进去的任何入口（D10-2004 / D10-2050）。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Descriptions, Flex, Input, Modal, Typography, theme } from 'antd';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { stepUpTexts } from '../../texts/step-up.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import {
  EMPTY_ENTRY,
  checkEntry,
  type Entry,
  type Field,
  type ManualPaidClock,
} from './ManualPaid.tsx';
import {
  EXECUTE_PERMISSION,
  MANUAL_ENTRY_PERMISSION,
  MANUAL_PAID_URL,
  OVERVIEW_URL,
  PAYOUT_BATCHES_URL,
  STEP_UP_URL,
  beijingTime,
  channelLabel,
  fieldsOf,
  isSettledRejection,
  money,
  newRequestKey,
  reasonOf,
  type PayoutBatchRequest,
  type PayoutBatchResult,
  type PayoutOverview,
  type WithdrawalDetail,
} from './model.ts';
import { checksOf, itemText, refusedText } from './PayoutExecute.tsx';

const t = withdrawalsTexts.detailPayout;
const te = withdrawalsTexts.execute;
const tm = withdrawalsTexts.manualPaid;
const STEP_UP_REFUSED = 10003;
const FORBIDDEN = 10403;
const VERIFY_PHONE_MISSING = 'verify_phone_missing';
/** Transfer results that bar a manual success (BR-WDR-16): only `fail` leaves it open. */
const OPEN_RESULTS: readonly string[] = ['pending', 'success', 'unknown'];

type ManualPayload = Schema<'AdminWithdrawalBatchManualPaidRequest'>;
type ManualAnswer = Schema<'AdminWithdrawalBatchManualPaid'>;
type ManualResult = Schema<'AdminWithdrawalBatchManualPaidItem'>;
type Phase = 'edit' | 'verify' | 'sending' | 'unknown' | 'done';

/** 【执行打款】: APPROVED, payout.execute, and no transfer attempt at all (BR-WDR-12 ②). */
export function canExecuteDetail(item: WithdrawalDetail, access: AccessControl): boolean {
  return (
    item.status === 'APPROVED' &&
    access.can(EXECUTE_PERMISSION) &&
    !item.payout_attempts.some((attempt) => attempt.kind === 'transfer')
  );
}

/**
 * 【手动成功】: APPROVED, payout.manual_entry, not WeChat (BR-WDR-33 ⑧) and no pending / success /
 * unknown transfer attempt (BR-WDR-16; a `fail` one returned by W9 leaves it open).
 */
export function canRecordPaidDetail(item: WithdrawalDetail, access: AccessControl): boolean {
  return (
    item.status === 'APPROVED' &&
    access.can(MANUAL_ENTRY_PERMISSION) &&
    item.payout_channel !== 'wechat' &&
    item.payout_method !== 'wechat' &&
    !item.payout_attempts.some(
      (attempt) => attempt.kind === 'transfer' && OPEN_RESULTS.includes(attempt.result),
    )
  );
}

/** A refusal that leaves an earlier unknown submission unknown (D10-2060 / D10-2061). */
function keepsUnknown(cause: unknown): boolean {
  if (!(cause instanceof AdminApiError) || cause.kind !== 'api') return false;
  if (cause.code === FORBIDDEN) return true;
  return cause.code === STEP_UP_REFUSED && reasonOf(cause) === VERIFY_PHONE_MISSING;
}

/** A plain 10003 (the step-up token was not accepted): verify again, same key and body. */
function verifyAgain(cause: unknown): boolean {
  return (
    cause instanceof AdminApiError &&
    cause.code === STEP_UP_REFUSED &&
    reasonOf(cause) !== VERIFY_PHONE_MISSING
  );
}

function useVerify() {
  const getProvider = useDataProvider();
  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
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
  return { customOf, verify };
}

function usePhase() {
  const [phase, setValue] = useState<Phase>('edit');
  const ref = useRef<Phase>('edit');
  const setPhase = (next: Phase) => {
    ref.current = next;
    setValue(next);
  };
  return { phase, phaseRef: ref, setPhase };
}

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export interface DetailPayoutActionsProps {
  readonly item: WithdrawalDetail;
  readonly access: AccessControl;
  readonly clock: ManualPaidClock;
  /** A write has an answer (or is to be checked): read the detail again. */
  readonly onChanged: () => void;
}

export function DetailPayoutActions(props: DetailPayoutActionsProps): ReactElement {
  return (
    <>
      <DetailExecute item={props.item} access={props.access} onChanged={props.onChanged} />
      <DetailManualPaid {...props} />
    </>
  );
}

// ---- 【执行打款】 -------------------------------------------------------------------------------

type OverviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: PayoutOverview }
  | { readonly status: 'failed' };

/** The notice of a settled refusal of the execute (the dialog unlocks). */
function executeFailure(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return te.failed;
  if (cause.code === FORBIDDEN) return te.forbidden;
  if (cause.code === STEP_UP_REFUSED && reasonOf(cause) === VERIFY_PHONE_MISSING)
    return stepUpTexts.verifyPhoneMissing;
  if (cause.code === 20001)
    return fieldsOf(cause).includes('withdrawal_ids') ? te.idsInvalid : te.invalid;
  return te.failed;
}

function DetailExecute({
  item,
  access,
  onChanged,
}: Omit<DetailPayoutActionsProps, 'clock'>): ReactElement {
  const { customOf, verify } = useVerify();
  const { token } = theme.useToken();
  const { phase, phaseRef, setPhase } = usePhase();
  const alive = useAlive();
  /** The withdrawal as it was when the dialog opened (the page may read it again meanwhile). */
  const [snapshot, setSnapshot] = useState<WithdrawalDetail>();
  const [overview, setOverview] = useState<OverviewState>({ status: 'loading' });
  const [again, setAgain] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [result, setResult] = useState<PayoutBatchResult>();
  /** The body and key of the open operation; undefined: the next submit is a new one. */
  const bodyRef = useRef<PayoutBatchRequest | undefined>(undefined);
  const keyRef = useRef<string | undefined>(undefined);
  /** An earlier send under this key got no settled answer: it may have taken effect. */
  const uncertainRef = useRef(false);
  const busy = phase === 'verify' || phase === 'sending' || phase === 'unknown';

  const forget = () => {
    bodyRef.current = undefined;
    keyRef.current = undefined;
    uncertainRef.current = false;
  };

  const shown = canExecuteDetail(item, access);

  const open = () => {
    if (snapshot !== undefined || !shown) return;
    forget();
    setNotice(undefined);
    setResult(undefined);
    setAgain(false);
    setPhase('edit');
    setSnapshot(item);
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
    forget();
    setSnapshot(undefined);
    setPhase('edit');
  };

  const check = () => {
    if (phaseRef.current !== 'unknown') return;
    forget();
    setSnapshot(undefined);
    setPhase('edit');
    onChanged();
  };

  const submit = () => {
    if (phaseRef.current !== 'edit' || snapshot === undefined) return;
    if (bodyRef.current === undefined || keyRef.current === undefined) {
      bodyRef.current = { withdrawal_ids: [snapshot.withdrawal_id] };
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
    forget();
    setPhase('edit');
  };

  const send = async (
    body: PayoutBatchRequest,
    key: string,
    stepUpToken: string,
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
      if (answer?.outcome === 'executed') {
        forget();
        setNotice(undefined);
        setResult(answer as PayoutBatchResult);
        setPhase('done');
        onChanged();
        return;
      }
      if (answer?.outcome === 'rejected') {
        // 整批拒绝已确定：显示原因、解锁；下一次执行是新操作，换新键。
        forget();
        setNotice(refusedText(answer as PayoutBatchResult));
        setPhase('edit');
        return;
      }
      // An answer that does not say what happened is no answer: stay locked.
      uncertainRef.current = true;
      setPhase('unknown');
    } catch (cause) {
      if (!alive.current) return;
      if (verifyAgain(cause)) {
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
        forget();
        setNotice(executeFailure(cause));
        setPhase('edit');
        return;
      }
      uncertainRef.current = true;
      setNotice(undefined);
      setPhase('unknown');
    }
  };

  const onVerified = (stepUpToken: string) => {
    const body = bodyRef.current;
    const key = keyRef.current;
    if (phaseRef.current !== 'verify' || body === undefined || key === undefined) return;
    setPhase('sending');
    void send(body, key, stepUpToken);
  };

  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const done = phase === 'done' && result !== undefined;

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
          {t.retry}
        </Button>
        <Button autoInsertSpace={false} onClick={check}>
          {t.check}
        </Button>
      </Flex>
    );
  else
    footer = (
      <Flex justify="end" gap={8}>
        <Button autoInsertSpace={false} disabled={busy} onClick={close}>
          {te.cancel}
        </Button>
        <Button autoInsertSpace={false} type="primary" disabled={busy} onClick={submit}>
          {te.submit}
        </Button>
      </Flex>
    );

  let checks: ReactElement | null = null;
  if (snapshot !== undefined && !done) {
    let list: ReactElement;
    if (overview.status === 'loading')
      list = <Typography.Text type="secondary">{t.overviewLoading}</Typography.Text>;
    else if (overview.status === 'failed')
      list = <Typography.Text type="warning">{t.overviewFailed}</Typography.Text>;
    else
      list = (
        <>
          <ul style={{ margin: 0, paddingInlineStart: token.paddingLG }}>
            {checksOf([snapshot], overview.data).map((entry) => (
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

  let outcome: ReactElement | null = null;
  if (done && snapshot !== undefined) {
    const paying = new Set(result.paying);
    const left = new Map(result.left.map((entry) => [entry.withdrawal_id, entry]));
    outcome = (
      <Typography.Text
        role="status"
        type={paying.has(snapshot.withdrawal_id) ? 'success' : 'warning'}
      >
        {itemText(snapshot.withdrawal_id, paying, left)}
      </Typography.Text>
    );
  }

  return (
    <>
      {shown ? (
        <Button type="primary" autoInsertSpace={false} onClick={open}>
          {t.execute}
        </Button>
      ) : null}
      {snapshot === undefined ? null : (
        <Modal
          open
          width={640}
          title={
            done ? t.executeResultTitle(snapshot.out_biz_no) : t.executeTitle(snapshot.out_biz_no)
          }
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
                description={t.executeUnknownDescription}
              />
            ) : null}
            {notice === undefined || (phase !== 'edit' && phase !== 'unknown') ? null : (
              <Alert type="error" showIcon role="alert" message={notice} />
            )}
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                {
                  key: 'number',
                  label: t.number,
                  children: <span style={code}>{snapshot.out_biz_no}</span>,
                },
                {
                  key: 'channel',
                  label: t.channel,
                  children: channelLabel(snapshot.payout_channel),
                },
                {
                  key: 'net',
                  label: t.net,
                  children: <span style={amount}>{money(snapshot.net_fen)}</span>,
                },
                ...(done
                  ? [
                      {
                        key: 'batch',
                        label: te.batch,
                        children: (
                          <span style={code}>{result.batch_id ?? withdrawalsTexts.dash}</span>
                        ),
                      },
                      { key: 'result', label: t.result, children: outcome },
                    ]
                  : []),
              ]}
            />
            {checks}
            <Typography.Text type="secondary">
              {done ? t.refreshed : t.executeConsequence}
            </Typography.Text>
          </Flex>
        </Modal>
      )}
      <StepUpModal
        open={snapshot !== undefined && phase === 'verify'}
        tier="totp"
        operation={te.operation}
        details={[t.stepUpTarget(snapshot?.out_biz_no ?? ''), ...(again ? [te.stepUpAgain] : [])]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </>
  );
}

// ---- 【手动成功】 -------------------------------------------------------------------------------

/** The notice of a settled refusal of the manual entry (the inputs unlock). */
function manualFailure(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return tm.failed;
  if (cause.code === FORBIDDEN) return tm.forbidden;
  if (cause.code === STEP_UP_REFUSED && reasonOf(cause) === VERIFY_PHONE_MISSING)
    return stepUpTexts.verifyPhoneMissing;
  if (cause.code === 20001) return tm.invalidRequest;
  return tm.failed;
}

function manualOutcome(result: ManualResult | undefined): string {
  if (result === undefined) return tm.noResult;
  if (result.result === 'paid') return tm.paid;
  const reason = result.reason ?? null;
  if (reason === null) return tm.noResult;
  return tm.skipped[reason] ?? tm.skippedOther(reason);
}

function DetailManualPaid({
  item,
  access,
  clock,
  onChanged,
}: DetailPayoutActionsProps): ReactElement {
  const { customOf, verify } = useVerify();
  const { token } = theme.useToken();
  const { phase, phaseRef, setPhase } = usePhase();
  const alive = useAlive();
  const [snapshot, setSnapshot] = useState<WithdrawalDetail>();
  const [entry, setEntry] = useState<Entry>(EMPTY_ENTRY);
  const [touched, setTouched] = useState<ReadonlySet<Field>>(new Set());
  const [again, setAgain] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [result, setResult] = useState<ManualResult | 'none'>();
  /** The request body of the open submission, sent again unchanged (same object, same bytes). */
  const bodyRef = useRef<ManualPayload | undefined>(undefined);
  /** The Idempotency-Key of the open submission; undefined: the next submission takes a new one. */
  const keyRef = useRef<string | undefined>(undefined);
  const uncertainRef = useRef(false);
  const busy = phase === 'verify' || phase === 'sending' || phase === 'unknown';
  const locked = phase !== 'edit';

  const forget = () => {
    bodyRef.current = undefined;
    keyRef.current = undefined;
    uncertainRef.current = false;
  };

  const shown = canRecordPaidDetail(item, access);

  const open = () => {
    if (snapshot !== undefined || !shown) return;
    forget();
    setEntry(EMPTY_ENTRY);
    setTouched(new Set());
    setNotice(undefined);
    setResult(undefined);
    setAgain(false);
    setPhase('edit');
    setSnapshot(item);
  };

  const close = () => {
    if (phaseRef.current !== 'edit' && phaseRef.current !== 'done') return;
    forget();
    setSnapshot(undefined);
    setPhase('edit');
  };

  const check = () => {
    if (phaseRef.current !== 'unknown') return;
    forget();
    setSnapshot(undefined);
    setPhase('edit');
    onChanged();
  };

  const now = clock.now();
  const checked = snapshot === undefined ? undefined : checkEntry(snapshot, entry, now);
  const ready = checked?.item !== undefined;

  const touch = (field: Field) =>
    setTouched((previous) => (previous.has(field) ? previous : new Set(previous).add(field)));

  const change = (field: Field, value: string) => {
    if (phaseRef.current !== 'edit') return;
    setEntry((previous) => ({ ...previous, [field]: value }));
    touch(field);
  };

  const submit = () => {
    if (phaseRef.current !== 'edit' || snapshot === undefined) return;
    // Judged again at the moment of the click, against the clock of this moment.
    const line = checkEntry(snapshot, entry, clock.now()).item;
    if (line === undefined) return;
    bodyRef.current = { items: [line] };
    keyRef.current = newRequestKey();
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
    forget();
    setPhase('edit');
  };

  const send = async (body: ManualPayload, key: string, stepUpToken: string): Promise<void> => {
    try {
      const response = await customOf()<ManualAnswer>({
        url: MANUAL_PAID_URL,
        method: 'post',
        payload: body,
        meta: { stepUpToken, idempotencyKey: key },
      });
      if (!alive.current) return;
      const items: unknown = (response.data as { items?: unknown } | undefined)?.items;
      if (!Array.isArray(items)) {
        uncertainRef.current = true;
        setPhase('unknown');
        return;
      }
      const id = body.items[0]?.withdrawal_id;
      const mine = (items as ManualResult[]).find((line) => line.withdrawal_id === id);
      forget();
      setNotice(undefined);
      setResult(mine ?? 'none');
      setPhase('done');
      onChanged();
    } catch (cause) {
      if (!alive.current) return;
      if (verifyAgain(cause)) {
        setAgain(true);
        setPhase('verify');
        return;
      }
      if (uncertainRef.current && keepsUnknown(cause)) {
        setNotice(manualFailure(cause));
        setPhase('unknown');
        return;
      }
      if (isSettledRejection(cause)) {
        forget();
        setNotice(manualFailure(cause));
        setPhase('edit');
        return;
      }
      uncertainRef.current = true;
      setNotice(undefined);
      setPhase('unknown');
    }
  };

  const onVerified = (stepUpToken: string) => {
    const body = bodyRef.current;
    const key = keyRef.current;
    if (phaseRef.current !== 'verify' || body === undefined || key === undefined) return;
    setPhase('sending');
    void send(body, key, stepUpToken);
  };

  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const done = phase === 'done' && result !== undefined;

  const input = (field: Field, label: string) => {
    const error = touched.has(field) ? checked?.errors[field] : undefined;
    return (
      <Flex vertical gap={2}>
        <Typography.Text>{label}</Typography.Text>
        <Input
          aria-label={label}
          value={entry[field]}
          disabled={locked}
          autoComplete="off"
          {...(field === 'paidAt' ? { placeholder: tm.paidAtPlaceholder } : {})}
          {...(field === 'amount' ? { inputMode: 'decimal' as const } : {})}
          status={error === undefined ? '' : 'error'}
          aria-invalid={error === undefined ? undefined : true}
          onChange={(event) => change(field, event.target.value)}
          onBlur={() => touch(field)}
        />
        {error === undefined ? null : (
          <Typography.Text type="danger" style={{ fontSize: token.fontSizeSM }}>
            {error}
          </Typography.Text>
        )}
      </Flex>
    );
  };

  let footer: ReactElement;
  if (done)
    footer = (
      <Flex justify="end">
        <Button autoInsertSpace={false} type="primary" onClick={close}>
          {tm.close}
        </Button>
      </Flex>
    );
  else if (phase === 'unknown')
    footer = (
      <Flex justify="end" gap={8}>
        <Button autoInsertSpace={false} type="primary" onClick={retry}>
          {t.retry}
        </Button>
        <Button autoInsertSpace={false} onClick={check}>
          {t.check}
        </Button>
      </Flex>
    );
  else
    footer = (
      <Flex justify="end" gap={8}>
        <Button autoInsertSpace={false} disabled={busy} onClick={close}>
          {tm.cancel}
        </Button>
        <Button autoInsertSpace={false} type="primary" disabled={busy || !ready} onClick={submit}>
          {tm.submit}
        </Button>
      </Flex>
    );

  const line = result === 'none' ? undefined : result;

  return (
    <>
      {shown ? (
        <Button autoInsertSpace={false} onClick={open}>
          {t.manual}
        </Button>
      ) : null}
      {snapshot === undefined ? null : (
        <Modal
          open
          width={640}
          title={
            done ? t.manualResultTitle(snapshot.out_biz_no) : t.manualTitle(snapshot.out_biz_no)
          }
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
                description={t.manualUnknownDescription}
              />
            ) : null}
            {notice === undefined || (phase !== 'edit' && phase !== 'unknown') ? null : (
              <Alert type="error" showIcon role="alert" message={notice} />
            )}
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                {
                  key: 'number',
                  label: t.number,
                  children: <span style={code}>{snapshot.out_biz_no}</span>,
                },
                {
                  key: 'channel',
                  label: t.channel,
                  children: channelLabel(snapshot.payout_channel),
                },
                {
                  key: 'due',
                  label: t.due,
                  children: <span style={amount}>{money(snapshot.net_fen)}</span>,
                },
                ...(done
                  ? [
                      {
                        key: 'result',
                        label: t.result,
                        children: (
                          <Typography.Text
                            role="status"
                            type={line?.result === 'paid' ? 'success' : 'warning'}
                          >
                            {manualOutcome(line)}
                          </Typography.Text>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            {input('serial', tm.serial)}
            {input('paidAt', tm.paidAt)}
            {input('amount', tm.paidFen)}
            <Typography.Text type="secondary">
              {done ? t.refreshed : t.manualConsequence}
            </Typography.Text>
          </Flex>
        </Modal>
      )}
      <StepUpModal
        open={snapshot !== undefined && phase === 'verify'}
        tier="totp"
        operation={tm.operation}
        details={[t.stepUpTarget(snapshot?.out_biz_no ?? ''), ...(again ? [tm.stepUpAgain] : [])]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </>
  );
}
