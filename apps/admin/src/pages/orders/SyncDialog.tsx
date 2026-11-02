// Manual sync dialog of the order list (design-hifi AdmOrderSync; design/specs/admin-orders.md
// §1, §2, §4; CT-24n). Opening it reads GET /admin/v1/order-syncs/limits (never earlier), which
// gives the platforms on offer, each one's earliest window start and its order number ceiling
// (0: no sync by order number, the option is greyed out and choosing that platform leaves it).
// Exactly one of two forms is sent: by time window (platform, from, to as Beijing time with
// +08:00) or by order numbers (platform, order_nos, one per line). Out-of-range input is stopped
// here with a hint next to the field; a 20001 from the server puts the same kind of hint next to
// the fields it names. A new or reused request closes the dialog and the page tells which; the
// other refusals stay in the dialog with the input kept, never resent on their own.
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Form, Input, Modal, Radio, Result, Select, Typography } from 'antd';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { ordersTexts } from '../../texts/orders.ts';
import {
  ORDER_NO_MAX,
  SYNC_LIMITS_URL,
  SYNC_MAX_ORDER_NOS,
  beijingInput,
  beijingMinute,
  minuteUp,
  failureOf,
  orderNosOf,
  platformLabel,
  type PlatformCode,
  type SyncCreateRequest,
  type SyncLimit,
  type SyncLimits,
  type SyncOutcome,
} from './model.ts';
import { nextNoticeId, noticeOf, useSyncRequest, type SyncNotice } from './sync.ts';

const t = ordersTexts.sync;

/** The form being filled: by time window or by order numbers. */
type Mode = 'byTime' | 'byNumbers';
type LimitsStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface FieldErrors {
  readonly platform?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly orderNos?: string | undefined;
}

export interface SyncDialogProps {
  readonly onClose: () => void;
  /** A request was accepted (new or reused): the page shows the outcome. */
  readonly onDone: (outcome: SyncOutcome) => void;
}

export function SyncDialog({ onClose, onDone }: SyncDialogProps): ReactElement {
  const getProvider = useDataProvider();
  const ids = { platform: useId(), from: useId(), to: useId(), orderNos: useId() };
  const [limitsStatus, setLimitsStatus] = useState<LimitsStatus>('loading');
  const [limits, setLimits] = useState<readonly SyncLimit[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>('byTime');
  const [platform, setPlatform] = useState<PlatformCode>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [orderNos, setOrderNos] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<SyncNotice>();
  const { busy, send } = useSyncRequest();

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<SyncLimits>({ url: SYNC_LIMITS_URL, method: 'get' }).then(
      (response) => {
        if (!current) return;
        const items = response.data.items;
        setLimits(items);
        setPlatform((chosen) =>
          chosen !== undefined && items.some((one) => one.platform === chosen)
            ? chosen
            : items[0]?.platform,
        );
        setLimitsStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setLimitsStatus(failureOf(cause) === 'forbidden' ? 'forbidden' : 'failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, attempt]);

  const limit = limits.find((one) => one.platform === platform);
  const maxOrderNos = Math.min(SYNC_MAX_ORDER_NOS, limit?.max_order_nos ?? SYNC_MAX_ORDER_NOS);
  const noOrderNos = (one: SyncLimit | undefined) => one?.max_order_nos === 0;

  /** The body of the chosen form, or the field hints that stop it. */
  const build = (): { readonly body: SyncCreateRequest } | { readonly errors: FieldErrors } => {
    if (limit === undefined) return { errors: { platform: t.platformRequired } };
    if (mode === 'byNumbers') {
      const numbers = orderNosOf(orderNos);
      if (numbers.length === 0) return { errors: { orderNos: t.orderNosRequired } };
      if (numbers.length > maxOrderNos)
        return { errors: { orderNos: t.orderNosTooMany(maxOrderNos) } };
      if (numbers.some((one) => one.length > ORDER_NO_MAX))
        return { errors: { orderNos: t.orderNosTooLong } };
      return { body: { platform: limit.platform, order_nos: numbers } };
    }
    const start = beijingInput(from);
    const end = beijingInput(to);
    if (start === undefined || end === undefined)
      return {
        errors: {
          ...(start === undefined ? { from: t.timeRequired } : {}),
          ...(end === undefined ? { to: t.timeRequired } : {}),
        },
      };
    if (Date.parse(start) >= Date.parse(end)) return { errors: { to: t.timeOrder } };
    const earliest = minuteUp(limit.earliest_from);
    if (Date.parse(start) < Date.parse(earliest))
      return { errors: { from: t.tooEarly(beijingMinute(earliest)) } };
    // TODO(规划/11 §7.1): 手动同步状态筛选 — blocked on 各平台 status_filter 取值登记（CAP-*-07）
    return { body: { platform: limit.platform, from: start, to: end } };
  };

  const submit = async () => {
    if (busy || limitsStatus !== 'ready') return;
    const built = build();
    if ('errors' in built) {
      setErrors(built.errors);
      return;
    }
    const body = built.body;
    setErrors({});
    setNotice(undefined);
    const outcome = await send(body);
    if (outcome === undefined) return;
    if (outcome.kind === 'created' || outcome.kind === 'reused') {
      onDone(outcome);
      return;
    }
    if (outcome.kind === 'fields') {
      const named = new Set(outcome.fields);
      const next: FieldErrors = {
        ...(named.has('platform') ? { platform: t.platformRejected } : {}),
        ...(named.has('from') && named.has('to')
          ? { from: t.windowRejected }
          : named.has('from')
            ? { from: t.tooEarlyServer }
            : named.has('to')
              ? { to: t.windowRejected }
              : {}),
        ...(named.has('order_nos') ? { orderNos: t.orderNosRejected } : {}),
      };
      const placed =
        (mode === 'byTime' && (next.from !== undefined || next.to !== undefined)) ||
        (mode === 'byNumbers' && next.orderNos !== undefined) ||
        next.platform !== undefined;
      setErrors(next);
      if (!placed) setNotice({ id: nextNoticeId(), type: 'error', text: t.failed });
      return;
    }
    const shown = noticeOf(outcome);
    if (shown !== undefined) setNotice({ id: nextNoticeId(), ...shown });
  };

  const status = (error: string | undefined) =>
    error === undefined ? {} : { validateStatus: 'error' as const, help: error };

  let content: ReactElement;
  if (limitsStatus === 'loading') {
    content = (
      <Typography.Text type="secondary" role="status">
        {t.limitsLoading}
      </Typography.Text>
    );
  } else if (limitsStatus === 'forbidden') {
    content = <Result status="403" title={t.forbidden} />;
  } else if (limitsStatus === 'failed') {
    content = (
      <Flex vertical align="flex-start" gap={12}>
        <Alert type="error" showIcon message={t.limitsFailed} />
        <Button onClick={() => (setLimitsStatus('loading'), setAttempt((value) => value + 1))}>
          {ordersTexts.retry}
        </Button>
      </Flex>
    );
  } else if (limits.length === 0) {
    content = <Typography.Text type="secondary">{t.limitsEmpty}</Typography.Text>;
  } else {
    content = (
      <Form layout="vertical" component="div" colon={false}>
        <Form.Item label={t.mode}>
          <Radio.Group
            optionType="button"
            aria-label={t.mode}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as Mode);
              setNotice(undefined);
            }}
            options={[
              { value: 'byTime', label: t.modeWindow },
              { value: 'byNumbers', label: t.modeOrderNos, disabled: noOrderNos(limit) },
            ]}
          />
        </Form.Item>
        <Form.Item label={t.platform} htmlFor={ids.platform} {...status(errors.platform)}>
          <Select<PlatformCode>
            id={ids.platform}
            aria-label={t.platform}
            value={platform ?? null}
            placeholder={t.platformPlaceholder}
            onChange={(value) => {
              setPlatform(value);
              const chosen = limits.find((one) => one.platform === value);
              if (mode === 'byNumbers' && noOrderNos(chosen)) {
                setMode('byTime');
                setNotice(undefined);
                setErrors({});
                return;
              }
              setErrors({ ...errors, platform: undefined });
            }}
            options={limits.map((one) => ({
              value: one.platform,
              label: platformLabel(one.platform),
            }))}
          />
        </Form.Item>
        {mode === 'byTime' ? (
          <Flex gap={12} wrap>
            <Form.Item
              label={t.start}
              htmlFor={ids.from}
              style={{ flex: '1 1 200px' }}
              {...status(errors.from)}
              extra={
                limit === undefined
                  ? undefined
                  : t.earliest(beijingMinute(minuteUp(limit.earliest_from)))
              }
            >
              <Input
                id={ids.from}
                placeholder={t.timePlaceholder}
                value={from}
                autoComplete="off"
                onChange={(event) => {
                  setFrom(event.target.value);
                  setErrors({ ...errors, from: undefined });
                }}
              />
            </Form.Item>
            <Form.Item
              label={t.end}
              htmlFor={ids.to}
              style={{ flex: '1 1 200px' }}
              {...status(errors.to)}
            >
              <Input
                id={ids.to}
                placeholder={t.timePlaceholder}
                value={to}
                autoComplete="off"
                onChange={(event) => {
                  setTo(event.target.value);
                  setErrors({ ...errors, to: undefined });
                }}
              />
            </Form.Item>
          </Flex>
        ) : (
          <Form.Item
            label={t.orderNos}
            htmlFor={ids.orderNos}
            {...status(errors.orderNos)}
            extra={t.orderNosHelp(maxOrderNos)}
          >
            <Input.TextArea
              id={ids.orderNos}
              rows={5}
              placeholder={t.orderNosPlaceholder}
              value={orderNos}
              onChange={(event) => {
                setOrderNos(event.target.value);
                setErrors({ ...errors, orderNos: undefined });
              }}
            />
          </Form.Item>
        )}
      </Form>
    );
  }

  return (
    <Modal
      open
      centered
      width={560}
      title={t.dialogTitle}
      transitionName=""
      maskTransitionName=""
      destroyOnHidden
      maskClosable={false}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t.cancel}
        </Button>,
        <Button
          key="submit"
          type="primary"
          disabled={busy || limitsStatus !== 'ready' || limits.length === 0}
          aria-busy={busy || undefined}
          onClick={() => void submit()}
        >
          {t.submit}
        </Button>,
      ]}
    >
      <Flex vertical gap={12}>
        <Typography.Text type="secondary">{t.intro}</Typography.Text>
        {notice === undefined ? null : (
          <Alert key={notice.id} type={notice.type} showIcon message={notice.text} />
        )}
        {content}
      </Flex>
    </Modal>
  );
}
