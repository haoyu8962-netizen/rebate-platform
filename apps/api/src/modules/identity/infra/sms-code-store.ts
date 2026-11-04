// Redis store of the SMS codes and of the per-phone send quota (BR-ID-05; orchestrator ruling B1-02e
// §9.3 #2–#4: Redis, no table; every key carries a TTL; every step one atomic Lua call; B1-02e review
// rounds 1–2 and B1-02l: an uncommitted send is never forgotten and is counted conservatively, the
// candidate code is stored before the SMS goes out, a reservation that was never marked as sending
// never voids the code in force and is cleaned up wherever it was left).
//
// Namespace `sms` (platform/redis prefixes every key with `sms:`). Keys hold no phone number and
// no code in clear: the caller passes `phoneKey`, an HMAC of the normalised number, and code HMACs
// (hex, so `,` never occurs in one).
//   q:<phoneKey>                    sorted set, the send history of one phone over every app and
//                                   purpose, one member per send of token T:
//                                     p:T  reserved, not marked: no SMS has left (score: reservation
//                                          time t);
//                                     s:T  marked as sending: the SMS may be out, its commit has not
//                                          run (score: t);
//                                     a:T  committed: accepted or outcome unknown (score: acceptance
//                                          time).
//                                   TTL 25 h, refreshed on every write (garbage collection only).
//   c:<app_id>:<purpose>:<phoneKey> hash, the codes of one app, purpose and phone:
//                                     h, t, e    the code in force: HMAC ('' when none), issued at
//                                                (ms), wrong tries;
//                                     n, k, nt, ne, s  the candidate of a send not committed: HMAC
//                                                ('' when none), token, reservation time, wrong
//                                                tries, state `r` (reserved) or `s` (sending);
//                                     u          purpose;
//                                     v          HMACs of replaced, consumed and voided codes,
//                                                comma-separated, newest last, at most VOID_LIMIT.
//                                   TTL 300 s, refreshed on every write (garbage collection only).
//
// Conservative counting. D is the caller's in-flight bound (send timeout plus a margin): mark is
// refused after t + D and the service sends only while now − t is within the margin, so a send
// reserved at t is accepted, if at all, within [t, t + D]. An `s:` (and a `p:`, while it may still
// be marked) counts over that interval: in every natural hour and day it touches, in the 60-second
// window until t + D + 60 s, in the rolling 24 hours until now − 24 h passes t + D. An `a:` counts
// at its acceptance time exactly. Every quota script drops a `p:` older than t + D + 60 s: it can no
// longer be marked, so it was never sent, whatever became of its code record (expired, or another
// app or purpose). Retry-After and the resend estimate follow the same counting, so they are never
// shorter than the rules allow.
//
// Code lifetime: a sending candidate is valid from its reservation time (it may be out already); a
// committed code from its acceptance time, as the response promises (expires_in_sec = 300); a
// sending candidate put in force by a later reservation (its commit never ran) keeps its
// reservation time.
//
// State machine of one send (token T, candidate C):
//   reserve  — first a reserved (`r`) candidate of the record that can no longer be marked
//              (nt + D + 60 s passed) is dropped together with its `p:`. Then: limits hold →
//              limited; C equals h, n or a void HMAC → collision (the caller draws another code); in
//              both cases nothing else is written. Otherwise one call adds p:T and stores C as
//              candidate in state `r`. A candidate still there is settled first: `s` (it may have
//              gone out) becomes the code in force, the code it replaces goes to v; `r` is dropped
//              with its `p:`. While C is `r` the code in force stays valid and C cannot be verified.
//   mark     — only while now ≤ t + D and the record still holds T's candidate: p:T becomes s:T
//              (same score) and the candidate `s`; idempotent once marked. Otherwise 0, and the
//              caller must not send. From `s` on, C is the current code and h is void.
//   commit   — after acceptance or an unknown outcome: p:T / s:T becomes a:T at the acceptance time
//              and, if the candidate is still T's, C becomes the code in force (h=C, t=acceptance,
//              e=ne) and the replaced code goes to v. Idempotent per token.
//   release  — after a definite rejection, or when the send never left: p:T / s:T is removed and
//              T's candidate dropped; the code in force is valid again, its wrong tries plus the
//              candidate's when the candidate was `s` (five void it). Idempotent; a candidate already
//              consumed or voided is no longer T's, so release never revives the code it replaced.
//   consumeCurrent — B1-02zza (staging test phones): the service already matched the node's fixed
//              code; the current code (n when the candidate is `s`, else h) is consumed exactly as a
//              match in verify would be, under the same expiry and wrong-try limit. No current code
//              (never sent, a reserved candidate only, expired, consumed, void) → void.
//   verify   — a code in v, or the previous code while the candidate is `s`, is void; the current
//              code is n when the candidate is `s`, else h; a match consumes it, the fifth wrong try
//              voids it; consuming or voiding moves the current code (and with `s` the previous one)
//              to v.
//
// What a Redis fault leaves behind (the service retries mark, commit and release once each):
//   - reserve's reply lost, mark refused (0) or never run (process stopped between reserve and
//     mark, or both mark attempts failed before running), each followed by a failed release (two
//     faults): p:T counts until t + D + 60 s and is then dropped by the next quota script on this
//     phone, whatever the code record; the `r` candidate never voids the code in force and goes
//     with the next reservation of its key or with the key's TTL.
//   - mark ran but both of its replies were lost, and both release attempts failed (at least four
//     faults), or the send was refused after mark (late, definite rejection) and both release
//     attempts failed (two faults, or a stall plus two faults): s:T counts as a send over
//     [t, t + D] and the candidate `s` stays current, so the previous code is void and the
//     undelivered candidate is current until it expires (300 s from t) or the next reservation of
//     its key puts it in force. One send too many is counted; no SMS more than the rules allow
//     goes out and no void code is accepted. The user asks for a new code once the window allows.
//   - commit failed twice after the provider answered: s:T keeps counting over [t, t + D] (the
//     acceptance is within it) and the candidate stays current: correct, only conservative.
// Times are the injected Clock's epoch milliseconds, passed in by the caller: windows and expiry are
// judged on them, never on Redis TTLs (ADR-0001 §4.2 #10; a FixedClock does not move Redis time).
//
// TTLs: platform/redis passes one TTL as ARGV[1]. The verify script writes only the code key and
// expires it with ARGV[1]. Reserve, mark, commit and release share one argument layout and must
// change both keys atomically, and the keys live for different times (25 h of history, 300 s of
// codes): they expire the quota key with ARGV[1] and the code key with ARGV[13], the code TTL,
// which each of them checks (≥ 1) before any write. Only ZADD and HSET can create a key, and each
// is followed directly by the EXPIRE of its key: once a script has written, Redis no longer refuses
// its commands for memory, so nothing can fail between the two (sms-codes.test.ts pins the order).
//
// Failures are platform/redis errors (RedisUnavailableError when Redis cannot answer, also for an
// error reply); the caller decides.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import { RedisUnavailableError, type RedisHandle } from '../../platform/index.ts';
import {
  SMS_CODE_LIFETIME_SECONDS,
  SMS_CODE_MAX_ERRORS,
  SMS_PER_NATURAL_DAY,
  SMS_PER_NATURAL_HOUR,
  SMS_PER_ROLLING_WINDOW,
  SMS_RESEND_INTERVAL_MS,
  SMS_ROLLING_WINDOW_MS,
  naturalWindows,
} from '../domain/sms-limits.ts';

const NAMESPACE = 'sms';
/** Longer than the 24-hour rolling window and the natural day; garbage collection only. */
const QUOTA_TTL_SECONDS = 90_000;
/** Most void code HMACs a code record keeps (at most 10 sends a day reach one phone). */
const VOID_LIMIT = 16;

/** Shared Lua: the comma-separated void list. */
const VOID_LIB = `
local function with_void(list, hash)
  local items = {}
  if list and list ~= '' then
    for item in string.gmatch(list, '[^,]+') do items[#items + 1] = item end
  end
  if hash and hash ~= '' then items[#items + 1] = hash end
  while #items > ${String(VOID_LIMIT)} do table.remove(items, 1) end
  return table.concat(items, ',')
end
local function in_void(list, hash)
  if hash == '' or not list or list == '' then return false end
  for item in string.gmatch(list, '[^,]+') do
    if item == hash then return true end
  end
  return false
end
`;

/**
 * Shared Lua of reserve, mark, commit and release. KEYS[1] quota key, KEYS[2] code key. ARGV[1]
 * quota TTL, [2] now, [3] token, [4] hour start, [5] next hour, [6] day start, [7] next day,
 * [8] interval, [9] per hour, [10] per day, [11] per rolling window, [12] window, [13] code TTL,
 * [14] candidate HMAC (reserve), [15] purpose (reserve), [16] in-flight bound D (ms).
 * The argument checks come first: nothing is written before them.
 */
const QUOTA_LIB = `${VOID_LIB}
local code_ttl = tonumber(ARGV[13])
local in_flight = tonumber(ARGV[16])
if not code_ttl or code_ttl < 1 then return redis.error_reply('ERR sms code TTL must be >= 1') end
if not in_flight or in_flight < 0 then return redis.error_reply('ERR sms in-flight bound must be >= 0') end
local key, code_key = KEYS[1], KEYS[2]
local now = tonumber(ARGV[2])
local token = ARGV[3]
local hour_start, next_hour = tonumber(ARGV[4]), tonumber(ARGV[5])
local day_start, next_day = tonumber(ARGV[6]), tonumber(ARGV[7])
local interval = tonumber(ARGV[8])
local per_hour, per_day = tonumber(ARGV[9]), tonumber(ARGV[10])
local per_window, window = tonumber(ARGV[11]), tonumber(ARGV[12])
local max_errors = ${String(SMS_CODE_MAX_ERRORS)}
local wrote = false
-- Each entry as [low, high]: an a: at its acceptance time, an s: (and a p: that may still be
-- marked) over [reservation, reservation + D]. A p: older than reservation + D + 60 s can no longer
-- be marked: it was never sent and is dropped. An entry leaves the rolling window when
-- now - window reaches its high end.
local function history()
  local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  local lows, highs = {}, {}
  for i = 1, #entries, 2 do
    local at = tonumber(entries[i + 1])
    local kind = string.sub(entries[i], 1, 2)
    local high = at
    if kind ~= 'a:' then high = at + in_flight end
    if (kind == 'p:' and high + interval <= now) or high <= now - window then
      redis.call('ZREM', key, entries[i])
      wrote = true
    else
      lows[#lows + 1] = at
      highs[#highs + 1] = high
    end
  end
  return lows, highs
end
-- The latest release over the 60-second window, the natural hour and day an entry touches, and the
-- rolling window; 0 when nothing holds.
local function release_at(lows, highs)
  local release = 0
  local n = #highs
  local in_hour, in_day = 0, 0
  local sorted = {}
  for i = 1, n do
    local high = highs[i]
    if high + interval > now and high + interval > release then release = high + interval end
    if high >= hour_start then in_hour = in_hour + 1 end
    if high >= day_start then in_day = in_day + 1 end
    sorted[i] = high
  end
  if in_hour >= per_hour and next_hour > release then release = next_hour end
  if in_day >= per_day and next_day > release then release = next_day end
  if n >= per_window then
    table.sort(sorted)
    local rolling = sorted[n - per_window + 1] + window
    if rolling > release then release = rolling end
  end
  return release
end
local function touch_quota()
  if wrote and redis.call('EXISTS', key) == 1 then redis.call('EXPIRE', key, ARGV[1]) end
end
`;

/**
 * {0, release ms} limited; {2, 0} the candidate collides with a code of the record; {1, release ms}
 * reserved and candidate stored as `r`, with the release this send causes when counted
 * conservatively (the caller's fallback when the commit cannot run).
 */
const RESERVE = `-- sms:reserve
${QUOTA_LIB}
local candidate = ARGV[14]
local r = redis.call('HMGET', code_key, 'h', 't', 'e', 'n', 'k', 'nt', 'ne', 's', 'v')
local h, t, e = r[1] or '', r[2] or '0', r[3] or '0'
local n, k, nt, ne, state, v = r[4] or '', r[5] or '', r[6] or '0', r[7] or '0', r[8] or '', r[9] or ''
local dropped = false
local function drop_candidate()
  redis.call('ZREM', key, 'p:' .. k)
  wrote = true
  n, k, nt, ne, state = '', '', '0', '0', ''
  dropped = true
end
local function save_drop()
  if not dropped then return end
  if h == '' and v == '' then
    redis.call('DEL', code_key)
  else
    redis.call('HSET', code_key, 'n', '', 'k', '', 'nt', '', 'ne', '0', 's', '')
    redis.call('EXPIRE', code_key, code_ttl)
  end
end
-- A reserved candidate that can no longer be in flight was never sent: it counts for nothing.
if n ~= '' and state ~= 's' and (tonumber(nt) or 0) + in_flight + interval <= now then
  drop_candidate()
end
local lows, highs = history()
local release = release_at(lows, highs)
if release > now then
  save_drop()
  touch_quota()
  return {0, release}
end
if candidate == h or candidate == n or in_void(v, candidate) then
  save_drop()
  touch_quota()
  return {2, 0}
end
if n ~= '' then
  if state == 's' then
    -- It may have gone out: it is the code in force, the code it replaces is void.
    v = with_void(v, h)
    h, t, e = n, nt, ne
  else
    drop_candidate()
  end
end
redis.call('ZADD', key, now, 'p:' .. token)
redis.call('EXPIRE', key, ARGV[1])
redis.call('HSET', code_key, 'h', h, 't', t, 'e', e, 'n', candidate, 'k', token, 'nt', ARGV[2],
  'ne', '0', 's', 'r', 'u', ARGV[15], 'v', v)
redis.call('EXPIRE', code_key, code_ttl)
lows[#lows + 1] = now
highs[#highs + 1] = now + in_flight
return {1, release_at(lows, highs)}
`;

/**
 * T's candidate goes from reserved to sending while now ≤ t + D: 1, idempotent once marked; 0 when
 * the reservation is too old, gone, or the record no longer holds T's candidate.
 */
const MARK = `-- sms:mark
${QUOTA_LIB}
local r = redis.call('HMGET', code_key, 'n', 'k', 's')
if r[2] ~= token or not r[1] or r[1] == '' then return 0 end
if redis.call('ZSCORE', key, 's:' .. token) then
  if r[3] ~= 's' then
    redis.call('HSET', code_key, 's', 's')
    redis.call('EXPIRE', code_key, code_ttl)
  end
  return 1
end
local reserved = redis.call('ZSCORE', key, 'p:' .. token)
if not reserved or now > tonumber(reserved) + in_flight then return 0 end
redis.call('ZREM', key, 'p:' .. token)
redis.call('ZADD', key, reserved, 's:' .. token)
redis.call('EXPIRE', key, ARGV[1])
redis.call('HSET', code_key, 's', 's')
redis.call('EXPIRE', code_key, code_ttl)
return 1
`;

/** Count the send as accepted at now and put its candidate in force; returns the next release. */
const COMMIT = `-- sms:commit
${QUOTA_LIB}
if not redis.call('ZSCORE', key, 'a:' .. token) then
  redis.call('ZREM', key, 'p:' .. token, 's:' .. token)
  redis.call('ZADD', key, now, 'a:' .. token)
  redis.call('EXPIRE', key, ARGV[1])
end
local r = redis.call('HMGET', code_key, 'h', 'n', 'k', 'ne', 'v')
if r[3] == token and r[2] and r[2] ~= '' then
  -- In force from the acceptance time, as the response promises (expires_in_sec).
  redis.call('HSET', code_key, 'h', r[2], 't', ARGV[2], 'e', r[4] or '0', 'n', '', 'k', '',
    'nt', '', 'ne', '0', 's', '', 'v', with_void(r[5] or '', r[1] or ''))
  redis.call('EXPIRE', code_key, code_ttl)
end
local lows, highs = history()
touch_quota()
return release_at(lows, highs)
`;

/**
 * The send counts for nothing and T's candidate is dropped; the code in force takes over the
 * candidate's wrong tries when the candidate was sending (five void it).
 */
const RELEASE = `-- sms:release
${QUOTA_LIB}
redis.call('ZREM', key, 'p:' .. token, 's:' .. token)
if redis.call('EXISTS', key) == 1 then redis.call('EXPIRE', key, ARGV[1]) end
local r = redis.call('HMGET', code_key, 'h', 'e', 'k', 'ne', 's', 'v')
if r[3] == token then
  local h, v = r[1] or '', r[6] or ''
  local e = tonumber(r[2]) or 0
  if r[5] == 's' then e = e + (tonumber(r[4]) or 0) end
  if h ~= '' and e >= max_errors then
    v = with_void(v, h)
    h, e = '', 0
  end
  if h == '' and v == '' then
    redis.call('DEL', code_key)
  else
    redis.call('HSET', code_key, 'h', h, 'e', e, 'v', v, 'n', '', 'k', '', 'nt', '', 'ne', '0',
      's', '')
    redis.call('EXPIRE', code_key, code_ttl)
  end
end
return 1
`;

/**
 * Check and consume: 0 consumed; 2 wrong (counted; the fifth wrong try voids the code); 3 no valid
 * code (none, replaced, consumed, expired by Clock, void, or the previous code while the candidate
 * is sending). A reserved candidate is not a code yet. KEYS[1] code key. ARGV[1] code TTL, [2] code
 * HMAC ('' never matches), [3] now, [4] lifetime ms, [5] max wrong tries.
 */
const VERIFY = `-- sms:verify
${VOID_LIB}
local key = KEYS[1]
local given = ARGV[2]
local now, lifetime, max_errors = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local r = redis.call('HMGET', key, 'h', 't', 'e', 'n', 'nt', 'ne', 's', 'v')
if not r[1] and not r[4] then return 3 end
local h, n, v = r[1] or '', r[4] or '', r[8] or ''
local sending = n ~= '' and r[7] == 's'
local function close()
  if sending then
    redis.call('HSET', key, 'h', '', 'e', '0', 'n', '', 'k', '', 'nt', '', 'ne', '0', 's', '',
      'v', with_void(with_void(v, h), n))
  else
    redis.call('HSET', key, 'h', '', 'e', '0', 'v', with_void(v, h))
  end
  redis.call('EXPIRE', key, ARGV[1])
end
if in_void(v, given) then return 3 end
local current, issued, errors, counter = h, tonumber(r[2]) or 0, tonumber(r[3]) or 0, 'e'
if sending then
  -- The candidate may have gone out: it is the current code, and the code it replaces is void.
  if given ~= '' and given == h then return 3 end
  current, issued, errors, counter = n, tonumber(r[5]) or 0, tonumber(r[6]) or 0, 'ne'
end
if current == '' then return 3 end
if now - issued >= lifetime or errors >= max_errors then
  close()
  return 3
end
if given ~= '' and given == current then
  close()
  return 0
end
errors = redis.call('HINCRBY', key, counter, 1)
if errors >= max_errors then
  close()
else
  redis.call('EXPIRE', key, ARGV[1])
end
return 2
`;

/**
 * Consume the current code without comparing (B1-02zza: the caller matched the staging fixed
 * code): 0 consumed; 3 no valid current code. KEYS[1] code key. ARGV[1] code TTL, [2] now,
 * [3] lifetime ms, [4] max wrong tries. Same state rules as VERIFY's match branch.
 */
const CONSUME_CURRENT = `-- sms:consume
${VOID_LIB}
local key = KEYS[1]
local now, lifetime, max_errors = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local r = redis.call('HMGET', key, 'h', 't', 'e', 'n', 'nt', 'ne', 's', 'v')
if not r[1] and not r[4] then return 3 end
local h, n, v = r[1] or '', r[4] or '', r[8] or ''
local sending = n ~= '' and r[7] == 's'
local function close()
  if sending then
    redis.call('HSET', key, 'h', '', 'e', '0', 'n', '', 'k', '', 'nt', '', 'ne', '0', 's', '',
      'v', with_void(with_void(v, h), n))
  else
    redis.call('HSET', key, 'h', '', 'e', '0', 'v', with_void(v, h))
  end
  redis.call('EXPIRE', key, ARGV[1])
end
local current, issued, errors = h, tonumber(r[2]) or 0, tonumber(r[3]) or 0
if sending then
  current, issued, errors = n, tonumber(r[5]) or 0, tonumber(r[6]) or 0
end
if current == '' then return 3 end
close()
if now - issued >= lifetime or errors >= max_errors then return 3 end
return 0
`;

/** The two keys of one send: the phone's history and the codes of (app, purpose, phone). */
export interface SmsKeys {
  readonly phoneKey: string;
  /** `<app_id>:<purpose>:<phoneKey>` */
  readonly codeKey: string;
}

export type ReserveOutcome =
  /** `releaseAtMs`: next release with this send counted conservatively. */
  | { readonly kind: 'reserved'; readonly releaseAtMs: number }
  | { readonly kind: 'limited'; readonly releaseAtMs: number }
  | { readonly kind: 'collision' };

export type VerifyOutcome = 'consumed' | 'wrong' | 'void';

export interface SmsCodeStore {
  reserve(
    keys: SmsKeys,
    token: string,
    candidateHash: string,
    purpose: string,
    nowMs: number,
  ): Promise<ReserveOutcome>;
  /**
   * Idempotent once marked. False when the reservation is older than the in-flight bound, gone, or
   * the record no longer holds T's candidate: do not send.
   */
  mark(keys: SmsKeys, token: string, nowMs: number): Promise<boolean>;
  /** Idempotent per token. Returns when the next send of this phone may go (epoch ms). */
  commit(keys: SmsKeys, token: string, nowMs: number): Promise<number>;
  /** Idempotent. */
  release(keys: SmsKeys, token: string, nowMs: number): Promise<void>;
  verify(codeKey: string, codeHash: string, nowMs: number): Promise<VerifyOutcome>;
  /** B1-02zza: consumes the current code without comparing ('wrong' never comes back). */
  consumeCurrent(codeKey: string, nowMs: number): Promise<Exclude<VerifyOutcome, 'wrong'>>;
}

export interface SmsCodeStoreOptions {
  /**
   * Longest time from a reservation to the provider's answer, in milliseconds (the send timeout
   * plus a margin for the steps around it): the conservative span of an uncommitted send.
   */
  readonly inFlightMs: number;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RedisUnavailableError('unexpected_reply');
  }
  return value;
}

const sendKeys = (keys: SmsKeys): string[] => [`q:${keys.phoneKey}`, `c:${keys.codeKey}`];

export function createSmsCodeStore(
  redis: Pick<RedisHandle, 'namespace'>,
  options: SmsCodeStoreOptions,
): SmsCodeStore {
  const { inFlightMs } = options;
  if (!Number.isSafeInteger(inFlightMs) || inFlightMs < 0) {
    throw new TypeError('createSmsCodeStore: inFlightMs must be a non-negative integer');
  }
  const sendArgs = (token: string, nowMs: number, candidateHash = '', purpose = ''): string[] => {
    const windows = naturalWindows(nowMs);
    return [
      String(nowMs),
      token,
      String(windows.hourStartMs),
      String(windows.nextHourMs),
      String(windows.dayStartMs),
      String(windows.nextDayMs),
      String(SMS_RESEND_INTERVAL_MS),
      String(SMS_PER_NATURAL_HOUR),
      String(SMS_PER_NATURAL_DAY),
      String(SMS_PER_ROLLING_WINDOW),
      String(SMS_ROLLING_WINDOW_MS),
      String(SMS_CODE_LIFETIME_SECONDS),
      candidateHash,
      purpose,
      String(inFlightMs),
    ];
  };
  // Taken per call: a handle closed later rejects there, never while the service is built.
  const eval_ = async (
    script: string,
    keys: readonly string[],
    args: readonly string[],
    ttlSeconds: number,
  ): Promise<unknown> => await redis.namespace(NAMESPACE).eval(script, { keys, args, ttlSeconds });
  const sendScript = (script: string, keys: SmsKeys, args: readonly string[]) =>
    eval_(script, sendKeys(keys), args, QUOTA_TTL_SECONDS);

  return Object.freeze({
    async reserve(
      keys: SmsKeys,
      token: string,
      candidateHash: string,
      purpose: string,
      nowMs: number,
    ): Promise<ReserveOutcome> {
      const reply = await sendScript(RESERVE, keys, sendArgs(token, nowMs, candidateHash, purpose));
      if (!Array.isArray(reply) || reply.length !== 2) {
        throw new RedisUnavailableError('unexpected_reply');
      }
      const [state, releaseAtMs] = [integer(reply[0]), integer(reply[1])];
      if (state === 1) return { kind: 'reserved', releaseAtMs };
      if (state === 0) return { kind: 'limited', releaseAtMs };
      if (state === 2) return { kind: 'collision' };
      throw new RedisUnavailableError('unexpected_reply');
    },
    async mark(keys: SmsKeys, token: string, nowMs: number): Promise<boolean> {
      const reply = integer(await sendScript(MARK, keys, sendArgs(token, nowMs)));
      if (reply === 1) return true;
      if (reply === 0) return false;
      throw new RedisUnavailableError('unexpected_reply');
    },
    async commit(keys: SmsKeys, token: string, nowMs: number): Promise<number> {
      return integer(await sendScript(COMMIT, keys, sendArgs(token, nowMs)));
    },
    async release(keys: SmsKeys, token: string, nowMs: number): Promise<void> {
      await sendScript(RELEASE, keys, sendArgs(token, nowMs));
    },
    async verify(codeKey: string, codeHash: string, nowMs: number): Promise<VerifyOutcome> {
      const reply = integer(
        await eval_(
          VERIFY,
          [`c:${codeKey}`],
          [
            codeHash,
            String(nowMs),
            String(SMS_CODE_LIFETIME_SECONDS * 1000),
            String(SMS_CODE_MAX_ERRORS),
          ],
          SMS_CODE_LIFETIME_SECONDS,
        ),
      );
      if (reply === 0) return 'consumed';
      if (reply === 2) return 'wrong';
      if (reply === 3) return 'void';
      throw new RedisUnavailableError('unexpected_reply');
    },
    async consumeCurrent(codeKey: string, nowMs: number): Promise<Exclude<VerifyOutcome, 'wrong'>> {
      const reply = integer(
        await eval_(
          CONSUME_CURRENT,
          [`c:${codeKey}`],
          [String(nowMs), String(SMS_CODE_LIFETIME_SECONDS * 1000), String(SMS_CODE_MAX_ERRORS)],
          SMS_CODE_LIFETIME_SECONDS,
        ),
      );
      if (reply === 0) return 'consumed';
      if (reply === 3) return 'void';
      throw new RedisUnavailableError('unexpected_reply');
    },
  });
}
