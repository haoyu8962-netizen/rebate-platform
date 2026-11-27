#!/usr/bin/env bash
# Runs inside the verify image; see tools/ops/verify-container.sh for the container setup.
#
#   couli-verify-entrypoint fetch    networked, sees only /in/pnpm-lock.yaml and
#                                    /in/pnpm-workspace.yaml; fills the store volume at /store
#   couli-verify-entrypoint verify   offline; copies /src to /work/repo, installs from the
#                                    read-only store and runs `pnpm verify` under a time limit
#                                    (VERIFY_SCRIPT=verify:fast: `pnpm run verify:fast` instead)
#   couli-verify-entrypoint red      offline; copies /src, installs, then runs the groups of
#                                    RED_PLAN (JSON from tools/ops/red-plan.ts: project dir,
#                                    Vitest config, files) each with the trusted reporter
#                                    /red/red-reporter.mjs (mounted read-only); reports go to
#                                    /out/<project>.json. The tests are expected to fail (red):
#                                    their exit code is recorded in /out/<project>.exit, not
#                                    returned; tools/guard/red-check.ts judges.
#   couli-verify-entrypoint browser  offline; copies /src, installs, then runs every browser
#                                    project (BROWSER_PROJECTS: "<name>:<dir>:<config>" words,
#                                    from the trusted red-projects.json) in order, under one time
#                                    limit for all; spec-browser in Vitest browser mode, build-smoke
#                                    with the playwright library against its own builds. Both use
#                                    the image's Chromium. Screenshots go to /out/screenshots
#                                    (COULI_BROWSER_SCREENSHOT_DIR), each project's Vitest JSON
#                                    report to /out/<name>.vitest-report.json; every project runs,
#                                    the exit code is the first failing one's. Needs an image built
#                                    with Playwright's browser (PLAYWRIGHT_VERSION).
set -euo pipefail

mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

# Copies the read-only snapshot /src to /work/repo and installs from the offline store.
# node_modules of the host holds darwin binaries; .git is not needed and not exposed.
# *.tsbuildinfo is git-ignored, so the path guard never sees it: a stale or forged one must
# not let `tsc -b` skip a project inside the container.
prepare_repo() { # <log tag>
  mkdir -p /work/repo
  tar -C /src \
    --exclude=node_modules --exclude=.git --exclude=dist --exclude=.turbo --exclude=.tmp \
    --exclude='*.tsbuildinfo' \
    -cf - . | tar -C /work/repo -xf -
  cd /work/repo
  echo "[$1] pnpm install --offline --frozen-lockfile"
  pnpm install --offline --frozen-lockfile --store-dir /store
}

# browser (D10-3369): copies the screenshot comparison report the browser tests leave in
# /work/repo/test/.tmp/visual-baseline to /out/visual-baseline, keeping relative paths. Regular
# files only: a symbolic link (to a file, a directory or nowhere) is never copied or followed, and
# a report directory that is itself a link is not exported at all. Absent directory: nothing.
export_visual_baseline() {
  local report=/work/repo/test/.tmp/visual-baseline
  local dest=/out/visual-baseline
  local file rel
  # The tests could write to /out as well: whatever they left under that name goes first.
  rm -rf -- "$dest" || return 1
  if [ -L "$report" ]; then
    echo "[browser] visual-baseline: the report directory is a symbolic link, not exported"
    return 0
  fi
  if [ ! -d "$report" ]; then
    echo "[browser] visual-baseline: no report directory, nothing to export"
    return 0
  fi
  mkdir -p -- "$dest" || return 1
  # find without -L never follows links; -type f leaves out links and every non-regular file.
  while IFS= read -r -d '' file; do
    rel="${file#./}"
    mkdir -p -- "$dest/$(dirname -- "$rel")" || return 1
    cp -- "$report/$rel" "$dest/$rel" || return 1
  done < <(cd "$report" && find . -type f -print0)
  echo "[browser] visual-baseline: report exported to /out/visual-baseline"
}

# A plan or project entry: a plain relative path (no `..`, no spaces, no shell syntax).
plain_path() {
  [[ "$1" =~ ^[A-Za-z0-9_./@-]+$ ]] && [[ "$1" != *..* ]] && [[ "$1" != /* ]]
}

case "${1:-}" in
  fetch)
    mkdir -p /work/fetch
    cd /work/fetch
    cp /in/pnpm-lock.yaml /in/pnpm-workspace.yaml .
    pnpm fetch --store-dir /store
    # Mount point for the tmpfs that covers the per-project registry of a read-only store.
    mkdir -p /store/v10/projects
    touch /store/.couli-fetch-ok
    ;;
  verify)
    limit="${VERIFY_TIMEOUT_SECS:?VERIFY_TIMEOUT_SECS is required}"
    script="${VERIFY_SCRIPT:-verify}"
    case "$script" in
      verify | verify:fast) ;;
      *)
        echo "VERIFY_SCRIPT must be verify or verify:fast" >&2
        exit 2
        ;;
    esac
    prepare_repo verify
    echo "[verify] pnpm run ${script} (limit ${limit}s)"
    started=$(date +%s)
    rc=0
    timeout --signal=TERM --kill-after=10 "$limit" pnpm run "$script" || rc=$?
    elapsed=$(( $(date +%s) - started ))
    # `timeout` reports 137 when the command ignored TERM and had to be killed.
    if [ "$rc" -eq 137 ] && [ "$elapsed" -ge "$limit" ]; then rc=124; fi
    echo "[verify] pnpm run ${script} exited ${rc} after ${elapsed}s"
    exit "$rc"
    ;;
  red)
    limit="${VERIFY_TIMEOUT_SECS:?VERIFY_TIMEOUT_SECS is required}"
    prepare_repo red
    cd /work/repo/test
    [ -f /red/red-reporter.mjs ] || { echo "[red] /red/red-reporter.mjs is not mounted" >&2; exit 2; }
    plan_lines="$(node -e '
      const plan = JSON.parse(process.env.RED_PLAN ?? "");
      const ok = (s) => typeof s === "string" && /^[A-Za-z0-9_.\/@-]+$/.test(s) && !s.includes("..");
      for (const g of plan.groups) {
        if (![g.name, g.dir, g.config, ...g.files].every(ok)) throw new Error("bad plan entry");
        console.log([g.name, g.dir, g.config, ...g.files].join(" "));
      }
    ')" || { echo "[red] RED_PLAN is missing or invalid" >&2; exit 2; }
    while read -r name dir config files; do
      [ -n "$name" ] || continue
      rc=0
      echo "[red] ${name}: vitest run --config ${config} in ${dir}: ${files}"
      # shellcheck disable=SC2086 # files: one word per path, validated above
      (cd "/work/repo/$dir" && RED_REPORT_OUT="/out/${name}.json" timeout --signal=TERM \
        --kill-after=10 "$limit" pnpm exec vitest run --config "$config" \
        --reporter=/red/red-reporter.mjs $files) || rc=$?
      echo "$rc" >"/out/${name}.exit"
      echo "[red] ${name} exited ${rc} (red is expected)"
    done <<<"$plan_lines"
    ;;
  browser)
    limit="${VERIFY_TIMEOUT_SECS:?VERIFY_TIMEOUT_SECS is required}"
    projects="${BROWSER_PROJECTS:-}"
    [ -n "$projects" ] || { echo "[browser] BROWSER_PROJECTS is not set" >&2; exit 2; }
    for entry in $projects; do
      IFS=: read -r name dir config extra <<<"$entry"
      if [ -n "${extra:-}" ] || ! plain_path "$name" || ! plain_path "$dir" || ! plain_path "$config"; then
        echo "[browser] BROWSER_PROJECTS entries must be <name>:<dir>:<config> plain relative paths" >&2
        exit 2
      fi
    done
    [ -d /out ] && [ -w /out ] || { echo "[browser] /out is not mounted writable" >&2; exit 2; }
    [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$PLAYWRIGHT_BROWSERS_PATH" ] || {
      echo "[browser] this image has no Playwright browser (built with PLAYWRIGHT_VERSION=none)" >&2
      exit 2
    }
    prepare_repo browser
    mkdir -p /out/screenshots
    started=$(date +%s)
    rc=0
    for entry in $projects; do
      IFS=: read -r name dir config <<<"$entry"
      left=$(( limit - ($(date +%s) - started) ))
      if [ "$left" -le 0 ]; then
        echo "[browser] ${name}: no time left (limit ${limit}s)"
        [ "$rc" -ne 0 ] || rc=124
        continue
      fi
      echo "[browser] ${name}: vitest run --config ${config} in ${dir} (${left}s left)"
      p_started=$(date +%s)
      p_rc=0
      # The command-line reporters replace the config's: build-smoke keeps its strict reporter
      # (page errors and failed own requests in the diagnostics fail the run).
      strict=()
      if [ "$name" = build-smoke ]; then
        strict=(--reporter=/work/repo/tools/ops/build-smoke/strict-reporter.mjs)
      fi
      (cd "/work/repo/$dir" && COULI_BROWSER_SCREENSHOT_DIR=/out/screenshots timeout --signal=TERM \
        --kill-after=10 "$left" pnpm exec vitest run --config "$config" \
        --reporter=default --reporter=json "${strict[@]}" \
        --outputFile.json="/out/${name}.vitest-report.json") || p_rc=$?
      p_elapsed=$(( $(date +%s) - p_started ))
      if [ "$p_rc" -eq 137 ] && [ "$p_elapsed" -ge "$left" ]; then p_rc=124; fi
      echo "[browser] ${name}: vitest exited ${p_rc} after ${p_elapsed}s"
      [ "$rc" -ne 0 ] || rc="$p_rc"
    done
    # D10-3369: whatever the projects' results, export the screenshot comparison report
    # (test/.tmp/visual-baseline/: summary-*.json, actual and diff images) to /out/visual-baseline.
    # Export only, never part of the verdict: rc is already recorded and a failed copy only logs.
    export_visual_baseline || echo "[browser] visual-baseline: export failed (the exit code is unchanged)" >&2
    echo "[browser] exited ${rc} after $(( $(date +%s) - started ))s"
    exit "$rc"
    ;;
  *)
    echo "usage: couli-verify-entrypoint fetch|verify|red|browser" >&2
    exit 2
    ;;
esac
