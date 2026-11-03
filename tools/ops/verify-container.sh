#!/usr/bin/env bash
# Out-of-sandbox verification (规划/11 §2.3 steps 3, 5 and 7, §4.1, §9.3 #6; ADR-0001 §4.2 #9, §7).
#
#   verify-container.sh <id> [--worktree <path>] [--fast | --red [--base <ref>] | --browser]
#                           [--dry-run]
#
#   (default)  `pnpm verify` — the task's verification; it alone decides the task. verify/<n>/
#   --fast     `pnpm run verify:fast` — the entry the Claude Opus implementation subagent uses for
#              its own test runs (default split of 2026-10-05, ops/approvals.yaml id 19). No
#              PostgreSQL, no Redis, `--network none`. verify-fast/<n>/; never evidence of
#              verification.
#   --red      the isolated red run of the rule tests Codex wrote (规划/11 §2.3 step 3; CR-12):
#              only the task's new rule-test files (inside its trusted test_paths, changed
#              against --base, default the branch point with origin/main), each run by the
#              trusted Vitest project that takes it (tools/ops/red-plan.ts, red-projects.json;
#              a file no project takes stops the run, CR2-04) with the trusted red reporter
#              (verify-image/red-reporter.mjs, keeps the failure causes, CR2-03); reports go to
#              red/<n>/out/<project>.json and tools/guard/red-check.ts reconciles them with the
#              expected list (exit code = red-check's). The groups whose project needs
#              PostgreSQL run in their own container with the one-shot PostgreSQL and Redis on the
#              internal network; all other groups run in a container with no network and no
#              database URL. A browser rule test (project `browser: true`, spec-browser) needs an
#              image with Playwright's browser: without playwright in the lockfile the run stops.
#   --browser  the browser tests: every browser project of red-projects.json, in its order, in one
#              container with `--network none` (loopback only) and the image's headless Chromium:
#              spec-browser (F1-01j: every test/spec/**/*.browser.test.{ts,tsx}, Vitest browser
#              mode) and build-smoke (F1-01k: builds the H5 entries and the admin console, serves
#              them on 127.0.0.1 and opens each one; every test/spec/**/*.smoke.test.ts).
#              Screenshots and one Vitest JSON report per project are exported to browser/<n>/out/
#              (screenshots/ — the build smoke's are screenshots/smoke-<entry>.png —,
#              <project>.vitest-report.json) for comparison with the design boards; the log counts
#              both kinds. Exit code = the first failing project's (every project still runs), or
#              1 when all passed but no screenshot was exported. Like --fast an implementer's own
#              check, never
#              evidence of verification (tools/ci/evidence-check.ts accepts verify and red only).
#   --dry-run  prints what would run (script, commit, tree, red files) as one JSON line and
#              starts nothing; no run directory is created.
#
# There is no host fallback (CR-01; 规划/11 §4.1, §8): every test or task file runs only in this
# container. `--host` is refused; without Docker the script stops (exit 2) and the run goes to CI.
#
# The container has no way out:
#   - per-run `--internal` network (or none); a one-shot PostgreSQL (TEST_PG_ADMIN_URL) and a
#     one-shot Redis (TEST_REDIS_URL) attached ONLY to it, no published port, data on tmpfs;
#   - worktree mounted read-only at /src and copied to a tmpfs before anything runs;
#   - dependencies from an offline pnpm store (volume keyed by the lockfile hash;
#     filled by one networked `pnpm fetch` that sees nothing but the lockfile and
#     pnpm-workspace.yaml);
#   - non-root, read-only root file system, no capabilities, no Docker socket; the red run
#     additionally mounts its own output directory (reports only);
#   - planning text for guards and tools tests comes from a read-only, single-commit
#     snapshot of the planning repository at SPEC_REF, mounted at /spec.
# Exit code = the exit code of the script run (124 = time limit); --red: red-check's. Exit code
# 2 = usage or infrastructure error (no result.json is written in that case).
#
# Output: <runs>/<id>/{verify,verify-fast,red,browser}/<n>/log.txt and result.json
#   { mode: container, script: verify|verify:fast|red|browser, exit_code, commit, tree,
#     prop_seed, prop_runs, started_at, finished_at }  — red adds red_tests, expected and reports
#     (path + sha256); browser leaves its screenshots and report in out/.
# `tree` is the git tree of the work tree as verified (uncommitted changes included). The tree
# is exported once into an immutable snapshot and that snapshot is what gets verified, so the
# hash and the exit code always describe the same files; git-ignored paths never reach it.
#
# The image: tools/ops/verify-image/Dockerfile with the pnpm of `packageManager` and the
# Playwright browser of the lockfile's `playwright` version (none: no browser); both versions are
# part of the image tag, so a lockfile that moves either one builds a new image.
#
# This script, the Dockerfile and the entrypoint are gates: run them from the
# trusted root, never from the task worktree (规划/11 §2.4).
#
# Environment: COULI_RUNS, COULI_TRUSTED_ROOT, COULI_SPEC_REPO (conventions C7);
#   COULI_VERIFY_TIMEOUT_SECS (default 3600, at most 3600; CT-06v, CT-06zxf); COULI_VERIFY_PREFIX (default couli-verify;
#   COULI_VERIFY_VITEST_MAX_WORKERS (default 2, an integer 1..32; CT-06zzza): VITEST_MAX_WORKERS of every
#   container that runs tests. turbo runs every package's tests at once and each vitest would start one
#   worker per CPU less one, which starved the AppModule start-up tests past their 5 s on this Mac.
#   prefix of every container, network and volume this script creates);
#   PROP_SEED (default 20261001) reaches every run. PROP_RUNS has no default here (D10-499): it is
#   passed only when the caller sets it, and result.json records it as prop_runs (null when unset).
#   Unset, the pure property tests keep the 10000 of @couli/testing (规划/11 §4.2) and the integration
#   tests take the 2000 of their test:int scripts (D10-210, D10-499).
#
# Host services (owner 2026-10-08/09: no Docker on the orchestrating Mac; runs go to the AWS test
# machine, and the test database does not run in Docker there — plan A of 2026-10-09). With
# COULI_VERIFY_HOST_SERVICES=1 every run that needs databases (pnpm verify, the integration groups
# of --red) gets, instead of the PostgreSQL and Redis containers, a fresh one-shot PostgreSQL and
# Redis started from the host's installed binaries and removed after the run:
#   COULI_VERIFY_SVC_USER   unprivileged user the services run as (default couli-svc); it must
#                           have no group but COULI_VERIFY_SVC_GROUP
#   COULI_VERIFY_SVC_GROUP  group of the sockets (default couli-sock); only the run's container
#                           gets it (--group-add)
#   COULI_VERIFY_SVC_ROOT   tmpfs for the instances (default /var/lib/couli-ephemeral, 0700 user)
#   COULI_VERIFY_PG_BIN     PostgreSQL 18 binaries (default /usr/lib/postgresql/18/bin)
#   COULI_VERIFY_REDIS_BIN  directory of redis-server and redis-cli (default /usr/bin)
# The host is prepared once by couli-runs/RUNNER/setup-isolation.sh; this script needs sudo
# (systemd-run, systemctl, nft, install, rm) and flock. What changes in that mode, and nothing else:
#   - before the services start: the nftables table `inet couli_isolation` must reject every packet
#     of the services user (checked, plus a live probe as that user), else exit 2; one run at a
#     time on the whole host (flock on /run/lock/couli-host-services.lock, shared by every lane
#     and every COULI_RUNS; the lock dies with the process); the instance root must be the
#     dedicated tmpfs mount point (owned by the services user, 0700), else exit 2; whatever an
#     earlier killed run left (containers labelled couli.services=host, transient units
#     couli-svc-*, the directories of runs in the registry /run/lock/couli-host-services.runs, the
#     user's processes, /dev/shm, /dev/mqueue and SysV IPC objects) is removed first, or the run
#     stops (exit 2); an unregistered entry in the instance root is never removed (exit 2);
#   - initdb on the tmpfs (superuser postgres, a random password that exists only in this run; it
#     reaches initdb on stdin, never a command line), then postgres (listen_addresses='', unix
#     socket only, 0770 to the socket group) and redis-server (port 0, unix socket only, no RDB or
#     AOF, maxmemory 256mb noeviction as infra/local/compose.yaml / ADR-0001 §4.2 #17; MIGRATE,
#     REPLICAOF, SLAVEOF, MODULE, DEBUG, SAVE, BGSAVE, BGREWRITEAOF, SHUTDOWN, FAILOVER, SYNC,
#     PSYNC disabled, protected settings immutable; CONFIG stays for the rule tests' CONFIG GET),
#     each a transient systemd unit as the services user, sandboxed: own empty network namespace,
#     AF_UNIX only, IPAddressDeny=any, own IPC namespace (RemoveIPC), /tmp, /var/tmp and /dev/shm
#     inside the run directory on the tmpfs, read-only system, no /home, /root, /run, /Users,
#     /var/log, /data or the host services' configuration (Pigsty's passwords), only its own run
#     directory writable, no capabilities, no new privileges, @system-service calls only,
#     MemoryMax=4G, TasksMax=512, own /proc view, RuntimeMaxSec; whatever COPY ... PROGRAM starts
#     runs inside that sandbox too;
#   - the database container runs with `--network none` and gets only the run's socket directory
#     (the two sockets) read-only, the socket group, and a small proxy (node, written by this
#     script, mounted read-only) on 127.0.0.1:5432 / 127.0.0.1:6379 that forwards to the two
#     sockets: TEST_PG_ADMIN_URL is postgres://postgres:<password>@127.0.0.1:5432/postgres and
#     TEST_REDIS_URL redis://127.0.0.1:6379/0 (packages/db/src/pg-url.ts and the test Redis probe
#     take host:port URLs only; pg_dump of db:check connects the same way);
#   - after the run (also on failure, time-out or signal) the units are stopped and the run
#     directory removed, each confirmed: a unit is stopped only when systemd says not-found, or
#     loaded and inactive / failed (no answer, an empty answer or a time-out is not stopped); no
#     process of the services user may be left; the directory must be reported absent (a check
#     that cannot run is not "absent"); no IPC or shared memory may be left. result.json is written
#     only after all that succeeded (a failed clean-up or a service that does not start is an
#     infrastructure error: exit 2, no result.json); the one-shot password is replaced in the log,
#     red-check.json and every regular file under out/ before the result is derived from them
#     (handed to node on stdin, never on a command line; a failure is exit 2); the database
#     container's whole docker run has a host-side hard limit (its own limit plus 15 minutes):
#     past it the containers are removed and the run stops with exit 2, no result;
#   - result.json has "gate" (recorded when the run starts: the trusted root's commit, whether its
#     tracked files equal that commit — an overlaid gate does not —, this script's sha256) and
#     "services": "host-ephemeral".
# Unset, the script behaves exactly as without these lines.
set -euo pipefail

PG_IMAGE='pgvector/pgvector:0.8.6-pg18-trixie'
# Same image as infra/local/compose.yaml and the verify-int job of .github/workflows/ci.yml.
REDIS_IMAGE='redis:7.4.11-alpine'
DEFAULT_PROP_SEED=20261001

log() { printf '%s\n' "$*" >&2; }
die() { log "verify-container: $*"; exit 2; }
usage() { log "usage: verify-container.sh <id> [--worktree <path>] [--fast | --red [--base <ref>] | --browser] [--dry-run]"; exit 2; }

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1
  fi
}

now_utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# True when $1 is $2 or lies below it (both absolute, physical paths).
is_under() {
  [ -n "$2" ] || return 1
  case "$1/" in "$2"/*) return 0 ;; esac
  return 1
}

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SELF_ROOT="$(cd "$SELF_DIR/../.." && pwd -P)"

ID=''
WORKTREE=''
MODE='container'
SCRIPT='verify'
BASE_ARG=''
DRY_RUN=0
set_script() {
  [ "$SCRIPT" = verify ] || die "give at most one of --fast, --red and --browser"
  SCRIPT="$1"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --fast)
      set_script 'verify:fast'
      shift
      ;;
    --red)
      set_script 'red'
      shift
      ;;
    --browser)
      set_script 'browser'
      shift
      ;;
    --base)
      [ $# -ge 2 ] || usage
      BASE_ARG="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --worktree)
      [ $# -ge 2 ] || usage
      WORKTREE="$2"
      shift 2
      ;;
    --host)
      # CR-01: a host run would execute the task's (Codex-written) tests and code on the host.
      die "--host is no longer accepted: tests and task code run only in the isolated container (规划/11 §4.1, §8). Start Docker, or hand the run to CI."
      ;;
    -h | --help) usage ;;
    -*) die "unknown option: $1" ;;
    *)
      [ -z "$ID" ] || usage
      ID="$1"
      shift
      ;;
  esac
done
[ -n "$ID" ] || usage
if ! [[ "$ID" =~ ^[A-Z][A-Z0-9]*-[0-9]+[a-z]*$ ]]; then die "invalid task id: $ID"; fi
if [ -n "$BASE_ARG" ] && [ "$SCRIPT" != red ]; then die "--base applies to --red only"; fi
if [ -n "$BASE_ARG" ] && ! [[ "$BASE_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$ ]]; then die "invalid --base: $BASE_ARG"; fi

# Same layout rule as tools/lib/paths.ts (findRunsDir, D10-222): the couli-runs directory that
# contains HANDOFF.md, found walking up from the checkout's parent (a couli-runs directory itself,
# or a couli-runs child); COULI_RUNS overrides it; neither is an error, never a guessed path.
FOUND_RUNS=''
dir="$(dirname "$SELF_ROOT")"
while :; do
  if [ "$(basename "$dir")" = couli-runs ] && [ -f "$dir/HANDOFF.md" ]; then FOUND_RUNS="$dir"; break; fi
  if [ -f "$dir/couli-runs/HANDOFF.md" ]; then FOUND_RUNS="$dir/couli-runs"; break; fi
  [ "$(dirname "$dir")" = "$dir" ] && break
  dir="$(dirname "$dir")"
done
if [ -n "$FOUND_RUNS" ]; then PROJECTS="$(dirname "$FOUND_RUNS")"; else PROJECTS="$(dirname "$SELF_ROOT")"; fi
if [ -n "${COULI_RUNS:-}" ]; then
  mkdir -p "$COULI_RUNS"
  RUNS="$(cd "$COULI_RUNS" && pwd -P)"
elif [ -n "$FOUND_RUNS" ]; then
  RUNS="$FOUND_RUNS"
else
  die "no run-state directory for $SELF_ROOT: set COULI_RUNS, or keep the checkout under a couli-runs directory (or next to one) that contains HANDOFF.md"
fi

if [ -n "${COULI_TRUSTED_ROOT:-}" ]; then
  TRUSTED="$(cd "$COULI_TRUSTED_ROOT" && pwd -P)"
elif [ -d "$RUNS/trusted/rebate-platform/tools/guard" ]; then
  TRUSTED="$(cd "$RUNS/trusted/rebate-platform" && pwd -P)"
else
  TRUSTED="$SELF_ROOT"
fi
if [ "$TRUSTED" != "$SELF_ROOT" ]; then
  die "run this script from the trusted root: $TRUSTED/tools/ops/verify-container.sh"
fi
# A task worktree is the Codex sandbox's writable root: it can never be the trusted root, with
# or without COULI_TRUSTED_ROOT (规划/11 §2.4; same rule as tools/lib/paths.ts).
case "$SELF_ROOT/" in
  "$RUNS"/worktrees/?* | */couli-runs/worktrees/?*)
    die "refusing to run from the task worktree $SELF_ROOT: gates are never read from the branch under test (规划/11 §2.4)"
    ;;
esac
IMG_DIR="$SELF_DIR/verify-image"

[ -n "$WORKTREE" ] || WORKTREE="$RUNS/worktrees/$ID"
[ -d "$WORKTREE" ] || die "worktree does not exist: $WORKTREE"
WT="$(cd "$WORKTREE" && pwd -P)"

# /tmp and $TMPDIR are writable roots of the Codex sandbox (规划/11 §0, §2.4):
# a worktree there could have been rewritten by the run we are about to verify.
tmp_phys=''
if [ -n "${TMPDIR:-}" ] && [ -d "${TMPDIR%/}" ]; then tmp_phys="$(cd "${TMPDIR%/}" && pwd -P)"; fi
for bad in /tmp /private/tmp "${TMPDIR:-}" "$tmp_phys"; do
  bad="${bad%/}"
  if is_under "$WT" "$bad"; then die "refusing a worktree under $bad: $WT"; fi
done

[ -f "$WT/package.json" ] || die "no package.json in $WT"

# CT-06v (2026-10-19): the default was 1200 and the cap too; with 464 integration test files a full
# verify ran past it (exit 124 in test:browser). The switch may lower or raise the limit up to the
# cap; the host-services limits (svc_run, RuntimeMaxSec) follow TIMEOUT_SECS. CT-06zxf (D10-372,
# 2026-10-27): default 2400 -> 3600 — 164 full verifies on the test machine 10-23..26 passed in
# 29.4-39.8 min, and all 9 exit-124 runs stopped at 40.1-40.5 min, the old default.
MAX_TIMEOUT_SECS=3600
DEFAULT_TIMEOUT_SECS=3600
TIMEOUT_SECS="${COULI_VERIFY_TIMEOUT_SECS:-$DEFAULT_TIMEOUT_SECS}"
if ! [[ "$TIMEOUT_SECS" =~ ^[1-9][0-9]*$ ]]; then die "COULI_VERIFY_TIMEOUT_SECS must be a positive integer"; fi
if [ "$TIMEOUT_SECS" -gt "$MAX_TIMEOUT_SECS" ]; then die "COULI_VERIFY_TIMEOUT_SECS is capped at $MAX_TIMEOUT_SECS"; fi
VITEST_WORKERS="${COULI_VERIFY_VITEST_MAX_WORKERS:-2}"
if ! [[ "$VITEST_WORKERS" =~ ^[1-9][0-9]*$ ]] || [ "$VITEST_WORKERS" -gt 32 ]; then
  die "COULI_VERIFY_VITEST_MAX_WORKERS must be an integer 1..32"
fi
PROP_SEED_VALUE="${PROP_SEED:-$DEFAULT_PROP_SEED}"
if ! [[ "$PROP_SEED_VALUE" =~ ^[0-9]+$ ]]; then die "PROP_SEED must be a non-negative integer"; fi
if [ -n "${PROP_RUNS:-}" ] && ! [[ "$PROP_RUNS" =~ ^[1-9][0-9]*$ ]]; then die "PROP_RUNS must be a positive integer"; fi
PREFIX="${COULI_VERIFY_PREFIX:-couli-verify}"
if ! [[ "$PREFIX" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then die "COULI_VERIFY_PREFIX must match [a-z0-9][a-z0-9-]*"; fi

# Host services (see the header): checked here, used by start_host_services.
HOST_SVC=0
if [ -n "${COULI_VERIFY_HOST_SERVICES:-}" ]; then
  [ "$COULI_VERIFY_HOST_SERVICES" = 1 ] || die "COULI_VERIFY_HOST_SERVICES must be 1 (or unset)"
  HOST_SVC=1
  SVC_USER="${COULI_VERIFY_SVC_USER:-couli-svc}"
  SVC_GROUP="${COULI_VERIFY_SVC_GROUP:-couli-sock}"
  SVC_ROOT="${COULI_VERIFY_SVC_ROOT:-/var/lib/couli-ephemeral}"
  SVC_PG_BIN="${COULI_VERIFY_PG_BIN:-/usr/lib/postgresql/18/bin}"
  SVC_REDIS_BIN="${COULI_VERIFY_REDIS_BIN:-/usr/bin}"
  for v in "$SVC_USER" "$SVC_GROUP"; do
    [[ "$v" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "COULI_VERIFY_SVC_USER / COULI_VERIFY_SVC_GROUP must be plain names: $v"
  done
  for v in "$SVC_ROOT" "$SVC_PG_BIN" "$SVC_REDIS_BIN"; do
    [[ "$v" =~ ^/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$ ]] && [[ "$v" != *..* ]] ||
      die "host service paths must be absolute, plain, without a trailing slash: $v"
  done
  [ "$SVC_ROOT" != / ] || die "COULI_VERIFY_SVC_ROOT must not be /"
  # One lock and one run registry for the whole host (tmpfiles.d of setup-isolation.sh creates
  # both on every boot, as the tmpfs comes back empty). COULI_VERIFY_SVC_LOCK exists for the tool
  # tests only; on the test machine every lane uses the default.
  SVC_LOCK="${COULI_VERIFY_SVC_LOCK:-/run/lock/couli-host-services.lock}"
  [[ "$SVC_LOCK" =~ ^/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$ ]] && [[ "$SVC_LOCK" != *..* ]] ||
    die "COULI_VERIFY_SVC_LOCK must be an absolute, plain path"
  SVC_REGISTRY="${SVC_LOCK%.lock}.runs"
  if [ -n "${COULI_VERIFY_SVC_RUN_LIMIT:-}" ] && ! [[ "$COULI_VERIFY_SVC_RUN_LIMIT" =~ ^[1-9][0-9]*$ ]]; then
    die "COULI_VERIFY_SVC_RUN_LIMIT must be a positive integer"
  fi
fi

# The red run: which rule-test files the task added (inside its trusted test_paths), against the
# base. The same list is what red-check reconciles the reports with (CR-10).
RED_FILES=''
RED_PLAN=''
RED_BROWSER=0
if [ "$SCRIPT" = red ]; then
  if [ -z "$BASE_ARG" ]; then
    for candidate in origin/main main; do
      if git -C "$WT" rev-parse --verify --quiet "$candidate^{commit}" >/dev/null 2>&1; then
        BASE_ARG="$(git -C "$WT" merge-base HEAD "$candidate" 2>/dev/null || true)"
        [ -z "$BASE_ARG" ] || break
      fi
    done
  fi
  [ -n "$BASE_ARG" ] || die "--red needs a base (no origin/main or main in $WT): pass --base <ref>"
  RED_FILES="$(cd "$TRUSTED" && node tools/guard/red-check.ts --task "$ID" --cwd "$WT" --base "$BASE_ARG" --print-expected)" ||
    die "cannot list the task's rule-test files (trusted ledger, test_paths)"
  [ -n "$RED_FILES" ] || die "task $ID added no rule-test file inside its test_paths (against $BASE_ARG): nothing to run red"
  while IFS= read -r f; do
    [[ "$f" =~ ^[A-Za-z0-9_./@-]+$ ]] && [[ "$f" != *..* ]] || die "unexpected rule-test path: $f"
  done <<<"$RED_FILES"
  # Which trusted Vitest project runs each file (CR2-04); a file without one stops the run.
  mkdir -p "$RUNS"
  red_list="$RUNS/.red-expected.$ID.$$"
  printf '%s\n' "$RED_FILES" >"$red_list"
  RED_PLAN="$(cd "$TRUSTED" && node tools/ops/red-plan.ts --expected "$red_list" 2>&1)" || {
    rm -f "$red_list"
    die "the red run cannot run every rule-test file: $RED_PLAN"
  }
  rm -f "$red_list"
  RED_BROWSER="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).groups.some((g) => g.browser) ? "1" : "0")' "$RED_PLAN")"
fi

# --browser: the browser projects of the trusted project table (name, dir and config), in order;
# handed to the entrypoint as BROWSER_PROJECTS ("<name>:<dir>:<config>", space-separated).
BROWSER_PROJECTS=''
if [ "$SCRIPT" = browser ]; then
  browser_projects="$(node -e '
    const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const found = (doc.projects ?? []).filter((p) => p.browser === true);
    if (found.length === 0) throw new Error("expected at least one browser project, found none");
    for (const p of found) console.log(`${p.name} ${p.dir} ${p.config}`);
  ' "$IMG_DIR/red-projects.json" 2>&1)" || die "no browser project in $IMG_DIR/red-projects.json: $browser_projects"
  while read -r b_name b_dir b_config; do
    for p in "$b_name" "$b_dir" "$b_config"; do
      [[ "$p" =~ ^[A-Za-z0-9_./@-]+$ ]] && [[ "$p" != *..* ]] || die "unexpected browser project entry: $p"
    done
    BROWSER_PROJECTS="${BROWSER_PROJECTS:+$BROWSER_PROJECTS }$b_name:$b_dir:$b_config"
  done <<<"$browser_projects"
fi

tree_of_worktree() { # prints the git tree of the work tree (uncommitted changes included)
  local idx="$1" t
  if [ -n "$head" ]; then GIT_INDEX_FILE="$idx" git -C "$WT" read-tree HEAD; fi
  GIT_INDEX_FILE="$idx" git -C "$WT" add -A . >/dev/null
  t="$(GIT_INDEX_FILE="$idx" git -C "$WT" write-tree)"
  rm -f "$idx" "$idx.lock"
  [[ "$t" =~ ^[0-9a-f]{40,64}$ ]] || die "cannot compute the tree of $WT"
  printf '%s' "$t"
}

RUN="$RUNS/$ID"
top="$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null || true)"
IS_TOP=0
if [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$WT" ]; then IS_TOP=1; fi
head=''
if [ "$IS_TOP" = 1 ]; then head="$(git -C "$WT" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null || true)"; fi

if [ "$DRY_RUN" = 1 ]; then
  mkdir -p "$RUNS"
  dry_tree='null'
  if [ "$IS_TOP" = 1 ]; then dry_tree="\"$(tree_of_worktree "$RUNS/.dry-index.$ID.$$")\""; fi
  node -e '
    const [script, commit, tree, files, plan] = process.argv.slice(1);
    const out = { script, commit: commit === "" ? null : commit, tree: JSON.parse(tree) };
    if (script === "red") {
      out.red_files = files.split("\n").filter((l) => l !== "");
      out.red_plan = JSON.parse(plan).groups;
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  ' "$SCRIPT" "$head" "$dry_tree" "$RED_FILES" "$RED_PLAN"
  exit 0
fi

# Next free run number; mkdir makes the choice atomic.
case "$SCRIPT" in
  verify) VBASE="$RUN/verify" ;;
  verify:fast) VBASE="$RUN/verify-fast" ;;
  red) VBASE="$RUN/red" ;;
  browser) VBASE="$RUN/browser" ;;
esac
mkdir -p "$VBASE"
N=1
while ! mkdir "$VBASE/$N" 2>/dev/null; do
  N=$((N + 1))
  [ "$N" -le 9999 ] || die "cannot create a run directory under $VBASE"
done
VDIR="$VBASE/$N"
LOG="$VDIR/log.txt"
RESULT="$VDIR/result.json"
: >"$LOG"

# What exactly is being verified. The worktree is exported ONCE into an immutable snapshot
# (SRC); the tree hash is computed from that snapshot and the snapshot — never the live
# worktree — is what the container (or the host run) sees. A worktree changed while the image
# is built or the store is filled therefore cannot make result.json describe one tree and the
# exit code another. git-ignored paths (node_modules, dist, .env*, *.key, coverage, reports …)
# are not part of a git tree and so never reach the verified copy.
# Only a worktree that is the top of its own git work tree gets commit and tree; a plain
# directory (or one nested in another repository) gets null and is copied with the same
# exclusions the image uses.
COMMIT='null'
TREE='null'
SRC="$VDIR/src"
mkdir -p "$SRC"
# The snapshot is removed however the script ends (container mode replaces this trap with
# cleanup(), which removes it as well).
trap 'rm -rf "$SRC"' EXIT
if [ "$IS_TOP" = 1 ]; then
  [ -z "$head" ] || COMMIT="\"$head\""
  # A throwaway index: the real index (the orchestrator's staging area) is not touched.
  tree="$(tree_of_worktree "$VDIR/index.tmp")"
  TREE="\"$tree\""
  # Export exactly that tree object (deterministic: the archive is built from the object
  # database, not from the live files; .gitattributes sets no export-ignore).
  git -C "$WT" archive --format=tar "$tree" | tar -C "$SRC" -xf - ||
    die "cannot export tree $tree of $WT"
else
  tar -C "$WT" \
    --exclude=node_modules --exclude=.git --exclude=dist --exclude=.turbo --exclude=.tmp \
    --exclude=coverage --exclude=reports --exclude='*.tsbuildinfo' --exclude='.env' \
    --exclude='.env.*' --exclude='*.key' --exclude='*.pem' --exclude='*.p12' --exclude='*.pfx' \
    --exclude='*.jks' --exclude='*.keystore' \
    -cf - . | tar -C "$SRC" -xf - || die "cannot copy $WT"
  # .env.example is the one environment file that belongs to the repository.
  if [ -f "$WT/.env.example" ]; then cp "$WT/.env.example" "$SRC/.env.example"; fi
fi

STARTED_AT="$(now_utc)"
# Extra result fields of the host-services mode (empty otherwise): the gate's provenance, and
# "services" once start_host_services ran.
RESULT_EXTRA=''
if [ "$HOST_SVC" = 1 ]; then
  # Where this gate comes from, recorded before anything runs: the trusted root's commit, whether
  # its tracked files equal that commit (an overlaid gate does not), and this script's sha256.
  # Evidence takes only results with a clean gate of a known commit; a trusted root that is not a
  # git checkout records commit null, clean false.
  gate_commit=null
  gate_clean=false
  if gate_head="$(git --no-optional-locks -c core.fsmonitor=false -C "$TRUSTED" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)" &&
    [[ "$gate_head" =~ ^[0-9a-f]{40,64}$ ]]; then
    gate_commit="\"$gate_head\""
    if git --no-optional-locks -c core.fsmonitor=false -C "$TRUSTED" diff --quiet HEAD -- 2>/dev/null; then gate_clean=true; fi
  fi
  gate_sha="$(sha256_stdin <"$SELF_DIR/verify-container.sh")"
  RESULT_EXTRA=$',\n  "gate": { "commit": '"$gate_commit"', "clean": '"$gate_clean"', "script_sha256": "'"$gate_sha"'" }'
fi

write_result() {
  local tmp="$RESULT.tmp.$$"
  printf '{\n  "mode": "%s",\n  "script": "%s",\n  "exit_code": %s,\n  "commit": %s,\n  "tree": %s,\n  "prop_seed": %s,\n  "prop_runs": %s,\n  "started_at": "%s",\n  "finished_at": "%s"%s\n}\n' \
    "$MODE" "$SCRIPT" "$1" "$COMMIT" "$TREE" "$PROP_SEED_VALUE" "${PROP_RUNS:-null}" "$STARTED_AT" "$(now_utc)" "$RESULT_EXTRA" >"$tmp"
  if [ "$SCRIPT" = red ] && [ -f "$VDIR/red-check.json" ]; then
    # The red tests, the expected files and the exported reports with their sha256 (evidence).
    node -e '
      const fs = require("node:fs");
      const crypto = require("node:crypto");
      const [file, check, outDir] = process.argv.slice(1);
      const result = JSON.parse(fs.readFileSync(file, "utf8"));
      const red = JSON.parse(fs.readFileSync(check, "utf8"));
      result.red_tests = red.red ?? [];
      result.expected = red.expected ?? [];
      result.reports = fs.readdirSync(outDir).filter((f) => f.endsWith(".json")).sort().map((f) => ({
        path: `out/${f}`,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(`${outDir}/${f}`)).digest("hex"),
      }));
      fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    ' "$tmp" "$VDIR/red-check.json" "$VDIR/out" || die "cannot record the red run in result.json"
  fi
  mv "$tmp" "$RESULT"
}

finish() {
  if [ "$SVC_RUN_TIMED_OUT" = 1 ]; then
    die "the container exceeded the host-side limit of ${SVC_RUN_LIMIT}s (no result is written), see $LOG"
  fi
  # Host services: the result exists only once this run's instances are gone.
  if [ "$SVC_ACTIVE" = 1 ]; then
    stop_host_services || die "the host services of this run could not be removed, see $LOG (no result is written)"
  fi
  if [ "$HOST_SVC" = 1 ]; then
    svc_redact || die "cannot remove the one-shot password from the run's log and reports (no result is written)"
  fi
  write_result "$1"
  # The snapshot is identified by `tree` in result.json; the copy itself is not kept.
  rm -rf "$SRC"
  log "verify-container: $ID run $N ($MODE, $SCRIPT) exit $1; log: $LOG"
  cat "$RESULT"
  exit "$1"
}

# --- container mode ----------------------------------------------------------
[ -f "$SRC/pnpm-lock.yaml" ] || die "no pnpm-lock.yaml in $WT"
[ -f "$SRC/pnpm-workspace.yaml" ] || die "no pnpm-workspace.yaml in $WT"

# The Playwright version of the snapshot's lockfile (a `playwright@<version>:` key; the packages
# and snapshots sections repeat it): the image installs exactly that browser build. `none` when
# the lockfile has no playwright (a branch from before F1-01i): the image has no browser, and
# the runs that need one stop here.
playwright_versions="$(sed -n "s/^  '\{0,1\}playwright@\([^:('][^:(']*\).*:\$/\1/p" "$SRC/pnpm-lock.yaml" | sort -u)"
case "$(printf '%s' "$playwright_versions" | grep -c '' || true)" in
  0) PLAYWRIGHT_VERSION='none' ;;
  1) PLAYWRIGHT_VERSION="$playwright_versions" ;;
  *) die "pnpm-lock.yaml has more than one playwright version: $(printf '%s' "$playwright_versions" | tr '\n' ' ')" ;;
esac
if [ "$PLAYWRIGHT_VERSION" != none ] && ! [[ "$PLAYWRIGHT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "unexpected playwright version in pnpm-lock.yaml: $PLAYWRIGHT_VERSION (the image installs exact releases only)"
fi
if [ "$PLAYWRIGHT_VERSION" = none ]; then
  if [ "$SCRIPT" = browser ]; then
    die "--browser needs playwright in pnpm-lock.yaml: this tree has none, so the verify image is built without a browser"
  fi
  if [ "$RED_BROWSER" = 1 ]; then
    die "the red run has browser rule tests, but pnpm-lock.yaml has no playwright: the verify image is built without a browser"
  fi
fi
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 ||
  die "Docker is not available. Start Docker, or hand the run to CI (there is no host fallback: 规划/11 §4.1, §8)."

PNPM_VERSION="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][0-9.]*\)".*/\1/p' "$SRC/package.json" | head -n 1)"
if ! [[ "$PNPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "package.json must pin \"packageManager\": \"pnpm@<exact version>\""
fi

IMAGE_HASH="$({
  cat "$IMG_DIR/Dockerfile" "$IMG_DIR/entrypoint.sh"
  printf 'pnpm@%s\n' "$PNPM_VERSION"
  printf 'playwright@%s\n' "$PLAYWRIGHT_VERSION"
} | sha256_stdin | cut -c1-16)"
IMAGE="couli-verify:$IMAGE_HASH"
LOCK_HASH="$(sha256_stdin <"$SRC/pnpm-lock.yaml" | cut -c1-16)"
STORE_VOL="$PREFIX-store-$LOCK_HASH"
TAG="$(printf '%s' "$ID" | tr '[:upper:]' '[:lower:]')-$N-$$"
NET="$PREFIX-net-$TAG"
PG_NAME="$PREFIX-pg-$TAG"
REDIS_NAME="$PREFIX-redis-$TAG"
VERIFY_NAME="$PREFIX-run-$TAG"
RED_DB_NAME="$PREFIX-run-db-$TAG"
FETCH_NAME="$PREFIX-fetch-$TAG"
STORE_LOCK="$RUNS/lock/verify-store-$LOCK_HASH"
LABELS=(--label "couli.verify=1" --label "couli.task=$ID")
HARDEN=(--init --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 4096)
# 2026-11-01 (CT-06zzw): `tsc -b` inside the container ran out of the default Node heap (about 4 GB),
# the same as CI before CT-06zzv (#2116). Every container of a run gets the same 8 GB upper limit as
# ci.yml; it is only a limit, nothing is reserved. Test content does not change.
NODE_HEAP=(-e 'NODE_OPTIONS=--max-old-space-size=8192')
# 2026-11-03 (CT-06zzza, FU-APPMODULE-STARTUP-TIMEOUT): every container that runs tests caps each vitest
# process at VITEST_WORKERS workers (vitest 5 reads VITEST_MAX_WORKERS; the test scripts pass the
# environment through with --env-mode=loose). Test content and timeouts do not change.
VITEST_ENV=(-e "VITEST_MAX_WORKERS=$VITEST_WORKERS")
TMPFS=(--tmpfs "/work:rw,exec,nosuid,uid=1000,gid=1000,mode=0755" --tmpfs "/tmp:rw,exec,nosuid,uid=1000,gid=1000,mode=1777")

net_created=0
store_locked=0
# Host services of this run that may still exist (stop_host_services clears it).
SVC_ACTIVE=0
EXT_PROXY="$VDIR/services-proxy.cjs"
cleanup() {
  # Signals do not reach processes inside a container: remove them explicitly.
  if [ "$HOST_SVC" = 1 ]; then
    timeout -k 5 120 docker rm -f -v "$VERIFY_NAME" "$RED_DB_NAME" "$FETCH_NAME" "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  else
    docker rm -f -v "$VERIFY_NAME" "$RED_DB_NAME" "$FETCH_NAME" "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  fi
  if [ "$net_created" -eq 1 ]; then docker network rm "$NET" >/dev/null 2>&1 || true; fi
  if [ "$store_locked" -eq 1 ]; then rmdir "$STORE_LOCK" 2>/dev/null || true; fi
  if [ "$SVC_ACTIVE" = 1 ]; then
    stop_host_services || log "verify-container: the host services of this run could not be removed (the next run removes them or stops), see $LOG"
  fi
  if [ "$HOST_SVC" = 1 ]; then
    rm -f "$EXT_PROXY"
    svc_redact || log "verify-container: could not remove the one-shot password from $VDIR"
  fi
  rm -rf "$SRC"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step() {
  log "verify-container: $*"
  printf '[verify-container %s] %s\n' "$(now_utc)" "$*" >>"$LOG"
}

# The one-shot services of a run that may connect to databases (ADR-0001 §4.2 #9): PostgreSQL
# (random password) and Redis, attached only to the run's --internal network, no published
# port, data on tmpfs. Exports TEST_PG_ADMIN_URL and TEST_REDIS_URL for `docker run -e NAME`.
# Redis runs with the settings of infra/local/compose.yaml: no RDB, no AOF, noeviction with an
# explicit limit (ADR-0001 §4.2 #17). It has no password: the network is internal and holds
# nothing but this run.
pg_ready() {
  # TCP only: the image first runs a temporary server that listens on the socket alone.
  docker exec "$PG_NAME" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1
}
redis_ready() {
  # The reply, not the exit code: a LOADING error reply is not ready.
  [ "$(docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null)" = PONG ]
}
wait_ready() { # <container> <readiness check> <label>
  local tries=0
  until "$2"; do
    # A container that has exited will never answer: stop now instead of waiting 60 seconds.
    if [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" != true ]; then
      docker logs "$1" >>"$LOG" 2>&1 || true
      die "$3 exited before it became ready, see $LOG"
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 120 ]; then
      docker logs "$1" >>"$LOG" 2>&1 || true
      die "$3 did not become ready within 60 seconds, see $LOG"
    fi
    sleep 0.5
  done
}
start_services() { # <what the services are for, for the log>
  step "creating internal network $NET ($1)"
  docker network create --internal "${LABELS[@]}" "$NET" >/dev/null 2>>"$LOG" ||
    die "cannot create network $NET, see $LOG"
  net_created=1

  step "starting one-shot PostgreSQL ($PG_IMAGE) on $NET only"
  PG_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  POSTGRES_PASSWORD="$PG_PASSWORD" docker run -d --name "$PG_NAME" "${LABELS[@]}" \
    --network "$NET" --network-alias pg \
    --tmpfs /var/lib/postgresql \
    -e POSTGRES_PASSWORD \
    "$PG_IMAGE" >/dev/null 2>>"$LOG" || die "cannot start PostgreSQL, see $LOG"

  step "starting one-shot Redis ($REDIS_IMAGE) on $NET only"
  docker run -d --name "$REDIS_NAME" "${LABELS[@]}" \
    --network "$NET" --network-alias redis \
    --tmpfs /data \
    "$REDIS_IMAGE" redis-server --save '' --appendonly no \
    --maxmemory 256mb --maxmemory-policy noeviction >/dev/null 2>>"$LOG" ||
    die "cannot start Redis, see $LOG"

  # Both start in parallel; the run begins once both answer.
  wait_ready "$PG_NAME" pg_ready PostgreSQL
  wait_ready "$REDIS_NAME" redis_ready Redis
  export TEST_PG_ADMIN_URL="postgres://postgres:$PG_PASSWORD@pg:5432/postgres"
  export TEST_REDIS_URL='redis://redis:6379/0'
}

# --- host services (header: COULI_VERIFY_HOST_SERVICES) -----------------------------------------
# The database container's network, mounts and command prefix. Empty unless host services are on:
# then `--network none`, the run's socket directory read-only, the socket group, the proxy, and a
# wrapper that starts the proxy and waits for it before it execs the entrypoint.
EXT_RUN=()
EXT_WRAP=()
IFS= read -r -d '' EXT_PROXY_JS <<'JS' || true
'use strict';
// Socket proxy of verify-container.sh (host services): the container has no network, the
// clients take host:port URLs only, so 127.0.0.1:<port> is forwarded to the mounted sockets.
const fs = require('node:fs');
const net = require('node:net');
const routes = JSON.parse(process.env.COULI_SERVICES_ROUTES);
let listening = 0;
for (const [port, path] of routes) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ path });
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.end());
    upstream.on('close', () => client.end());
  });
  server.on('error', (error) => {
    process.stderr.write(`[services] cannot listen on 127.0.0.1:${port}: ${error.code}\n`);
    process.exit(2);
  });
  server.listen(port, '127.0.0.1', () => {
    listening += 1;
    if (listening === routes.length) fs.writeFileSync('/tmp/.couli-services-ready', '');
  });
}
JS
IFS= read -r -d '' EXT_WRAP_SH <<'SH' || true
node /couli-services/proxy.cjs &
proxy=$!
tries=0
until [ -e /tmp/.couli-services-ready ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 200 ] || ! kill -0 "$proxy" 2>/dev/null; then
    echo "[services] the socket proxy did not start" >&2
    exit 2
  fi
  sleep 0.05
done
exec "$@"
SH
# initdb inside the sandboxed unit: the password arrives on stdin (systemd-run --pipe), goes to a
# 0600 file in the run directory for initdb and is removed right after.
IFS= read -r -d '' SVC_INITDB_SH <<'SH' || true
umask 077
cat >"$1/pw" || exit 1
"$2/initdb" -D "$1/pgdata" -U postgres --pwfile="$1/pw" --encoding=UTF8 --locale=en_US.utf8 \
  --auth-local=scram-sha-256 --auth-host=reject
rc=$?
rm -f "$1/pw"
exit "$rc"
SH
SVC_UNIT="couli-svc-$TAG"
SVC_DIR=''
SVC_SOCK=''
if [ "$HOST_SVC" = 1 ]; then
  SVC_DIR="$SVC_ROOT/$TAG"
  SVC_SOCK="$SVC_DIR/sock"
fi
# 1 once this run holds the host-services lock (fd 9): only then do the docker runs close fd 9.
SVC_LOCKED=0
# 1 when a docker run outlived the host-side limit (svc_run): the run then writes no result.
SVC_RUN_TIMED_OUT=0
# Every privileged step has a hard time limit: a hanging sudo, systemctl or rm cannot hold the
# lock forever.
svc_sudo() { # <seconds> <sudo arguments...>
  local secs="$1"
  shift
  timeout -k 5 "$secs" sudo -n "$@"
}
svc_as_user() { # <seconds> <command...>: as the services user (readiness probes)
  local secs="$1"
  shift
  svc_sudo "$secs" -u "$SVC_USER" "$@"
}
svc_docker() { # <seconds> <docker arguments...>: docker calls of the host-services mode
  local secs="$1"
  shift
  timeout -k 5 "$secs" docker "$@"
}
svc_journal() { # <unit>: its last lines into the log (startup failures)
  svc_sudo 20 journalctl -u "$1" -n 40 --no-pager >>"$LOG" 2>&1 || true
}
# Runs the docker run of a container. Without host services the command runs exactly as written at
# the call site. With them (this run holds the host-wide lock): the container does not inherit the
# lock (fd 9), and the whole docker run has a host-side hard limit (the container's own limit plus
# 15 minutes for the offline install), since a docker daemon that never answers, or an install
# that hangs before the container's timeout starts, would otherwise hold the lock for ever. When
# that limit hits: the run's containers are removed (bounded) and the run stops as an
# infrastructure error (exit 2, no result; the EXIT trap removes the services).
svc_run() {
  if [ "$SVC_LOCKED" != 1 ]; then
    "$@"
    return
  fi
  local limit=$((TIMEOUT_SECS + 900)) started rc=0
  # COULI_VERIFY_SVC_RUN_LIMIT (tool tests) can only lower it.
  if [ -n "${COULI_VERIFY_SVC_RUN_LIMIT:-}" ] && [ "$COULI_VERIFY_SVC_RUN_LIMIT" -lt "$limit" ]; then
    limit="$COULI_VERIFY_SVC_RUN_LIMIT"
  fi
  started="$(date +%s)"
  timeout -k 30 "$limit" "$@" 9>&- || rc=$?
  if { [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && [ $(($(date +%s) - started)) -ge "$limit" ]; then
    # The caller's stderr is the log: the reason is recorded here, the run stops in finish (or,
    # for a red group, at its missing report).
    printf '[verify-container %s] %s\n' "$(now_utc)" "the container exceeded the host-side limit of ${limit}s; removing it" >>"$LOG"
    svc_docker 120 rm -f -v "$VERIFY_NAME" "$RED_DB_NAME" >/dev/null 2>>"$LOG" ||
      printf '[verify-container %s] %s\n' "$(now_utc)" "docker rm of the timed-out containers failed or timed out" >>"$LOG"
    SVC_RUN_TIMED_OUT=1
    SVC_RUN_LIMIT="$limit"
  fi
  return "$rc"
}
# Host checks run as root through one small script each. Every check ends its output with the line
# "couli-check: ok" only when each command it ran succeeded; the callers require that line, so
# "the query ran and found nothing" is never confused with "the query did not run" (sudo refused,
# time-out, a failing ipcs / pgrep / find).
#   couli-presence <path>        absent | present
#   couli-rootcheck <root>       "<mount target> <fstype>" and "<owner> <octal mode>"
#   couli-procs <user>           "procs: none", or the user's processes
#   couli-residue <user> <mode>  lists (mode list) or removes, then lists (mode clean) the user's
#                                /dev/shm and /dev/mqueue entries and SysV IPC objects;
#                                "residue: none" when there are none
IFS= read -r -d '' SVC_HOST_SH <<'SH' || true
set -u
ok() { echo 'couli-check: ok'; exit 0; }
case "$0" in
  couli-presence)
    if [ -e "$1" ] || [ -L "$1" ]; then echo present; else echo absent; fi
    ok
    ;;
  couli-rootcheck)
    m="$(findmnt -n -r -o TARGET,FSTYPE --mountpoint "$1")" || exit 1
    s="$(stat -c '%U %a' "$1")" || exit 1
    printf '%s\n%s\n' "$m" "$s"
    ok
    ;;
  couli-procs)
    rc=0
    p="$(pgrep -u "$1" -l)" || rc=$?
    case "$rc" in
      0) printf '%s\n' "$p" ;;
      1) echo 'procs: none' ;;
      *) exit 1 ;;
    esac
    ok
    ;;
  couli-residue)
    user="$1"
    list() {
      for d in /dev/shm /dev/mqueue; do
        [ -d "$d" ] || continue
        f="$(find "$d" -mindepth 1 -maxdepth 1 -user "$user" -printf "file $d/%f\n")" || return 1
        [ -z "$f" ] || printf '%s\n' "$f"
      done
      i="$(ipcs -m -q -s)" || return 1
      printf '%s\n' "$i" | awk -v u="$user" '$3 == u { print "ipc " $2 }'
    }
    if [ "$2" = clean ]; then
      for d in /dev/shm /dev/mqueue; do
        if [ -d "$d" ]; then find "$d" -mindepth 1 -maxdepth 1 -user "$user" -exec rm -rf -- {} + || exit 1; fi
      done
      for t in m q s; do
        i="$(ipcs -"$t")" || exit 1
        for id in $(printf '%s\n' "$i" | awk -v u="$user" '$3 == u { print $2 }'); do ipcrm -"$t" "$id" || exit 1; done
      done
    fi
    out="$(list)" || exit 1
    if [ -z "$out" ]; then echo 'residue: none'; else printf '%s\n' "$out"; fi
    ok
    ;;
  *) exit 2 ;;
esac
SH
svc_host() { # <seconds> <check> <args...>: prints the check's answer without the success line;
  # fails unless the check ran completely (exit 0 and the success line last)
  local secs="$1" check="$2" out
  shift 2
  out="$(svc_sudo "$secs" sh -c "$SVC_HOST_SH" "$check" "$@")" || return 1
  case "$out" in
    *$'\n''couli-check: ok') printf '%s\n' "${out%$'\n'couli-check: ok}" ;;
    *) return 1 ;;
  esac
}
svc_absent() { # <path>: true only when the path is certainly gone
  [ "$(svc_host 20 couli-presence "$1" 2>>"$LOG")" = absent ]
}
svc_no_residue() { # <list|clean>: true only when the services user certainly left no IPC / shm
  local out
  out="$(svc_host 60 couli-residue "$SVC_USER" "$1" 2>>"$LOG")" || {
    step "cannot list what $SVC_USER left in /dev/shm, /dev/mqueue and SysV IPC"
    return 1
  }
  [ "$out" = 'residue: none' ] && return 0
  step "$SVC_USER left IPC or shared memory behind: $(printf '%s' "$out" | tr '\n' ' ')"
  return 1
}
# A unit counts as stopped only when systemd answers for it: not loaded, or loaded and inactive /
# failed. No answer, an empty answer, a time-out or any other state is not "stopped".
svc_unit_stopped() { # <unit>
  local out load active
  out="$(svc_sudo 20 systemctl show -p LoadState -p ActiveState "$1" 2>>"$LOG")" || {
    step "cannot ask systemd about $1"
    return 1
  }
  load="$(printf '%s\n' "$out" | sed -n 's/^LoadState=//p')"
  active="$(printf '%s\n' "$out" | sed -n 's/^ActiveState=//p')"
  case "$load/$active" in
    not-found/inactive | loaded/inactive | loaded/failed) return 0 ;;
  esac
  step "unit $1 is not stopped (LoadState=${load:-?} ActiveState=${active:-?})"
  return 1
}
# No process of the services user may be left (one host-services run at a time: any is ours).
svc_no_processes() {
  local out
  out="$(svc_host 20 couli-procs "$SVC_USER" 2>>"$LOG")" || {
    step "cannot list the processes of $SVC_USER"
    return 1
  }
  [ "$out" = 'procs: none' ] && return 0
  step "processes of $SVC_USER are still running: $(printf '%s' "$out" | tr '\n' ' ')"
  return 1
}
# The services user may send nothing anywhere: the nftables rule exists and a live probe as that
# user fails. The user has no group but the socket group (no docker, no adm ...).
svc_check_isolation() {
  local uid rules groups
  uid="$(id -u "$SVC_USER" 2>/dev/null)" || { step "no user $SVC_USER (couli-runs/RUNNER/setup-isolation.sh)"; return 1; }
  groups="$(id -Gn "$SVC_USER" 2>/dev/null)" || return 1
  if [ "$groups" != "$SVC_GROUP" ]; then
    step "$SVC_USER must belong to $SVC_GROUP only, it has: $groups"
    return 1
  fi
  rules="$(svc_sudo 30 nft list chain inet couli_isolation output 2>>"$LOG")" || {
    step "nftables chain inet couli_isolation output is missing (couli-runs/RUNNER/setup-isolation.sh)"
    return 1
  }
  # The rule itself: the uid match, an optional counter, then the verdict (not a word in a comment,
  # not a rule narrowed to some destination).
  if ! printf '%s\n' "$rules" | grep -Eq '^[[:space:]]*type filter hook output priority [^;]+; policy accept;$' ||
    ! printf '%s\n' "$rules" | grep -Eq "^[[:space:]]*meta skuid (\"?$SVC_USER\"?|$uid) (counter packets [0-9]+ bytes [0-9]+ )?(reject|drop)( comment \"[^\"]*\")?\$"; then
    step "nftables chain inet couli_isolation output does not block $SVC_USER (uid $uid)"
    # CT-06zxf (D10-375): the listing as received, for the cause (firewall rules only: the
    # `nft list chain` output, no environment, token or password).
    printf '%s\n' 'nft list chain inet couli_isolation output, as received:' "$rules" >>"$LOG"
    return 1
  fi
  if svc_as_user 10 timeout 3 bash -c ': </dev/tcp/1.1.1.1/443' >/dev/null 2>&1; then
    step "egress probe: $SVC_USER reached 1.1.1.1:443 despite the rule"
    return 1
  fi
}
# The instance root must be the dedicated tmpfs: a mount point of its own, tmpfs, owned by the
# services user, 0700. Anything else (an unmounted directory, a mistyped path) stops the run
# before anything there is created or removed.
svc_check_root() {
  local out
  out="$(svc_host 20 couli-rootcheck "$SVC_ROOT" 2>>"$LOG")" || {
    step "$SVC_ROOT is not a mount point (couli-runs/RUNNER/setup-isolation.sh)"
    return 1
  }
  if [ "$out" != "$SVC_ROOT tmpfs"$'\n'"$SVC_USER 700" ]; then
    step "$SVC_ROOT must be a tmpfs mount point owned by $SVC_USER with mode 0700, found: $(printf '%s' "$out" | tr '\n' ' ')"
    return 1
  fi
}
# Run registry (one tag per line, under the lock): a run is registered before its directory and
# units exist and leaves only after both are certainly gone. Only registered directories are ever
# removed; an unregistered entry in the instance root stops the run.
svc_registered() { [ -f "$SVC_REGISTRY" ] && grep -vx '' "$SVC_REGISTRY" || true; }
svc_unregister() { # <tag>
  local tmp="$SVC_REGISTRY.tmp.$$"
  { grep -vxF -- "$1" "$SVC_REGISTRY" || true; } >"$tmp" && mv "$tmp" "$SVC_REGISTRY"
}
# Removes a registered run completely: its units stopped (and confirmed), no process of the
# services user left, its directory removed (and confirmed absent).
svc_remove_run() { # <tag>
  local tag="$1" u ok=0
  # Not-loaded units make `systemctl stop` fail; the state check below is what decides.
  svc_sudo 90 systemctl stop "couli-svc-$tag-pg.service" "couli-svc-$tag-redis.service" "couli-svc-$tag-initdb.service" >>"$LOG" 2>&1 || true
  for u in pg redis initdb; do
    svc_unit_stopped "couli-svc-$tag-$u.service" || ok=1
  done
  [ "$ok" = 0 ] || return 1
  svc_no_processes || return 1
  if ! svc_sudo 120 rm -rf --one-file-system -- "$SVC_ROOT/$tag" >>"$LOG" 2>&1; then
    step "cannot remove $SVC_ROOT/$tag"
    return 1
  fi
  svc_absent "$SVC_ROOT/$tag" || {
    step "$SVC_ROOT/$tag is not certainly gone"
    return 1
  }
}
# Under the lock nothing else may use host services: what is there was left by a run that was
# killed (SIGKILL leaves its container, units and directory behind) and goes first.
svc_sweep() {
  local ids units left tag
  ids="$(svc_docker 60 ps -aq --filter label=couli.services=host 2>>"$LOG")" || {
    step "docker ps failed or timed out"
    return 1
  }
  if [ -n "$ids" ]; then
    step "removing containers an earlier run left: $(printf '%s' "$ids" | tr '\n' ' ')"
    # shellcheck disable=SC2086 # container ids, one word each
    svc_docker 120 rm -f -v $ids >/dev/null 2>>"$LOG" || {
      step "docker rm of the leftover containers failed or timed out"
      return 1
    }
  fi
  units="$(svc_sudo 30 systemctl list-units --all --plain --no-legend --type=service 'couli-svc-*' 2>>"$LOG" | awk '{print $1}')" || return 1
  if [ -n "$units" ]; then
    step "stopping units an earlier run left: $(printf '%s' "$units" | tr '\n' ' ')"
    # shellcheck disable=SC2086 # unit names, one word each
    svc_sudo 90 systemctl stop $units >>"$LOG" 2>&1 || true
    for u in $units; do svc_unit_stopped "$u" || return 1; done
    # shellcheck disable=SC2086
    svc_sudo 30 systemctl reset-failed $units >/dev/null 2>&1 || true
  fi
  for tag in $(svc_registered); do
    [[ "$tag" =~ ^[a-z0-9-]+$ ]] || {
      step "unexpected entry in $SVC_REGISTRY: $tag"
      return 1
    }
    step "removing what the earlier run $tag left"
    svc_remove_run "$tag" || return 1
    svc_unregister "$tag" || return 1
  done
  left="$(svc_sudo 30 find "$SVC_ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>>"$LOG")" || return 1
  if [ -n "$left" ]; then
    step "$SVC_ROOT holds entries no registered run owns (not removed): $(printf '%s' "$left" | tr '\n' ' ')"
    return 1
  fi
  svc_no_processes || return 1
  svc_no_residue clean
}
# Stops this run's units and removes its directory; fails unless everything is certainly gone.
stop_host_services() {
  svc_remove_run "$TAG" || return 1
  svc_no_residue list || return 1
  svc_unregister "$TAG" || return 1
  SVC_ACTIVE=0
  step "host services of this run stopped and removed"
}
svc_pg_ready() { svc_as_user 10 "$SVC_PG_BIN/pg_isready" -q -h "$SVC_SOCK" -p 5432 >/dev/null 2>&1; }
svc_redis_ready() { [ "$(svc_as_user 10 "$SVC_REDIS_BIN/redis-cli" -s "$SVC_SOCK/redis.sock" ping 2>/dev/null)" = PONG ]; }
svc_wait() { # <unit suffix> <readiness check> <label>
  local tries=0 state
  until "$2"; do
    state="$(svc_sudo 20 systemctl is-active "$SVC_UNIT-$1.service" 2>/dev/null || true)"
    case "$state" in
      active | activating) ;;
      *)
        svc_journal "$SVC_UNIT-$1.service"
        die "$3 exited before it became ready ($state), see $LOG"
        ;;
    esac
    tries=$((tries + 1))
    if [ "$tries" -ge 120 ]; then
      svc_journal "$SVC_UNIT-$1.service"
      die "$3 did not become ready within 60 seconds, see $LOG"
    fi
    sleep 0.5
  done
}
start_host_services() { # <what the services are for, for the log>
  local p gid
  for p in flock timeout sudo; do
    command -v "$p" >/dev/null 2>&1 || die "host services need $p"
  done
  for p in "$SVC_PG_BIN/initdb" "$SVC_PG_BIN/postgres" "$SVC_PG_BIN/pg_isready" "$SVC_REDIS_BIN/redis-server" "$SVC_REDIS_BIN/redis-cli"; do
    [ -x "$p" ] || die "host services: $p is missing"
  done
  gid="$(getent group "$SVC_GROUP" | cut -d: -f3)"
  [[ "$gid" =~ ^[0-9]+$ ]] || die "host services: no group $SVC_GROUP"

  # One lock for the whole host (every lane, every COULI_RUNS): the container label, the unit
  # prefix and the instance root below are all host-wide, and so is this lock.
  exec 9>>"$SVC_LOCK" || die "cannot open the host-services lock $SVC_LOCK"
  # CT-06zxg (D10-382): the wait follows the time limit like RuntimeMaxSec (× 2 + 1800), taken from
  # the cap MAX_TIMEOUT_SECS, not this run's own TIMEOUT_SECS: the holder may run with a larger
  # limit than the waiter. It covers the worst hold of one full verify (limit + 930 s + preamble and
  # clean-up); a --red run with two service containers can in theory hold longer. Only the wait
  # changes, not the lock.
  local lock_wait=$((MAX_TIMEOUT_SECS * 2 + 1800))
  step "waiting for the host-services lock $SVC_LOCK ($1)"
  flock -w "$lock_wait" 9 || die "another run holds $SVC_LOCK for more than $lock_wait s"
  SVC_LOCKED=1
  svc_check_isolation || die "the host services' isolation is not in place, see $LOG"
  svc_check_root || die "the instance root is not the dedicated tmpfs, see $LOG"
  svc_sweep || die "cannot remove what an earlier run left of the host services, see $LOG"

  printf '%s\n' "$TAG" >>"$SVC_REGISTRY" || die "cannot register this run in $SVC_REGISTRY"
  SVC_ACTIVE=1
  step "starting one-shot PostgreSQL ($SVC_PG_BIN) and Redis ($SVC_REDIS_BIN/redis-server) as $SVC_USER in $SVC_DIR"
  local d
  svc_sudo 30 install -d -o "$SVC_USER" -g "$SVC_GROUP" -m 0700 "$SVC_DIR" >>"$LOG" 2>&1 ||
    die "cannot create $SVC_DIR, see $LOG"
  for d in sock:0750 tmp:0700 vartmp:0700 shm:0700; do
    svc_sudo 30 install -d -o "$SVC_USER" -g "$SVC_GROUP" -m "${d#*:}" "$SVC_DIR/${d%%:*}" >>"$LOG" 2>&1 ||
      die "cannot create $SVC_DIR/${d%%:*}, see $LOG"
  done
  # The sandbox of every unit (initdb, postgres, redis-server and whatever they start): no network,
  # no IPC namespace of the host, /tmp, /var/tmp and /dev/shm inside the run directory on the
  # tmpfs, only that directory writable, the host's service configuration (Pigsty's passwords)
  # hidden, limits on memory and tasks, the system-service system calls only.
  local sandbox=(--quiet --collect "--uid=$SVC_USER" "--gid=$SVC_GROUP"
    -p NoNewPrivileges=yes -p PrivateNetwork=yes -p RestrictAddressFamilies=AF_UNIX -p IPAddressDeny=any
    -p PrivateIPC=yes -p RemoveIPC=yes -p PrivateDevices=yes -p ProtectSystem=strict -p ProtectHome=yes
    -p "ReadWritePaths=$SVC_DIR" -p TemporaryFileSystem=/run:ro
    -p "BindPaths=$SVC_DIR/tmp:/tmp $SVC_DIR/vartmp:/var/tmp $SVC_DIR/shm:/dev/shm"
    -p "InaccessiblePaths=-/Users -/data -/infra -/var/log -/var/lib/grafana -/var/lib/haproxy -/var/lib/docker -/var/lib/cloud -/var/lib/snapd -/var/lib/ubuntu-advantage -/var/lib/amazon -/etc/grafana -/etc/pg_exporter.yml -/etc/pgbouncer_exporter.yml -/etc/alertmanager.yml -/etc/nginx -/etc/postgresql -/etc/patroni -/etc/pgbouncer -/etc/vector -/etc/cloud -/etc/dnsmasq.conf -/etc/sudoers -/etc/sudoers.d"
    -p ProtectProc=invisible -p ProcSubset=pid -p ProtectKernelTunables=yes -p ProtectKernelModules=yes
    -p ProtectKernelLogs=yes -p ProtectControlGroups=yes -p ProtectClock=yes -p ProtectHostname=yes
    -p RestrictNamespaces=yes -p RestrictRealtime=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes
    -p CapabilityBoundingSet= -p SystemCallArchitectures=native
    -p SystemCallFilter=@system-service -p SystemCallErrorNumber=EPERM
    -p MemoryMax=4G -p MemorySwapMax=0 -p TasksMax=512 -p UMask=0007
    -p "WorkingDirectory=$SVC_DIR" -p Environment=TZ=Etc/UTC -p Environment=LANG=en_US.utf8)
  local life=(-p "RuntimeMaxSec=$((TIMEOUT_SECS * 2 + 1800))" -p TimeoutStopSec=20s)

  SVC_PG_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s\n' "$SVC_PG_PASSWORD" | svc_sudo 120 systemd-run "${sandbox[@]}" --unit="$SVC_UNIT-initdb" --wait --pipe \
    -- /bin/sh -c "$SVC_INITDB_SH" sh "$SVC_DIR" "$SVC_PG_BIN" >>"$LOG" 2>&1 ||
    die "initdb of the one-shot PostgreSQL failed, see $LOG"
  svc_sudo 30 systemd-run "${sandbox[@]}" "${life[@]}" --unit="$SVC_UNIT-pg" \
    -- "$SVC_PG_BIN/postgres" -D "$SVC_DIR/pgdata" -c listen_addresses= -c "unix_socket_directories=$SVC_SOCK" \
    -c unix_socket_permissions=0770 -c log_min_error_statement=panic >>"$LOG" 2>&1 ||
    die "cannot start the one-shot PostgreSQL, see $LOG"
  local renamed=() c
  # CONFIG stays: the Redis rule tests read maxmemory-policy with CONFIG GET (as against the CI and
  # container Redis); protected settings (dir, dbfilename ...) cannot be changed at run time.
  for c in MIGRATE REPLICAOF SLAVEOF MODULE DEBUG SAVE BGSAVE BGREWRITEAOF SHUTDOWN FAILOVER SYNC PSYNC; do
    renamed+=(--rename-command "$c" '')
  done
  svc_sudo 30 systemd-run "${sandbox[@]}" "${life[@]}" --unit="$SVC_UNIT-redis" \
    -- "$SVC_REDIS_BIN/redis-server" --port 0 --unixsocket "$SVC_SOCK/redis.sock" --unixsocketperm 770 \
    --save '' --appendonly no --maxmemory 256mb --maxmemory-policy noeviction \
    --dir "$SVC_DIR" --logfile '' --daemonize no --enable-protected-configs no --enable-debug-command no \
    --enable-module-command no "${renamed[@]}" >>"$LOG" 2>&1 ||
    die "cannot start the one-shot Redis, see $LOG"
  svc_wait pg svc_pg_ready PostgreSQL
  svc_wait redis svc_redis_ready Redis
  # What the run gets: MIGRATE (disabled with the others) is unknown, the policy is noeviction.
  case "$(svc_as_user 10 "$SVC_REDIS_BIN/redis-cli" -s "$SVC_SOCK/redis.sock" MIGRATE 127.0.0.1 1 k 0 1 2>&1)" in
    *'unknown command'*) ;;
    *) die "the one-shot Redis still knows MIGRATE: its dangerous commands are not disabled" ;;
  esac
  case "$(svc_as_user 10 "$SVC_REDIS_BIN/redis-cli" -s "$SVC_SOCK/redis.sock" CONFIG GET maxmemory-policy 2>&1)" in
    *noeviction*) ;;
    *) die "the one-shot Redis does not run with maxmemory-policy noeviction" ;;
  esac

  printf '%s' "$EXT_PROXY_JS" >"$EXT_PROXY"
  chmod 0644 "$EXT_PROXY"
  EXT_RUN=(--network none --label couli.services=host --group-add "$gid"
    -v "$SVC_SOCK:/run/couli-services:ro"
    -v "$EXT_PROXY:/couli-services/proxy.cjs:ro"
    -e 'COULI_SERVICES_ROUTES=[[5432,"/run/couli-services/.s.PGSQL.5432"],[6379,"/run/couli-services/redis.sock"]]')
  EXT_WRAP=(bash -c "$EXT_WRAP_SH" couli-services)
  export TEST_PG_ADMIN_URL="postgres://postgres:$SVC_PG_PASSWORD@127.0.0.1:5432/postgres"
  export TEST_REDIS_URL='redis://127.0.0.1:6379/0'
  RESULT_EXTRA="$RESULT_EXTRA"$',\n  "services": "host-ephemeral"'
  step "host services ready: the run gets 127.0.0.1:5432 and 127.0.0.1:6379 through the socket proxy, no network"
}
# What a run writes may quote the one-shot password (a test printing a URL, a red report's failure
# message or test title): the log, red-check.json and every regular file under out/ have it
# replaced before the result (reports' sha256, red_tests) is derived from them, and again when the
# script ends. The password reaches node on stdin, never a command line; symbolic links, FIFOs
# and other special files are skipped, never opened.
svc_redact() {
  [ -n "${SVC_PG_PASSWORD:-}" ] || return 0
  printf '%s' "$SVC_PG_PASSWORD" | node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const secret = fs.readFileSync(0, "utf8");
    if (!/^[0-9a-f]{32}$/.test(secret)) throw new Error("unexpected one-shot password on stdin");
    const visit = (p) => {
      let st;
      try { st = fs.lstatSync(p); } catch (e) { if (e.code === "ENOENT") return; throw e; }
      if (st.isDirectory()) { for (const n of fs.readdirSync(p)) visit(path.join(p, n)); return; }
      if (!st.isFile()) return;
      const text = fs.readFileSync(p, "latin1");
      if (text.includes(secret)) fs.writeFileSync(p, text.split(secret).join("[one-shot password]"), "latin1");
    };
    for (const p of process.argv.slice(1)) visit(p);
  ' "$LOG" "$VDIR/red-check.json" "$VDIR/out" 2>>"$LOG"
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  step "building image $IMAGE (pnpm $PNPM_VERSION, playwright $PLAYWRIGHT_VERSION)"
  docker build -t "$IMAGE" --build-arg "PNPM_VERSION=$PNPM_VERSION" \
    --build-arg "PLAYWRIGHT_VERSION=$PLAYWRIGHT_VERSION" --label "couli.verify=1" "$IMG_DIR" >>"$LOG" 2>&1 ||
    die "image build failed, see $LOG"
fi

store_ready() {
  docker volume inspect "$STORE_VOL" >/dev/null 2>&1 &&
    docker run --rm --network none -v "$STORE_VOL:/store:ro" "$IMAGE" test -f /store/.couli-fetch-ok >/dev/null 2>&1
}

if ! store_ready; then
  # One fetch per lockfile at a time; a second run waits for the first.
  mkdir -p "$RUNS/lock"
  waited=0
  while ! mkdir "$STORE_LOCK" 2>/dev/null; do
    [ "$waited" -lt 900 ] || die "another run holds $STORE_LOCK for more than 15 minutes"
    sleep 5
    waited=$((waited + 5))
  done
  store_locked=1
  if ! store_ready; then
    step "filling offline store $STORE_VOL (networked pnpm fetch; sees only the lockfile and pnpm-workspace.yaml)"
    docker volume create --label "couli.verify=1" "$STORE_VOL" >/dev/null
    docker run --rm --name "$FETCH_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
      -v "$SRC/pnpm-lock.yaml:/in/pnpm-lock.yaml:ro" \
      -v "$SRC/pnpm-workspace.yaml:/in/pnpm-workspace.yaml:ro" \
      -v "$STORE_VOL:/store" \
      "$IMAGE" couli-verify-entrypoint fetch >>"$LOG" 2>&1 </dev/null ||
      die "pnpm fetch failed, see $LOG"
  fi
  rmdir "$STORE_LOCK" 2>/dev/null || true
  store_locked=0
fi

# Planning text at SPEC_REF for guards and tools tests: a single-commit bare
# snapshot, so the container sees neither the planning work tree nor its config.
SPEC_ARGS=()
if [ -f "$SRC/SPEC_REF" ]; then
  spec_ref="$(tr -d '[:space:]' <"$SRC/SPEC_REF")"
  spec_repo="${COULI_SPEC_REPO:-$PROJECTS/couli}"
  if [[ "$spec_ref" =~ ^[0-9a-f]{40}$ ]] && git -C "$spec_repo" cat-file -e "$spec_ref^{commit}" 2>/dev/null; then
    snap="$RUNS/spec-snapshots/$spec_ref.git"
    if [ ! -f "$snap/.couli-snapshot-ok" ]; then
      step "creating planning snapshot for SPEC_REF $spec_ref"
      rm -rf "$snap.tmp.$$"
      mkdir -p "$RUNS/spec-snapshots"
      git init -q --bare "$snap.tmp.$$" >>"$LOG" 2>&1
      git -C "$snap.tmp.$$" -c protocol.file.allow=always fetch -q --depth 1 "file://$(cd "$spec_repo" && pwd -P)" "$spec_ref" >>"$LOG" 2>&1 ||
        die "cannot snapshot the planning repository at $spec_ref, see $LOG"
      touch "$snap.tmp.$$/.couli-snapshot-ok"
      # A concurrent run may have finished the same snapshot first: keep theirs.
      if [ -e "$snap" ]; then rm -rf "$snap.tmp.$$"; else mv "$snap.tmp.$$" "$snap"; fi
    fi
    # The snapshot has no history, so "SPEC_REF is on the planning main" (规划/11 §5.3)
    # is checked here, against the real repository; only then does the snapshot get an
    # origin/main for the spec-ref guard inside the container to compare with.
    if ! git -C "$snap" rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then
      if git -C "$spec_repo" merge-base --is-ancestor "$spec_ref" origin/main 2>/dev/null; then
        git -C "$snap" update-ref refs/remotes/origin/main "$spec_ref"
      else
        step "SPEC_REF $spec_ref is not on origin/main of $spec_repo: the spec-ref guard will fail"
      fi
    fi
    SPEC_ARGS=(-v "$snap:/spec:ro" -e COULI_SPEC_REPO=/spec)
  else
    step "SPEC_REF is not a commit of $spec_repo: /spec is not mounted"
  fi
fi

if [ "$SCRIPT" = red ]; then
  # Groups of the plan (tools/ops/red-plan.ts), split by the project's `database` flag into at
  # most two containers (Codex review of F1-01j, S1): the groups that need PostgreSQL run in one
  # with the one-shot PostgreSQL and Redis on the internal network; every other group (unit,
  # browser) runs in another with no network at all and no database URL — also when the same task
  # adds both kinds of rule tests.
  printf '%s\n' "$RED_FILES" >"$VDIR/expected.txt"
  printf '%s\n' "$RED_PLAN" >"$VDIR/plan.json"
  mkdir -p "$VDIR/out"
  chmod 0777 "$VDIR/out"
  red_part() { # <1: groups with a database, 0: the others>; prints the plan of those groups or ''
    node -e '
      const want = process.argv[2] === "1";
      const groups = JSON.parse(process.argv[1]).groups.filter((g) => g.database === want);
      if (groups.length > 0) process.stdout.write(JSON.stringify({ groups }));
    ' "$RED_PLAN" "$1"
  }
  red_container() { # <container name> <plan> <1: database network, 0: no network>
    local env=("${NODE_HEAP[@]}" "${VITEST_ENV[@]}" -e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS" -e RED_PLAN)
    [ -z "${PROP_RUNS:-}" ] || env+=(-e "PROP_RUNS=$PROP_RUNS")
    local net=(--network none)
    local wrap=()
    if [ "$3" = 1 ]; then
      net=(--network "$NET")
      env+=(-e TEST_PG_ADMIN_URL -e TEST_REDIS_URL)
      if [ "$HOST_SVC" = 1 ]; then
        net=("${EXT_RUN[@]}")
        wrap=("${EXT_WRAP[@]}")
      fi
    fi
    local red_rc=0
    RED_PLAN="$2" svc_run docker run --rm --name "$1" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
      "${net[@]}" \
      -v "$SRC:/src:ro" \
      -v "$STORE_VOL:/store:ro" \
      -v "$VDIR/out:/out" \
      -v "$IMG_DIR/red-reporter.mjs:/red/red-reporter.mjs:ro" \
      --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
      ${SPEC_ARGS[@]+"${SPEC_ARGS[@]}"} \
      "${env[@]}" \
      "$IMAGE" ${wrap[@]+"${wrap[@]}"} couli-verify-entrypoint red >>"$LOG" 2>&1 </dev/null || red_rc=$?
    [ "$red_rc" = 0 ] || die "the red run did not produce its reports (exit $red_rc), see $LOG"
  }
  red_db_plan="$(red_part 1)"
  red_offline_plan="$(red_part 0)"
  if [ -n "$red_db_plan" ]; then
    if [ "$HOST_SVC" = 1 ]; then
      start_host_services 'integration rule tests'
      step "running the task's integration rule tests (red run) in $IMAGE, no network, host services (limit ${TIMEOUT_SECS}s)"
    else
      start_services 'integration rule tests'
      step "running the task's integration rule tests (red run) in $IMAGE on $NET (limit ${TIMEOUT_SECS}s)"
    fi
    red_container "$RED_DB_NAME" "$red_db_plan" 1
  fi
  if [ -n "$red_offline_plan" ]; then
    step "running the task's other rule tests (red run) in $IMAGE, no network (limit ${TIMEOUT_SECS}s)"
    red_container "$VERIFY_NAME" "$red_offline_plan" 0
  fi
  # Every group must have written its report (the red reporter, with failure causes).
  reports=''
  for name in $(node -e 'for (const g of JSON.parse(process.argv[1]).groups) console.log(g.name)' "$RED_PLAN"); do
    [ -f "$VDIR/out/$name.json" ] || die "the red run wrote no report for $name, see $LOG"
    reports="${reports:+$reports,}$VDIR/out/$name.json"
  done
  [ -n "$reports" ] || die "the red run wrote no report, see $LOG"
  rc=0
  # CT-06p: the base and the snapshot tree let red-check hold the rule-test files that existed at
  # the base to their new and changed tests only (the expected list above is unchanged). Without a
  # tree (a plain directory) every test of every expected file must be red, as before.
  red_base=()
  if [ -n "${tree:-}" ]; then red_base=(--cwd "$WT" --base "$BASE_ARG" --head-tree "$tree"); fi
  (cd "$TRUSTED" && node tools/guard/red-check.ts --task "$ID" --report "$reports" \
    --expected-list "$VDIR/expected.txt" ${red_base[@]+"${red_base[@]}"} --root /work/repo --json) \
    >"$VDIR/red-check.json" 2>>"$LOG" || rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 1 ] || die "red-check failed to run (exit $rc), see $LOG"
  finish "$rc"
fi

if [ "$SCRIPT" = browser ]; then
  # The browser projects only, no network at all: Vitest serves the browser tests and Chromium
  # loads them on the container's loopback; the build smoke serves its builds there too. The
  # output directory takes the screenshots and the reports.
  # The container runs as uid 1000 (node), which is not the owner of the directory on a Linux
  # host: it needs write and search permission as "other". 1733 gives it exactly that (no
  # listing, and the sticky bit keeps it from removing what it did not create); the owner keeps
  # full access to read the results.
  mkdir -p "$VDIR/out"
  chmod 1733 "$VDIR/out"
  step "running the browser tests ($BROWSER_PROJECTS) in $IMAGE (no network, limit ${TIMEOUT_SECS}s)"
  BROWSER_ENV=("${NODE_HEAP[@]}" "${VITEST_ENV[@]}" -e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS"
    -e "BROWSER_PROJECTS=$BROWSER_PROJECTS")
  [ -z "${PROP_RUNS:-}" ] || BROWSER_ENV+=(-e "PROP_RUNS=$PROP_RUNS")
  rc=0
  docker run --rm --name "$VERIFY_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
    --network none \
    -v "$SRC:/src:ro" \
    -v "$STORE_VOL:/store:ro" \
    -v "$VDIR/out:/out" \
    --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
    "${BROWSER_ENV[@]}" \
    "$IMAGE" couli-verify-entrypoint browser >>"$LOG" 2>&1 </dev/null || rc=$?
  # The run exists to export screenshots for the design comparison: a green run that exported
  # none (no test called page.screenshot, or the export directory was not used) fails.
  shots="$( (find "$VDIR/out/screenshots" -type f -name '*.png' 2>/dev/null || true) | wc -l | tr -d ' ')"
  # The build smoke writes smoke-<entry>.png at the top of the directory; Vitest browser mode
  # writes below a directory per test file.
  smoke_shots="$( (find "$VDIR/out/screenshots" -maxdepth 1 -type f -name 'smoke-*.png' 2>/dev/null || true) | wc -l | tr -d ' ')"
  step "browser tests exited $rc; screenshots exported: $shots (browser tests $((shots - smoke_shots)), build smoke $smoke_shots; $VDIR/out/screenshots)"
  if [ "$rc" = 0 ] && [ "$shots" = 0 ]; then
    step "no screenshot was exported to out/screenshots: the browser run counts as failed (exit 1)"
    log "verify-container: no screenshot was exported to $VDIR/out/screenshots"
    rc=1
  fi
  finish "$rc"
fi

if [ "$SCRIPT" = 'verify:fast' ]; then
  # verify:fast connects to no database and no network (规划/11 §4.1): no PostgreSQL, no
  # Redis, no network at all.
  step "running pnpm run verify:fast in $IMAGE (no network, limit ${TIMEOUT_SECS}s)"
  FAST_ENV=("${NODE_HEAP[@]}" "${VITEST_ENV[@]}" -e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS" -e "VERIFY_SCRIPT=verify:fast")
  [ -z "${PROP_RUNS:-}" ] || FAST_ENV+=(-e "PROP_RUNS=$PROP_RUNS")
  rc=0
  docker run --rm --name "$VERIFY_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
    --network none \
    -v "$SRC:/src:ro" \
    -v "$STORE_VOL:/store:ro" \
    --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
    ${SPEC_ARGS[@]+"${SPEC_ARGS[@]}"} \
    "${FAST_ENV[@]}" \
    "$IMAGE" couli-verify-entrypoint verify >>"$LOG" 2>&1 </dev/null || rc=$?
  finish "$rc"
fi

VERIFY_NET=(--network "$NET")
if [ "$HOST_SVC" = 1 ]; then
  start_host_services 'pnpm verify'
  VERIFY_NET=("${EXT_RUN[@]}")
else
  start_services 'pnpm verify'
fi

step "running pnpm verify in $IMAGE (limit ${TIMEOUT_SECS}s)"
ENV_ARGS=("${NODE_HEAP[@]}" "${VITEST_ENV[@]}" -e TEST_PG_ADMIN_URL -e TEST_REDIS_URL
  -e "PROP_SEED=$PROP_SEED_VALUE" -e "VERIFY_TIMEOUT_SECS=$TIMEOUT_SECS")
[ -z "${PROP_RUNS:-}" ] || ENV_ARGS+=(-e "PROP_RUNS=$PROP_RUNS")
rc=0
svc_run docker run --rm --name "$VERIFY_NAME" "${LABELS[@]}" "${HARDEN[@]}" "${TMPFS[@]}" \
  "${VERIFY_NET[@]}" \
  -v "$SRC:/src:ro" \
  -v "$STORE_VOL:/store:ro" \
  --tmpfs "/store/v10/projects:rw,nosuid,uid=1000,gid=1000,mode=0755" \
  ${SPEC_ARGS[@]+"${SPEC_ARGS[@]}"} \
  "${ENV_ARGS[@]}" \
  "$IMAGE" ${EXT_WRAP[@]+"${EXT_WRAP[@]}"} couli-verify-entrypoint verify >>"$LOG" 2>&1 </dev/null || rc=$?

finish "$rc"
