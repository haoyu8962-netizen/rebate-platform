import * as bridgeSdk from '@couli/bridge-sdk';
import { useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import type { AppApiBridge } from '../../../../shared/api/app-api.ts';
import { PRIMARY_BUTTON } from '../../../../components/base/styles.ts';
import { t } from '../../../../shared/texts.ts';
import { getPlatformName } from '../../../../texts/platform.ts';
import { findOrderTexts } from '../../../../texts/find-order.ts';
import jdIcon from '../../../../components/platform/assets/jd.png?no-inline';
import pddIcon from '../../../../components/platform/assets/pinduoduo.png?no-inline';
import taobaoIcon from '../../../../components/platform/assets/taobao.png?no-inline';
import { clearDailyBlock, readDailyBlock, writeDailyBlock } from './daily-block.ts';
import { activeBlockMessage, msUntilNextShanghaiDay, shanghaiToday } from './dates.ts';
import { ChevronIcon, ClockIcon, InfoIcon, WarningIcon } from './icons.tsx';
import type { DailyBlock, Claim, ClaimConfig, ClaimPlatform } from './model.ts';
import { CAPTION, CARD, FOCUS, FOOTNOTE } from './parts.tsx';
import type { SubmitOutcome } from './submit.ts';

/** 平台胶囊里的 16px 官方图标（与 PlatformBadge 同一批内置图）。 */
const CAPSULE_ICONS: Readonly<Record<ClaimPlatform, string>> = {
  taobao: taobaoIcon,
  jd: jdIcon,
  pdd: pddIcon,
};

const CLAIM_PATH = '/v1/orders/claims';

/** 提交结果的解析单独成块：表单挂载时预取，请求发出后才等它（不推迟请求本身）。 */
const loadSubmit = () => import('./submit.ts');

export interface ClaimFormProps {
  bridge: AppApiBridge;
  config: ClaimConfig;
  /** 提交成功：切到记录页签并定位到这条申请。 */
  onCreated: (claim: Claim) => void;
  /** 30205：切到记录页签，按平台与单号定位已有申请并提示。 */
  onDuplicate: (platform: ClaimPlatform, orderNo: string, message: string) => void;
}

interface FieldErrors {
  order: string | null;
  date: string | null;
}

const NO_ERRORS: FieldErrors = { order: null, date: null };

const INPUT =
  'block min-h-couli-component-field-min-height w-full min-w-0 rounded-couli-button border bg-couli-background-surface px-couli-3 text-couli-body leading-couli-body text-couli-text-primary';

function inputClass(invalid: boolean): string {
  return `${INPUT} ${FOCUS} ${invalid ? 'border-couli-status-error-text' : 'border-couli-border-control'}`;
}

/** 字段下方与按钮上方的错误提示（读屏立即播报）。 */
function FieldError({ id, message }: { id?: string; message: string }): ReactElement {
  return (
    <p
      id={id}
      role="alert"
      className={`flex items-start gap-couli-1 text-couli-status-error-text ${FOOTNOTE} [overflow-wrap:anywhere]`}
    >
      <WarningIcon className="mt-0.5 size-couli-4 flex-none" />
      <span className="min-w-0">{message}</span>
    </p>
  );
}

function describedBy(...ids: (string | null)[]): string | undefined {
  const list = ids.filter((id) => id !== null);
  return list.length === 0 ? undefined : list.join(' ');
}

/**
 * 申请找回表单（编排裁定 2、3）：平台胶囊、订单号、付款日期（日期选择）、按平台的「订单号在哪里找？」入口；
 * 必填在本地校验；提交只经桥 net.signedRequest（签名路径），请求体只含契约三个字段；提交中禁用、只发一次；
 * 错误按码就近显示并与输入框关联；30203、30206 按上海日期当天置灰（存壳层缓存，再进页仍在、跨日解除，不写次数）；网络错误保留输入、不自动重发。
 */
export function ClaimForm({
  bridge,
  config,
  onCreated,
  onDuplicate,
}: ClaimFormProps): ReactElement {
  const { platforms, windowDays, guides } = config;
  const [platform, setPlatform] = useState<ClaimPlatform | null>(platforms[0] ?? null);
  const [orderNo, setOrderNo] = useState('');
  const [paidDate, setPaidDate] = useState('');
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS);
  const [general, setGeneral] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  // 卸载后（含账号切换时壳层重挂页面树）迟到的提交结果不再写置灰、不再回调。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const queryClient = useQueryClient();
  // 当天置灰：记录带上海日期，存在壳层缓存里（再进页仍在）；是否仍生效按当前时钟算，跨日即解除。
  const [block, setBlock] = useState<DailyBlock | null>(() => readDailyBlock(queryClient));
  const [now, setNow] = useState(() => Date.now());
  const blocked = activeBlockMessage(block, now);
  // 日期选择的上限：当前的上海日期。
  const today = shanghaiToday(now);

  // 置灰期间到上海次日 0 点重算一次；WebView 回前台（app.resume）时也重算（后台计时器可能被挂起）。
  useEffect(() => {
    if (blocked === null) return;
    const timer = setTimeout(() => setNow(Date.now()), msUntilNextShanghaiDay(now) + 1000);
    return () => clearTimeout(timer);
  }, [blocked, now]);
  useEffect(() => bridgeSdk.on('app.resume', () => setNow(Date.now())), []);
  useEffect(() => {
    loadSubmit().catch(() => undefined);
  }, []);
  // 记录已过期（跨日）时从缓存删掉；组件里留着的旧记录按日期算出来已不生效。
  useEffect(() => {
    if (block !== null && blocked === null) clearDailyBlock(queryClient);
  }, [block, blocked, queryClient]);

  const ids = {
    platform: useId(),
    order: useId(),
    orderHint: useId(),
    orderError: useId(),
    date: useId(),
    dateHint: useId(),
    dateError: useId(),
    footer: useId(),
  };

  const navOpen = useMemo(() => bridge.has('nav.open'), [bridge]);
  const guide = platform === null ? undefined : guides[platform];
  const openGuide =
    guide === undefined || navOpen === null
      ? null
      : () => {
          bridge.call(navOpen, guide).catch(() => undefined);
        };

  function choose(next: ClaimPlatform): void {
    if (next === platform) return;
    setPlatform(next);
    setErrors(NO_ERRORS);
  }

  function apply(outcome: SubmitOutcome, submitted: ClaimPlatform, order: string): void {
    switch (outcome.kind) {
      case 'created':
        onCreated(outcome.claim);
        return;
      case 'inline':
        setErrors({ order: outcome.order, date: outcome.date });
        return;
      case 'blocked': {
        const next: DailyBlock = { day: shanghaiToday(Date.now()), message: outcome.message };
        writeDailyBlock(queryClient, next);
        setBlock(next);
        setNow(Date.now());
        return;
      }
      case 'duplicate':
        onDuplicate(submitted, order, outcome.message);
        return;
      case 'general':
        setGeneral(outcome.message);
        return;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current || platform === null) return;
    const current = Date.now();
    if (activeBlockMessage(block, current) !== null) return;
    setNow(current);
    const order = orderNo.trim();
    const local: FieldErrors = {
      order: order === '' ? findOrderTexts.orderRequired : null,
      date: paidDate === '' ? findOrderTexts.paidDateRequired : null,
    };
    setGeneral(null);
    setErrors(local);
    if (local.order !== null || local.date !== null) return;

    const signed = bridge.has('net.signedRequest');
    if (signed === null) {
      // 原生不支持签名请求：版本过低，交给用户更新（不改走 H5 直发）。
      setGeneral(t('error.10405'));
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    let outcome: SubmitOutcome;
    try {
      const result = await bridge.call(signed, {
        method: 'POST',
        path: CLAIM_PATH,
        body: { platform, order_no: order, paid_date: paidDate },
      });
      const { outcomeOfResponse } = await loadSubmit();
      outcome = outcomeOfResponse(result.body);
    } catch {
      // 桥或网络失败（含解析块取不到）：结果未知，不自动重发；输入保留，用户可再次提交。
      outcome = { kind: 'general', message: t('buy.timeout') };
    } finally {
      inFlight.current = false;
      if (alive.current) setSubmitting(false);
    }
    if (alive.current) apply(outcome, platform, order);
  }

  const orderHint =
    platform === null
      ? ''
      : t('claim.guide.order_no', { platform_name: getPlatformName(platform) });
  const footerMessage = blocked ?? general;
  const windowText =
    windowDays === null ? null : t('claim.guide.window', { claim_window_days: String(windowDays) });

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-1 flex-col gap-couli-3"
    >
      <p
        className={`flex items-start gap-couli-2 rounded-couli-button bg-couli-background-muted p-couli-3 ${FOOTNOTE} text-couli-text-primary`}
      >
        <InfoIcon className="mt-0.5 size-couli-4 flex-none" />
        <span className="min-w-0">{findOrderTexts.intro}</span>
      </p>

      <div className={`${CARD} flex flex-col gap-couli-4 p-couli-4`}>
        <div className="flex flex-col gap-couli-1">
          <p id={ids.platform} className={`${FOOTNOTE} font-couli-semibold`}>
            {findOrderTexts.platformLabel}
          </p>
          <div
            role="radiogroup"
            aria-labelledby={ids.platform}
            className="flex flex-wrap gap-x-couli-2"
          >
            {platforms.map((item) => {
              const selected = item === platform;
              return (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => choose(item)}
                  className={`${FOCUS} flex min-h-11 min-w-11 cursor-pointer items-center rounded-couli-pill`}
                >
                  <span
                    className={`flex h-8 items-center gap-couli-1 rounded-couli-pill border px-couli-3 ${FOOTNOTE} ${
                      selected
                        ? 'border-couli-brand-subtle bg-couli-brand-subtle font-couli-semibold text-couli-brand-emphasis'
                        : 'border-couli-border-subtle bg-couli-background-surface text-couli-text-primary'
                    }`}
                  >
                    <img
                      src={CAPSULE_ICONS[item]}
                      alt=""
                      aria-hidden="true"
                      className="block size-couli-4 flex-none rounded-couli-small"
                    />
                    <span>{getPlatformName(item)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-couli-2">
          <label htmlFor={ids.order} className={`${FOOTNOTE} font-couli-semibold`}>
            {findOrderTexts.orderLabel}
          </label>
          <input
            id={ids.order}
            type="text"
            inputMode="text"
            autoComplete="off"
            enterKeyHint="next"
            required
            value={orderNo}
            aria-invalid={errors.order !== null}
            aria-describedby={describedBy(
              errors.order === null ? null : ids.orderError,
              ids.orderHint,
            )}
            onChange={(event) => {
              setOrderNo(event.target.value);
              setErrors((current) => ({ ...current, order: null }));
            }}
            className={inputClass(errors.order !== null)}
          />
          {errors.order === null ? null : <FieldError id={ids.orderError} message={errors.order} />}
          <p id={ids.orderHint} className={`${CAPTION} [overflow-wrap:anywhere]`}>
            {orderHint}
          </p>
          {openGuide === null ? null : (
            <button
              type="button"
              onClick={openGuide}
              className={`${FOCUS} -my-couli-2 flex min-h-11 cursor-pointer items-center gap-couli-1 self-start ${FOOTNOTE} font-couli-medium text-couli-text-link`}
            >
              {t('claim.guide.entry')}
              <ChevronIcon className="size-couli-4 flex-none" />
            </button>
          )}
        </div>

        <div className="flex flex-col gap-couli-2">
          <label htmlFor={ids.date} className={`${FOOTNOTE} font-couli-semibold`}>
            {findOrderTexts.paidDateLabel}
          </label>
          <input
            id={ids.date}
            type="date"
            required
            max={today}
            value={paidDate}
            aria-invalid={errors.date !== null}
            aria-describedby={describedBy(
              errors.date === null ? null : ids.dateError,
              ids.dateHint,
            )}
            onChange={(event) => {
              setPaidDate(event.target.value);
              setErrors((current) => ({ ...current, date: null }));
            }}
            className={`${inputClass(errors.date !== null)} appearance-none`}
          />
          {errors.date === null ? null : <FieldError id={ids.dateError} message={errors.date} />}
          <p id={ids.dateHint} className={`${CAPTION} [overflow-wrap:anywhere]`}>
            {t('claim.guide.paid_date')}
          </p>
        </div>
      </div>

      {windowText === null ? null : (
        <p
          className={`flex items-center gap-couli-2 px-couli-1 ${FOOTNOTE} text-couli-text-secondary`}
        >
          <ClockIcon className="size-couli-4 flex-none" />
          <span className="min-w-0">{windowText}</span>
        </p>
      )}

      <div
        id={ids.footer}
        className="sticky bottom-0 -mx-couli-4 mt-auto flex flex-col gap-couli-2 border-t border-couli-border-subtle bg-couli-background-surface px-couli-4 pt-couli-3 pb-couli-4"
      >
        <p className={`flex items-start gap-couli-1 ${CAPTION}`}>
          <InfoIcon className="mt-px size-couli-3 flex-none" />
          <span className="min-w-0">{t('claim.guide.caution')}</span>
        </p>
        {footerMessage === null ? null : <FieldError message={footerMessage} />}
        <button
          type="submit"
          disabled={submitting || blocked !== null || platform === null}
          className={`${PRIMARY_BUTTON} w-full disabled:cursor-default disabled:bg-couli-button-primary-disabled-background disabled:text-couli-button-primary-disabled-text`}
        >
          {findOrderTexts.submit}
        </button>
      </div>
    </form>
  );
}
