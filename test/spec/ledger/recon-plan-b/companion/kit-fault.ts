// 故障夹具在后台入口所用 Kysely 句柄的查询转换层计数和注入失败，直接用数据库驱动、另建连接池或由触发器间接写入时均无法计数或注入失败。
import { PostgresQueryCompiler, type KyselyPlugin } from 'kysely';
import type { AdjustFixture, AdminSent } from '../../admin-adjustments/kit.ts';
import type { WritePoint } from '../kit-fault.ts';

const TARGETS: Record<WritePoint, string> = {
  link: 'adjustment_recon_diffs',
  diff: 'recon_diffs',
};

// Match the target of a write, including writes inside WITH and batched statements. An
// INSERT ... ON CONFLICT counts as one write. SELECT ... FOR UPDATE has no write target.
const WRITE_TARGET =
  /\b(?:insert\s+into|merge\s+into|update)\s+(?:only\s+)?(?:(?:app|"app")\s*\.\s*)?"?(adjustment_recon_diffs|recon_diffs)"?(?=\s|\(|;|$)/gi;
const SQL_TEXT = /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|\$(\w*)\$[\s\S]*?\$\1\$/g;

interface Attempt {
  readonly point: WritePoint;
  readonly ordinal: number;
  readonly hits: Record<WritePoint, number>;
}

/** Count writes on the entry's Kysely handle and fail once, before executing the chosen statement. */
export function withWriteFault(f: AdjustFixture) {
  const compiler = new PostgresQueryCompiler();
  let active: Attempt | undefined;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (active === undefined) return node;
      const { point, ordinal, hits } = active;
      const sql = compiler.compileQuery(node, queryId).sql.replace(SQL_TEXT, ' ');
      const targets = new Set(
        Array.from(sql.matchAll(WRITE_TARGET), (match) => match[1]!.toLowerCase()),
      );
      if (targets.has(TARGETS.link)) hits.link += 1;
      if (targets.has(TARGETS.diff)) hits.diff += 1;
      if (targets.has(TARGETS[point]) && hits[point] === ordinal) {
        throw new Error(`synthetic failure at ${point} write ${ordinal}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };

  return {
    fixture: { ...f, db: f.db.withPlugin(plugin) },
    async attempt(point: WritePoint, ordinal: number, submit: () => Promise<AdminSent>) {
      const hits = { link: 0, diff: 0 };
      active = { point, ordinal, hits };
      try {
        return { sent: await submit(), hits };
      } finally {
        active = undefined;
      }
    },
  };
}
