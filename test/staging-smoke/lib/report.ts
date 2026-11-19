// STAGING-SMOKE (QA-04b): results of one smoke run — verdicts per case and step, timings, HTTP
// status and business code per call — and the redaction every recorded text goes through.
//
// Nothing recorded here may carry a credential: step names and notes are written by the cases
// without values; HTTP bodies are kept only for failed or yellow steps, and only after (1) every
// value under a sensitive key is replaced by *** and (2) every registered secret value (phone, SMS
// code, password, TOTP codes, tokens, install_secret, signatures) is replaced by *** wherever it
// still appears. Amounts are integer fen; ¥ text is built with integer arithmetic only.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Verdict = 'PASS' | 'FAIL' | 'YELLOW' | 'SKIP';

/** Thrown inside a step: the step and its case fail; the case stops. */
export class Fail extends Error {}
/** Thrown inside a step: the step and its case are yellow (environment, not code); the case stops. */
export class Yellow extends Error {}
/** Thrown inside a step: the rest of the case is not run (a missing fixture or precondition). */
export class Skipped extends Error {}

const SENSITIVE_KEY =
  /token|secret|password|ticket|sign|nonce|phone|logon|payee|card_no|id_number|authorization|otpauth|masked_|real_?name/i;
const RAW_LIMIT = 2000;

const secretValues = new Set<string>();

/** Every value registered here is replaced by *** in anything the report writes or prints. */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value === 'string' && value.length >= 4) secretValues.add(value);
}

export function scrub(text: string): string {
  let out = text;
  // Longest first, so a secret that contains another one is replaced whole.
  for (const value of [...secretValues].sort((a, b) => b.length - a.length)) {
    out = out.split(value).join('***');
  }
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 12) return '***';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '***' : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** A response body as it may be kept in the results: key-redacted, value-scrubbed, truncated. */
export function redactBody(body: unknown, rawText: string): string {
  const text = body === undefined ? rawText : JSON.stringify(redactValue(body, 0));
  const scrubbed = scrub(text);
  return scrubbed.length > RAW_LIMIT ? `${scrubbed.slice(0, RAW_LIMIT)}…(truncated)` : scrubbed;
}

/** ¥ text of integer fen, by integer arithmetic only (no floating point). */
export function yuan(fen: bigint): string {
  const sign = fen < 0n ? '-' : '';
  const abs = fen < 0n ? -fen : fen;
  return `${sign}¥${String(abs / 100n)}.${String(abs % 100n).padStart(2, '0')}`;
}

export interface CallRecord {
  /** Method and path template, e.g. `GET /v1/withdrawals/{id}` (no ids, no query values). */
  readonly label: string;
  readonly status: number | null;
  readonly code: number | null;
  readonly ms: number;
  readonly traceId: string | null;
  /** Redacted body; only persisted for failed or yellow steps. */
  readonly raw: string | null;
}

interface StepRecord {
  name: string;
  verdict: Verdict;
  ms: number;
  notes: string[];
  calls: CallRecord[];
}

interface CaseRecord {
  id: string;
  title: string;
  verdict: Verdict;
  ms: number;
  reason: string | null;
  steps: StepRecord[];
}

const RANK: Record<Verdict, number> = { PASS: 0, SKIP: 1, YELLOW: 2, FAIL: 3 };

function worse(a: Verdict, b: Verdict): Verdict {
  return RANK[b] > RANK[a] ? b : a;
}

export class StepContext {
  readonly #record: StepRecord;
  constructor(record: StepRecord) {
    this.#record = record;
  }
  /** A remark kept in the results (no values). */
  note(text: string): void {
    this.#record.notes.push(scrub(text));
  }
  /** Marks the step yellow without stopping the case. */
  warn(text: string): void {
    this.#record.verdict = worse(this.#record.verdict, 'YELLOW');
    this.note(text);
  }
  /** Marks a step that could not check anything as SKIP without stopping the case. */
  notChecked(text: string): void {
    if (this.#record.verdict === 'PASS') this.#record.verdict = 'SKIP';
    this.note(text);
  }
}

export class CaseContext {
  readonly #record: CaseRecord;
  readonly #report: Report;
  constructor(record: CaseRecord, report: Report) {
    this.#record = record;
    this.#report = report;
  }

  async step<T>(name: string, run: (step: StepContext) => Promise<T>): Promise<T> {
    const record: StepRecord = { name, verdict: 'PASS', ms: 0, notes: [], calls: [] };
    this.#record.steps.push(record);
    const started = performance.now();
    this.#report.currentStep = record;
    try {
      return await run(new StepContext(record));
    } catch (error) {
      record.verdict =
        error instanceof Yellow ? 'YELLOW' : error instanceof Skipped ? 'SKIP' : 'FAIL';
      record.notes.push(scrub(describe(error)));
      throw error;
    } finally {
      this.#report.currentStep = null;
      record.ms = Math.round(performance.now() - started);
      this.#report.printStep(record);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Fail || error instanceof Yellow || error instanceof Skipped) {
    return error.message;
  }
  // Unexpected errors: the class name only; a message could carry a value.
  return `unexpected error (${error instanceof Error ? error.name : typeof error})`;
}

export class Report {
  readonly #cases: CaseRecord[] = [];
  readonly #started = new Date();
  /** The step the next HTTP call belongs to (the run is strictly sequential). */
  currentStep: StepRecord | null = null;

  recordCall(call: CallRecord): void {
    this.currentStep?.calls.push(call);
  }

  /** Runs one case; a thrown Fail / Yellow / Skipped ends it with that verdict. */
  async runCase(
    id: string,
    title: string,
    run: (ctx: CaseContext) => Promise<void>,
  ): Promise<Verdict> {
    const record: CaseRecord = { id, title, verdict: 'PASS', ms: 0, reason: null, steps: [] };
    this.#cases.push(record);
    process.stdout.write(`\n[${id}] ${title}\n`);
    const started = performance.now();
    try {
      await run(new CaseContext(record, this));
      for (const step of record.steps) {
        record.verdict = worse(record.verdict, step.verdict === 'SKIP' ? 'PASS' : step.verdict);
      }
      if (record.steps.length > 0 && record.steps.every((step) => step.verdict === 'SKIP')) {
        record.verdict = 'SKIP';
      }
    } catch (error) {
      record.verdict =
        error instanceof Yellow ? 'YELLOW' : error instanceof Skipped ? 'SKIP' : 'FAIL';
      for (const step of record.steps) {
        if (step.verdict !== 'SKIP') record.verdict = worse(record.verdict, step.verdict);
      }
      record.reason = scrub(describe(error));
    }
    record.ms = Math.round(performance.now() - started);
    process.stdout.write(
      `[${id}] ${record.verdict} (${String(record.ms)} ms)${record.reason === null ? '' : ` — ${record.reason}`}\n`,
    );
    return record.verdict;
  }

  /** A case that is not run at all (its precondition failed earlier). */
  skipCase(id: string, title: string, reason: string): void {
    this.#cases.push({ id, title, verdict: 'SKIP', ms: 0, reason: scrub(reason), steps: [] });
    process.stdout.write(`\n[${id}] ${title}\n[${id}] SKIP — ${scrub(reason)}\n`);
  }

  printStep(step: StepRecord): void {
    const calls = step.calls
      .map((call) => `${call.label} → ${call.status ?? '-'}/${call.code ?? '-'}`)
      .join('; ');
    process.stdout.write(
      `  ${step.verdict.padEnd(6)} ${step.name} (${String(step.ms)} ms)${calls === '' ? '' : `  ${calls}`}\n`,
    );
    for (const note of step.notes) process.stdout.write(`         · ${note}\n`);
  }

  get failed(): boolean {
    return this.#cases.some((record) => record.verdict === 'FAIL');
  }

  /** summary.json (everything, raw bodies only for failed / yellow steps) and summary.md. */
  async write(outDir: string): Promise<void> {
    await mkdir(outDir, { recursive: true });
    const cases = this.#cases.map((record) => ({
      ...record,
      steps: record.steps.map((step) => ({
        ...step,
        calls: step.calls.map((call) =>
          step.verdict === 'FAIL' || step.verdict === 'YELLOW' ? call : { ...call, raw: null },
        ),
      })),
    }));
    const totals: Record<Verdict, number> = { PASS: 0, FAIL: 0, YELLOW: 0, SKIP: 0 };
    for (const record of cases) totals[record.verdict] += 1;
    const summary = {
      started_at: this.#started.toISOString(),
      finished_at: new Date().toISOString(),
      totals,
      cases,
    };
    await writeFile(
      join(outDir, 'summary.json'),
      `${scrub(JSON.stringify(summary, null, 2))}\n`,
      'utf8',
    );
    const lines = [
      `# staging 冒烟 ${summary.started_at}`,
      '',
      `PASS ${String(totals.PASS)} · FAIL ${String(totals.FAIL)} · YELLOW ${String(totals.YELLOW)} · SKIP ${String(totals.SKIP)}`,
      '',
      '| 用例 | 结果 | 耗时 ms | 说明 |',
      '| --- | --- | --- | --- |',
      ...cases.map(
        (record) =>
          `| ${record.id} ${record.title} | ${record.verdict} | ${String(record.ms)} | ${(record.reason ?? '').replace(/\|/g, '/')} |`,
      ),
      '',
      '## 每步',
      '',
    ];
    for (const record of cases) {
      lines.push(`### ${record.id} ${record.title} — ${record.verdict}`, '');
      for (const step of record.steps) {
        lines.push(`- ${step.verdict} ${step.name}（${String(step.ms)} ms）`);
        for (const call of step.calls) {
          lines.push(
            `  - ${call.label} → HTTP ${call.status ?? '-'}，code ${call.code ?? '-'}，${String(call.ms)} ms，trace_id ${call.traceId ?? '-'}`,
          );
          if (call.raw !== null)
            lines.push(`    - 原文（已脱敏）：\`${call.raw.replace(/`/g, "'")}\``);
        }
        for (const note of step.notes) lines.push(`  - ${note}`);
      }
      lines.push('');
    }
    await writeFile(join(outDir, 'summary.md'), `${scrub(lines.join('\n'))}\n`, 'utf8');
  }
}
