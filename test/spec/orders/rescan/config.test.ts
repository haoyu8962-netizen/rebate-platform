// B1-04zm: order_sync.rescan.<platform>.enabled / .days, read through the scheduling round.
import { expect, it } from 'vitest';
import { scheduleOrderRescan } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import { PLATFORM_RULES } from '../../../../apps/api/src/modules/orders/domain/platform-rules/index.ts';
import { rescanDefaults } from '../../../../apps/api/src/modules/orders/domain/platform-rules/rescan.ts';
import type { RegisteredPlatform } from '../../../../apps/api/src/modules/union/index.ts';
import {
  JD_DAYS,
  JD_ENABLED,
  PDD_ACCOUNT,
  PDD_ENABLED,
  TAOBAO_ACCOUNT,
  account,
  fixture,
  mentioning,
  pddAccount,
  pddStream,
  rescanWindow,
  roundStart,
} from './kit.ts';

it('[AC-B1-04zm#7] 键未设时 jd 开、回扫 30 天，开关与天数都按平台的键读', async () => {
  const f = fixture();
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.config.get).toHaveBeenCalledWith(JD_ENABLED);
  expect(f.config.get).toHaveBeenCalledWith(JD_DAYS);
  expect(f.sent()).toEqual([rescanWindow(roundStart(30))]);
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#8] 键未设时 pdd 关：不读游标、不发窗口', async () => {
  const f = fixture({ accounts: [pddAccount] });
  await scheduleOrderRescan(f.ruleTableCaps, ['pdd']);
  expect(f.config.get).toHaveBeenCalledWith(PDD_ENABLED);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B1-04zm#9] pdd 打开后默认回扫 90 天，窗口长度取规则表的 syncWindowCapMs', async () => {
  const f = fixture({ accounts: [pddAccount], config: { [PDD_ENABLED]: true } });
  await scheduleOrderRescan(f.ruleTableCaps, ['pdd']);
  const cap = PLATFORM_RULES.pdd.syncWindowCapMs!;
  expect(f.sent()).toEqual([rescanWindow(roundStart(90), cap, pddStream)]);
});

it('[AC-B1-04zm#10] jd 开关显式关闭后不回扫', async () => {
  const f = fixture({ config: { [JD_ENABLED]: false } });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it.each([1, 45, 90])('[AC-B1-04zm#11] days=%d 在 1～90 内：按配置起算，不告警', async (days) => {
  const f = fixture({ config: { [JD_DAYS]: days } });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(f.sent()).toEqual([rescanWindow(roundStart(days))]);
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, 91, '45', 'abc'])(
  '[AC-B1-04zm#12] days=%j 不合法：回默认 30 天，warn 一次且只含键名',
  async (days) => {
    const f = fixture({ config: { [JD_DAYS]: days } });
    await scheduleOrderRescan(f.scheduler, ['jd']);
    expect(f.sent()).toEqual([rescanWindow(roundStart(30))]);
    expect(f.logger.warn.mock.calls).toHaveLength(1);
    expect(f.logger.warn.mock.calls[0]?.[0]).toEqual({ key: JD_DAYS });
  },
);

it('[AC-B1-04zm#13] 同平台多个账号一轮只告警一次', async () => {
  const f = fixture({
    accounts: [account, { ...account, app_id: 'other-app' }],
    config: { [JD_DAYS]: 91 },
  });
  await scheduleOrderRescan(f.scheduler, ['jd']);
  expect(mentioning(f.logger.warn, JD_DAYS)).toHaveLength(1);
});

it.each([JD_ENABLED, JD_DAYS])(
  '[AC-B1-04zm#14] 读 %s 失败：本轮跳过该平台并 warn，不当默认值',
  async (key) => {
    const f = fixture();
    f.config.get.mockImplementation(async (asked) => {
      if (asked === key) throw new Error('synthetic config outage');
      return undefined;
    });
    await expect(scheduleOrderRescan(f.scheduler, ['jd'])).resolves.toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalled();
  },
);

it('[AC-B1-04zm#15] 一个平台读配置失败不影响另一个平台', async () => {
  const f = fixture({ accounts: [account, pddAccount] });
  f.config.get.mockImplementation(async (asked) => {
    if (asked === JD_ENABLED) throw new Error('synthetic config outage');
    return asked === PDD_ENABLED ? true : undefined;
  });
  await scheduleOrderRescan(f.ruleTableCaps, ['jd', 'pdd']);
  expect(f.sent()).toHaveLength(1);
  expect(f.sent()[0]).toMatchObject({ platform: 'pdd', union_account_id: PDD_ACCOUNT });
});

it.each(['taobao', 'synthetic-unlisted'])(
  '[AC-B1-04zm#16] %s 就算配了开关和上限也不回扫',
  async (platform) => {
    const code = platform as RegisteredPlatform;
    const f = fixture({
      accounts: [{ ...account, platform: code, union_account_id: TAOBAO_ACCOUNT }],
      config: {
        [`order_sync.rescan.${platform}.enabled`]: true,
        [`order_sync.rescan.${platform}.days`]: 30,
      },
    });
    f.queryableAccount.mockResolvedValue(TAOBAO_ACCOUNT);
    await scheduleOrderRescan({ ...f.scheduler, capsMs: { [code]: 3_600_000 } }, [code]);
    // B1-04zzo：收紧为单态（B1-04zzb 已合并）
    if (platform === 'taobao') {
      expect(PLATFORM_RULES.taobao.syncWindowCapMs).toBe(20 * 60_000);
      expect(rescanDefaults('taobao')).toEqual({ enabled: true, days: 30 });
      expect(f.read).toHaveBeenCalled();
      expect(f.sent()).toHaveLength(1);
      expect(f.sent()[0]).toMatchObject({ platform: 'taobao', union_account_id: TAOBAO_ACCOUNT });
    } else {
      expect(f.read).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    }
  },
);
