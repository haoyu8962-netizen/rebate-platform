// Prometheus registry of one entry (B1-01zzh): process-level metrics everywhere; the five business
// gauges only on the worker, filled by `collect` at scrape time (no polling loop). The five fund
// gauges (B1-01zzi) likewise only on the worker, filled by `collectFund` at scrape time; a rejected
// collection rejects render() (the scrape fails visibly, no value is made up). The two auto-payout
// daily gauges (B1-01zzp) likewise only on the worker, filled by `collectAutoPayout`; the review
// overdue gauge (B2-05o) likewise, filled by `collectReviewOverdue`. The Taobao search counter
// (B1-04zy) only on the api, filled by `collectTaobaoSearch` from union's in-process counter.
// The text exposition format 0.0.4 is written here from Node built-ins only: the client library
// cannot be loaded in the test environment (its @opentelemetry/api dependency resolves to an ESM
// build Node cannot import), so no third-party metrics library is used at runtime.
import { performance } from 'node:perf_hooks';
import type { EntryName } from '../entries.ts';
import type { AutoPayoutDailySnapshot } from './auto-payout.ts';
import type { WorkerMetricsSnapshot } from './collect.ts';
import type { FundMetricsSnapshot } from './fund.ts';
import { pddServiceFeeMissingTotal } from './pdd-service-fee.ts';
import { REVIEW_OVERDUE_GAUGE, type ReviewOverdueSnapshot } from './review-overdue.ts';
import { WATER_LOW_GAUGE, type WaterLowSnapshot } from './water-low.ts';

export interface MetricsRegistryOptions {
  readonly entry: EntryName;
  /** Used only when entry is 'worker'; called once per render(). */
  readonly collect?: () => Promise<WorkerMetricsSnapshot>;
  /** The fund gauges (B1-01zzi). Used only when entry is 'worker'; called once per render(). */
  readonly collectFund?: () => Promise<FundMetricsSnapshot>;
  /** The auto-payout daily gauges (B1-01zzp). Used only on 'worker'; called once per render(). */
  readonly collectAutoPayout?: () => Promise<AutoPayoutDailySnapshot>;
  /** The review overdue gauge (B2-05o). Used only on 'worker'; called once per render(). */
  readonly collectReviewOverdue?: () => Promise<ReviewOverdueSnapshot>;
  /** The water level gauge (B2-09j). Used only on 'worker'; called once per render(). */
  readonly collectWaterLow?: () => Promise<WaterLowSnapshot>;
  /** couli_taobao_search_total (B1-04zy). Used only on 'api', never 'worker'; once per render(). */
  readonly collectTaobaoSearch?: () => TaobaoSearchMetricsSnapshot;
}

/** One series of couli_taobao_search_total; union's counter hands these over (no import of union). */
export interface TaobaoSearchMetricSample {
  readonly source: string;
  readonly outcome: string;
  readonly value: number;
}

/** Every series of couli_taobao_search_total counted so far in this process. */
export type TaobaoSearchMetricsSnapshot = readonly TaobaoSearchMetricSample[];

export interface MetricsRegistry {
  /** Content-Type of render()'s text (Prometheus text exposition format). */
  readonly contentType: string;
  /** Every registered metric in the Prometheus text exposition format. */
  render(): Promise<string>;
}

/** Prometheus text exposition format 0.0.4. */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

interface Family {
  readonly name: string;
  readonly help: string;
  readonly type: 'gauge' | 'counter';
  readonly samples: readonly { readonly labels?: Record<string, string>; readonly value: number }[];
}

/** The five business gauges: snapshot key → metric name, help text and its one label. */
const BUSINESS_GAUGES: Readonly<
  Record<keyof WorkerMetricsSnapshot, { name: string; help: string; label: string }>
> = {
  queueFailed: {
    name: 'couli_queue_failed_jobs',
    help: 'Jobs in state failed, per queue (dead letter queues included).',
    label: 'queue',
  },
  deadLetters: {
    name: 'couli_queue_dead_letters',
    help: 'Jobs waiting in a dead letter queue (state created or retry).',
    label: 'queue',
  },
  backlog: {
    name: 'couli_queue_backlog_jobs',
    help: 'Jobs in state created that are due (start_after at or before now), per business queue.',
    label: 'queue',
  },
  oldestDueEvtAgeSeconds: {
    name: 'couli_evt_oldest_due_created_age_seconds',
    help: 'Age in seconds of the oldest due created job of each evt.* queue; 0 when none.',
    label: 'queue',
  },
  syncWatermarkLagSeconds: {
    name: 'couli_sync_watermark_lag_seconds',
    help: 'Seconds between now and the oldest sync cursor of each platform.',
    label: 'platform',
  },
};

const BUSINESS_KEYS = Object.keys(BUSINESS_GAUGES) as (keyof WorkerMetricsSnapshot)[];

/** The fund gauge with one label (reason): open order_sync_pending rows (BR-FUND-02). */
const PENDING_GAUGE = {
  name: 'couli_order_sync_pending_open',
  help: 'Open order_sync_pending rows per reason (UNMAPPED_STATUS: status code outside the map).',
  label: 'reason',
} as const;

type ScalarFundKey = Exclude<keyof FundMetricsSnapshot, 'orderSyncPendingOpen'>;

/** The four unlabelled fund gauges: snapshot key → metric name and help text. */
const SCALAR_FUND_GAUGES: Readonly<Record<ScalarFundKey, { name: string; help: string }>> = {
  billJobsFailed: {
    name: 'couli_settle_bill_jobs_failed',
    help: 'Monthly bill generation jobs (settle_jobs job bill) in status failed.',
  },
  partialBatches: {
    name: 'couli_settle_batches_partial',
    help: 'Settlement batches in status PARTIAL.',
  },
  beneficiariesHeldOver30Days: {
    name: 'couli_beneficiary_held_over_30d',
    help: 'Beneficiary shares still held 30 days or more after their first held event.',
  },
  payingNeedsManual: {
    name: 'couli_withdrawals_paying_needs_manual',
    help: 'Withdrawals in status PAYING whose result is unknown and needs a person (needs_manual).',
  },
};

const SCALAR_FUND_KEYS = Object.keys(SCALAR_FUND_GAUGES) as ScalarFundKey[];

/** The two auto-payout daily gauges (B1-01zzp), both labelled app_id so the rules divide them. */
const AUTO_PAYOUT_GAUGES: Readonly<
  Record<keyof AutoPayoutDailySnapshot, { name: string; help: string }>
> = {
  totalFen: {
    name: 'couli_auto_payout_daily_total_fen',
    help: 'Sum of amount_fen of auto-reviewed withdrawals not REJECTED or FAILED, reviewed in the current +08:00 day, per app_id.',
  },
  capFen: {
    name: 'couli_auto_payout_daily_cap_fen',
    help: 'The withdraw.auto_payout.platform_daily_max_fen B2-11c executes with (its default when absent or malformed), per app_id with a cap row or a nonzero total.',
  },
};

const AUTO_PAYOUT_KEYS = Object.keys(AUTO_PAYOUT_GAUGES) as (keyof AutoPayoutDailySnapshot)[];

const AUTO_PAYOUT_LABEL = 'app_id';

/** The Taobao search counter (B1-04zy): reasons stay out of the labels (warn log only). */
const TAOBAO_SEARCH_COUNTER = {
  name: 'couli_taobao_search_total',
  help: 'Taobao search attempts per source and outcome (fallback: the official attempt handed over to dataoke).',
} as const;

function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabelValue(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function renderFamily(family: Family): string {
  let out = `# HELP ${family.name} ${escapeHelp(family.help)}\n# TYPE ${family.name} ${family.type}\n`;
  for (const sample of family.samples) {
    const pairs = Object.entries(sample.labels ?? {}).map(
      ([key, value]) => `${key}="${escapeLabelValue(value)}"`,
    );
    const labels = pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
    out += `${family.name}${labels} ${formatValue(sample.value)}\n`;
  }
  return out;
}

/** B1-08zh: has a sample from the start, or increase() misses the first count. */
function pddServiceFeeFamily(): Family {
  return {
    name: 'couli_pdd_service_fee_missing_total',
    help: 'Pinduoduo reports without the service fee on orders that already have an estimate.',
    type: 'counter',
    samples: [{ value: pddServiceFeeMissingTotal() }],
  };
}

/** The process-level metrics, under the names the standard Node.js client exports. */
function processFamilies(): Family[] {
  const cpu = process.cpuUsage();
  const user = cpu.user / 1e6;
  const system = cpu.system / 1e6;
  const memory = process.memoryUsage();
  return [
    {
      name: 'process_cpu_user_seconds_total',
      help: 'Total user CPU time spent in seconds.',
      type: 'counter',
      samples: [{ value: user }],
    },
    {
      name: 'process_cpu_system_seconds_total',
      help: 'Total system CPU time spent in seconds.',
      type: 'counter',
      samples: [{ value: system }],
    },
    {
      name: 'process_cpu_seconds_total',
      help: 'Total user and system CPU time spent in seconds.',
      type: 'counter',
      samples: [{ value: user + system }],
    },
    {
      name: 'process_resident_memory_bytes',
      help: 'Resident memory size in bytes.',
      type: 'gauge',
      samples: [{ value: memory.rss }],
    },
    {
      name: 'process_start_time_seconds',
      help: 'Start time of the process since unix epoch in seconds.',
      type: 'gauge',
      // The process's own start instant (not a business clock reading).
      samples: [{ value: Math.round(performance.timeOrigin / 1000) }],
    },
    {
      name: 'nodejs_heap_size_total_bytes',
      help: 'Process heap size from Node.js in bytes.',
      type: 'gauge',
      samples: [{ value: memory.heapTotal }],
    },
    {
      name: 'nodejs_heap_size_used_bytes',
      help: 'Process heap size used from Node.js in bytes.',
      type: 'gauge',
      samples: [{ value: memory.heapUsed }],
    },
  ];
}

function businessFamilies(snapshot: WorkerMetricsSnapshot): Family[] {
  return BUSINESS_KEYS.map((key) => {
    const { name, help, label } = BUSINESS_GAUGES[key];
    // Only this snapshot's series: one that disappeared does not keep its previous value.
    const samples = Object.entries(snapshot[key]).map(([value, sample]) => ({
      labels: { [label]: value },
      value: sample,
    }));
    return { name, help, type: 'gauge' as const, samples };
  });
}

function fundFamilies(snapshot: FundMetricsSnapshot): Family[] {
  // Only this snapshot's reasons: one without open rows has no series (not a stale or made-up 0).
  const pending: Family = {
    name: PENDING_GAUGE.name,
    help: PENDING_GAUGE.help,
    type: 'gauge',
    samples: Object.entries(snapshot.orderSyncPendingOpen).map(([reason, value]) => ({
      labels: { [PENDING_GAUGE.label]: reason },
      value,
    })),
  };
  // The scalar gauges are always exported, 0 included (the rules compare with > 0).
  const scalars = SCALAR_FUND_KEYS.map((key) => ({
    name: SCALAR_FUND_GAUGES[key].name,
    help: SCALAR_FUND_GAUGES[key].help,
    type: 'gauge' as const,
    samples: [{ value: snapshot[key] }],
  }));
  return [pending, ...scalars];
}

function autoPayoutFamilies(snapshot: AutoPayoutDailySnapshot): Family[] {
  // Only this snapshot's app_ids: one that disappeared does not keep its previous value.
  return AUTO_PAYOUT_KEYS.map((key) => ({
    name: AUTO_PAYOUT_GAUGES[key].name,
    help: AUTO_PAYOUT_GAUGES[key].help,
    type: 'gauge' as const,
    samples: Object.entries(snapshot[key]).map(([appId, value]) => ({
      labels: { [AUTO_PAYOUT_LABEL]: appId },
      value,
    })),
  }));
}

/** The water level gauge (B2-09j): only this snapshot's app_ids, an app without a conclusion has none. */
function waterLowFamilies(snapshot: WaterLowSnapshot): Family[] {
  return [
    {
      name: WATER_LOW_GAUGE.name,
      help: WATER_LOW_GAUGE.help,
      type: 'gauge',
      samples: Object.entries(snapshot.waterLow).map(([appId, value]) => ({
        labels: { [WATER_LOW_GAUGE.label]: appId },
        value,
      })),
    },
  ];
}

/** The review overdue gauge (B2-05o): always exported, 0 included (the rule compares with > 0). */
function reviewOverdueFamilies(snapshot: ReviewOverdueSnapshot): Family[] {
  return [
    {
      name: REVIEW_OVERDUE_GAUGE.name,
      help: REVIEW_OVERDUE_GAUGE.help,
      type: 'gauge',
      samples: [{ value: snapshot.reviewOverdue }],
    },
  ];
}

function taobaoSearchFamilies(snapshot: TaobaoSearchMetricsSnapshot): Family[] {
  return [
    {
      name: TAOBAO_SEARCH_COUNTER.name,
      help: TAOBAO_SEARCH_COUNTER.help,
      type: 'counter',
      samples: snapshot.map(({ source, outcome, value }) => ({
        labels: { source, outcome },
        value,
      })),
    },
  ];
}

export function createMetricsRegistry(options: MetricsRegistryOptions): MetricsRegistry {
  const worker = options.entry === 'worker';
  const collect = worker ? options.collect : undefined;
  const collectFund = worker ? options.collectFund : undefined;
  const collectAutoPayout = worker ? options.collectAutoPayout : undefined;
  const collectReviewOverdue = worker ? options.collectReviewOverdue : undefined;
  const collectWaterLow = worker ? options.collectWaterLow : undefined;
  const collectTaobaoSearch = options.entry === 'api' ? options.collectTaobaoSearch : undefined;
  return {
    contentType: CONTENT_TYPE,
    async render() {
      // Business, fund, auto-payout and review overdue values first, then the process values of
      // the same scrape. Any collection rejecting (or throwing synchronously) rejects the whole
      // render.
      const [business, fund, autoPayout, reviewOverdue, waterLow] = await Promise.all([
        collect === undefined ? [] : collect().then(businessFamilies),
        collectFund === undefined ? [] : collectFund().then(fundFamilies),
        collectAutoPayout === undefined
          ? []
          : Promise.resolve().then(collectAutoPayout).then(autoPayoutFamilies),
        collectReviewOverdue === undefined
          ? []
          : Promise.resolve().then(collectReviewOverdue).then(reviewOverdueFamilies),
        collectWaterLow === undefined
          ? []
          : Promise.resolve().then(collectWaterLow).then(waterLowFamilies),
      ]);
      const taobaoSearch =
        collectTaobaoSearch === undefined ? [] : taobaoSearchFamilies(collectTaobaoSearch());
      return [
        ...business,
        ...fund,
        ...autoPayout,
        ...reviewOverdue,
        ...waterLow,
        ...taobaoSearch,
        pddServiceFeeFamily(),
        ...processFamilies(),
      ]
        .map(renderFamily)
        .join('');
    },
  };
}
