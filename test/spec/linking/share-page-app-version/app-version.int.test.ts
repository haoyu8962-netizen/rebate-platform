// CT-26zj (D10-1232 / D10-1246): GET /v1/share-pages/{link_id} and POST
// /v1/share-pages/{link_id}/tpwd may omit X-App-Version when X-Platform=h5 (规划/08 BR-ID-01
// 「最低支持版本拦截」判定：h5、admin 不判版本); the share page in a browser has no app version.
// The three apps without it are answered as on trunk (the request check's 20001 on x-app-version,
// as every other operation); a valid version keeps the old behaviour on every platform.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP_PLATFORMS,
  MISSING,
  UA,
  VERSION,
  harness,
  headersOf,
  pageData,
  refused,
  stable,
  tpwdOf,
  versionMissing,
  type ShareLink,
} from './kit.ts';

const h = harness({ createTestDatabase, acquireTestRedis });

const WITH_VERSION = { 'x-app-version': VERSION } as const;

it('[AC-CT-26zj#1] getSharePage：X-Platform=h5 不带 X-App-Version 照常出页（与带版本号时同一结果，含 30144）；三端 App 不带仍按主干拒绝（400 20001 fields=[x-app-version]），带合法版本号照旧 200', async () => {
  const t = await h.tenant();
  const taobao = await t.taobaoLink();
  const jd = await t.jdLink();

  // h5 without X-App-Version: the same page as with it, in a browser and in WeChat.
  for (const link of [taobao, jd]) {
    for (const ua of [UA.safariIos, UA.wechatIos]) {
      const what = `h5 无版本号 ${link.linkId} ${ua === UA.safariIos ? '浏览器' : '微信'}`;
      const without = await pageData(
        await h.get(link.linkId, headersOf(t.appId, 'h5', { 'user-agent': ua })),
        what,
      );
      expect(without, what).toMatchObject({
        jump_url: link.jumpUrl,
        product_card: { link_id: link.linkId },
      });
      const withVersion = await pageData(
        await h.get(link.linkId, headersOf(t.appId, 'h5', { 'user-agent': ua, ...WITH_VERSION })),
        `${what}（对照：带版本号）`,
      );
      expect(stable(without), what).toEqual(stable(withVersion));
    }
  }
  // Outside WeChat the Taobao page still hands out a ticket without the version.
  const browser = await pageData(
    await h.get(taobao.linkId, headersOf(t.appId, 'h5')),
    'h5 无版本号 淘宝 浏览器票据',
  );
  expect(browser['tpwd_ticket']).toEqual(expect.any(String));

  // The business refusals are unchanged: an unknown link is the same 30144 with or without it.
  const missing = await h.get(MISSING, headersOf(t.appId, 'h5'));
  const missingBody = await refused(missing, 404, 30144, 'h5 无版本号 不存在的 link');
  const control = await h.get(MISSING, headersOf(t.appId, 'h5', WITH_VERSION));
  expect(missingBody).toEqual(await refused(control, 404, 30144, 'h5 带版本号 不存在的 link'));

  // A malformed version is still refused on h5 (omitting is allowed, a wrong value is not).
  const malformed = await h.get(
    taobao.linkId,
    headersOf(t.appId, 'h5', { 'x-app-version': '1.0' }),
  );
  await refused(malformed, 400, 20001, 'h5 版本号不合格式');

  // The three apps: without the version refused as on trunk; with a valid one served as before.
  for (const { platform } of APP_PLATFORMS) {
    for (const link of [taobao, jd]) {
      await versionMissing(
        await h.get(link.linkId, headersOf(t.appId, platform)),
        `${platform} 无版本号 ${link.linkId}`,
      );
      const served = await pageData(
        await h.get(link.linkId, headersOf(t.appId, platform, WITH_VERSION)),
        `${platform} 带版本号 ${link.linkId}`,
      );
      expect(served).toMatchObject({ jump_url: link.jumpUrl });
    }
  }
}, 120_000);

it('[AC-CT-26zj#2] getShareTpwd：X-Platform=h5 不带 X-App-Version 照常换口令（票据规则不变：微信 UA 仍 20001 fields=[ticket]）；三端 App 不带仍按主干拒绝（400 20001 fields=[x-app-version]），带合法版本号照旧换得口令', async () => {
  const t = await h.tenant();
  // At most 5 exchanges per IP × link_id and minute: the h5 cases and each app use their own link.
  const taobao = await t.taobaoLink();
  expect(taobao.tpwd).not.toBeNull();

  async function ticket(link: ShareLink = taobao): Promise<string> {
    const data = await pageData(
      await h.get(link.linkId, headersOf(t.appId, 'h5', WITH_VERSION)),
      '取票据（h5 带版本号）',
    );
    expect(data['tpwd_ticket']).toEqual(expect.any(String));
    return String(data['tpwd_ticket']);
  }

  // h5 without X-App-Version exchanges a ticket issued with or without the version.
  const issued = await ticket();
  expect(
    await tpwdOf(
      await h.tpwd(taobao.linkId, issued, headersOf(t.appId, 'h5')),
      'h5 无版本号 换口令',
    ),
  ).toBe(taobao.tpwd);
  const fromVersionless = await pageData(
    await h.get(taobao.linkId, headersOf(t.appId, 'h5')),
    'h5 无版本号 取票据',
  );
  expect(fromVersionless['tpwd_ticket']).toEqual(expect.any(String));
  const versionlessTicket = String(fromVersionless['tpwd_ticket']);
  expect(
    await tpwdOf(
      await h.tpwd(taobao.linkId, versionlessTicket, headersOf(t.appId, 'h5')),
      'h5 无版本号 用无版本号取得的票据换口令',
    ),
  ).toBe(taobao.tpwd);

  // The ticket rules are unchanged without the version: WeChat UA → 20001 fields=[ticket].
  const wechat = await refused(
    await h.tpwd(
      taobao.linkId,
      await ticket(),
      headersOf(t.appId, 'h5', { 'user-agent': UA.wechatIos }),
    ),
    400,
    20001,
    'h5 无版本号 微信 UA 换口令',
  );
  expect(wechat.data).toEqual({ fields: ['ticket'] });
  expect(JSON.stringify(wechat)).not.toContain(String(taobao.tpwd).replaceAll('￥', ''));

  // A malformed version is still refused on h5.
  await refused(
    await h.tpwd(
      taobao.linkId,
      await ticket(),
      headersOf(t.appId, 'h5', { 'x-app-version': '1.0' }),
    ),
    400,
    20001,
    'h5 版本号不合格式 换口令',
  );

  // The three apps: without the version refused as on trunk; with a valid one served as before.
  for (const { platform } of APP_PLATFORMS) {
    const link = await t.taobaoLink();
    const refusedResponse = await h.tpwd(
      link.linkId,
      await ticket(link),
      headersOf(t.appId, platform),
    );
    await versionMissing(refusedResponse, `${platform} 无版本号 换口令`);
    expect(refusedResponse.payload).not.toContain(String(link.tpwd).replaceAll('￥', ''));
    expect(
      await tpwdOf(
        await h.tpwd(link.linkId, await ticket(link), headersOf(t.appId, platform, WITH_VERSION)),
        `${platform} 带版本号 换口令`,
      ),
    ).toBe(link.tpwd);
  }
}, 120_000);
