import { expect, it } from 'vitest';
import { asset, noInlineCredentials } from '../staging/kit.ts';

// AC-B1-04zze labels refer only to this task's brief (refs is empty; FU-STAGING-README-WORDING,
// the two S2 of #2317 money r1, corrected by money r1 S1 / S2 of the test round). Facts pinned
// here come from the code at this commit: union.module.ts refuses only
// TAOBAO_SEARCH_SOURCE=official_first without the 大淘客 order source; under 'dataoke' without one,
// taobao-adapter.ts searchItems throws adapter_unimplemented on every call, so the Taobao search
// fails and never falls back to the official one (test/spec/union/taobao-official-search/
// switches.test.ts); rebate-quoter.ts reads the two union.pdd.*_factor_bp keys and the published
// rule versions; seed 0002 has both, the two pdd keys as placeholder values marked 待核实;
// config-registry.ts registers tech_fee_bp and the compare ratio as config.business (B2-03t)
// without seed rows, and does not register the two pdd keys (FU-PDD-FACTOR-REGISTRY).

const README = 'infra/staging/README.md';
const DATAOKE_VARS = ['DATAOKE_APP_KEY', 'DATAOKE_APP_SECRET_FILE'];
const PDD_KEYS = ['union.pdd.self_buy_factor_bp', 'union.pdd.account_level_factor_bp'];
const COMPARE_KEY = 'rebate.taobao.compare_rate_ratio_bp';
const PUBLISHED_RULE = ['已发布', '分佣规则', '版本'];
const ADMIN_EDIT = ['tech_fee_bp', COMPARE_KEY, '后台', 'config.business'];
/** A startup refusal. */
const REFUSES = /拒绝启动|启动(?:即|就)?失败/;
/** Wording that the search stays on (or falls back to) the official one; negated hits aside. */
const STAYS_OFFICIAL =
  /(?:仍|还是|照旧|照样|静默|自动)[^。\n]{0,6}(?:走|用|留在|退回|回退|回落|改走|切回|改用)[^。\n]{0,4}(?:官方|official(?!_))/g;
/** A sentence saying nothing more needs configuring. */
const NO_SETUP = /(?:不用|不需要?|无需|不必)(?:另|再|额外)?(?:配|设)/;
/** A sentence saying a key is already seeded. */
const SEEDED = /已在种子|种子里已有|种子已有|种子(?:会|里)?写入/;

/** Whether `text` contains every one of `parts`. */
function includesAll(text: string, parts: readonly string[]): boolean {
  return parts.every((part) => text.includes(part));
}

/**
 * The lines of the first section of `lines` whose heading satisfies `matches`, heading included, up
 * to the next heading of the same or a higher level; a shell comment inside a code fence is not a
 * heading. Empty when no heading matches.
 */
function cut(lines: string[], matches: (title: string) => boolean): string[] {
  let fenced = false;
  let depth = 0;
  const kept: string[] = [];
  for (const line of lines) {
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

/** The lines of section 1.10; asserts it exists. */
function section(): string[] {
  const kept = cut(asset(README).split('\n'), isSection10);
  expect(kept.length, 'README needs section 1.10 on Taobao going live').toBeGreaterThan(0);
  return kept;
}

/** The lines of 1.10's subsection on the real rebate quoter; asserts it exists. */
function quoterSection(): string[] {
  const kept = cut(section(), (title) => title.includes('真实返利报价器'));
  expect(kept.length, '1.10 keeps the real rebate quoter subsection').toBeGreaterThan(0);
  return kept;
}

/** Sentences: split on line breaks, the Chinese full stop and the Chinese semicolon. */
function sentences(lines: string[]): string[] {
  return lines.join('\n').split(/[。；\n]/);
}

/** A line naming TAOBAO_SEARCH_SOURCE with the value dataoke. */
function namesDataokeSwitch(line: string): boolean {
  return /TAOBAO_SEARCH_SOURCE`?\s*(?:=|为|设为|设成|是)\s*`?dataoke\b/.test(line);
}

/** A line naming TAOBAO_SEARCH_SOURCE=dataoke and both DATAOKE_* variables. */
function dataokeNamed(line: string): boolean {
  return namesDataokeSwitch(line) && includesAll(line, DATAOKE_VARS);
}

/** The new 大淘客 line of 1.10; asserts it exists. */
function dataokeLine(lines: string[]): string {
  const hit = lines.find((line) => dataokeNamed(line));
  expect(hit, '1.10 names TAOBAO_SEARCH_SOURCE=dataoke and both DATAOKE_*').toBeDefined();
  return hit ?? '';
}

/** A sentence naming one of the two union.pdd.* keys. */
function namesPddKey(sentence: string): boolean {
  return PDD_KEYS.some((key) => sentence.includes(key));
}

/**
 * Whether `sentence` says the search stays on or falls back to the official one: a STAYS_OFFICIAL
 * hit with no 不 in it or in the three characters before it (「不会自动改走官方」 is the required
 * wording, not the wrong claim).
 */
function claimsOfficial(sentence: string): boolean {
  return [...sentence.matchAll(STAYS_OFFICIAL)].some((hit) => {
    const start = hit.index ?? 0;
    return !sentence.slice(Math.max(0, start - 3), start + hit[0].length).includes('不');
  });
}

/** A sentence naming tech_fee_bp or the Taobao compare ratio. */
function namesQuoterKey(sentence: string): boolean {
  return sentence.includes('tech_fee_bp') || sentence.includes(COMPARE_KEY);
}

it('[AC-B1-04zze#1] 1.10 写明 TAOBAO_SEARCH_SOURCE=dataoke 而缺大淘客两项时照常启动、不报错，但淘宝搜索不可用、不会自动改走官方，只有 official_first 拒绝启动；要用大淘客搜索须先配齐两项，否则设为 official 或不设', () => {
  const lines = section();
  const line = dataokeLine(lines);
  // Missing credentials: 缺 / 没设 / 未配 … before the variable names.
  expect(line).toMatch(/(?:缺|没有?|未|不)(?:设|配)?[^。\n]{0,12}DATAOKE_APP_KEY/);
  // The four entries start without an error (union.module.ts refuses only official_first).
  expect(line).toMatch(/不报错|不会报错|不拒绝启动|不会拒绝启动|照常启动/);
  // But every Taobao search fails (adapter_unimplemented in searchItems) …
  expect(line).toMatch(
    /搜索[^。\n]{0,10}(?:不可用|用不了|全部失败|全都失败|都会失败|都失败|一律失败|每次都失败)/,
  );
  // … and it does not fall back to the official search (switches.test.ts).
  expect(line).toMatch(
    /不(?:会)?[^。\n]{0,4}(?:退回|回退|回落|改走|切回|改用|转用|转到|切到)[^。\n]{0,4}(?:官方|official(?!_))/,
  );
  // Only official_first refuses to start without the 大淘客 credentials (union.module.ts).
  expect(line).toMatch(/只有[^。\n]{0,4}official_first[^。\n]*(?:拒绝启动|启动(?:即|就)?失败)/);
  // To use the 大淘客 search, both variables are configured first …
  expect(line).toMatch(/大淘客搜索[^。\n]*?(?:须|必须|需|需要|要)[^。\n]*?(?:配齐|设齐)/);
  // … otherwise TAOBAO_SEARCH_SOURCE is set to official or left unset.
  expect(line).toMatch(/否则[^。\n]*?(?:设为|设成|改为|改成|改回|=)\s*`?official`?(?!_)/);
  expect(line).toMatch(/official`?(?!_)[^。\n]{0,6}(?:或|或者)[^。\n]{0,4}不设/);
  // No sentence of 1.10 naming the dataoke switch claims it stays on or falls back to official.
  const wrong = sentences(lines).filter((s) => namesDataokeSwitch(s) && claimsOfficial(s));
  expect(wrong, 'dataoke without 大淘客 does not stay on the official search').toEqual([]);
  expect(claimsOfficial(line), 'the dataoke line does not claim the official search').toBe(false);
  // No line of 1.10 says dataoke itself refuses to start without the credentials.
  const refusals = lines.filter((other) => namesDataokeSwitch(other) && REFUSES.test(other));
  for (const other of refusals) expect(other).toContain('official_first');
});

it('[AC-B1-04zze#2] 真实返利报价器的配置写明拼多多商品另读两个 union.pdd.*_factor_bp 键：种子里是待核实的占位值，且不在 config 登记表、后台改不了', () => {
  const lines = quoterSection();
  const line = lines.find((candidate) => includesAll(candidate, PDD_KEYS));
  expect(line, 'one quoter line names both union.pdd.* keys').toBeDefined();
  expect(line).toMatch(/拼多多|\bpdd\b/);
  expect(line).toMatch(/(?:另|还|也|额外)[^。\n]{0,4}读/);
  // Seeded (db/seeds/0002), but as placeholder values still to be verified.
  expect(line).toContain('种子');
  expect(line).toMatch(/占位/);
  expect(line).toContain('待核实');
  // Not in the config registry, so the admin cannot change them; a registry task is needed.
  expect(line).toMatch(/不在[^。\n]{0,12}登记表/);
  expect(line).toMatch(/后台[^。\n]{0,6}(?:改不了|不能改|无法改|不能修改|无法修改)/);
  expect(line).toMatch(/FU-PDD-FACTOR-REGISTRY|登记任务/);
  // Not 「不用另配」: no sentence naming them says nothing needs configuring.
  const settled = sentences(lines).filter((s) => namesPddKey(s) && NO_SETUP.test(s));
  expect(settled, 'the placeholder union.pdd.* keys are not called settled').toEqual([]);
});

it('[AC-B1-04zze#3] 真实返利报价器的配置写明报价要求一条已发布的分佣规则版本，种子里已有', () => {
  const line = quoterSection().find((candidate) => includesAll(candidate, PUBLISHED_RULE));
  expect(line, 'one quoter line names a published commission rule version').toBeDefined();
  expect(line).toContain('报价');
  expect(line).toContain('种子');
});

it('[AC-B1-04zze#4] 真实返利报价器的配置写明 tech_fee_bp 与 rebate.taobao.compare_rate_ratio_bp 可经后台（config.business）修改，且不说它们在种子里', () => {
  const lines = quoterSection();
  const line = lines.find((candidate) => includesAll(candidate, ADMIN_EDIT));
  expect(line, 'both keys edited in the admin (config.business)').toBeDefined();
  expect(line).toMatch(/改/);
  // B2-03t registered them without seed rows.
  const seeded = sentences(lines).filter((s) => namesQuoterKey(s) && SEEDED.test(s));
  expect(seeded, 'tech_fee_bp and the compare ratio have no seed rows').toEqual([]);
});

it('[AC-B1-04zze#5] 新增说明与整份 README 不含任何密钥值、真实 app key 或 PID', () => {
  const lines = section();
  dataokeLine(lines);
  const text = lines.join('\n');
  for (const key of PDD_KEYS) {
    expect(text, 'the new quoter wording is in 1.10').toContain(key);
  }
  const readme = asset(README);
  for (const checked of [text, readme]) {
    // Placeholders such as TAOBAO_APP_KEY=<值> and a bare `TAOBAO_APP_KEY=` are names, not values.
    expect(checked).not.toMatch(/\b(?:TAOBAO|JD|PDD|DATAOKE)_APP_KEY`?[ \t]*=[ \t]*[^\s<`]/);
    expect(checked).not.toMatch(/\bPDD_CLIENT_ID`?[ \t]*=[ \t]*[^\s<`]/);
    expect(checked).not.toMatch(/\b[0-9a-f]{16,}\b/i);
    // PID shapes: Taobao mm_<n>_<n>_<n>; JD / pdd digit groups joined by underscores.
    expect(checked).not.toMatch(/\bmm_\d+_\d+_\d+\b/);
    expect(checked).not.toMatch(/\b\d{3,}_\d{3,}(?:_\d+)*\b/);
  }
  // App-key-like digit runs (Taobao app keys are eight digits); five-digit error codes such as
  // 50304 and basis-point values such as 10000 are allowed.
  expect(text).not.toMatch(/\b\d{6,}\b/);
  expect(text).not.toMatch(/DATAOKE_APP_SECRET_FILE[^\n]*\/etc\//);
  noInlineCredentials(readme);
});

// Section 1.10 as it stands before this task, blank lines dropped: the task only adds lines.
const ORIGINAL_1_10 = [
  '### 1.10 淘宝接线与三平台切 live',
  '依据 approvals 第 43 条（staging 连真实联盟：淘宝、京东、拼多多）。本节先给淘宝的节点文件与变量，再给三平台一起切 live 的步骤。1.5 与 1.8 的准备照旧，本节在它们之上做。',
  '注：1.5 写的「pdd 切 live 暂不可用 — blocked on 真实返利报价器（B2-03）」已由 B2-03d / B2-03n 解除：真实返利报价器已经接入，pdd 可以随本节一起切 live。',
  '#### 淘宝节点文件',
  'compose 给 admin、api、stream 与 worker（装配联盟模块的四个入口）只读挂载节点目录 `/etc/couli-taobao`（容器内 `/run/couli-taobao`）；payout 不挂。这个挂载可缺：节点没有该目录时部署照常进行，`deploy.sh` 也不检查它。',
  '节点文件由负责人放入（容器以 uid 1000 运行）：',
  '| 节点路径 | 内容 | 属主与权限 |',
  '| --- | --- | --- |',
  '| `/etc/couli-taobao/` | 目录 | 属主 1000，目录 500 |',
  '| `/etc/couli-taobao/app_secret` | 淘宝联盟（阿里妈妈）应用的密钥原文，文件里只放这一个值 | 属主 1000，文件 400 |',
  '密钥内容不得出现在命令行里（会进 shell 历史和进程列表），也不得放进环境变量或 `staging.env`；用编辑器打开文件粘贴后保存，不要用 `echo` / `printf` 写入密钥。准备步骤（root 执行）：',
  '```sh',
  'install -d -m 700 /etc/couli-taobao',
  'vi /etc/couli-taobao/app_secret',
  'chown -R 1000:1000 /etc/couli-taobao',
  'chmod 400 /etc/couli-taobao/app_secret',
  'chmod 500 /etc/couli-taobao',
  '```',
  '#### 淘宝变量',
  '先放好上面的文件，再在 `/etc/couli/staging.env` 设下面三个变量（值只写在节点上，不进仓库，也不写进本文档）：',
  '| 变量 | 取值 |',
  '| --- | --- |',
  '| `TAOBAO_APP_KEY` | 淘宝联盟应用的 app key（不是密钥） |',
  '| `TAOBAO_APP_SECRET_FILE` | `/run/couli-taobao/app_secret`（容器内路径；只写路径，不写密钥内容） |',
  '| `TAOBAO_SEARCH_SOURCE` | 商品搜索来源，三选一：`official`（官方接口）、`dataoke`（大淘客）、`official_first`（先官方，需要大淘客凭据，否则启动失败）；未设即 `official` |',
  '- `TAOBAO_APP_KEY` 与 `TAOBAO_APP_SECRET_FILE` 要么都设、要么都不设：只设一个时 admin、api、stream 与 worker 启动即失败。',
  '- 端点是 demo 时应用不打开密钥文件，所以文件读不到或内容为空要到切 live 后才暴露：那时这四个入口启动即失败。',
  '#### 三平台切 live',
  '顺序：先放好三家密钥文件与三个 live 端点文件，再在 `staging.env` 设变量，再跑 `deploy.sh <标签>`。不能反过来。',
  '1. 三家密钥文件：`/etc/couli-taobao/app_secret`（本节上文）、`/etc/couli-jd/app_secret`（1.8）、`/etc/couli-pdd/client_secret`（1.5）。',
  '2. 三个端点文件：改现有的 `/etc/couli-pdd/union-endpoints/` 下的 `jd.json`、`pdd.json`、`taobao.json`，把 `"mode": "demo"` 改成 `"mode": "live"`，并把 `baseUrl` 从 `null` 改成该联盟网关的 https 地址（live 的 baseUrl 必须是 https，否则启动失败）。形如 `{"platform":"jd","mode":"live","baseUrl":"https://<联盟网关>","quotaKey":"account:jd"}`。改完按 1.5 保持属主 1000、文件 400、目录 500。镜像内的 `config/union-endpoints/*.json` 保持 demo，不改。',
  '3. 三个端点文件缺一个时，admin、api、stream 与 worker 四个入口启动即失败（不会退回镜像内的端点）。`UNION_ENDPOINT_OVERRIDE_DIR` 维持 1.5 的 `/run/couli-pdd/union-endpoints`，不改。',
  '4. 变量：在 `/etc/couli/staging.env` 设齐淘宝三项（上文）、京东三项（1.8）、拼多多三项与 `UNION_ENDPOINT_OVERRIDE_DIR`（1.5）。',
  '5. 部署：`deploy.sh <标签>`，然后按 1.8 的 CHK-JD-STAGING-CRED 人工核对变量都已设。',
  '#### 真实返利报价器的配置',
  'live 下 api 用真实返利报价器（B2-03d / B2-03n），它读下面三个配置键；缺任何一项时报价失败：',
  '| 配置键 | 说明 |',
  '| --- | --- |',
  '| `tech_fee_bp` | 技术服务费比例（万分之一整数），按平台分项，每个平台都要有 |',
  '| `rebate.taobao.compare_rate_ratio_bp` | 淘宝比价用的佣金比例系数（万分之一整数） |',
  '| `commission.platforms` | 参与分佣的平台列表 |',
  '- `tech_fee_bp` 与 `rebate.taobao.compare_rate_ratio_bp` 要先在 staging 配好（取值由负责人定，本文不写），再切 live。',
  '- `commission.platforms` 已在种子里（`db/seeds/0002_commission-rules.sql`），部署时种子会写入，不用另配。',
];

it('[AC-B1-04zze#6] 只在 1.10 里追加：原有每一行原样按序保留，新说明落在 1.10 之内', () => {
  const lines = section();
  dataokeLine(lines);
  const current = lines.filter((line) => line.trim() !== '');
  expect(current.length, '1.10 gains lines').toBeGreaterThan(ORIGINAL_1_10.length);
  // Every original line, verbatim and in order (added lines may sit between them).
  let at = 0;
  for (const line of current) {
    if (at < ORIGINAL_1_10.length && line === ORIGINAL_1_10[at]) at += 1;
  }
  expect(ORIGINAL_1_10.slice(at), 'original 1.10 lines missing or reordered').toEqual([]);
  // The new wording appears nowhere outside 1.10.
  const outside = asset(README).replace(lines.join('\n'), '');
  for (const name of [...DATAOKE_VARS, ...PDD_KEYS, 'config.business']) {
    expect(outside, `${name} is added only inside 1.10`).not.toContain(name);
  }
});
