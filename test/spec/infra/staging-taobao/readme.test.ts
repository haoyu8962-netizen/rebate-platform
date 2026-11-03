import { expect, it } from 'vitest';
import { asset, noInlineCredentials } from '../staging/kit.ts';

// AC-B1-04zzd labels refer only to this task's brief (refs is empty; approvals #43, D10-597 ④).

/**
 * The lines of the first README section whose heading satisfies `matches`, heading included, up to
 * the next heading of the same or a higher level; a shell comment inside a code fence is not a
 * heading. Empty when no heading matches.
 */
function sectionLines(matches: (title: string) => boolean): string[] {
  let fenced = false;
  let depth = 0;
  const kept: string[] = [];
  for (const line of asset('infra/staging/README.md').split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      if (depth > 0 && level <= depth) break;
      if (depth === 0 && matches(heading[2] ?? '')) depth = level;
    }
    if (depth > 0) kept.push(line);
  }
  return kept;
}

/** Section 1.10's title: numbered 1.10 and naming both 淘宝 and live. */
function isSection10(title: string): boolean {
  return /^1\.10(?!\d)/.test(title) && title.includes('淘宝') && title.includes('live');
}

/** The new section 1.10; asserts it exists. */
function section(): string {
  const kept = sectionLines(isSection10);
  expect(kept.length, 'README needs section 1.10 on Taobao going live').toBeGreaterThan(0);
  return kept.join('\n');
}

/** Sentences of the section: split on line breaks and the Chinese full stop. */
function sentences(text: string): string[] {
  return text.split(/[。\n]/);
}

/** One line names both TAOBAO_APP_* variables and says they are set together or not at all. */
function statesTogether(line: string): boolean {
  return (
    /TAOBAO_APP_KEY(?!_)/.test(line) &&
    line.includes('TAOBAO_APP_SECRET_FILE') &&
    /要么都设[^\n]{0,3}要么都不设/.test(line)
  );
}

const SECRET_FILES = [
  '/etc/couli-taobao/app_secret',
  '/etc/couli-jd/app_secret',
  '/etc/couli-pdd/client_secret',
];

const COMPARE_KEY = 'rebate.taobao.compare_rate_ratio_bp';
const QUOTER_KEYS = ['tech_fee_bp', COMPARE_KEY, 'commission.platforms'];

/** A sentence naming a quoter key that says it is configured first, or on staging. */
function configuredAhead(sentence: string): boolean {
  const named = sentence.includes('tech_fee_bp') || sentence.includes(COMPARE_KEY);
  return named && /先|staging/.test(sentence);
}

it('[AC-B1-04zzd#3] 1.10 是第 1 节的三级小节，排在 1.9 之后、第 2 节之前', () => {
  const heading = section().split('\n')[0] ?? '';
  expect(heading).toMatch(/^### 1\.10\s/);
  const readme = asset('infra/staging/README.md');
  const at = readme.indexOf(`${heading}\n`);
  expect(readme.indexOf('\n### 1.9 ')).toBeGreaterThanOrEqual(0);
  expect(at).toBeGreaterThan(readme.indexOf('\n### 1.9 '));
  expect(at).toBeLessThan(readme.indexOf('\n## 2. '));
});

it('[AC-B1-04zzd#4] 淘宝节点文件 app_secret 只放密钥原文一个值，属主 1000、目录 500、文件 400', () => {
  const text = section();
  expect(text).toContain('/etc/couli-taobao/app_secret');
  expect(text).toMatch(
    /\/etc\/couli-taobao(?!\/app_secret)[^\n]*\b1000\b|chown[^\n]*\b1000\b[^\n]*\/etc\/couli-taobao/,
  );
  expect(text).toMatch(
    /目录[^\n，；|]*\b500\b|chmod\s+0?500\s+(?:[^\n]*\s)?\/etc\/couli-taobao(?![\w/-])/,
  );
  expect(text).toMatch(
    /(?:文件|app_secret)[^\n，；|]*\b400\b|chmod\s+0?400\s+(?:[^\n]*\s)?\/etc\/couli-taobao\/app_secret/,
  );
  expect(text).toContain('只放这一个值');
});

it('[AC-B1-04zzd#5] 三个淘宝变量：APP_KEY 不是密钥，密钥文件变量只写容器内路径，搜索来源三选一且未设即 official，两个 APP_* 同设同不设', () => {
  const text = section();
  expect(text).toContain('staging.env');
  expect(text).toMatch(/TAOBAO_APP_KEY(?!_)[^\n]*不是密钥/);
  expect(text).toMatch(/TAOBAO_APP_SECRET_FILE[^\n]*\/run\/couli-taobao\/app_secret/);
  expect(text).not.toMatch(/TAOBAO_APP_SECRET_FILE[^\n]*\/etc\/couli-taobao/);
  const search = text.split('\n').filter((line) => line.includes('TAOBAO_SEARCH_SOURCE'));
  expect(search.join('\n')).toMatch(/\bofficial\b/);
  expect(search.join('\n')).toMatch(/\bdataoke\b/);
  expect(search.join('\n')).toMatch(/\bofficial_first\b/);
  expect(search.join('\n')).toMatch(/(?:未设|不设|没设)[^。\n]*\bofficial\b/);
  const together = text.split('\n').filter(statesTogether);
  expect(together.length, 'one line states the two TAOBAO_APP_* go together').toBeGreaterThan(0);
});

it('[AC-B1-04zzd#6] 1.10 与整份 README 不含任何密钥值或 env 文件内容', () => {
  const text = section();
  // Placeholders such as TAOBAO_APP_KEY=<值> and a bare `TAOBAO_APP_KEY=` are names, not values.
  expect(text).not.toMatch(/\b(?:TAOBAO|JD|PDD|DATAOKE)_APP_KEY`?[ \t]*=[ \t]*[^\s<`]/);
  expect(text).not.toMatch(/\bPDD_CLIENT_ID`?[ \t]*=[ \t]*[^\s<`]/);
  expect(text).not.toMatch(/\b[0-9a-f]{16,}\b/i);
  expect(text).not.toMatch(/\b\d{5,}\b/);
  noInlineCredentials(asset('infra/staging/README.md'));
});

it('[AC-B1-04zzd#7] 三平台切 live：先放三家密钥文件与三个 live 端点文件（https baseUrl），再设变量，再 deploy.sh <标签>；缺一个端点文件四个入口启动即失败', () => {
  const text = section();
  for (const file of SECRET_FILES) {
    expect(text).toContain(file);
  }
  expect(text).toContain('/etc/couli-pdd/union-endpoints');
  for (const platform of ['jd', 'pdd', 'taobao']) {
    expect(text).toMatch(new RegExp(`\\b${platform}\\.json\\b`));
  }
  expect(text).toMatch(/["']?mode["']?\s*[:=]\s*["']?live\b/);
  expect(text).toContain('baseUrl');
  expect(text).toMatch(/live[^。\n]*https|https[^。\n]*live/);
  expect(text).toContain('deploy.sh <标签>');
  // The order as one sentence: files first, then the variables, then the deployment.
  expect(text).toMatch(
    /先[^。\n]*(?:密钥|端点)[^。\n]*(?:再|然后|→)[^。\n]*(?:变量|staging\.env)[^。\n]*(?:再|然后|最后|→)[^。\n]*deploy\.sh/,
  );
  expect(text).toMatch(
    /缺[^。\n]*(?:一个|任何一个|任一)[^。\n]*(?:admin[^。\n]*api[^。\n]*stream[^。\n]*worker|四个入口)[^。\n]*启动(?:即|就)?失败/,
  );
});

it('[AC-B1-04zzd#8] live 下真实返利报价器要的配置键先在 staging 配好，否则报价失败', () => {
  const text = section();
  for (const key of QUOTER_KEYS) {
    expect(text).toContain(key);
  }
  expect(text).toMatch(/报价[^。\n]*失败/);
  // A table row per key is fine; some sentence naming a key says it is set first / on staging.
  const ahead = sentences(text).filter(configuredAhead);
  expect(ahead.length, 'the keys are configured on staging first').toBeGreaterThan(0);
  const seeded = sentences(text).filter(
    (sentence) => sentence.includes('commission.platforms') && sentence.includes('种子'),
  );
  expect(seeded.length, 'commission.platforms is already in the seed').toBeGreaterThan(0);
});

it('[AC-B1-04zzd#9] 1.10 注明 1.5 的「pdd 切 live blocked on B2-03」已由 B2-03d / B2-03n 解除', () => {
  const text = section();
  const note = sentences(text).find(
    (sentence) =>
      sentence.includes('1.5') &&
      sentence.includes('B2-03d') &&
      sentence.includes('B2-03n') &&
      sentence.includes('解除'),
  );
  expect(note, 'one sentence names 1.5, B2-03d, B2-03n and 解除').toBeDefined();
  expect(note).toMatch(/blocked on/);
});

// The two sections as they stand before this task; the frozen B1-04y / B1-04zf tests read them
// section by section, so neither may gain a live switch or any line of the new wiring.
const FROZEN_1_5 = [
  '### 1.5 拼多多（准备，不切 live）',
  '',
  '本节只做接线准备，不切 live：**pdd 切 live 暂不可用 — blocked on 真实返利报价器（B2-03）**。api 入口只要有一个联盟端点是 live，就按 live 装配，而演示返利报价器在 live 下拒绝启动（资金安全设计），真实报价器由 B2-03 提供。所以下面三个端点文件现在都保持 demo，pdd.json 也不例外；本节不提供切换步骤。',
  '',
  'compose 给 admin、api、stream 与 worker（装配联盟模块的四个入口）只读挂载节点目录 `/etc/couli-pdd`（容器内 `/run/couli-pdd`）。这个挂载可缺：节点没有该目录时部署照常进行，`deploy.sh` 也不检查它。',
  '',
  '节点文件由负责人放入（容器以 uid 1000 运行）：',
  '',
  '| 节点路径 | 内容 | 属主与权限 |',
  '| --- | --- | --- |',
  '| `/etc/couli-pdd/` | 目录 | 属主 1000，目录 500 |',
  '| `/etc/couli-pdd/client_secret` | 拼多多开放平台应用的密钥原文，文件里只放这一个值 | 属主 1000，文件 400 |',
  '| `/etc/couli-pdd/union-endpoints/` | 子目录，放三平台端点文件 | 属主 1000，目录 500 |',
  '| `/etc/couli-pdd/union-endpoints/jd.json`、`pdd.json`、`taobao.json` | 三个端点文件，现在都是 demo，与镜像内 `config/union-endpoints/` 相同 | 属主 1000，文件 400 |',
  '',
  '密钥内容不得出现在命令行里（会进 shell 历史和进程列表），也不得放进环境变量或 `staging.env`；用编辑器打开文件粘贴后保存，不要用 `echo` / `printf` 写入密钥。准备步骤（root 执行）：',
  '',
  '```sh',
  'install -d -m 700 /etc/couli-pdd /etc/couli-pdd/union-endpoints',
  'vi /etc/couli-pdd/client_secret',
  'for platform in jd pdd taobao; do',
  '  printf \'{"platform":"%s","mode":"demo","baseUrl":null,"quotaKey":"account:%s"}\\n\' \\',
  '    "$platform" "$platform" > "/etc/couli-pdd/union-endpoints/$platform.json"',
  'done',
  'chown -R 1000:1000 /etc/couli-pdd',
  'chmod 400 /etc/couli-pdd/client_secret /etc/couli-pdd/union-endpoints/*.json',
  'chmod 500 /etc/couli-pdd/union-endpoints /etc/couli-pdd',
  '```',
  '',
  '先放好上面的文件，再在 `/etc/couli/staging.env` 设下面四个变量（顺序不能反：设了 UNION_ENDPOINT_OVERRIDE_DIR 而目录缺文件时，admin、api、stream 与 worker 启动即失败，不会退回镜像内的端点）：',
  '',
  '| 变量 | 取值 |',
  '| --- | --- |',
  '| `PDD_CLIENT_ID` | 拼多多开放平台应用的 client_id（不是密钥） |',
  '| `PDD_CLIENT_SECRET_FILE` | `/run/couli-pdd/client_secret`（容器内路径；只写路径，不写密钥内容） |',
  '| `PDD_QUERY_CUSTOM_PARAMETERS` | 商品查询带的 custom_parameters，JSON 对象文本，按 UTF-8 不超过 64 字节 |',
  '| `UNION_ENDPOINT_OVERRIDE_DIR` | `/run/couli-pdd/union-endpoints`（容器内路径；只有 staging 认，必须是绝对路径） |',
  '',
  '`staging.env` 由 api、stream、worker、admin 共用，这四个入口都有这个挂载。其余入口只有 payout：它没有这个挂载，也不装配联盟模块，不读端点目录，所以不受影响。',
  '',
  '拼多多开放平台应用的 IP 白名单只加不删：把 staging 节点的出口 IP 加进去，已有的地址一律保留。',
];

const FROZEN_1_8 = [
  '### 1.8 京东（准备，不切 live）',
  '',
  '本节只做接线准备，不切 live：镜像内和节点上的 `jd.json` 都保持 demo，本节不提供切换步骤。',
  '',
  'compose 给 admin、api、stream 与 worker（装配联盟模块的四个入口）只读挂载节点目录 `/etc/couli-jd`（容器内 `/run/couli-jd`）；payout 不挂。这个挂载可缺：节点没有该目录时部署照常进行，`deploy.sh` 也不检查它。',
  '',
  '节点文件由负责人放入（容器以 uid 1000 运行）：',
  '',
  '| 节点路径 | 内容 | 属主与权限 |',
  '| --- | --- | --- |',
  '| `/etc/couli-jd/` | 目录 | 属主 1000，目录 500 |',
  '| `/etc/couli-jd/app_secret` | 京东联盟应用的密钥原文，文件里只放这一个值 | 属主 1000，文件 400 |',
  '',
  '密钥内容不得出现在命令行里（会进 shell 历史和进程列表），也不得放进环境变量或 `staging.env`；用编辑器打开文件粘贴后保存，不要用 `echo` / `printf` 写入密钥。准备步骤（root 执行）：',
  '',
  '```sh',
  'install -d -m 700 /etc/couli-jd',
  'vi /etc/couli-jd/app_secret',
  'chown -R 1000:1000 /etc/couli-jd',
  'chmod 400 /etc/couli-jd/app_secret',
  'chmod 500 /etc/couli-jd',
  '```',
  '',
  '先放好上面的文件，再在 `/etc/couli/staging.env` 设下面三个变量（值只写在节点上，不进仓库，也不写进本文档）：',
  '',
  '| 变量 | 取值 |',
  '| --- | --- |',
  '| `JD_APP_KEY` | 京东联盟应用的 app key（不是密钥） |',
  '| `JD_APP_SECRET_FILE` | `/run/couli-jd/app_secret`（容器内路径；只写路径，不写密钥内容） |',
  '| `JD_SITE_ID` | 京东联盟的站点 id，十进制正整数 |',
  '',
  '- `JD_APP_KEY` 与 `JD_APP_SECRET_FILE` 要么都设、要么都不设：只设一个时 admin、api、stream 与 worker 启动即失败。`JD_SITE_ID` 设了但不是十进制正整数时同样启动失败。',
  '- 端点是 demo 时应用不打开密钥文件，所以文件读不到或内容为空要到切 live 后才暴露：那时这四个入口启动即失败。',
  '- `JD_SITE_ID` 现在只校验格式，转链由 B1-04zd 接入，在那之前京东转链不可用。',
  '',
  '切 live 走 `UNION_ENDPOINT_OVERRIDE_DIR` 下的 `jd.json`，本节不切。这个变量维持 1.5 的 `/run/couli-pdd/union-endpoints`：它是三平台共用的一个目录，里面的 `jd.json`、`pdd.json`、`taobao.json` 缺任何一个，这四个入口都启动失败，所以**不要把它改到 `/run/couli-jd`**。到切 live 的时候，改的是现有的节点文件 `/etc/couli-pdd/union-endpoints/jd.json`。',
  '',
  '**部署检查 CHK-JD-STAGING-CRED**：jd 端点为 live 而 `JD_APP_KEY`、`JD_APP_SECRET_FILE` 两个变量都没设时，应用不报错、也不打日志，jd 保持未实现（D10-479 同款）。部署成功不代表京东已接通，所以切 live 前要人工核对 `JD_APP_KEY`、`JD_APP_SECRET_FILE`、`JD_SITE_ID` 这三项已设，并核对 `UNION_ENDPOINT_OVERRIDE_DIR` 已设，值是现有的 `/run/couli-pdd/union-endpoints`：节点没做 1.5 时这个变量没设，应用读的是镜像内的端点，改了 `/etc/couli-pdd/union-endpoints/jd.json` 也不生效，jd 静默留在 demo。',
];

/** A section's text with its trailing blank lines dropped. */
function frozen(title: string): string {
  const lines = sectionLines((heading) => heading === title);
  return lines.join('\n').trimEnd();
}

it('[AC-B1-04zzd#10] 1.5、1.8 原文不改，镜像内三个端点文件仍是 demo', () => {
  section();
  expect(frozen('1.5 拼多多（准备，不切 live）')).toBe(FROZEN_1_5.join('\n'));
  expect(frozen('1.8 京东（准备，不切 live）')).toBe(FROZEN_1_8.join('\n'));
  for (const platform of ['jd', 'pdd', 'taobao']) {
    const packaged: unknown = JSON.parse(asset(`config/union-endpoints/${platform}.json`));
    expect(packaged).toEqual({
      platform,
      mode: 'demo',
      baseUrl: null,
      quotaKey: `account:${platform}`,
    });
  }
});
