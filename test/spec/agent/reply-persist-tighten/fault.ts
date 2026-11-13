import type { DB } from '@couli/db';
import { PostgresQueryCompiler, type Kysely, type KyselyPlugin } from 'kysely';

/**
 * 在终态与回复两组写操作中，第一组到库、第二组执行前失败；两种顺序都覆盖。
 * 故障持续到显式解除，不让内部重试掩盖分开提交。插件只观察/拒绝 SQL，不代写业务状态。
 */
export function betweenReplyAndTerminal(db: Kysely<DB>) {
  const compiler = new PostgresQueryCompiler();
  let first: 'reply' | 'terminal' | undefined;
  let failures = 0;
  let enabled = true;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (!enabled) return node;
      const statement = compiler.compileQuery(node, queryId).sql.replaceAll('"', '');
      const terminal = /update\s+(?:app\.)?agent_runs\s+set[\s\S]*?\bfinal_event\s*=/iu.test(
        statement,
      );
      const reply =
        /update\s+(?:app\.)?agent_messages\s+set[\s\S]*?\btext\s*=/iu.test(statement) ||
        /insert\s+into\s+(?:app\.)?agent_cards\b/iu.test(statement);
      const kind = terminal ? 'terminal' : reply ? 'reply' : undefined;
      if (kind !== undefined) {
        first ??= kind;
        if (kind !== first) {
          failures += 1;
          throw new Error('合成故障：回复与终态写操作之间中断');
        }
      }
      return node;
    },
    transformResult: ({ result }) => Promise.resolve(result),
  };
  return {
    db: db.withPlugin(plugin),
    failures: () => failures,
    release: () => {
      enabled = false;
    },
  };
}
