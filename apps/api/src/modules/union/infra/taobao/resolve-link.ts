// B1-04zzzzk（D10-2674 ②）：淘宝 resolveLink 首段只认的一种链接形态——淘宝 / 天猫商品页
// https://item.taobao.com/item.htm?id=<数字> 与 https://detail.tmall.com/item.htm?id=<数字>。
// 主机按 B1-07d 规范化（小写、去掉末尾一个「.」）后须恰为这两个之一；只认 https、不带用户信息、
// 不写端口、路径恰为 /item.htm、查询参数 id 只出现一次且为 1–20 位纯数字。其余一律不认（返回 null），
// 由调用方照旧抛 adapter_unimplemented。推广链、淘口令、m.tb.cn 与手机页不在本段（D10-2683）。
// 纯函数：不读时钟、不联网。

const ITEM_HOSTS: ReadonlySet<string> = new Set(['item.taobao.com', 'detail.tmall.com']);
const ITEM_PATH = '/item.htm';
const ITEM_ID = /^[0-9]{1,20}$/;

/** 商品页链接 → 链接里的数字商品 id；不是本段认的形态 → null。 */
export function parseTaobaoItemLink(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  const host = url.hostname.toLowerCase();
  const normalized = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!ITEM_HOSTS.has(normalized)) return null;
  if (url.pathname !== ITEM_PATH) return null;
  const ids = url.searchParams.getAll('id');
  if (ids.length !== 1) return null;
  const id = ids[0]!;
  return ITEM_ID.test(id) ? id : null;
}
