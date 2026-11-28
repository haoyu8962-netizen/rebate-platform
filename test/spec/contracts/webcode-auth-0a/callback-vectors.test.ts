import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const vectorsFile = new URL('../../../../specs/webcode-callback-vectors.json', import.meta.url);
const stateMaximum = 128;
const codeMaximum = 4096;
const callbackUrl = /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(#.*)?$/iu;
const requiredDropCases = [
  'missing_state',
  'empty_state',
  'state_over_limit',
  'code_over_limit',
  'duplicate_code',
  'duplicate_state',
  'invalid_percent_encoding',
  'fragment',
  'port',
  'userinfo',
  'wrong_host',
  'wrong_path',
  'wrong_scheme',
] as const;

// C3 的 expect 用 kind 区分结果，按分支携带解析值。ignore_extra 只用于成功且有额外键的向量。
interface Vector {
  name: string;
  url: string;
  expect: { kind: string };
}

function readVectors(): Vector[] {
  // 文件尚未新增时在测试体内断言失败；缺失文件、非法 JSON、空数组和坏结构都有明确断言。
  expect(existsSync(vectorsFile), '缺少 specs/webcode-callback-vectors.json').toBe(true);
  const raw = readFileSync(vectorsFile, 'utf8');
  const parse = () => JSON.parse(raw) as unknown;
  expect(parse, '向量文件必须是合法 JSON').not.toThrow();
  const document = parse();
  expect(Array.isArray(document), '向量文件必须是数组').toBe(true);
  const vectors = document as Vector[];
  expect(vectors.length).toBeGreaterThan(0);
  for (const [index, vector] of vectors.entries()) {
    expect(vector, `第 ${index + 1} 条向量`).toEqual({
      name: expect.stringMatching(/\S/u),
      url: expect.stringMatching(/\S/u),
      expect: expect.objectContaining({
        kind: expect.stringMatching(/^(ok|not_completed|drop|ignore_extra)$/u),
      }),
    });
  }
  return vectors;
}

function hasValidPercentEncoding(url: string): boolean {
  try {
    decodeURIComponent(url);
    return true;
  } catch {
    return false;
  }
}

function inspectUrl(url: string) {
  // 按原始 URL 识别空 fragment、userinfo 或显式端口，避免 URL 规范化隐藏拒绝条件。
  const [, scheme, authority = '', path, query, fragment] = callbackUrl.exec(url) ?? [];
  const userinfo = authority.lastIndexOf('@');
  const hostAndPort = authority.slice(userinfo + 1);
  const [host] = hostAndPort.split(':');
  const params = new URLSearchParams(`?${query ?? ''}`);
  const state = params.get('state');
  const code = params.get('code');
  const stateLength = Array.from(state ?? '').length;
  const codeLength = Array.from(code ?? '').length;
  const notCompleted = params.get('error') === '1';
  const hasExtraKey = [...params.keys()].some((key) => !['state', 'code', 'error'].includes(key));
  const checks = [
    ['missing_state', state === null],
    ['empty_state', state === ''],
    ['state_over_limit', stateLength > stateMaximum],
    ['code_over_limit', codeLength > codeMaximum],
    ['duplicate_code', params.getAll('code').length > 1],
    ['duplicate_state', params.getAll('state').length > 1],
    ['invalid_percent_encoding', !hasValidPercentEncoding(url)],
    ['fragment', fragment !== undefined],
    ['port', hostAndPort.includes(':')],
    ['userinfo', userinfo >= 0],
    ['wrong_host', host?.toLowerCase() !== 'auth'],
    ['wrong_path', path !== '/taobao'],
    ['wrong_scheme', scheme?.toLowerCase() !== 'couli'],
    ['missing_or_empty_code', !notCompleted && codeLength === 0],
  ] as const;
  const dropReasons = checks.filter(([, matches]) => matches).map(([reason]) => reason);
  return { state, code, stateLength, codeLength, notCompleted, hasExtraKey, dropReasons };
}

it('[AC-CT-17l#4] 回跳向量结构合法，每条预期结果与 URL 相符', () => {
  // 错标结果、漏解析值、把编码原样当解析值、保留额外键或在丢弃分支返回凭证均会失败。
  for (const vector of readVectors()) {
    const { state, code, notCompleted, hasExtraKey, dropReasons } = inspectUrl(vector.url);
    if (dropReasons.length > 0) {
      expect(vector.expect, vector.name).toEqual({ kind: 'drop' });
    } else if (notCompleted) {
      expect(vector.expect, vector.name).toEqual({ kind: 'not_completed', state });
    } else {
      const kind = hasExtraKey && vector.expect.kind === 'ignore_extra' ? 'ignore_extra' : 'ok';
      expect(vector.expect, vector.name).toEqual({ kind, code, state });
    }
  }
});

it('[AC-CT-17l#5] 回跳向量覆盖各结果、边界与拒绝原因', () => {
  // 漏掉某个分支、用多个错误叠在同一条伪造覆盖、把越界或边界长度写错均会失败。
  const cases = readVectors().map((vector) => ({
    kind: vector.expect.kind,
    ...inspectUrl(vector.url),
  }));
  const accepted = cases.filter(({ dropReasons }) => dropReasons.length === 0);
  const success = accepted.filter(({ kind, notCompleted }) => kind === 'ok' && !notCompleted);
  const plain = success.some(({ hasExtraKey }) => !hasExtraKey);
  const withExtraKey = success.some(({ hasExtraKey }) => hasExtraKey);
  const incomplete = accepted.some(
    ({ kind, notCompleted, code }) => notCompleted && code === null && kind === 'not_completed',
  );
  const maxState = success.some(({ stateLength }) => stateLength === stateMaximum);
  const maxCode = success.some(({ codeLength }) => codeLength === codeMaximum);
  expect(plain, '缺少合法 code 和 state').toBe(true);
  expect(incomplete, '缺少只有合法 state 和 error=1 的未完成回跳').toBe(true);
  expect(withExtraKey, '缺少带额外键的 ok').toBe(true);
  expect(maxState, '缺少 128 字符合法 state').toBe(true);
  expect(maxCode, '缺少 4096 字符合法 code').toBe(true);

  for (const required of requiredDropCases) {
    const covered = cases.some(({ kind, dropReasons, stateLength, codeLength }) => {
      if (kind !== 'drop' || dropReasons.length !== 1 || dropReasons[0] !== required) return false;
      if (required === 'state_over_limit') return stateLength === stateMaximum + 1;
      if (required === 'code_over_limit') return codeLength === codeMaximum + 1;
      return true;
    });
    expect(covered, `缺少独立的 drop 向量：${required}`).toBe(true);
  }
});
