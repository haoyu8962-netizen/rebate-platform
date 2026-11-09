import type { BridgeMethods } from '@couli/bridge-sdk';
import type { ApiData } from '../../../../shared/api/index.ts';

// 订单找回页的类型与少量常量（页面块）。启动配置解析在 config.ts，提交结果在 submit.ts，
// 记录显示与定位在 records-model.ts，日期在 dates.ts：按用途各自成块，每块连同依赖守住路由块体积上限。

export type ClaimListData = ApiData<'GET', '/v1/orders/claims'>;
export type Claim = ClaimListData['items'][number];
export type ClaimItem = Claim['items'][number];
/** 找回页可选的平台（画板三平台）；记录里的平台是契约 PlatformCode。 */
export type ClaimPlatform = 'taobao' | 'jd' | 'pdd';
export type RecordPlatform = Claim['platform'];
export type HelpTarget = BridgeMethods['nav.open']['params'];

/** getConfig 取的顶层键（/v1/config 的子集）。 */
export const CONFIG_KEYS = ['features', 'claim', 'help_links'];

/** 本页用到的配置：开放平台、找回期限天数、按平台的指引链接。 */
export interface ClaimConfig {
  platforms: ClaimPlatform[];
  windowDays: number | null;
  guides: Partial<Record<ClaimPlatform, HelpTarget>>;
}

// ---- 查询键、定位目标与当天置灰的数据形状 ----

/** 找回记录的查询键；提交成功或 30205 后让它失效，切回记录页签时重取（账号切换由壳层清空整份缓存）。 */
export const RECORDS_KEY = ['orders', 'claims'] as const;

/** 要定位的申请：提交成功按 claim_id；30205（契约不带 data）按平台与订单号。 */
export type LocateTarget = { claimId: string } | { platform: ClaimPlatform; orderNo: string };

/** 当天置灰的记录：上海日期与按钮上方的提示（不含次数）。 */
export interface DailyBlock {
  day: string;
  message: string;
}
