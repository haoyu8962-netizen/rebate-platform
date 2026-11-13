// D10-1361 · 通过生产模型循环和真实 PG 比较连线/断线结果。
// 比较每一行的全部业务列，不排序/去重/折叠条件；只将随机 chain_id 按首次出现顺序改名。
// app_id 必须相同；session_id 分别核对；created_at 是数据库插入时刻，只核对其存在。
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import type { SessionChain } from '../../../../apps/api/src/modules/agent/orchestrator/results/types.ts';
import type { Step } from '../core-reply-templates/kit.ts';
import { openSession, runRow, usePgEach } from '../stream-mount/kit.ts';
import { ask, cardTypesOf, productionRig, runIdOf } from '../trace-persist/kit.ts';
import { disconnectedRun, held, waitAt } from '../reply-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

type Search = { readonly q: string; readonly price_max_fen?: number };
interface Scenario {
  readonly searches: readonly Search[];
  readonly lists: number;
  readonly awaiting?: boolean;
}
const EMPTY = '合成无结果词';

async function compare(scenario: Scenario): Promise<void> {
  const h = held();
  const connectedAsk = '执行合成搜索序列甲';
  const offlineAsk = '执行合成搜索序列乙';
  const steps: Step[] = scenario.searches.map((args) => ({
    calls: [{ name: 'search_products', args }],
  }));
  const x = await productionRig(pg.db, {
    scripts: {
      [connectedAsk]: [...steps, { text: '合成搜索结束。' }],
      [offlineAsk]: steps
        .map((step, i) => (i === 0 ? { ...step, before: waitAt(h) } : step))
        .concat({ text: '合成搜索结束。' }),
    },
  });
  x.f.searchProducts.mockImplementation(async (query) =>
    query.q === EMPTY ? [] : [x.f.state.row],
  );
  try {
    const normalSession = await openSession(x.r, x.f.caller);
    const store = createPgResultSetStore({ db: pg.db });
    const seed: SessionChain = {
      chainId: 'synthetic-awaiting-price',
      status: 'awaiting_price',
      conditions: { chain_id: 'synthetic-awaiting-price', q: '合成保温杯', price_max_fen: 9_000 },
    };
    if (scenario.awaiting) await store.appendChain!(x.appId, normalSession, seed);
    const normal = await ask(x, x.f.caller, normalSession, connectedAsk);
    expect(cardTypesOf(normal).filter((type) => type === 'product_list')).toHaveLength(
      scenario.lists,
    );
    // D10-1524 夹具修正：正常那轮跑完再开断线会话，避免 open() 返回同一会话
    const offlineSession = await openSession(x.r, x.f.caller);
    expect(offlineSession, '断线会话必须是另开的新会话，不是正常那轮用过的会话').not.toBe(
      normalSession,
    );
    if (scenario.awaiting) await store.appendChain!(x.appId, offlineSession, seed);
    const offline = await disconnectedRun(x, h, offlineSession, offlineAsk);
    expect(cardTypesOf(offline.frames), '断线发生在第一张列表之前').toEqual([]);
    for (const frames of [normal, offline.frames]) {
      const run = await runRow(pg.db, runIdOf(frames));
      expect(run['final_event']).not.toBeNull();
      expect(run['finish_reason']).toBe('stop');
    }

    async function snapshot(sessionId: string) {
      const rows = await pg.db
        .selectFrom('agent_result_chains')
        .selectAll()
        .where('app_id', '=', x.appId)
        .where('session_id', '=', sessionId)
        .orderBy('seq')
        .execute();
      const names = new Map<string, string>();
      function canonical(id: string): string {
        if (!names.has(id)) names.set(id, `chain-${String(names.size + 1)}`);
        return names.get(id)!;
      }
      const normalized = rows.map(
        ({ app_id, session_id, created_at, chain_id, conditions, ...rest }) => {
          expect(app_id).toBe(x.appId);
          expect(session_id).toBe(sessionId);
          expect(Number.isFinite(new Date(created_at).getTime())).toBe(true);
          const condition = conditions as Record<string, unknown> | null;
          if (condition !== null) expect(condition['chain_id']).toBe(chain_id);
          return {
            ...rest,
            chain_id: canonical(chain_id),
            conditions: condition === null ? null : { ...condition, chain_id: canonical(chain_id) },
          };
        },
      );
      const current = await store.currentChain!(x.appId, sessionId);
      expect(current).not.toBeNull();
      const actual = current!;
      return {
        rows: normalized,
        current: {
          ...actual,
          chainId: canonical(actual.chainId),
          conditions:
            actual.conditions === null
              ? null
              : {
                  ...actual.conditions,
                  chain_id: canonical(actual.conditions.chain_id),
                },
        },
      };
    }
    const connected = await snapshot(normalSession);
    const disconnected = await snapshot(offlineSession);
    expect(connected.rows.length, '不是比较两个空快照').toBeGreaterThan(0);
    expect(connected.current.conditions?.q).toBe(scenario.searches.at(-1)?.q);
    if (scenario.searches.at(-1)?.price_max_fen !== undefined) {
      expect(connected.current.conditions?.price_max_fen).toBe(
        scenario.searches.at(-1)?.price_max_fen,
      );
    }
    expect(disconnected.rows, '按 seq 比较全部行，包括链复用关系与每次条件变化').toEqual(
      connected.rows,
    );
    expect(disconnected.current, '当前条件不得被较早的补写列表覆盖').toEqual(connected.current);
  } finally {
    h.gate.open();
    await x.r.runtime.close();
  }
}

it('[AC-B3-08zd#9][BR-AI-19][BR-AI-05] 断线期间没有产生列表：搜索尝试的全部链行与当前条件仍等于正常送达', async () => {
  await compare({ searches: [{ q: EMPTY }], lists: 0 });
}, 120_000);
