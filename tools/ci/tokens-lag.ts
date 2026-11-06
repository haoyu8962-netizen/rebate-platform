// TOKENS-LAG (规划/05 §3.11; D10-643 ⑥, D10-672 ②; DSX-42 D10-683): warns when a client's
// design-token lock or contract lock falls behind its source, when the client contract locks
// disagree, and (--client-vectors) when the shared client vectors a client locks differ from this
// repository's specs/client/ manifest.
//
//   node tools/ci/tokens-lag.ts --planning <planning repo> [--planning-ref <ref>]
//     [--platform <this repo>] [--platform-ref <ref>]
//     [--lock <name>=<contract.lock>]... [--h5] [--client-vectors <specs/client dir>]
//     [--now <ISO time>]
//
//   --planning      local git checkout of the planning repository (zora4523-bot/couli).
//   --planning-ref  ref whose history is the token source; default origin/main when it resolves,
//                   else HEAD.
//   --platform      this repository (default: current directory). Its working tree supplies the
//                   H5 snapshot; its history supplies the contract trunk.
//   --platform-ref  ref of the contract trunk; default origin/main when it resolves, else HEAD.
//                   The trunk commit is the newest commit on that ref touching contracts/.
//   --lock          a client contract.lock (android, harmony, ios ...); repeatable. Shape:
//                   {"rebate_platform": {"commit": "<40hex>"},
//                    "design_tokens": {"commit": "<40hex>", "path": "design/tokens/design-tokens.json"}}
//                   (`repo` fields are not read; `path` is optional but must name the token file
//                   when present; `files` is read only with --client-vectors, and then only its
//                   `specs/client/<path>` keys).
//   --h5            the H5 token lock: contracts/design-tokens.json of this repository (version
//                   from its metadata.version) and the 40-hex source commit on the
//                   `design-tokens.json` row of contracts/README.md. H5 has no contract lock.
//   --client-vectors  the specs/client directory of this repository (manifest.json, see
//                   client-vectors.ts). The manifest must parse and match the directory's files,
//                   else input error. Each --lock's `files` table is compared with it: a key
//                   `specs/client/<path>` maps to the sha256 of manifest entry <path>.
//   --now           the clock (tests). Default: the later of the newest token commit and the
//                   current time. Only used for the reported lock age, never for a verdict.
//
// Verdicts (each lock):
//   tokens   - the locked file's metadata.version is >= 1 version behind the newest one, where a
//              "version" is a distinct metadata.version seen in the token file's history (no
//              semver arithmetic); or the locked planning commit is >= 7 days older than the newest
//              token commit and does not contain it. The locked commit must exist on the planning
//              ref and hold a readable token file, else input error.
//   source   - the newest commit touching the token file on the planning ref must leave a readable
//              file with a metadata.version (not deleted, valid JSON), else input error. An older
//              revision that is deleted, broken or lacks metadata.version is not counted as a
//              version and is reported as a `source-invalid` warning (exit 1): history cannot be
//              rewritten, so an input error there would fail CI for good.
//   h5       - the token verdict uses the version of the file at the README source commit; a
//              snapshot whose metadata.version differs (or cannot be read) is a `snapshot-mismatch`
//              warning only. A README without exactly one source commit, a source commit not on the
//              planning ref, or a missing snapshot / README file is an input error.
//   contract - rebate_platform.commit is >= 7 days older than the contract trunk commit and does
//              not contain it; a commit this repository does not have is a warning ("找不到该提交"),
//              not an input error (a client may lock an unpushed commit).
//   two or more client locks whose rebate_platform.commit differ -> "三端契约锁不一致".
//   client vectors (--client-vectors; warnings only, never an input error about a lock):
//              `client-vectors-mismatch` - a lock's `specs/client/<path>` hash differs from the
//              manifest, or names a path the manifest does not have (one warning per lock);
//              `client-vectors-unlocked` - manifest paths the lock has no key for (one warning per
//              lock; expected until the client adopts the keys, DSX-140 to DSX-142);
//              `client-vectors-disagree` - two or more locks lock the same path with different
//              hashes (one warning per path). A lock without a `files` object locks nothing.
//
// Output: stdout is one JSON document (see Report); stderr a Chinese summary; under GitHub Actions
// (GITHUB_ACTIONS=true) every warning is also printed to stderr as `::warning title=TOKENS-LAG::...`
// (the runner reads workflow commands from both streams; stdout stays a single JSON document).
// Exit codes: 0 no warning, 1 warnings, 2 input error (bad arguments, unreadable or malformed lock,
// missing repository or commit).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tryGit } from '../lib/git.ts';
import { LOCK_PREFIX, ownEntry, verifiedManifest } from './client-vectors.ts';

export const TOKENS_PATH = 'design/tokens/design-tokens.json';
export const H5_SNAPSHOT = 'contracts/design-tokens.json';
export const H5_README = 'contracts/README.md';
export const CONTRACTS_DIR = 'contracts/';
export const DAY_MS = 86_400_000;
export const LAG_DAYS = 7;

export class InputError extends Error {
  override name = 'InputError';
}

// ---------------------------------------------------------------------------------------------
// Pure verdicts
// ---------------------------------------------------------------------------------------------

/** One commit of the token file's history, oldest first. */
export type TokenRevision = { commit: string; time: number; version: string };

/** Distinct versions in order of first appearance (oldest first). */
export function distinctVersions(history: readonly TokenRevision[]): string[] {
  const seen: string[] = [];
  for (const rev of history) if (!seen.includes(rev.version)) seen.push(rev.version);
  return seen;
}

export type TokenVerdictInput = {
  history: readonly TokenRevision[];
  lockedVersion: string;
  lockedTime: number;
  /** The locked commit already contains the newest token commit (it is that commit or a descendant). */
  containsLatest: boolean;
};

export type TokenVerdict = {
  latestVersion: string;
  versionsBehind: number;
  msBehind: number;
  versionLag: boolean;
  timeLag: boolean;
};

export function judgeTokens(input: TokenVerdictInput): TokenVerdict {
  const latest = input.history[input.history.length - 1];
  if (latest === undefined) throw new InputError('令牌文件没有提交历史');
  const versions = distinctVersions(input.history);
  const lockedIndex = versions.indexOf(input.lockedVersion);
  if (lockedIndex < 0) {
    throw new InputError(`锁定的令牌版本 ${input.lockedVersion} 不在令牌文件历史里`);
  }
  const latestIndex = versions.indexOf(latest.version);
  const versionsBehind = Math.max(0, latestIndex - lockedIndex);
  const msBehind = input.containsLatest ? 0 : Math.max(0, latest.time - input.lockedTime);
  return {
    latestVersion: latest.version,
    versionsBehind,
    msBehind,
    versionLag: versionsBehind >= 1,
    timeLag: msBehind >= LAG_DAYS * DAY_MS,
  };
}

export type ContractVerdictInput = {
  found: boolean;
  lockedTime: number | null;
  trunkTime: number;
  containsTrunk: boolean;
};

export type ContractVerdict = { msBehind: number | null; timeLag: boolean };

export function judgeContract(input: ContractVerdictInput): ContractVerdict {
  if (!input.found || input.lockedTime === null) return { msBehind: null, timeLag: false };
  const msBehind = input.containsTrunk ? 0 : Math.max(0, input.trunkTime - input.lockedTime);
  return { msBehind, timeLag: msBehind >= LAG_DAYS * DAY_MS };
}

/** The client locks whose contract commits differ, or null when all agree (or fewer than two). */
export function contractMismatch(
  locks: readonly { name: string; commit: string }[],
): { name: string; commit: string }[] | null {
  if (locks.length < 2) return null;
  const commits = new Set(locks.map((l) => l.commit));
  return commits.size > 1 ? [...locks] : null;
}

export function days(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Lock parsing (pure)
// ---------------------------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;

type Obj = Record<string, unknown>;
function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type ClientLock = {
  contractCommit: string;
  tokensCommit: string;
  /** The lock's `files` table when it is an object, else null (only read with --client-vectors). */
  files: Record<string, unknown> | null;
};

export function parseContractLock(text: string, label: string): ClientLock {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new InputError(`${label}: 不是合法 JSON（${err instanceof Error ? err.message : ''}）`);
  }
  if (!isObj(doc)) throw new InputError(`${label}: 顶层不是对象`);
  const rp = doc['rebate_platform'];
  const dt = doc['design_tokens'];
  const field = (o: unknown, key: string, name: string): string => {
    const v = isObj(o) ? o[key] : undefined;
    if (typeof v !== 'string' || !HEX40.test(v)) {
      throw new InputError(`${label}: 缺少或不合法的 ${name}（要 40 位小写十六进制提交号）`);
    }
    return v;
  };
  const contractCommit = field(rp, 'commit', 'rebate_platform.commit');
  const tokensCommit = field(dt, 'commit', 'design_tokens.commit');
  const path = isObj(dt) ? dt['path'] : undefined;
  if (path !== undefined && path !== TOKENS_PATH) {
    throw new InputError(`${label}: design_tokens.path 应为 ${TOKENS_PATH}，实为 ${String(path)}`);
  }
  const files = doc['files'];
  return { contractCommit, tokensCommit, files: isObj(files) ? files : null };
}

// ---------------------------------------------------------------------------------------------
// Client vectors (pure)
// ---------------------------------------------------------------------------------------------

export type ClientVectorsMismatch = { path: string; locked: string; manifest: string | null };

export type ClientVectorsLock = {
  name: string;
  matched: string[];
  mismatched: ClientVectorsMismatch[];
  unlocked: string[];
};

export type ClientVectorsDisagreement = { path: string; locks: { name: string; sha256: string }[] };

const lockedValue = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** Compares each lock's `specs/client/<path>` keys with the manifest (path -> sha256). */
export function judgeClientVectors(
  manifest: Readonly<Record<string, string>>,
  locks: readonly { name: string; files: Readonly<Record<string, unknown>> | null }[],
): { locks: ClientVectorsLock[]; disagreements: ClientVectorsDisagreement[] } {
  const byPath = new Map<string, { name: string; sha256: string }[]>();
  const out = locks.map((l): ClientVectorsLock => {
    const locked = new Map<string, string>();
    for (const [key, value] of Object.entries(l.files ?? {})) {
      if (key.startsWith(LOCK_PREFIX))
        locked.set(key.slice(LOCK_PREFIX.length), lockedValue(value));
    }
    const report: ClientVectorsLock = { name: l.name, matched: [], mismatched: [], unlocked: [] };
    for (const [path, sha] of [...locked].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const expected = ownEntry(manifest, path);
      if (expected === sha) report.matched.push(path);
      else report.mismatched.push({ path, locked: sha, manifest: expected ?? null });
      const list = byPath.get(path) ?? [];
      list.push({ name: l.name, sha256: sha });
      byPath.set(path, list);
    }
    report.unlocked = Object.keys(manifest)
      .filter((p) => !locked.has(p))
      .sort();
    return report;
  });
  const disagreements = [...byPath]
    .filter(([, list]) => list.length >= 2 && new Set(list.map((x) => x.sha256)).size > 1)
    .map(([path, list]) => ({ path, locks: list }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { locks: out, disagreements };
}

/** metadata.version of a token document. */
export function tokenVersion(text: string, label: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new InputError(`${label}: 令牌文件不是合法 JSON`);
  }
  const meta = isObj(doc) ? doc['metadata'] : undefined;
  const version = isObj(meta) ? meta['version'] : undefined;
  if (typeof version !== 'string' || version === '') {
    throw new InputError(`${label}: 令牌文件没有 metadata.version`);
  }
  return version;
}

/** The 40-hex source commit on the `design-tokens.json` row of contracts/README.md. */
export function readmeSourceCommit(text: string): string {
  const rows = text.split('\n').filter((l) => l.startsWith('| `design-tokens.json`'));
  if (rows.length !== 1) {
    throw new InputError(`${H5_README}: 要恰好一行 design-tokens.json，实有 ${rows.length} 行`);
  }
  const commits = [...new Set((rows[0] ?? '').match(/\b[0-9a-f]{40}\b/g) ?? [])];
  if (commits.length !== 1) {
    throw new InputError(`${H5_README}: design-tokens.json 一行要恰好一个 40 位来源提交`);
  }
  return commits[0] ?? '';
}

// ---------------------------------------------------------------------------------------------
// Git layer
// ---------------------------------------------------------------------------------------------

function gitOut(repo: string, args: string[]): string | null {
  const res = tryGit(args, { cwd: repo });
  return res.status === 0 ? res.stdout.replace(/\n+$/, '') : null;
}

function requireRepo(repo: string, what: string): void {
  if (!existsSync(repo) || gitOut(repo, ['rev-parse', '--git-dir']) === null) {
    throw new InputError(`${what} 不是 git 仓库：${repo}`);
  }
}

function resolveRef(
  repo: string,
  ref: string | undefined,
  what: string,
): { ref: string; sha: string } {
  const candidates = ref === undefined ? ['origin/main', 'HEAD'] : [ref];
  for (const c of candidates) {
    const sha = gitOut(repo, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
    if (sha !== null) return { ref: c, sha };
  }
  throw new InputError(`${what} 里解析不了引用 ${ref ?? 'origin/main / HEAD'}`);
}

function commitTime(repo: string, commit: string): number | null {
  const out = gitOut(repo, ['log', '-1', '--format=%ct', commit]);
  return out === null || out === '' ? null : Number(out) * 1000;
}

function hasCommit(repo: string, commit: string): boolean {
  return gitOut(repo, ['cat-file', '-e', `${commit}^{commit}`]) !== null;
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return tryGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repo }).status === 0;
}

export type InvalidRevision = { commit: string; reason: string };

function tokenHistory(
  planning: string,
  head: string,
): { history: TokenRevision[]; invalid: InvalidRevision[] } {
  const out = gitOut(planning, ['log', '--format=%H %ct', '--reverse', head, '--', TOKENS_PATH]);
  if (out === null || out === '')
    throw new InputError(`规划仓库 ${head} 上没有 ${TOKENS_PATH} 的提交历史`);
  const history: TokenRevision[] = [];
  const invalid: InvalidRevision[] = [];
  const lines = out.split('\n');
  lines.forEach((line, i) => {
    const [commit = '', ct = ''] = line.split(' ');
    const text = gitOut(planning, ['show', `${commit}:${TOKENS_PATH}`]);
    let version: string | null = null;
    let reason = '该提交删除了令牌文件';
    if (text !== null) {
      try {
        version = tokenVersion(text, `${commit.slice(0, 12)}:${TOKENS_PATH}`);
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    if (version === null) {
      if (i === lines.length - 1) {
        throw new InputError(
          `规划仓库 ${head.slice(0, 12)} 上最新的令牌提交 ${commit.slice(0, 12)} 不可用：${reason}`,
        );
      }
      invalid.push({ commit, reason });
      return;
    }
    history.push({ commit, time: Number(ct) * 1000, version });
  });
  return { history, invalid };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export type WarningKind =
  | 'tokens-version'
  | 'tokens-days'
  | 'contract-days'
  | 'contract-missing'
  | 'contract-mismatch'
  | 'snapshot-mismatch'
  | 'source-invalid'
  | 'client-vectors-mismatch'
  | 'client-vectors-unlocked'
  | 'client-vectors-disagree';

export type Warning = { lock: string | null; kind: WarningKind; message: string };

export type LockReport = {
  name: string;
  source: 'contract.lock' | 'h5-snapshot';
  path: string;
  tokens: {
    commit: string;
    committed_at: string;
    version: string;
    latest_version: string;
    versions_behind: number;
    days_behind: number;
    age_days: number;
  };
  contract: {
    commit: string;
    found: boolean;
    committed_at: string | null;
    days_behind: number | null;
  } | null;
};

export type Report = {
  now: string;
  planning: {
    ref: string;
    commit: string;
    tokens_path: string;
    latest: { version: string; commit: string; committed_at: string };
    versions: { version: string; first_commit: string; committed_at: string }[];
  };
  platform: { ref: string; commit: string; contracts_commit: string; committed_at: string } | null;
  locks: LockReport[];
  /** Present with --client-vectors. */
  client_vectors: {
    dir: string;
    manifest: Record<string, string>;
    locks: ClientVectorsLock[];
    disagreements: ClientVectorsDisagreement[];
  } | null;
  warnings: Warning[];
};

export type Options = {
  planning: string;
  planningRef?: string;
  platform: string;
  platformRef?: string;
  locks: { name: string; path: string }[];
  h5: boolean;
  clientVectors?: string;
  now?: number;
};

const iso = (ms: number): string => new Date(ms).toISOString();
const short = (sha: string): string => sha.slice(0, 12);

export function buildReport(opts: Options, wallClock: number): Report {
  requireRepo(opts.planning, '规划仓库');
  const planningRef = resolveRef(opts.planning, opts.planningRef, '规划仓库');
  const planningHead = planningRef.sha;
  const { history, invalid } = tokenHistory(opts.planning, planningHead);
  const latest = history[history.length - 1] as TokenRevision;
  const now = opts.now ?? Math.max(latest.time, wallClock);
  const warnings: Warning[] = invalid.map((r) => ({
    lock: null,
    kind: 'source-invalid',
    message: `令牌源历史里的提交 ${short(r.commit)} 读不出 metadata.version（不计为版本）：${r.reason}`,
  }));
  const locks: LockReport[] = [];

  const versions = distinctVersions(history).map((v) => {
    const first = history.find((r) => r.version === v) as TokenRevision;
    return { version: v, first_commit: first.commit, committed_at: iso(first.time) };
  });

  let platform: Report['platform'] = null;
  const clientLocks = opts.locks.map((l) => {
    let text: string;
    try {
      text = readFileSync(l.path, 'utf8');
    } catch {
      throw new InputError(`${l.name}: 读不了锁文件 ${l.path}`);
    }
    return { ...l, lock: parseContractLock(text, `${l.name} (${l.path})`) };
  });
  if (clientLocks.length > 0) {
    requireRepo(opts.platform, '本仓库');
    const platformRef = resolveRef(opts.platform, opts.platformRef, '本仓库');
    const head = platformRef.sha;
    const trunk = gitOut(opts.platform, [
      'log',
      '-1',
      '--format=%H %ct',
      head,
      '--',
      CONTRACTS_DIR,
    ]);
    if (trunk === null || trunk === '')
      throw new InputError(`本仓库 ${head} 上没有 ${CONTRACTS_DIR} 的提交`);
    const [trunkCommit = '', ct = ''] = trunk.split(' ');
    platform = {
      ref: platformRef.ref,
      commit: head,
      contracts_commit: trunkCommit,
      committed_at: iso(Number(ct) * 1000),
    };
  }

  const tokensFor = (
    name: string,
    commit: string,
    snapshot: { version: string | null; problem: string | null } | null,
  ): LockReport['tokens'] => {
    if (!hasCommit(opts.planning, commit) || !isAncestor(opts.planning, commit, planningHead)) {
      throw new InputError(
        `${name}: 令牌锁定提交 ${short(commit)} 不在规划仓库 ${short(planningHead)} 的历史里`,
      );
    }
    const text = gitOut(opts.planning, ['show', `${commit}:${TOKENS_PATH}`]);
    if (text === null) throw new InputError(`${name}: 提交 ${short(commit)} 里没有 ${TOKENS_PATH}`);
    const atCommit = tokenVersion(text, `${name} ${short(commit)}`);
    if (snapshot !== null && snapshot.version !== atCommit) {
      warnings.push({
        lock: name,
        kind: 'snapshot-mismatch',
        message:
          snapshot.version === null
            ? `${name}: 快照读不出版本（${snapshot.problem ?? ''}），按来源提交 ${short(commit)} 的版本 ${atCommit} 判定`
            : `${name}: 快照版本 ${snapshot.version} 与来源提交 ${short(commit)} 的版本 ${atCommit} 不符，按来源提交判定`,
      });
    }
    const version = atCommit;
    const lockedTime = commitTime(opts.planning, commit) ?? 0;
    const verdict = judgeTokens({
      history,
      lockedVersion: version,
      lockedTime,
      containsLatest: isAncestor(opts.planning, latest.commit, commit),
    });
    if (verdict.versionLag) {
      warnings.push({
        lock: name,
        kind: 'tokens-version',
        message:
          `${name}: 令牌锁版本 ${version} 落后源最新 ${verdict.latestVersion} ` +
          `${verdict.versionsBehind} 个版本`,
      });
    }
    if (verdict.timeLag) {
      warnings.push({
        lock: name,
        kind: 'tokens-days',
        message:
          `${name}: 令牌锁定提交 ${short(commit)} 早于源最新令牌提交 ${short(latest.commit)} ` +
          `${days(verdict.msBehind)} 天`,
      });
    }
    return {
      commit,
      committed_at: iso(lockedTime),
      version,
      latest_version: verdict.latestVersion,
      versions_behind: verdict.versionsBehind,
      days_behind: days(verdict.msBehind),
      age_days: days(Math.max(0, now - lockedTime)),
    };
  };

  for (const l of clientLocks) {
    const tokens = tokensFor(l.name, l.lock.tokensCommit, null);
    const p = platform as NonNullable<Report['platform']>;
    const commit = l.lock.contractCommit;
    const found = hasCommit(opts.platform, commit);
    const lockedTime = found ? commitTime(opts.platform, commit) : null;
    const verdict = judgeContract({
      found,
      lockedTime,
      trunkTime: Date.parse(p.committed_at),
      containsTrunk: found && isAncestor(opts.platform, p.contracts_commit, commit),
    });
    if (!found) {
      warnings.push({
        lock: l.name,
        kind: 'contract-missing',
        message: `${l.name}: 契约锁 rebate_platform.commit ${short(commit)} 在本仓库找不到该提交`,
      });
    } else if (verdict.timeLag && verdict.msBehind !== null) {
      warnings.push({
        lock: l.name,
        kind: 'contract-days',
        message:
          `${l.name}: 契约锁 ${short(commit)} 落后本仓库契约主干 ${short(p.contracts_commit)} ` +
          `${days(verdict.msBehind)} 天`,
      });
    }
    locks.push({
      name: l.name,
      source: 'contract.lock',
      path: l.path,
      tokens,
      contract: {
        commit,
        found,
        committed_at: lockedTime === null ? null : iso(lockedTime),
        days_behind: verdict.msBehind === null ? null : days(verdict.msBehind),
      },
    });
  }

  const mismatch = contractMismatch(
    clientLocks.map((l) => ({ name: l.name, commit: l.lock.contractCommit })),
  );
  if (mismatch) {
    warnings.push({
      lock: null,
      kind: 'contract-mismatch',
      message: `三端契约锁不一致：${mismatch.map((m) => `${m.name}=${short(m.commit)}`).join('，')}`,
    });
  }

  let clientVectors: Report['client_vectors'] = null;
  if (opts.clientVectors !== undefined) {
    const manifest = Object.fromEntries(
      Object.entries(verifiedManifest(opts.clientVectors).files).map(([p, e]) => [p, e.sha256]),
    );
    const judged = judgeClientVectors(
      manifest,
      clientLocks.map((l) => ({ name: l.name, files: l.lock.files })),
    );
    for (const l of judged.locks) {
      if (l.mismatched.length > 0) {
        warnings.push({
          lock: l.name,
          kind: 'client-vectors-mismatch',
          message:
            `${l.name}: 锁定的共享向量与本仓库清单不一致 ${String(l.mismatched.length)} 个：` +
            l.mismatched
              .map((m) =>
                m.manifest === null
                  ? `${LOCK_PREFIX}${m.path}（清单里没有）`
                  : `${LOCK_PREFIX}${m.path}（锁 ${m.locked.slice(0, 12)}，清单 ${m.manifest.slice(0, 12)}）`,
              )
              .join('，'),
        });
      }
      if (l.unlocked.length > 0) {
        warnings.push({
          lock: l.name,
          kind: 'client-vectors-unlocked',
          message:
            `${l.name}: 清单里有 ${String(l.unlocked.length)} 个共享向量没锁：` +
            l.unlocked.map((p) => `${LOCK_PREFIX}${p}`).join('，'),
        });
      }
    }
    for (const d of judged.disagreements) {
      warnings.push({
        lock: null,
        kind: 'client-vectors-disagree',
        message:
          `三端锁定的共享向量 ${LOCK_PREFIX}${d.path} 不一致：` +
          d.locks.map((x) => `${x.name}=${x.sha256.slice(0, 12)}`).join('，'),
      });
    }
    clientVectors = {
      dir: opts.clientVectors,
      manifest,
      locks: judged.locks,
      disagreements: judged.disagreements,
    };
  }

  if (opts.h5) {
    const snapshotPath = join(opts.platform, H5_SNAPSHOT);
    const readmePath = join(opts.platform, H5_README);
    let snapshot: string;
    let readme: string;
    try {
      snapshot = readFileSync(snapshotPath, 'utf8');
      readme = readFileSync(readmePath, 'utf8');
    } catch {
      throw new InputError(
        `h5: 读不了 ${H5_SNAPSHOT} 或 ${H5_README}（--platform ${opts.platform}）`,
      );
    }
    let snapshotVersion: string | null = null;
    let problem: string | null = null;
    try {
      snapshotVersion = tokenVersion(snapshot, `h5 ${H5_SNAPSHOT}`);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    const commit = readmeSourceCommit(readme);
    locks.push({
      name: 'h5',
      source: 'h5-snapshot',
      path: snapshotPath,
      tokens: tokensFor('h5', commit, { version: snapshotVersion, problem }),
      contract: null,
    });
  }

  return {
    now: iso(now),
    planning: {
      ref: planningRef.ref,
      commit: planningHead,
      tokens_path: TOKENS_PATH,
      latest: { version: latest.version, commit: latest.commit, committed_at: iso(latest.time) },
      versions,
    },
    platform,
    locks,
    client_vectors: clientVectors,
    warnings,
  };
}

export function summary(report: Report): string {
  const lines = [
    `TOKENS-LAG: 令牌源最新 ${report.planning.latest.version}（${short(report.planning.latest.commit)}）`,
  ];
  for (const l of report.locks) {
    let line =
      `  ${l.name}: 令牌 ${l.tokens.version}，落后 ${l.tokens.versions_behind} 个版本、` +
      `${l.tokens.days_behind} 天`;
    if (l.contract) {
      line += l.contract.found
        ? `；契约 ${short(l.contract.commit)} 落后 ${String(l.contract.days_behind)} 天`
        : `；契约 ${short(l.contract.commit)} 找不到该提交`;
    }
    lines.push(line);
  }
  if (report.client_vectors) {
    const total = Object.keys(report.client_vectors.manifest).length;
    for (const l of report.client_vectors.locks) {
      lines.push(
        `  ${l.name}: 共享向量 ${String(total)} 个，一致 ${String(l.matched.length)}、` +
          `不一致 ${String(l.mismatched.length)}、未锁 ${String(l.unlocked.length)}`,
      );
    }
  }
  if (report.warnings.length === 0) lines.push('无告警');
  else {
    lines.push(`告警 ${report.warnings.length} 条：`);
    for (const w of report.warnings) lines.push(`  - ${w.message}`);
  }
  return lines.join('\n');
}

/** A GitHub Actions workflow command; data is escaped as the runner expects. */
export function githubWarning(message: string): string {
  const data = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::warning title=TOKENS-LAG::${data}`;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE =
  'usage: node tools/ci/tokens-lag.ts --planning <dir> [--planning-ref <ref>] [--platform <dir>] ' +
  '[--platform-ref <ref>] [--lock <name>=<contract.lock>]... [--h5] ' +
  '[--client-vectors <specs/client dir>] [--now <ISO>]';

export function parseArgs(argv: readonly string[], cwd: string): Options {
  const opts: Partial<Options> & { locks: Options['locks'] } = {
    platform: cwd,
    locks: [],
    h5: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new InputError(`${arg} 缺少取值\n${USAGE}`);
      return v;
    };
    switch (arg) {
      case '--planning':
        opts.planning = resolve(cwd, value());
        break;
      case '--planning-ref':
        opts.planningRef = value();
        break;
      case '--platform':
        opts.platform = resolve(cwd, value());
        break;
      case '--platform-ref':
        opts.platformRef = value();
        break;
      case '--lock': {
        const v = value();
        const m = /^([a-z][a-z0-9-]*)=(.+)$/.exec(v);
        if (!m) throw new InputError(`--lock 要写成 <名字>=<路径>：${v}`);
        const name = m[1] ?? '';
        if (name === 'h5') throw new InputError('--lock 的名字不能是 h5（H5 用 --h5）');
        if (opts.locks.some((l) => l.name === name)) throw new InputError(`--lock ${name} 重复`);
        opts.locks.push({ name, path: resolve(cwd, m[2] ?? '') });
        break;
      }
      case '--h5':
        opts.h5 = true;
        break;
      case '--client-vectors':
        opts.clientVectors = resolve(cwd, value());
        break;
      case '--now': {
        const v = value();
        const t = Date.parse(v);
        if (Number.isNaN(t)) throw new InputError(`--now 不是 ISO 时间：${v}`);
        opts.now = t;
        break;
      }
      default:
        throw new InputError(`未知参数 ${arg}\n${USAGE}`);
    }
  }
  if (opts.planning === undefined) throw new InputError(`缺少 --planning\n${USAGE}`);
  if (opts.locks.length === 0 && !opts.h5)
    throw new InputError(`至少给一份 --lock 或 --h5\n${USAGE}`);
  return opts as Options;
}

export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
  cwd: string = process.cwd(),
): number {
  let report: Report;
  try {
    report = buildReport(parseArgs(argv, cwd), Date.now());
  } catch (err) {
    io.err(`TOKENS-LAG 输入错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  io.out(`${JSON.stringify(report, null, 2)}\n`);
  io.err(`${summary(report)}\n`);
  if (env['GITHUB_ACTIONS'] === 'true') {
    for (const w of report.warnings) io.err(`${githubWarning(w.message)}\n`);
  }
  return report.warnings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
