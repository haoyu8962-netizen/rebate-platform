import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type {
  HandlerResult,
  Idempotency,
  IdempotentRequest,
  IdempotentResponse,
} from '../../platform/index.ts';
import {
  ShopEntryNeedsAuthState,
  ShopEntryNeedsConvert,
  createShopOpen,
  runShopEntry,
  type ShopEntryMode,
  type ShopOpenOptions,
} from './shop-open.ts';

// r6 (D10-3129 ⑤): the issuance and the reads are replaced so the account handed to the issuance
// can be observed without a database (the other link-open-taobao functions stay as they are).
const issued = vi.hoisted(() => ({
  issue: vi.fn(),
  reads: {
    binding: vi.fn(),
    authAccountId: vi.fn(),
    siteAuthAvailable: vi.fn(),
    userBanned: vi.fn(),
  },
}));
vi.mock('./link-open-taobao.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./link-open-taobao.ts')>()),
  issueTaobaoAuthState: issued.issue,
}));
vi.mock('./union-auth-reads.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./union-auth-reads.ts')>()),
  createUnionAuthReads: () => issued.reads,
}));

// A synthetic idempotency store with the platform's two modes, in memory: the standard mode stores
// the handler's result after it returns (a throw stores nothing); the transactional mode buffers
// the handler's writes on its `trx` and commits them with the stored result, or drops them all.
interface FakeTrx {
  readonly writes: string[];
}

function fakeIdempotency() {
  const stored = new Map<string, string>();
  const committedStates: string[] = [];
  const calls: string[] = [];
  let loseNextCommit = false;
  const storable = (code: number) => code === 0 || (code >= 30000 && code <= 39999);
  const respond = (key: string, out: HandlerResult): IdempotentResponse => {
    const body = JSON.stringify(out.envelope);
    if (storable(out.envelope.code)) stored.set(key, body);
    return { status: out.status, body, source: 'handler' };
  };
  const replay = (key: string): IdempotentResponse | null => {
    const body = stored.get(key);
    return body === undefined ? null : { status: 200, body, source: 'replay' };
  };
  const idempotency: Pick<Idempotency, 'execute' | 'executeInTransaction'> = {
    async execute(request, handler) {
      calls.push('execute');
      const hit = replay(request.key ?? '');
      if (hit !== null) return hit;
      return respond(request.key ?? '', await handler());
    },
    async executeInTransaction(request, handler) {
      calls.push('executeInTransaction');
      const hit = replay(request.key ?? '');
      if (hit !== null) return hit;
      const trx: FakeTrx = { writes: [] };
      const out = await handler(trx as unknown as Transaction<DB>);
      if (loseNextCommit) {
        // The process dies before COMMIT: neither the state nor the record survives.
        loseNextCommit = false;
        throw new Error('synthetic: connection lost before commit');
      }
      if (storable(out.envelope.code)) committedStates.push(...trx.writes);
      return respond(request.key ?? '', out);
    },
  };
  return {
    idempotency,
    committedStates,
    calls,
    loseNextCommit: () => {
      loseNextCommit = true;
    },
  };
}

const REQUEST: IdempotentRequest = {
  appId: 'synthetic-app',
  actor: { userId: 'synthetic-user', deviceId: 'synthetic-device', phoneHmac: null },
  method: 'POST',
  path: '/v1/products/synthetic-key/shop/open',
  key: 'synthetic-shop-open-key',
  body: { platform: 'taobao' },
  traceId: 'synthetic-trace',
};

function envelope(code: number, data?: unknown): HandlerResult {
  return {
    status: code === 0 ? 200 : 422,
    envelope: {
      code,
      msg: '',
      ...(data === undefined ? {} : { data }),
      trace_id: 'synthetic-trace',
    },
  };
}

/** A shop entry in miniature: bound → jump; unbound → a state issued only through `trx`. */
function stageOf(binding: { active: boolean }, modes: ShopEntryMode[]) {
  let serial = 0;
  return async (executor: Kysely<DB> | null, mode: ShopEntryMode): Promise<HandlerResult> => {
    modes.push(mode);
    if (!binding.active) {
      if (mode !== 'transactional' || executor === null) throw new ShopEntryNeedsAuthState();
      const state = `synthetic-state-${++serial}`;
      (executor as unknown as FakeTrx).writes.push(state);
      return envelope(30101, { state });
    }
    if (mode === 'transactional') throw new ShopEntryNeedsConvert();
    return envelope(0, { jump: 'synthetic' });
  };
}

describe('shop entry idempotency modes (B1-06zg r2)', () => {
  it('[AC-B1-06zg] a bound caller runs in the standard mode only (no transaction around the conversion)', async () => {
    const f = fakeIdempotency();
    const modes: ShopEntryMode[] = [];
    const response = await runShopEntry(f.idempotency, REQUEST, stageOf({ active: true }, modes));
    expect(JSON.parse(response.body)).toMatchObject({ code: 0 });
    expect(f.calls).toEqual(['execute']);
    expect(modes).toEqual(['standard']);
  });

  it('[AC-B1-06zg] an unbound caller issues its state in the transaction that stores the result', async () => {
    const f = fakeIdempotency();
    const modes: ShopEntryMode[] = [];
    const response = await runShopEntry(f.idempotency, REQUEST, stageOf({ active: false }, modes));
    const body = JSON.parse(response.body) as { code: number; data: { state: string } };
    expect(body.code).toBe(30101);
    expect(f.calls).toEqual(['execute', 'executeInTransaction']);
    expect(modes).toEqual(['standard', 'transactional']);
    expect(f.committedStates).toEqual([body.data.state]);
  });

  it('[AC-B1-06zg] a first attempt lost before commit leaves no state; the same key then answers one state', async () => {
    const f = fakeIdempotency();
    const stage = stageOf({ active: false }, []);
    f.loseNextCommit();
    await expect(runShopEntry(f.idempotency, REQUEST, stage)).rejects.toThrow(
      'synthetic: connection lost before commit',
    );
    expect(f.committedStates).toEqual([]);
    const second = await runShopEntry(f.idempotency, REQUEST, stage);
    const third = await runShopEntry(f.idempotency, REQUEST, stage);
    expect(third.body).toBe(second.body);
    expect(third.source).toBe('replay');
    const state = (JSON.parse(second.body) as { data: { state: string } }).data.state;
    expect(f.committedStates).toEqual([state]);
  });

  it('[AC-B1-06zg] a binding that turned active rolls the transaction back and converts in the standard mode', async () => {
    const f = fakeIdempotency();
    const binding = { active: false };
    const modes: ShopEntryMode[] = [];
    const inner = stageOf(binding, modes);
    const response = await runShopEntry(f.idempotency, REQUEST, async (executor, mode) => {
      if (mode === 'transactional') binding.active = true;
      return inner(executor, mode);
    });
    expect(JSON.parse(response.body)).toMatchObject({ code: 0 });
    expect(modes).toEqual(['standard', 'transactional', 'final']);
    expect(f.committedStates).toEqual([]);
  });

  it('[AC-B1-06zg] any other error of an attempt is rethrown unchanged', async () => {
    const f = fakeIdempotency();
    const boom = new Error('synthetic: other failure');
    await expect(runShopEntry(f.idempotency, REQUEST, () => Promise.reject(boom))).rejects.toBe(
      boom,
    );
    expect(f.calls).toEqual(['execute']);
  });
});

it('[AC-B1-04zzzzn] 进店把站长授权检查用的那个账号传给签发（签发不再自选账号）', async () => {
  issued.reads.binding.mockResolvedValue({ status: 'unbound', accountId: null });
  issued.reads.authAccountId.mockResolvedValue('synthetic-account-b');
  issued.reads.siteAuthAvailable.mockResolvedValue(true);
  issued.issue.mockResolvedValue({
    kind: 'refused',
    code: 30101,
    data: { state: 'synthetic-state' },
  });
  const settings: Record<string, unknown> = {
    'shop.entry.enabled.taobao': true,
    'shop.entry.source.taobao': 'synthetic-source',
    'convert.enabled.taobao': true,
  };
  const f = fakeIdempotency();
  const options = {
    db: {},
    clock: {},
    callerContext: {
      current: async () => ({
        appId: 'synthetic-app',
        userId: 'synthetic-user',
        deviceId: 'synthetic-device',
      }),
    },
    config: {
      configValue: async (_appId: string, key: string) =>
        key in settings ? { value: settings[key], version: 1 } : null,
    },
    pids: {},
    registry: { get: () => ({ shopConvertSources: ['synthetic-source'] }) },
    shops: {},
    cache: {},
    idempotency: f.idempotency,
    logger: { warn: () => undefined },
    appEnv: 'dev',
    authApps: {},
  } as unknown as ShopOpenOptions;
  const out = await createShopOpen(options).open({
    productKey: 'synthetic-key',
    body: { platform: 'taobao' } as never,
    idempotencyKey: 'synthetic-shop-open-key',
    traceId: 'synthetic-trace',
    client: 'ios' as never,
  });
  expect(out.envelope.code).toBe(30101);
  expect(issued.reads.siteAuthAvailable).toHaveBeenCalledWith(
    'synthetic-app',
    'taobao',
    'synthetic-account-b',
  );
  expect(issued.issue).toHaveBeenCalledTimes(1);
  expect(issued.issue.mock.calls[0]?.[2]).toMatchObject({
    accountId: 'synthetic-account-b',
    linkId: null,
  });
  // The account is selected once per attempt; the issuance never looks it up again.
  expect(issued.reads.authAccountId).toHaveBeenCalledTimes(2);
});
