// B2-17 rule-test helper of the third writing (claude-independent, SPEC_REF 1025764b; 编排 D10-3205):
// a one-shot fault on the two writes this task adds to the submission (§11.1 of the task), so that
// a submission which commits the money in one transaction and the diff / link writes in another is
// told apart from one that commits them together (BR-FUND-24 ⑨ 「在批准的同一事务内」「红冲该调账单
// 时同一事务把差错单退回 processing」):
// - 'link': the INSERT into app.adjustment_recon_diffs (a new form) or the UPDATE of it (a reversal
//   writing reversed_by_adjust_id);
// - 'diff': the UPDATE of app.recon_diffs (置 adjusted / processing, or 退回 processing).
// The frozen ../admin-adjustments/kit.ts withAdjustAdmin builds the entry's database handle from
// the fixture's `db` (f.db.withPlugin(faultPlugin(...))); `armed` returns a copy of the fixture
// whose `db` already carries this plugin, so every statement of the entry passes through it first.
// The test's own reads keep using the plain fixture. Written the way kit.ts faultPlugin is: the
// statement is compiled with PostgresQueryCompiler and a match throws a plain Error (the entry
// answers 50001 to it) and disarms. No real data.
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, type Kysely, type KyselyPlugin } from 'kysely';
import type { AdjustFixture } from '../admin-adjustments/kit.ts';

/** Which of the two new writes fails once. */
export type WritePoint = 'link' | 'diff';

export interface WriteFault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: WritePoint | null;
  tripped: number;
}

const LINK_WRITE = /\b(?:insert\s+into|update)\s+(?:"?app"?\s*\.\s*)?"?adjustment_recon_diffs\b/i;
const DIFF_WRITE = /\bupdate\s+(?:only\s+)?(?:"?app"?\s*\.\s*)?"?recon_diffs\b/i;

/** Whether the compiled statement is the write `point` names. */
export function hitsWrite(point: WritePoint, text: string): boolean {
  return point === 'link' ? LINK_WRITE.test(text) : DIFF_WRITE.test(text);
}

function writeFaultPlugin(fault: WriteFault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      const point = fault.point;
      if (point === null) return node;
      const text = compiler.compileQuery(node, queryId).sql;
      if (hitsWrite(point, text)) {
        fault.point = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at ${point} write`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

export interface Armed {
  /** The fixture to hand to withAdjustAdmin (its db carries the write fault). */
  readonly fixture: AdjustFixture;
  readonly fault: WriteFault;
}

/** A copy of the fixture whose db fails the named write once whenever `fault.point` is set. */
export function armed(f: AdjustFixture): Armed {
  const fault: WriteFault = { point: null, tripped: 0 };
  const db: Kysely<DB> = f.db.withPlugin(writeFaultPlugin(fault));
  return { fixture: { ...f, db }, fault };
}
