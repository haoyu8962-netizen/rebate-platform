import type { ClaimConfig, ClaimPlatform, HelpTarget } from './model.ts';

// 启动配置（app.getConfig 的 values）解析。单独成块、不依赖页面块：进页取配置时与取配置并行加载。

/** 找回页的平台顺序（画板 FindOrder-v2：淘宝、京东、拼多多）。 */
export const CLAIM_PLATFORMS: readonly ClaimPlatform[] = ['taobao', 'jd', 'pdd'];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 解析 app.getConfig 的 values。平台按 features.platform_status：not_launched、maintenance 不显示；
 * window_days 不是正整数（含 null）时期限句整句隐藏，不猜默认值；指引链接只认 {route, params} 对象，原样交给 nav.open。
 */
export function parseClaimConfig(values: unknown): ClaimConfig {
  const root = record(values) ?? {};
  const status = record(record(root['features'])?.['platform_status']) ?? {};
  const platforms = CLAIM_PLATFORMS.filter((platform) => {
    const value = status[platform];
    return value !== 'not_launched' && value !== 'maintenance';
  });
  const days = record(root['claim'])?.['window_days'];
  const windowDays = typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : null;
  const links = record(root['help_links']) ?? {};
  const guides: Partial<Record<ClaimPlatform, HelpTarget>> = {};
  for (const platform of CLAIM_PLATFORMS) {
    const link = record(links[`claim_guide.${platform}`]);
    if (link !== null && typeof link['route'] === 'string' && link['route'] !== '') {
      guides[platform] = link as unknown as HelpTarget;
    }
  }
  return { platforms, windowDays, guides };
}
