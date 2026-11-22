import { expect, it } from 'vitest';
import { asset, sourceLines } from '../staging/kit.ts';

// AC labels are local to the B1-01zzx ledger (D10-2519). Only inspect the README.
const HOST_DIR = '/etc/couli-keys';
const CONTAINER_DIR = '/run/couli-keys';
const MASTER = 'prior-identity-master.key';
const KEYRING = 'prior-identity-keyring.json';
const HOST_MASTER = `${HOST_DIR}/${MASTER}`;
const HOST_KEYRING = `${HOST_DIR}/${KEYRING}`;

function priorIdentitySection(): string {
  const readme = asset('infra/staging/README.md');
  const between = /^### 1\.3[ \t][^\n]*\n([\s\S]*?)(?=^### 1\.4[ \t])/m.exec(readme)?.[1] ?? '';
  return /^#{3,4}[ \t]+[^\n]*旧身份[^\n]*\n[\s\S]*/m.exec(between)?.[0] ?? '';
}

function shellLines(section: string): string[] {
  const blocks = [
    ...section.matchAll(/^[ \t]*```(?:sh|bash|shell)[ \t]*\r?\n([\s\S]*?)^[ \t]*```/gm),
  ];
  return sourceLines(blocks.map((block) => block[1] ?? '').join('\n'));
}

function shellWords(line: string): string[] {
  return line.replace(/["']/g, '').split(/\s+/);
}

it('[AC-B1-01zzx#1] 在 1.3 与 1.4 之间说明旧身份隔离存储的密钥环，沿用节点到容器的只读挂载', () => {
  const section = priorIdentitySection();
  expect(section, '1.3 之后、1.4 之前要有旧身份小节').not.toBe('');
  expect(section).toContain('隔离');
  expect(section).toContain('密钥环');
  expect(section).toContain(HOST_MASTER);
  expect(section).toContain(HOST_KEYRING);
  const mount = section.split(/[。\n]/).find((line) => {
    return line.includes(HOST_DIR) && line.includes(CONTAINER_DIR) && line.includes('只读');
  });
  expect(mount, '说明两个文件随现有目录只读挂载到容器').toBeDefined();
});

it('[AC-B1-01zzx#2] 节点先生成独立主密钥，再用镜像内 keyring-init.ts 接收文件路径并生成第二套密钥环', () => {
  const lines = shellLines(priorIdentitySection());
  const createMaster = lines.findIndex((line) => {
    const unquoted = line.replace(/["']/g, '');
    const generate = /(?:^|[(&;])\s*openssl\s+rand\s+-hex\s+32\s*>\s*([^\s);&]+)/.exec(unquoted);
    return generate?.[1] === HOST_MASTER;
  });
  expect(createMaster, '主密钥由 openssl 写入文件').toBeGreaterThanOrEqual(0);

  const initialize = lines.findIndex((line) => {
    return /^docker\s+run\s/.test(line) && line.includes('apps/api/scripts/keyring-init.ts');
  });
  expect(initialize, '先生成主密钥再初始化').toBeGreaterThan(createMaster);
  const command = lines[initialize] ?? '';
  const words = shellWords(command);
  expect(words.some((word) => word.startsWith('couli-api:'))).toBe(true);
  expect(command.replace(/["']/g, '')).toMatch(/\s(?:--user|-u)(?:=|\s+)(?:0|root)(?::0)?\s/);
  const volumeFlag = words.findIndex((word) => word === '--volume' || word === '-v');
  expect(volumeFlag, '初始化容器挂载节点密钥目录').toBeGreaterThanOrEqual(0);
  const [host, mounted, mode] = (words[volumeFlag + 1] ?? '').split(':');
  expect(host).toBe(HOST_DIR);
  expect(mounted ?? '').toMatch(/^\/[^/]/);
  expect(mode ?? 'rw').toBe('rw');
  const node = words.indexOf('node');
  expect(node, '使用 node 执行初始化脚本').toBeGreaterThan(volumeFlag);
  expect(words.slice(node + 1)).toEqual([
    'apps/api/scripts/keyring-init.ts',
    `${mounted}/${MASTER}`,
    `${mounted}/${KEYRING}`,
  ]);
});

it('[AC-B1-01zzx#3] 两个新文件归 uid 1000 并设为 400，密钥目录为 500', () => {
  const lines = shellLines(priorIdentitySection()).map(shellWords);
  for (const file of [HOST_MASTER, HOST_KEYRING]) {
    expect(
      lines.some(
        (words) =>
          words[0] === 'chown' &&
          words.some((word) => /^1000(?::\d+)?$/.test(word)) &&
          (words.includes(file) || (words.includes('-R') && words.includes(HOST_DIR))),
      ),
      `${file} 的属主为 1000`,
    ).toBe(true);
    expect(
      lines.some(
        (words) => words[0] === 'chmod' && /^0?400$/.test(words[1] ?? '') && words.includes(file),
      ),
      `${file} 的权限为 400`,
    ).toBe(true);
  }
  expect(
    lines.some(
      (words) => words[0] === 'chmod' && /^0?500$/.test(words[1] ?? '') && words.includes(HOST_DIR),
    ),
    `${HOST_DIR} 的权限为 500`,
  ).toBe(true);
});

it('[AC-B1-01zzx#4] 两份应用 env 都给出同样三行容器内配置，缺这组时五个入口启动失败', () => {
  const section = priorIdentitySection();
  const envFiles = section.split(/。|\n\s*\n/).find((sentence) => {
    return sentence.includes('staging.env') && sentence.includes('staging-payout.env');
  });
  expect(envFiles ?? '').toMatch(/都|均|各|同样|两份/);
  const assignments = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^PRIOR_IDENTITY_(?:KEY_PROVIDER|KEYRING_FILE|MASTER_KEY_FILE)=/.test(line));
  expect(new Set(assignments)).toEqual(
    new Set([
      'PRIOR_IDENTITY_KEY_PROVIDER=local',
      `PRIOR_IDENTITY_KEYRING_FILE=${CONTAINER_DIR}/${KEYRING}`,
      `PRIOR_IDENTITY_MASTER_KEY_FILE=${CONTAINER_DIR}/${MASTER}`,
    ]),
  );
  const startup = section.split(/。|\n\s*\n/).find((sentence) => {
    return (
      /缺|漏|未配|未设|没配|没设/.test(sentence) &&
      /启动失败|启动即失败|拒绝启动|无法启动/.test(sentence)
    );
  });
  const namesAllEntries = ['api', 'stream', 'worker', 'admin', 'payout'].every((entry) =>
    startup?.includes(entry),
  );
  expect(namesAllEntries || /(?:五|5)个(?:入口|进程|服务)/.test(startup ?? '')).toBe(true);
});

it('[AC-B1-01zzx#5] 区分主密钥和数据密钥，禁止复用密钥环，两把主密钥离线备份，生产用 KMS', () => {
  const section = priorIdentitySection();
  const sentences = section.replace(/`/g, '').split(/。|\n\s*\n/);
  const distinctFiles = sentences.find(
    (sentence) =>
      sentence.includes('PRIOR_IDENTITY_KEYRING_FILE') && /\bFIELD_KEYRING_FILE\b/.test(sentence),
  );
  expect(distinctFiles ?? '').toMatch(/不得|不能|不同|不要/);
  const noCopy = /(?:不得|不能|不要|禁止)[^。\n]*复制[^。\n]*(?<![\w-])keyring\.json\b/;
  expect(section).toMatch(noCopy);
  expect(section).toMatch(
    /独立(?:的)?数据密钥|数据密钥[^。\n]*(?:不同|独立|不(?:能|得)共用|不(?:能|得)相同)/,
  );
  const allowsSharedMaster = sentences.some(
    (sentence) =>
      /\bFIELD_MASTER_KEY_FILE\b/.test(sentence) &&
      /(?:可以|允许|可与)[^。]*(?:共用|同一)|共用[^。]*(?:允许|可以)/.test(sentence),
  );
  expect(allowsSharedMaster, '契约允许共用主密钥').toBe(true);
  const backup = sentences.find((sentence) => sentence.includes('离线备份')) ?? '';
  const listsBoth = backup.includes(MASTER) && /\bmaster\.key\b/.test(backup.replace(MASTER, ''));
  expect(listsBoth || /(?:两|2)把主密钥/.test(backup), '备份两把主密钥').toBe(true);
  const handling = sentences.find(
    (sentence) => sentence.includes('命令行') && sentence.includes('环境变量'),
  );
  expect(handling ?? '').toMatch(/不要|不得|不能|不经|不放|不传|避免/);
  expect(section).not.toMatch(/\b[0-9a-f]{64}\b/i);
  expect(section).toMatch(/(?:prod|生产环境)[^。\n]*\bKMS\b/i);
});
