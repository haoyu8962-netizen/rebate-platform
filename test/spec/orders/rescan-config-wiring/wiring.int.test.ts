// 规则测试（B1-04zzz，FU-RESCAN-CONFIG-WIRING，D10-845；claude-independent，SPEC_REF 7666a46）：
// 本单只钉 window_minutes 的登记上限。order_sync.rescan.taobao.window_minutes 在 config-registry 登记为
// 整数 1～180（B1-04zzzt）；超过 180 的值与其它非法值一样，按默认（天档 180 分钟、小时档 20 分钟）并只带
// key 告警一次。其余生产装配用例（默认、promo_mode、每轮重读、范围内取值、其它非法值、三档开关、别的 App）
// 见 ../rescan-config-wiring-main/（B1-04zzzu，D10-903 (A) / D10-927）。
// 夹具一律取自 ../rescan-config-wiring-main/kit.ts：回扫配置端口取自真实组合根（AppModule.forEntry 的
// worker 入口交给 OrdersModule.forWorker 的 rescanConfig），库是真 PostgreSQL（couli_app，每例一库），
// 行写进 app.config_items 的 ORDER_SYNC_APP_ID（'couli'）；联盟侧是替身，时间只读注入的 FixedClock。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS,
  WINDOW_MINUTES,
  installCaseDatabase,
  scene,
} from '../rescan-config-wiring-main/kit.ts';

installCaseDatabase(createTestDatabase);

it.each([
  { label: '181', value: 181 },
  { label: '240', value: 240 },
  { label: '1440', value: 1440 },
])(
  '[AC-B1-04zzz#1][D10-845] window_minutes 超过登记上限 180（$label）：下一轮天档按默认 180 分钟、小时档 20 分钟，并只带 key 告警一次',
  async ({ value }) => {
    const s = await scene();
    await s.set(WINDOW_MINUTES, value);
    const round = await s.round();
    expect(round.minutes).toEqual(DEFAULT_WINDOWS);
    expect(round.warned(WINDOW_MINUTES)).toBe(1);
  },
);
