import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOW,
  close,
  envelope,
  fixture,
  open,
  seedVerified,
  type Fixture,
  type Kit,
  type Response,
} from './app-kit.ts';
import {
  NAME,
  OTHER_NAME,
  PROVIDER,
  auditLines,
  expectAudit,
  expectCountWarning,
  expectNoLeak,
  listOf,
  residentId,
  stagingApiConfig,
  userId,
  userIds,
  wrongCheckDigit,
} from './kit.ts';

/** The listed user_ids of the staging node (D10-2636 ②: test accounts only). */
const [HIT, CHECKS, NO_CONSENT] = userIds(3) as [string, string, string];
const LISTED = [HIT, CHECKS, NO_CONSENT];

let database: TestDatabase;
let server: TestRedis;
let staged: Readonly<Record<string, unknown>>;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  // What the real api entry reads on a staging node with the list (bootstrap.ts: loadConfig(env,
  // 'api')); the member-side verifier is assembled from this result, not from a hand-made list.
  staged = stagingApiConfig(LISTED) as unknown as Readonly<Record<string, unknown>>;
  kit = await open(database, server, staged);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await server?.stop();
    } finally {
      await database?.drop();
    }
  }
});

interface Answer {
  readonly status: number;
  readonly code: number;
  readonly data: unknown;
}

/** What a submission answered, without the trace id: status, code and data. */
async function answer(f: Fixture, body: unknown, responses: Response[]): Promise<Answer> {
  const response = await f.submit(body);
  responses.push(response);
  const { code, data } = response.json<{ code: number; data?: unknown }>();
  envelope(kit, response, code);
  return { status: response.statusCode, code, data: data ?? null };
}

it('[AC-B1-13n#3] staging 装配下会员实名提交：名单内 user_id 走完前置校验后判一致，实名记录 provider 为 staging-test-identity，写一条审计（app_id / user_id / provider）；启用时 warn 只带个数；名单外照旧 50301 不计次；名单内用户的同意、格式、校验位、年龄线、占用（30405）结果与名单外完全相同；姓名与证件号不进日志、审计与响应', async () => {
  const responses: Response[] = [];
  const hitId = residentId('1990-01-01', '011');
  const hit = await fixture(kit, HIT);
  const appId = hit.appId;

  // 1. The api entry's loadConfig kept the list it was given, and that list was assembled.
  expect(staged['appEnv']).toBe('staging');
  expect([...(listOf(staged) ?? [])].sort()).toEqual([...LISTED].sort());

  // A listed user_id: verified under the staging test identity, one audit line.
  const verified = await hit.submit({ name: NAME, id_no: hitId });
  responses.push(verified);
  const data = envelope(kit, verified, 0).data;
  expect(data).toEqual({ realname_status: 'verified', masked_name: expect.any(String) });
  expect(data?.['masked_name']).not.toBe(NAME);
  const rows = await hit.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: 'verified',
    provider: PROVIDER,
    verified_at: new Date(NOW),
  });
  expect(auditLines(kit.lines)).toHaveLength(1);
  expectAudit(auditLines(kit.lines)[0], appId, HIT);

  // Enabled at startup: a warn with the count only.
  expectCountWarning(kit.startup, LISTED.length);
  expectNoLeak(kit.startup.join('\n'), LISTED);

  // 2. A user_id outside the list: 50301 as before, never counted (no 30410), nothing stored.
  const outsider = await fixture(kit, userId(), { appId });
  for (let i = 0; i < 4; i++) {
    const refused = await answer(
      outsider,
      { name: NAME, id_no: residentId('1993-04-05', '021') },
      responses,
    );
    expect(refused.code).toBe(50301);
  }
  expect(await outsider.rows()).toEqual([]);

  // 3. The checks before the verifier are not relaxed: listed and unlisted answer alike.
  const owner = await fixture(kit, userId(), { appId });
  const occupied = residentId('1985-05-05', '031');
  await seedVerified(kit, owner, OTHER_NAME, occupied, '1985-05-05');
  const listedChecks = await fixture(kit, CHECKS, { appId });
  const unlistedChecks = await fixture(kit, userId(), { appId });
  const bodies = [
    { name: NAME, id_no: 'bad' },
    { name: NAME, id_no: wrongCheckDigit(residentId('1991-02-03', '041')) },
    { name: NAME, id_no: residentId('2020-01-01', '051') },
    { name: NAME, id_no: occupied },
  ];
  const listedSeen: Answer[] = [];
  const unlistedSeen: Answer[] = [];
  for (const body of bodies) listedSeen.push(await answer(listedChecks, body, responses));
  for (const body of bodies) unlistedSeen.push(await answer(unlistedChecks, body, responses));
  expect(listedSeen.map((seen) => seen.code)).toEqual([20001, 20001, 30407, 30405]);
  expect(listedSeen).toEqual(unlistedSeen);
  expect(await listedChecks.rows()).toEqual([]);
  expect(await unlistedChecks.rows()).toEqual([]);

  const listedNoConsent = await fixture(kit, NO_CONSENT, { appId, consent: false });
  const unlistedNoConsent = await fixture(kit, userId(), { appId, consent: false });
  const freeId = residentId('1994-06-07', '061');
  for (const f of [listedNoConsent, unlistedNoConsent]) {
    const refused = await answer(f, { name: NAME, id_no: freeId }, responses);
    expect(refused).toMatchObject({ code: 10004, data: { consent_type: 'id_verification' } });
    expect(await f.rows()).toEqual([]);
  }
  expect(auditLines(kit.lines)).toHaveLength(1);

  // The listed user still gets the test identity once the submission passes every check; the
  // unlisted one still gets 50301.
  const later = residentId('1992-03-04', '071');
  const listedLater = await answer(listedChecks, { name: OTHER_NAME, id_no: later }, responses);
  expect(listedLater.code).toBe(0);
  const listedRows = await listedChecks.rows();
  expect(listedRows[0]).toMatchObject({ status: 'verified', provider: PROVIDER });
  const otherLater = residentId('1992-03-04', '081');
  const unlistedLater = await answer(
    unlistedChecks,
    { name: OTHER_NAME, id_no: otherLater },
    responses,
  );
  expect(unlistedLater.code).toBe(50301);
  expect(await unlistedChecks.rows()).toEqual([]);

  const audits = auditLines(kit.lines);
  expect(audits).toHaveLength(2);
  expectAudit(audits[1], appId, CHECKS);

  // 4. Neither the names nor any submitted ID number in logs, audit lines or responses.
  const text = kit.lines.join('\n') + responses.map((response) => response.body).join('\n');
  expectNoLeak(text, [
    NAME,
    OTHER_NAME,
    hitId,
    occupied,
    later,
    otherLater,
    freeId,
    residentId('1993-04-05', '021'),
    residentId('2020-01-01', '051'),
    wrongCheckDigit(residentId('1991-02-03', '041')),
  ]);
});
