// 提现审核列表的【批量手动打款】（规格 admin-withdrawals.md §4 批量栏 / 批量手动打款对话框；契约
// adminBatchManualPaid；BR-WDR-16 手动成功、BR-WDR-05 阻断只由服务端判、BR-ID-34 动态码档）。
// 持 payout.manual_entry（超管持全部点）时勾到待执行（APPROVED）单出现批量栏与【批量手动打款】。
// 对话框按列表顺序逐单列出单号、收款方式、应付，并让录入人逐单填写通道流水号、实付时间、实付金额（元）；
// 三项打开时都为空，页面不预填、不提供把应付或当前时间填进去的任何快捷入口，也不改写输入（D10-2004 /
// D10-2012）。微信零钱单只标跳过、不出输入、不进请求。本地校验：流水号去首尾空白后 1–64 字、无空白与
// NUL；实付时间不晚于注入时钟的现在；实付金额先判格式（非负、最多两位小数），合格才经 yuanStrToFen
// 转整数分，且必须等于 net_fen。
// 流程：【确认录入】→ 动态码（totp）→ 只发一次 POST batch-manual-paid（items，带 X-Step-Up-Token 与
// Idempotency-Key）→ 逐单显示已录入 / 跳过原因与汇总，清空已选并重读列表；下一次提交换新键。
// 结果未知（照 F1-08ce）：没有统一外壳的回答、带外壳的 40901 与 5xx → 「上次提交结果未知」，输入锁定、
// 对话框不能关，只剩【重试】（重新动态码后原键、同一请求体逐字节相同地重发）与【去列表核对】；
// 拿到确定结果才解锁。10003 重新动态码后沿用原键原体。任何失败都不自动重发。
// 进入结果未知后重试收到带外壳的 10403（契约先判 payout.manual_entry、后做幂等回放，权限可能在未知窗口内
// 被撤）不算确定结果：显示其原文，仍是结果未知、原键原体保留（F1-08as，D10-2060）；20001 照旧解锁换键。
import type { Schema } from '@couli/contracts-ts';
import { addFen, fenToJsonNumber, formatYuanAdmin, parseFen, yuanStrToFen } from '@couli/money';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Flex,
  Input,
  Modal,
  Table,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { endsSession, useUnknownMarker } from '../../components/unknown-marker/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import {
  MANUAL_PAID_URL,
  STEP_UP_URL,
  channelLabel,
  checkOrderId,
  isSettledRejection,
  manualPaidClosed,
  money,
  newRequestKey,
  parsePaidAt,
  type WithdrawalRow,
} from './model.ts';

const t = withdrawalsTexts.manualPaid;
const STEP_UP_REFUSED = 10003;
/** The result-unknown marker's page (F1-08at): the menu id of 提现审核. */
export const MARKER_PAGE = 'withdrawals';
/** admin_permission_denied: judged before the idempotent replay, and it changes with the account. */
const FORBIDDEN = 10403;

type Payload = Schema<'AdminWithdrawalBatchManualPaidRequest'>;
type Answer = Schema<'AdminWithdrawalBatchManualPaid'>;
type ResultItem = Schema<'AdminWithdrawalBatchManualPaidItem'>;
type Phase = 'edit' | 'verify' | 'sending' | 'unknown' | 'done';
export type Field = 'serial' | 'paidAt' | 'amount';

/** Time source of the page (AGENTS.md §4 rule 5): the console's injected clock, in epoch ms. */
export interface ManualPaidClock {
  now(): number;
}

export interface Entry {
  readonly serial: string;
  readonly paidAt: string;
  readonly amount: string;
}

export const EMPTY_ENTRY: Entry = { serial: '', paidAt: '', amount: '' };

export interface Checked {
  readonly errors: Partial<Record<Field, string>>;
  readonly item?: Payload['items'][number];
}

/** 实付金额（元）的格式：非负整数，或带一到两位小数。 */
const AMOUNT_FORMAT = /^\d+(\.\d{1,2})?$/;

/** One row's local check; `item` only when all three inputs pass. */
export function checkEntry(
  row: Pick<WithdrawalRow, 'withdrawal_id' | 'net_fen'>,
  entry: Entry,
  now: number,
): Checked {
  const errors: Partial<Record<Field, string>> = {};
  const serial = entry.serial.trim();
  if (serial === '') errors.serial = t.invalid.serialRequired;
  else if (!checkOrderId(serial)) errors.serial = t.invalid.serial;
  const time = parsePaidAt(entry.paidAt);
  if (entry.paidAt.trim() === '') errors.paidAt = t.invalid.timeRequired;
  else if (time === undefined) errors.paidAt = t.invalid.time;
  else if (time.at > now) errors.paidAt = t.invalid.future;
  let paidFen: bigint | undefined;
  if (entry.amount === '') errors.amount = t.invalid.amountRequired;
  else {
    // 先判格式：只接受非负、最多两位小数的十进制（去首尾空白后判），不认正负号、千分位、全角与科学计数；
    // 98.009 这类多位小数在这里就拒，不交给 yuanStrToFen 截尾后误判为等于应付。输入值本身不改写。
    const amount = entry.amount.trim();
    if (AMOUNT_FORMAT.test(amount)) {
      try {
        paidFen = yuanStrToFen(amount);
      } catch {
        paidFen = undefined;
      }
    }
    if (paidFen === undefined || paidFen !== parseFen(row.net_fen))
      errors.amount = t.invalid.amount;
  }
  if (Object.keys(errors).length > 0 || time === undefined || paidFen === undefined)
    return { errors };
  return {
    errors,
    item: {
      withdrawal_id: row.withdrawal_id,
      channel_order_id: serial,
      paid_at: time.iso,
      paid_fen: fenToJsonNumber(paidFen),
    },
  };
}

/** Sum of the net amounts (integer fen through @couli/money). */
function netTotal(rows: readonly WithdrawalRow[]): string {
  let total = parseFen(0);
  for (const row of rows) total = addFen(total, parseFen(row.net_fen));
  return formatYuanAdmin(total);
}

function outcomeText(item: ResultItem | undefined): string {
  if (item === undefined) return t.noResult;
  if (item.result === 'paid') return t.paid;
  const reason = item.reason ?? null;
  if (reason === null) return t.noResult;
  return t.skipped[reason] ?? t.skippedOther(reason);
}

/** The notice of a settled refusal (the inputs unlock, nothing is sent again). */
function failureNotice(cause: unknown): string {
  if (cause instanceof AdminApiError && cause.code === 10403) return t.forbidden;
  if (cause instanceof AdminApiError && cause.code === 20001) return t.invalidRequest;
  return t.failed;
}

export interface ManualPaidProps {
  /** The selected APPROVED rows, in list order, without duplicates. */
  readonly rows: readonly WithdrawalRow[];
  readonly clock: ManualPaidClock;
  /** A batch has an answer (or is to be checked in the list): clear the selection, read again. */
  readonly onFinished: () => void;
  /** Whether a step-up, the write or an unknown result is open (the list locks its checkboxes). */
  readonly onBusyChange: (busy: boolean) => void;
}

export function ManualPaid({
  rows,
  clock,
  onFinished,
  onBusyChange,
}: ManualPaidProps): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  // F1-08at (D10-2075): a marker without business data while the result is unknown, for the prompt
  // after signing in again; cleared once a settled answer comes (not by a 10001).
  const marker = useUnknownMarker(MARKER_PAGE, clock);
  const [snapshot, setSnapshot] = useState<readonly WithdrawalRow[]>();
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(new Map());
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhaseValue] = useState<Phase>('edit');
  const [again, setAgain] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [results, setResults] = useState<ReadonlyMap<string, ResultItem>>();
  const phaseRef = useRef<Phase>('edit');
  /** The request body of the open submission, sent again unchanged (same object, same bytes). */
  const bodyRef = useRef<Payload | undefined>(undefined);
  /** The Idempotency-Key of the open submission; undefined: the next submission takes a new one. */
  const keyRef = useRef<string | undefined>(undefined);
  /** An earlier send under this key got no settled answer: it may have taken effect. */
  const uncertainRef = useRef(false);
  const entryRef = useRef<HTMLButtonElement>(null);
  const closedRef = useRef(false);
  const alive = useRef(true);
  const busy = phase === 'verify' || phase === 'sending' || phase === 'unknown';
  const locked = phase !== 'edit';

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // 对话框关闭后焦点回到【批量手动打款】（入口已因清空勾选消失时不处理）。
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
    keyRef.current = undefined;
    bodyRef.current = undefined;
    uncertainRef.current = false;
  };

  const openDialog = () => {
    if (snapshot !== undefined || rows.length === 0) return;
    forget();
    setEntries(new Map());
    setTouched(new Set());
    setResults(undefined);
    setFailure(undefined);
    setAgain(false);
    setPhase('edit');
    setSnapshot(rows);
  };

  const close = () => {
    if (phaseRef.current !== 'edit' && phaseRef.current !== 'done') return;
    closedRef.current = true;
    forget();
    setSnapshot(undefined);
  };

  /** 【去列表核对】: leave the unknown submission to the list (it is read again). */
  const toList = () => {
    if (phaseRef.current !== 'unknown') return;
    closedRef.current = true;
    // F1-08at: the given-up submission keeps holding the marker (only 【关闭】 or nothing of this
    // instance drops it); the next batch is judged afresh and its answer settles only itself.
    marker.leave();
    forget();
    setSnapshot(undefined);
    setPhase('edit');
    onFinished();
  };

  const recorded = snapshot?.filter((row) => !manualPaidClosed(row)) ?? [];
  const now = clock.now();
  const checks = new Map(
    recorded.map((row) => [
      row.withdrawal_id,
      checkEntry(row, entries.get(row.withdrawal_id) ?? EMPTY_ENTRY, now),
    ]),
  );
  const ready = recorded.length > 0 && recorded.every((row) => checks.get(row.withdrawal_id)?.item);

  const change = (id: string, field: Field, value: string) => {
    if (phaseRef.current !== 'edit') return;
    setEntries((previous) => {
      const next = new Map(previous);
      next.set(id, { ...(previous.get(id) ?? EMPTY_ENTRY), [field]: value });
      return next;
    });
    touch(id, field);
  };

  const touch = (id: string, field: Field) => {
    const name = `${id}:${field}`;
    setTouched((previous) => (previous.has(name) ? previous : new Set(previous).add(name)));
  };

  const submit = () => {
    if (phaseRef.current !== 'edit' || snapshot === undefined) return;
    // Judged again at the moment of the click, against the clock of this moment.
    const at = clock.now();
    const items: Payload['items'] = [];
    for (const row of recorded) {
      const item = checkEntry(row, entries.get(row.withdrawal_id) ?? EMPTY_ENTRY, at).item;
      if (item === undefined) return;
      items.push(item);
    }
    if (items.length === 0) return;
    bodyRef.current = { items };
    keyRef.current = newRequestKey();
    uncertainRef.current = false;
    setFailure(undefined);
    setAgain(false);
    setPhase('verify');
  };

  const retry = () => {
    if (phaseRef.current !== 'unknown') return;
    if (bodyRef.current === undefined || keyRef.current === undefined) return;
    setAgain(false);
    setFailure(undefined);
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

  const send = async (body: Payload, key: string, stepUpToken: string): Promise<void> => {
    try {
      const response = await customOf()<Answer>({
        url: MANUAL_PAID_URL,
        method: 'post',
        payload: body,
        meta: { stepUpToken, idempotencyKey: key },
      });
      if (!alive.current) return;
      const items: unknown = (response.data as { items?: unknown } | undefined)?.items;
      if (!Array.isArray(items)) {
        // An answer that does not say what happened is no answer: stay locked.
        if (!uncertainRef.current) marker.mark();
        uncertainRef.current = true;
        setPhase('unknown');
        return;
      }
      if (uncertainRef.current) marker.clear();
      forget();
      setResults(new Map((items as ResultItem[]).map((item) => [item.withdrawal_id, item])));
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
      if (
        uncertainRef.current &&
        cause instanceof AdminApiError &&
        cause.kind === 'api' &&
        cause.code === FORBIDDEN
      ) {
        // 结果未知后的重试被先于幂等回放判的 10403 拒绝：第一次提交仍可能已生效，保持结果未知、原键原体。
        setFailure(failureNotice(cause));
        setPhase('unknown');
        return;
      }
      if (isSettledRejection(cause)) {
        // 服务端确定拒绝（10403、20001 等）：解锁，提示全文；下次提交换新键。会话失效（10001）不算确定的回答，标记留着。
        if (endsSession(cause)) marker.leave();
        else marker.clear();
        forget();
        setFailure(failureNotice(cause));
        setPhase('edit');
        return;
      }
      // 网络错误、无法解析、40901（同键仍在处理）、5xx（已录入的保留）：结果未知，锁定。
      if (!uncertainRef.current) marker.mark();
      uncertainRef.current = true;
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

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const done = phase === 'done' && results !== undefined;

  const input = (row: WithdrawalRow, field: Field, label: string, width: number) => {
    const entry = entries.get(row.withdrawal_id) ?? EMPTY_ENTRY;
    const error = touched.has(`${row.withdrawal_id}:${field}`)
      ? checks.get(row.withdrawal_id)?.errors[field]
      : undefined;
    return (
      <Flex vertical gap={2}>
        <Input
          aria-label={label}
          value={entry[field]}
          disabled={locked}
          autoComplete="off"
          {...(field === 'paidAt' ? { placeholder: t.paidAtPlaceholder } : {})}
          {...(field === 'amount' ? { inputMode: 'decimal' as const } : {})}
          status={error === undefined ? '' : 'error'}
          aria-invalid={error === undefined ? undefined : true}
          style={{ width }}
          onChange={(event) => change(row.withdrawal_id, field, event.target.value)}
          onBlur={() => touch(row.withdrawal_id, field)}
        />
        {error === undefined ? null : (
          <Typography.Text type="danger" style={{ fontSize: token.fontSizeSM }}>
            {error}
          </Typography.Text>
        )}
      </Flex>
    );
  };

  const columns: TableColumnsType<WithdrawalRow> = [
    {
      key: 'number',
      title: t.number,
      render: (_, row) => <span style={code}>{row.out_biz_no}</span>,
    },
    {
      key: 'channel',
      title: t.channel,
      render: (_, row) => <span>{channelLabel(row.payout_channel)}</span>,
    },
    {
      key: 'net',
      title: t.net,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.net_fen)}</span>,
    },
    {
      key: 'serial',
      title: t.serial,
      render: (_, row) => (manualPaidClosed(row) ? null : input(row, 'serial', t.serial, 180)),
    },
    {
      key: 'paidAt',
      title: t.paidAt,
      render: (_, row) => (manualPaidClosed(row) ? null : input(row, 'paidAt', t.paidAt, 180)),
    },
    {
      key: 'amount',
      title: t.paidFen,
      render: (_, row) => (manualPaidClosed(row) ? null : input(row, 'amount', t.paidFen, 120)),
    },
    {
      key: 'result',
      title: t.result,
      render: (_, row) => {
        if (manualPaidClosed(row))
          return <Typography.Text type="warning">{t.wechatSkipped}</Typography.Text>;
        if (!done) return null;
        const item = results.get(row.withdrawal_id);
        return (
          <Typography.Text type={item?.result === 'paid' ? 'success' : 'warning'}>
            {outcomeText(item)}
          </Typography.Text>
        );
      },
    },
  ];

  let summary: string | undefined;
  if (done && snapshot !== undefined) {
    const count = snapshot.filter(
      (row) => results.get(row.withdrawal_id)?.result === 'paid',
    ).length;
    summary = t.summary(count, snapshot.length - count);
  }

  let footer: ReactElement;
  if (done)
    footer = (
      <Flex justify="end">
        <Button autoInsertSpace={false} type="primary" onClick={close}>
          {t.close}
        </Button>
      </Flex>
    );
  else if (phase === 'unknown')
    footer = (
      <Flex justify="end" gap={8}>
        <Button autoInsertSpace={false} type="primary" onClick={retry}>
          {t.retry}
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
          {t.cancel}
        </Button>
        <Button autoInsertSpace={false} type="primary" disabled={busy || !ready} onClick={submit}>
          {t.submit}
        </Button>
      </Flex>
    );

  return (
    <>
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
          width={1080}
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
            {failure === undefined || (phase !== 'edit' && phase !== 'unknown') ? null : (
              <Alert type="error" showIcon message={failure} />
            )}
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
        details={[t.stepUpTarget(recorded.length), ...(again ? [t.stepUpAgain] : [])]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </>
  );
}
