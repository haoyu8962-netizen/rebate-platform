import { expect, it } from 'vitest';
import {
  ENTRIES,
  asset,
  envFiles,
  list,
  noInlineCredentials,
  record,
  services,
  sourceLines,
} from '../staging/kit.ts';

// AC-B1-04zzd labels refer only to this task's brief (refs is empty; approvals #43, D10-597 ④).
// Same shape as the Jingdong mount (B1-04zf): the four entries that assemble UnionModule.
const UNION_ENTRIES = ['admin', 'api', 'stream', 'worker'] as const;

/** Any spelling counts, so a short-syntax or mistargeted mount cannot hide from the checks. */
function taobaoMounts(service: Record<string, unknown>): unknown[] {
  return list(service['volumes'] ?? []).filter((volume) =>
    JSON.stringify(volume).includes('couli-taobao'),
  );
}

it.each(UNION_ENTRIES)(
  '[AC-B1-04zzd#1] %s 有且只有一个只读、可缺的节点淘宝目录挂载，bind 使用块状长语法',
  (entry) => {
    const mounts = taobaoMounts(record(services()[entry]));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toEqual({
      type: 'bind',
      source: '/etc/couli-taobao',
      target: '/run/couli-taobao',
      read_only: true,
      bind: { create_host_path: true },
    });
    expect(asset('infra/staging/compose.yaml')).not.toMatch(/\bbind:\s*\{/);
  },
);

it('[AC-B1-04zzd#2] 淘宝目录只给装配联盟模块的四个入口（payout 不挂），compose 不注入 TAOBAO_ 变量、env_file 不变，deploy.sh 不检查也不提这个目录', () => {
  const all = services();
  const recipients = Object.keys(all).filter((name) => taobaoMounts(record(all[name])).length > 0);
  expect(recipients.sort()).toEqual([...UNION_ENTRIES]);
  expect(taobaoMounts(record(all['payout']))).toEqual([]);
  for (const name of ENTRIES) {
    const file = name === 'payout' ? 'staging-payout.env' : 'staging.env';
    expect(envFiles(record(all[name])['env_file'])).toEqual([`/etc/couli/${file}`]);
  }
  const compose = asset('infra/staging/compose.yaml');
  // Values come only from staging.env; comments may name the variables, configuration may not.
  expect(sourceLines(compose).join('\n')).not.toMatch(/\bTAOBAO_[A-Z]/);
  noInlineCredentials(compose);
  // The optional mount must not add a required node path to the deployment preflight.
  const deploy = sourceLines(asset('infra/staging/deploy.sh')).join('\n');
  expect(deploy).not.toMatch(/couli-taobao|\bTAOBAO_[A-Z]/);
});
