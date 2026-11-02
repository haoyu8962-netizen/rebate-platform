// B1-02zq §9 #2: data of 10010 (contracts/error-codes.yaml) on every operation that answers it:
// one method by priority, providers only for oauth, fail_limit unless manual, nothing else; manual
// once today's failures reach the limit; and the same conclusion as GET /v1/me/reverify. Answering
// never changes the account (no failure place is reserved by a refusal).
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FAIL_LIMIT,
  MIDNIGHT,
  YESTERDAY,
  closeKit,
  openKit,
  statusOf,
  type Kit,
  type Trusted,
} from '../reverify/kit.ts';
import {
  ID_NUMBER,
  MANUAL,
  SURFACES,
  WITHDRAW,
  gates,
  oauth,
  refused,
  sameConclusion,
  type PendingData,
  type Surface,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

interface Trust {
  readonly case: string;
  readonly trusted: Trusted;
  readonly failures: number;
  readonly data: PendingData;
}

const TRUSTS: readonly Trust[] = [
  {
    case: '含实名 → id_number，不带 providers',
    trusted: { realname: true, providers: [] },
    failures: 0,
    data: ID_NUMBER,
  },
  {
    case: '含实名和第三方 → 只给 id_number',
    trusted: { realname: true, providers: ['wechat'] },
    failures: 0,
    data: ID_NUMBER,
  },
  {
    case: '只含第三方 → oauth，带 providers 和 fail_limit',
    trusted: { realname: false, providers: ['wechat'] },
    failures: 0,
    data: oauth(['wechat']),
  },
  {
    case: '都没有 → manual，不带 providers 和 fail_limit',
    trusted: { realname: false, providers: [] },
    failures: 0,
    data: MANUAL,
  },
  {
    case: '含实名、当天失败到上限 → manual',
    trusted: { realname: true, providers: [] },
    failures: FAIL_LIMIT,
    data: MANUAL,
  },
  {
    case: '只含第三方、当天失败到上限 → manual',
    trusted: { realname: false, providers: ['wechat'] },
    failures: FAIL_LIMIT,
    data: MANUAL,
  },
  {
    case: '含实名、当天失败未到上限 → 仍是 id_number',
    trusted: { realname: true, providers: [] },
    failures: FAIL_LIMIT - 1,
    data: ID_NUMBER,
  },
];

// A first real name has no completed real name to freeze.
const CASES = SURFACES.flatMap((surface: Surface) =>
  TRUSTS.filter((trust) => !(surface.first && trust.trusted.realname)).map((trust) => ({
    name: surface.name,
    surface,
    ...trust,
  })),
);

it.each(CASES)(
  '[AC-B1-02zq#13] $name：可信身份$case，与 GET /v1/me/reverify 结论一致，账号不变',
  async ({ surface, trusted, failures, data }) => {
    const f = await gates(kit);
    const m = await f.member(surface.member);
    await f.flag(m.uid, trusted);
    if (failures > 0) await f.failures(m.uid, failures);
    const before = await f.state(m.uid);
    refused(kit, surface.path, surface.verb, await surface.submit(f.on(m)), data);
    sameConclusion(statusOf(kit, await f.client(m.uid, m.device).status()), data);
    expect(await f.state(m.uid)).toEqual(before);
    expect(await f.devices(m.uid)).toEqual([]);
  },
);

it('[AC-B1-02zq#14] 打标后才绑定的第三方身份不进 providers，data 只按固定的可信身份给', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.bind(m.uid, 'wechat');
  await f.bind(m.uid, 'apple');
  await f.flag(m.uid, { realname: false, providers: ['wechat'] });
  refused(kit, WITHDRAW, 'post', await f.on(m).withdraw(), oauth(['wechat']));
});

it('[AC-B1-02zq#15] 打标后才完成的实名不算：账号已实名，可信身份没有 → manual', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: false, providers: [] });
  refused(kit, WITHDRAW, 'post', await f.on(m).withdraw(), MANUAL);
});

it('[AC-B1-02zq#16] 前一天的失败不算：昨天满额 → id_number；今天满额 → manual，+08:00 次日恢复', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  const c = f.on(m);
  await f.failures(m.uid, FAIL_LIMIT, YESTERDAY);
  refused(kit, WITHDRAW, 'post', await c.withdraw(), ID_NUMBER);
  await f.failures(m.uid, FAIL_LIMIT);
  refused(kit, WITHDRAW, 'post', await c.withdraw(), MANUAL);
  kit.clock.set(MIDNIGHT);
  refused(kit, WITHDRAW, 'post', await c.withdraw(), ID_NUMBER);
});
