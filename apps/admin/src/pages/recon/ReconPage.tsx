// 对账与差错（资源 recon，菜单 资金 / 对账与差错；规格 admin-recon.md，F1-08e 第一段）：「差错单」
// 列表 GET /admin/v1/recon-diffs（只有 R1–R3；类型 / 来源 / 状态 / 周期区间 / 关联单据号筛选，页码
// 分页）、详情抽屉 GET …/{id}、【已关闭（不处理）】POST …/{id}/close（只给 fund.recon，必填原因，
// Idempotency-Key：同一对话框内重试沿用、新开对话框换新键；不走动态码）。持 fund.recon 或
// fund.view 可看；两者都没有时本页说明无权限、不发请求。
// 【核销】POST …/{id}/write-off（F1-08eb，CT-24za；R2 迟到成功 → 提现 W11）：只给 payout.execute、
// R2、待处理 / 处理中；确认对话框 → 动态码（totp，每次新取令牌，不缓存）→ 请求带 X-Step-Up-Token、
// Idempotency-Key（打开对话框时生成，同框重试与 10003 重放沿用，新开换新）与
// {expected_withdrawal_status: 'APPROVED', note?}，不传金额、渠道结果或凭证。
// 【确认扣回】POST …/{id}/blacklist-clawback（F1-08ec，CT-24zzf；黑名单复核结论「扣回」）：只给
// order.blacklist_clawback、blacklist_after_credit、待处理 / 处理中；二次确认（订单、命中维度、
// expected_fen 只作展示）→ 动态码（totp，每次新取令牌）→ 请求带 X-Step-Up-Token、Idempotency-Key
// （打开对话框时生成，同框重试与 10003 重放沿用，新开换新）与 {note?}（空则 {}），从不传金额；
// 实扣以返回的 clawed_back_fen 为准。各种拒绝都不把差错单移出列表、不在本地改状态。
// TODO(规划/11 §7): 「对账任务」页签（任务列表、手动触发 R1、月末三项、导出）与工作台计数 — blocked on 契约未出
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Result,
  Select,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { reconTexts as t } from '../../texts/recon.ts';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { ClawbackModal } from './ClawbackModal.tsx';
import { CloseModal } from './CloseModal.tsx';
import { DetailDrawer, type DetailState } from './DetailDrawer.tsx';
import { WriteOffModal } from './WriteOffModal.tsx';
import {
  EMPTY_DRAFT,
  PAGE_SIZE,
  SOURCES,
  STATUSES,
  TYPES,
  STEP_UP_URL,
  blacklistDimensions,
  blacklistOrderKey,
  checkDraft,
  clawable,
  clawbackReason,
  codeOf,
  conflictResource,
  guardReason,
  isNetwork,
  listQuery,
  money,
  newRequestKey,
  rejectedFields,
  rowOf,
  sourceLabel,
  statusColor,
  statusLabel,
  typeLabel,
  type Draft,
  type DraftErrors,
  type Filters,
  type ReconDiff,
  type ReconDiffDetail,
  type ReconDiffSource,
  type ReconDiffStatus,
  type ReconDiffType,
} from './model.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

const LIST_URL = '/admin/v1/recon-diffs';
const itemUrl = (id: string): string => `${LIST_URL}/${encodeURIComponent(id)}`;

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface ListData {
  readonly items: readonly ReconDiff[];
  readonly total: number;
}

type Notice = { readonly type: 'success' | 'error' | 'warning'; readonly text: string };

/** The open drawer: which difference, and a counter so every 【详情】 reads it again. */
interface DrawerTarget {
  readonly id: string;
  readonly read: number;
}

/** One close dialog: its own Idempotency-Key, kept for every retry inside it. */
interface CloseFlow {
  readonly id: string;
  readonly requestKey: string;
  readonly sending: boolean;
  readonly fieldError?: string;
  readonly error?: string;
  readonly canSubmit: boolean;
}

/**
 * One write-off dialog: its own Idempotency-Key, kept for every retry and 10003 replay inside it.
 * `phase`: editing the note, passing the step-up (`note` is what will be sent), or sending.
 */
interface WriteOffFlow {
  readonly id: string;
  readonly ref: string;
  readonly requestKey: string;
  readonly phase: 'editing' | 'verifying' | 'sending';
  readonly note?: string | undefined;
  /** The step-up is asked again after a 10003. */
  readonly again?: boolean;
  /** A sent body whose outcome is unknown: the note stays as sent. */
  readonly locked?: boolean;
  readonly fieldError?: string;
  readonly error?: string;
  readonly canSubmit: boolean;
}

/**
 * One clawback dialog: its own Idempotency-Key, kept for every retry and 10003 replay inside it.
 * `phase`: editing the note, passing the step-up (`note` is what will be sent), or sending.
 */
interface ClawbackFlow {
  readonly id: string;
  readonly orderKey: string;
  readonly dimensions: readonly string[];
  readonly expectedFen: number;
  readonly requestKey: string;
  readonly phase: 'editing' | 'verifying' | 'sending';
  readonly note?: string | undefined;
  /** The step-up is asked again after a 10003. */
  readonly again?: boolean;
  /** A sent body whose outcome is unknown: the note stays as sent. */
  readonly locked?: boolean;
  readonly fieldError?: string;
  readonly error?: string;
  readonly canSubmit: boolean;
}

export interface ReconPageProps {
  readonly access: AccessControl;
}

export function ReconPage({ access }: ReconPageProps): ReactElement {
  if (!access.can('fund.recon') && !access.can('fund.view')) {
    return (
      <Flex vertical gap={16}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Card>
          <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
        </Card>
      </Flex>
    );
  }
  return (
    <ReconContent
      canClose={access.can('fund.recon')}
      canWriteOff={access.can('payout.execute')}
      canClawback={access.can('order.blacklist_clawback')}
    />
  );
}

function ReconContent({
  canClose,
  canWriteOff,
  canClawback,
}: {
  readonly canClose: boolean;
  readonly canWriteOff: boolean;
  readonly canClawback: boolean;
}): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = {
    type: useId(),
    source: useId(),
    status: useId(),
    from: useId(),
    to: useId(),
    ref: useId(),
  };
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();
  const [notice, setNotice] = useState<Notice>();
  const [drawer, setDrawer] = useState<DrawerTarget>();
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [flow, setFlowState] = useState<CloseFlow>();
  const flowRef = useRef<CloseFlow | undefined>(undefined);
  const [writeOff, setWriteOffState] = useState<WriteOffFlow>();
  const writeOffRef = useRef<WriteOffFlow | undefined>(undefined);
  const [clawback, setClawbackState] = useState<ClawbackFlow>();
  const clawbackRef = useRef<ClawbackFlow | undefined>(undefined);
  const drawerRef = useRef<DrawerTarget | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setFlow = (next: CloseFlow | undefined) => {
    flowRef.current = next;
    setFlowState(next);
  };
  const setWriteOff = (next: WriteOffFlow | undefined) => {
    writeOffRef.current = next;
    setWriteOffState(next);
  };
  const setClawback = (next: ClawbackFlow | undefined) => {
    clawbackRef.current = next;
    setClawbackState(next);
  };
  /** A close, write-off or clawback dialog is open. */
  const busyElsewhere = (): boolean =>
    flowRef.current !== undefined ||
    writeOffRef.current !== undefined ||
    clawbackRef.current !== undefined;
  const openDrawer = (next: DrawerTarget | undefined) => {
    drawerRef.current = next;
    setDrawer(next);
    // Never a flash of the previous difference while this one is read.
    if (next !== undefined) setDetail({ status: 'loading' });
  };

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  // The list: page `page` under the applied `filters`; `attempt` reads the same again.
  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminReconDiffPage'>>({
      url: LIST_URL,
      method: 'get',
      query: listQuery(filters, page),
    }).then(
      (response) => {
        if (!current) return;
        setData({ items: response.data.items, total: response.data.total });
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        // A failed read never keeps the rows of an earlier answer on screen.
        setData(undefined);
        setStatus(codeOf(cause) === 10403 ? 'forbidden' : 'failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, filters, page, attempt]);

  // The drawer's difference, read on every 【详情】 and after a 20902.
  useEffect(() => {
    if (drawer === undefined) return;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<ReconDiffDetail>({ url: itemUrl(drawer.id), method: 'get' }).then(
      (response) => {
        if (current) setDetail({ status: 'ready', data: response.data });
      },
      (cause: unknown) => {
        if (current) setDetail({ status: codeOf(cause) === 20001 ? 'missing' : 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, drawer]);

  const reload = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const readDetailAgain = () => {
    const target = drawerRef.current;
    if (target !== undefined) openDrawer({ id: target.id, read: target.read + 1 });
  };

  const runQuery = () => {
    const checked = checkDraft(draft);
    if ('errors' in checked) {
      setDraftErrors(checked.errors);
      return;
    }
    setDraftErrors({});
    setFilters(checked.filters);
    setPage(1);
    reload();
  };

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setDraftErrors({});
    setFilters({});
    setPage(1);
    reload();
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const showDetail = (id: string) => {
    const previous = drawerRef.current;
    openDrawer({ id, read: (previous?.read ?? 0) + 1 });
  };

  /** Puts a difference as the server now has it into the list and the open drawer. */
  const applyItem = (item: ReconDiffDetail) => {
    const row = rowOf(item);
    setData((previous) =>
      previous === undefined
        ? previous
        : {
            ...previous,
            items: previous.items.map((entry) =>
              entry.recon_diff_id === row.recon_diff_id ? row : entry,
            ),
          },
    );
    if (drawerRef.current?.id === item.recon_diff_id) setDetail({ status: 'ready', data: item });
  };

  const startClose = (item: ReconDiffDetail) => {
    if (!canClose || busyElsewhere()) return;
    setNotice(undefined);
    // A new dialog is a new close: a new Idempotency-Key (kept for every retry inside it).
    setFlow({
      id: item.recon_diff_id,
      requestKey: newRequestKey(),
      sending: false,
      canSubmit: true,
    });
  };

  const cancelClose = () => {
    if (flowRef.current?.sending === true) return;
    setFlow(undefined);
  };

  const submitClose = async (reason: string) => {
    const current = flowRef.current;
    if (current === undefined || current.sending || !current.canSubmit) return;
    setFlow({ id: current.id, requestKey: current.requestKey, sending: true, canSubmit: true });
    const payload: Schema<'AdminReconDiffCloseRequest'> = { reason };
    try {
      const response = await customOf()<Schema<'AdminReconDiffClose'>>({
        url: `${itemUrl(current.id)}/close`,
        method: 'post',
        payload,
        meta: { idempotencyKey: current.requestKey },
      });
      if (!alive.current) return;
      setFlow(undefined);
      applyItem(response.data.recon_diff);
      setNotice({ type: 'success', text: t.close.done(response.data.released_hold_count) });
    } catch (cause) {
      if (!alive.current) return;
      const keep = (patch: Partial<CloseFlow>) =>
        setFlow({
          id: current.id,
          requestKey: current.requestKey,
          sending: false,
          canSubmit: true,
          ...patch,
        });
      const code = codeOf(cause);
      const fields = rejectedFields(cause);
      if (code === 20001 && fields.includes('reason')) {
        keep({ fieldError: t.close.rejected });
      } else if (code === 20001) {
        // Unknown or no longer visible: the list is read again.
        setFlow(undefined);
        setNotice({ type: 'error', text: t.close.missing });
        reload();
        readDetailAgain();
      } else if (code === 20902) {
        // Handled meanwhile (closed / adjusted / written off): nothing changed; read it again.
        setFlow(undefined);
        setNotice({ type: 'warning', text: t.close.conflict });
        reload();
        readDetailAgain();
      } else if (code === 20901) {
        // The same key with another body: never resent from this dialog.
        keep({ error: t.close.changed, canSubmit: false });
      } else if (code === 40901) {
        keep({ error: t.close.running });
      } else if (code === 10403) {
        keep({ error: t.close.forbidden, canSubmit: false });
      } else if (isNetwork(cause)) {
        // Not known whether it was closed: a retry here resends the same key and body.
        keep({ error: t.close.network });
      } else {
        keep({ error: t.close.failed });
      }
    }
  };

  const startWriteOff = (item: ReconDiffDetail) => {
    if (!canWriteOff || busyElsewhere()) return;
    if (item.source !== 'R2' || (item.status !== 'open' && item.status !== 'processing')) return;
    setNotice(undefined);
    // A new dialog is a new write-off: a new Idempotency-Key (kept for every retry inside it).
    setWriteOff({
      id: item.recon_diff_id,
      ref: item.ref_id,
      requestKey: newRequestKey(),
      phase: 'editing',
      canSubmit: true,
    });
  };

  const cancelWriteOff = () => {
    if (writeOffRef.current?.phase === 'sending') return;
    setWriteOff(undefined);
  };

  /** The dialog's confirm: the step-up comes first (a new totp value for every write). */
  const confirmWriteOff = (note: string | undefined) => {
    const current = writeOffRef.current;
    if (current === undefined || current.phase !== 'editing' || !current.canSubmit) return;
    // After an unknown outcome the same body is resent (the note field is locked meanwhile).
    const sent = current.locked === true ? current.note : note;
    setWriteOff({
      id: current.id,
      ref: current.ref,
      requestKey: current.requestKey,
      phase: 'verifying',
      note: sent,
      ...(current.locked === true ? { locked: true } : {}),
      canSubmit: true,
    });
  };

  const verifyStepUp = async (code: string): Promise<StepUpResult> => {
    const payload: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await customOf()<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload,
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

  const cancelStepUp = () => {
    const current = writeOffRef.current;
    if (current === undefined || current.phase !== 'verifying') return;
    setWriteOff({ ...current, phase: 'editing', again: false });
  };

  const submitWriteOff = async (stepUpToken: string) => {
    const current = writeOffRef.current;
    if (current === undefined || current.phase !== 'verifying') return;
    const sending: WriteOffFlow = {
      id: current.id,
      ref: current.ref,
      requestKey: current.requestKey,
      phase: 'sending',
      note: current.note,
      ...(current.locked === true ? { locked: true } : {}),
      canSubmit: true,
    };
    setWriteOff(sending);
    const payload: Schema<'AdminReconDiffWriteOffRequest'> = {
      expected_withdrawal_status: 'APPROVED',
      ...(current.note === undefined ? {} : { note: current.note }),
    };
    try {
      const response = await customOf()<Schema<'AdminReconDiffWriteOff'>>({
        url: `${itemUrl(current.id)}/write-off`,
        method: 'post',
        payload,
        meta: { idempotencyKey: current.requestKey, stepUpToken },
      });
      if (!alive.current) return;
      setWriteOff(undefined);
      applyItem(response.data.recon_diff);
      setNotice({ type: 'success', text: t.writeOff.done(response.data.released_hold_count) });
    } catch (cause) {
      if (!alive.current) return;
      const keep = (patch: Partial<WriteOffFlow>) =>
        setWriteOff({ ...sending, phase: 'editing', ...patch });
      const code = codeOf(cause);
      const reason = guardReason(cause);
      const fields = rejectedFields(cause);
      if (code === 10003) {
        // The step-up value was refused: verify again, then replay with the same key and body.
        setWriteOff({ ...sending, phase: 'verifying', again: true });
      } else if (reason !== undefined) {
        // The W11 guard refused: nothing changed; this difference cannot be written off.
        setWriteOff(undefined);
        setNotice({ type: 'error', text: t.writeOff.guard[reason] });
      } else if (code === 20001 && fields.includes('note')) {
        keep({ fieldError: t.writeOff.rejected });
      } else if (code === 20001) {
        setWriteOff(undefined);
        setNotice({ type: 'error', text: t.writeOff.missing });
        reload();
        readDetailAgain();
      } else if (code === 20902) {
        // The difference or its withdrawal changed meanwhile: nothing was written; read again.
        setWriteOff(undefined);
        setNotice({
          type: 'warning',
          text:
            conflictResource(cause) === 'withdrawal'
              ? t.writeOff.conflictWithdrawal
              : t.writeOff.conflictDiff,
        });
        reload();
        readDetailAgain();
      } else if (code === 20901) {
        // The same key with another body: never resent from this dialog.
        keep({ error: t.writeOff.changed, canSubmit: false });
      } else if (code === 40901) {
        keep({ error: t.writeOff.running, locked: true });
      } else if (code === 10403) {
        keep({ error: t.writeOff.forbidden, canSubmit: false });
      } else if (isNetwork(cause)) {
        // Not known whether it was written off: a retry here resends the same key and body.
        keep({ error: t.writeOff.network, locked: true });
      } else {
        keep({ error: t.writeOff.failed });
      }
    }
  };

  const startClawback = (item: ReconDiffDetail) => {
    if (!canClawback || busyElsewhere() || !clawable(item)) return;
    setNotice(undefined);
    // A new dialog is a new clawback: a new Idempotency-Key (kept for every retry inside it).
    setClawback({
      id: item.recon_diff_id,
      orderKey: blacklistOrderKey(item.ref_id),
      dimensions: blacklistDimensions(item),
      expectedFen: item.expected_fen,
      requestKey: newRequestKey(),
      phase: 'editing',
      canSubmit: true,
    });
  };

  const cancelClawback = () => {
    if (clawbackRef.current?.phase === 'sending') return;
    setClawback(undefined);
  };

  /** The dialog's confirm: the step-up comes first (a new totp value for every clawback). */
  const confirmClawback = (note: string | undefined) => {
    const current = clawbackRef.current;
    if (current === undefined || current.phase !== 'editing' || !current.canSubmit) return;
    // After an unknown outcome the same body is resent (the note field is locked meanwhile).
    const sent = current.locked === true ? current.note : note;
    setClawback({
      id: current.id,
      orderKey: current.orderKey,
      dimensions: current.dimensions,
      expectedFen: current.expectedFen,
      requestKey: current.requestKey,
      phase: 'verifying',
      note: sent,
      ...(current.locked === true ? { locked: true } : {}),
      canSubmit: true,
    });
  };

  const cancelClawbackStepUp = () => {
    const current = clawbackRef.current;
    if (current === undefined || current.phase !== 'verifying') return;
    setClawback({ ...current, phase: 'editing', again: false });
  };

  const submitClawback = async (stepUpToken: string) => {
    const current = clawbackRef.current;
    if (current === undefined || current.phase !== 'verifying') return;
    const sending: ClawbackFlow = {
      id: current.id,
      orderKey: current.orderKey,
      dimensions: current.dimensions,
      expectedFen: current.expectedFen,
      requestKey: current.requestKey,
      phase: 'sending',
      note: current.note,
      ...(current.locked === true ? { locked: true } : {}),
      canSubmit: true,
    };
    setClawback(sending);
    // Only the optional note: the console never sends an amount (the server calculates it).
    const payload: Schema<'AdminReconDiffBlacklistClawbackRequest'> =
      current.note === undefined ? {} : { note: current.note };
    try {
      const response = await customOf()<Schema<'AdminReconDiffBlacklistClawback'>>({
        url: `${itemUrl(current.id)}/blacklist-clawback`,
        method: 'post',
        payload,
        meta: { idempotencyKey: current.requestKey, stepUpToken },
      });
      if (!alive.current) return;
      setClawback(undefined);
      applyItem(response.data.recon_diff);
      setNotice({ type: 'success', text: t.clawback.done(money(response.data.clawed_back_fen)) });
    } catch (cause) {
      if (!alive.current) return;
      const keep = (patch: Partial<ClawbackFlow>) =>
        setClawback({ ...sending, phase: 'editing', ...patch });
      const code = codeOf(cause);
      const reason = clawbackReason(cause);
      const fields = rejectedFields(cause);
      if (code === 10003) {
        // The step-up value was refused: verify again, then replay with the same key and body.
        setClawback({ ...sending, phase: 'verifying', again: true });
      } else if (reason !== undefined) {
        // Not supported, or the switch is off: nothing was written; the difference stays listed.
        setClawback(undefined);
        setNotice({
          type: 'error',
          text:
            reason === 'blacklist_clawback_disabled'
              ? t.clawback.disabled
              : t.clawback.notSupported,
        });
      } else if (code === 20001 && fields.includes('note')) {
        keep({ fieldError: t.clawback.rejected });
      } else if (code === 20001) {
        setClawback(undefined);
        setNotice({ type: 'error', text: t.clawback.missing });
        reload();
        readDetailAgain();
      } else if (code === 20902) {
        // The difference or its order changed meanwhile: nothing was written; read it again.
        setClawback(undefined);
        setNotice({
          type: 'warning',
          text:
            conflictResource(cause) === 'order' ? t.clawback.orderGone : t.clawback.conflictDiff,
        });
        reload();
        readDetailAgain();
      } else if (code === 20901) {
        // The same key with another body: never resent from this dialog.
        keep({ error: t.clawback.changed, canSubmit: false });
      } else if (code === 40901) {
        keep({ error: t.clawback.running, locked: true });
      } else if (code === 10403) {
        keep({ error: t.clawback.forbidden, canSubmit: false });
      } else if (isNetwork(cause)) {
        // Not known whether it was clawed back: a retry here resends the same key and body.
        keep({ error: t.clawback.network, locked: true });
      } else {
        keep({ error: t.clawback.failed });
      }
    }
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

  const columns: TableColumnsType<ReconDiff> = [
    {
      key: 'id',
      title: t.columns.id,
      width: 150,
      render: (_, row) => (
        <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.recon_diff_id}</span>
      ),
    },
    { key: 'type', title: t.columns.type, render: (_, row) => typeLabel(row.type) },
    {
      key: 'source',
      title: t.columns.source,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{sourceLabel(row.source)}</span>,
    },
    {
      key: 'period',
      title: t.columns.period,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{row.period}</span>,
    },
    {
      key: 'ref',
      title: t.columns.ref,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={secondary}>{row.ref_type}</span>
          <span style={code}>{row.ref_id}</span>
        </Flex>
      ),
    },
    {
      key: 'expected',
      title: t.columns.expected,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.expected_fen)}</span>,
    },
    {
      key: 'actual',
      title: t.columns.actual,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.actual_fen)}</span>,
    },
    {
      key: 'diff',
      title: t.columns.diff,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.diff_fen)}</span>,
    },
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => (
        <Tag color={statusColor(row.status)} style={{ marginInlineEnd: 0 }}>
          {statusLabel(row.status)}
        </Tag>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 80,
      render: (_, row) => (
        <Button size="small" onClick={() => showDetail(row.recon_diff_id)}>
          {t.detailEntry}
        </Button>
      ),
    },
  ];

  const loadingLine =
    status === 'loading' ? (
      <Flex
        align="center"
        gap={8}
        style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Flex>
    ) : null;

  let body: ReactElement;
  if (status === 'forbidden') {
    body = (
      <Card title={t.listTitle}>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card title={t.listTitle}>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={reload}>
              {t.retryLoad}
            </Button>
          }
        />
      </Card>
    );
  } else if (data === undefined) {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {loadingLine}
      </Card>
    );
  } else {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {loadingLine}
        <Table<ReconDiff>
          rowKey="recon_diff_id"
          columns={columns}
          dataSource={data.items as ReconDiff[]}
          loading={delayedLoading(status === 'loading', loadingClock)}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Flex vertical align="center" gap={4}>
                    <Typography.Text strong>{t.empty}</Typography.Text>
                    <Typography.Text type="secondary">{t.emptyHint}</Typography.Text>
                  </Flex>
                }
              />
            ),
          }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: data.total,
            showSizeChanger: false,
            showTotal: (total) => t.total(total),
            style: { paddingInline: 16 },
          }}
          onChange={changePage}
        />
      </Card>
    );
  }

  const periodItem = (which: 'from' | 'to') => {
    const error = which === 'from' ? draftErrors.periodFrom : draftErrors.periodTo;
    const field = which === 'from' ? 'periodFrom' : 'periodTo';
    return (
      <Form.Item
        label={which === 'from' ? t.filter.periodFrom : t.filter.periodTo}
        htmlFor={which === 'from' ? ids.from : ids.to}
        validateStatus={error === undefined ? '' : 'error'}
        help={error}
        style={{ marginBottom: 0 }}
      >
        <Input
          id={which === 'from' ? ids.from : ids.to}
          value={draft[field]}
          placeholder={t.filter.periodPlaceholder}
          aria-invalid={error === undefined ? undefined : true}
          style={{ width: 180 }}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((previous) => ({ ...previous, [field]: value }));
          }}
        />
      </Form.Item>
    );
  };

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Typography.Text type="secondary">{t.runsPending}</Typography.Text>
      <Alert type="info" showIcon role="note" message={t.r4Notice} />
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          closable
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            <Form.Item label={t.filter.type} htmlFor={ids.type} style={{ marginBottom: 0 }}>
              <Select<ReconDiffType>
                id={ids.type}
                value={draft.type ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 180 }}
                options={TYPES.map((item) => ({ value: item, label: typeLabel(item) }))}
                onChange={(value: ReconDiffType | undefined) =>
                  setDraft((previous) => ({ ...previous, type: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.source} htmlFor={ids.source} style={{ marginBottom: 0 }}>
              <Select<ReconDiffSource>
                id={ids.source}
                value={draft.source ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 140 }}
                options={SOURCES.map((item) => ({ value: item, label: sourceLabel(item) }))}
                onChange={(value: ReconDiffSource | undefined) =>
                  setDraft((previous) => ({ ...previous, source: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.status} htmlFor={ids.status} style={{ marginBottom: 0 }}>
              <Select<ReconDiffStatus>
                id={ids.status}
                value={draft.status ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 160 }}
                options={STATUSES.map((item) => ({ value: item, label: statusLabel(item) }))}
                onChange={(value: ReconDiffStatus | undefined) =>
                  setDraft((previous) => ({ ...previous, status: value ?? undefined }))
                }
              />
            </Form.Item>
            {periodItem('from')}
            {periodItem('to')}
            <Form.Item label={t.filter.ref} htmlFor={ids.ref} style={{ marginBottom: 0 }}>
              <Input
                id={ids.ref}
                value={draft.refId}
                maxLength={64}
                placeholder={t.filter.refPlaceholder}
                style={{ width: 200 }}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((previous) => ({ ...previous, refId: value }));
                }}
              />
            </Form.Item>
            <Flex gap={8}>
              <Button onClick={reset}>{t.filter.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {t.filter.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>
      <Alert type="info" role="note" message={t.amountNotice} />
      {body}
      <DetailDrawer
        open={drawer !== undefined}
        state={detail}
        canClose={canClose}
        canWriteOff={canWriteOff}
        canClawback={canClawback}
        closing={flow !== undefined || writeOff !== undefined || clawback !== undefined}
        covered={writeOff?.phase === 'verifying' || clawback?.phase === 'verifying'}
        onClose={() => openDrawer(undefined)}
        onRetry={readDetailAgain}
        onCloseDiff={startClose}
        onWriteOff={startWriteOff}
        onClawback={startClawback}
      />
      {flow === undefined ? null : (
        <CloseModal
          key={flow.requestKey}
          reconDiffId={flow.id}
          sending={flow.sending}
          fieldError={flow.fieldError}
          error={flow.error}
          canSubmit={flow.canSubmit}
          onCancel={cancelClose}
          onSubmit={(reason) => void submitClose(reason)}
        />
      )}
      {writeOff === undefined ? null : (
        <WriteOffModal
          key={writeOff.requestKey}
          reconDiffId={writeOff.id}
          withdrawalRef={writeOff.ref}
          busy={writeOff.phase !== 'editing'}
          covered={writeOff.phase === 'verifying'}
          locked={writeOff.locked === true}
          fieldError={writeOff.fieldError}
          error={writeOff.error}
          canSubmit={writeOff.canSubmit}
          onCancel={cancelWriteOff}
          onSubmit={confirmWriteOff}
        />
      )}
      <StepUpModal
        open={writeOff?.phase === 'verifying'}
        tier="totp"
        operation={t.writeOff.stepUpOperation}
        details={[
          ...(writeOff === undefined ? [] : [t.writeOff.target(writeOff.id)]),
          ...(writeOff?.again === true ? [t.writeOff.stepUpAgain] : []),
        ]}
        onSubmit={verifyStepUp}
        onClose={cancelStepUp}
        onVerified={(stepUpToken) => void submitWriteOff(stepUpToken)}
      />
      {clawback === undefined ? null : (
        <ClawbackModal
          key={clawback.requestKey}
          reconDiffId={clawback.id}
          orderKey={clawback.orderKey}
          dimensions={clawback.dimensions}
          expectedFen={clawback.expectedFen}
          busy={clawback.phase !== 'editing'}
          covered={clawback.phase === 'verifying'}
          locked={clawback.locked === true}
          fieldError={clawback.fieldError}
          error={clawback.error}
          canSubmit={clawback.canSubmit}
          onCancel={cancelClawback}
          onSubmit={confirmClawback}
        />
      )}
      <StepUpModal
        open={clawback?.phase === 'verifying'}
        tier="totp"
        operation={t.clawback.stepUpOperation}
        details={[
          ...(clawback === undefined ? [] : [t.clawback.target(clawback.id)]),
          ...(clawback?.again === true ? [t.clawback.stepUpAgain] : []),
        ]}
        onSubmit={verifyStepUp}
        onClose={cancelClawbackStepUp}
        onVerified={(stepUpToken) => void submitClawback(stepUpToken)}
      />
    </Flex>
  );
}
