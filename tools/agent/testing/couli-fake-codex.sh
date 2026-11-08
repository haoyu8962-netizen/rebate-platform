#!/usr/bin/env bash
# Fake `codex` binary for the tools/agent tests (selected through COULI_CODEX_BIN).
# It never talks to a model and uses no quota. FAKE_CODEX_SCENARIO picks the behaviour,
# FAKE_CODEX_LOG is a directory that receives what the fake observed (argv, stdin, pids).
set -euo pipefail

LOG="${FAKE_CODEX_LOG:-}"
SCENARIO="${FAKE_CODEX_SCENARIO:-ok}"

if [ "${1:-}" = '--grandchild' ]; then
  # Background process of the `hang` scenario. It survives TERM, writes the `-o` file only
  # after TERM arrived (a late output) and keeps running until it is killed.
  out="$2"
  trap 'printf "%s\n" "{\"late\":true}" >"$out"' TERM
  while :; do sleep 0.1 || true; done
fi

if [ "${1:-}" = '--version' ]; then
  echo 'codex-cli 0.0.0-fake'
  exit 0
fi

if [ "${1:-}" = 'exec' ] && [ "${2:-}" = '--help' ]; then
  if [ "$SCENARIO" = 'help-missing-flag' ]; then
    echo '  -C, --cd <DIR>'
    exit 0
  fi
  cat <<'EOF'
Run Codex non-interactively (fake)
  -c, --config <key=value>
      --disable <FEATURE>
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
  -C, --cd <DIR>
      --ignore-user-config
      --ignore-rules
      --output-schema <FILE>
      --json
  -o, --output-last-message <FILE>
EOF
  exit 0
fi

[ "${1:-}" = 'exec' ] || {
  echo "fake codex: unsupported invocation: $*" >&2
  exit 64
}

out=''
schema=''
wt=''
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  case "${args[$i]}" in
    -o) out="${args[$((i + 1))]:-}" ;;
    --output-schema) schema="${args[$((i + 1))]:-}" ;;
    -C) wt="${args[$((i + 1))]:-}" ;;
  esac
  i=$((i + 1))
done

if [ -n "$LOG" ]; then
  mkdir -p "$LOG"
  printf '%s\0' "$@" >"$LOG/argv.nul"
  {
    printf 'wrapper=%s\n' "${COULI_CODEX_WRAPPER:-}"
    printf 'stdin=%s\n' "$(perl -e 'my @a = stat(STDIN); my @b = stat("/dev/null");
      print((@a && @b && $a[0] == $b[0] && $a[1] == $b[1]) ? "devnull" : "other")')"
    if [ -e "$out" ]; then echo 'out_existed=1'; else echo 'out_existed=0'; fi
    printf 'pid=%s\n' "$$"
    printf 'ppid=%s\n' "$PPID"
    printf 'cwd=%s\n' "$(pwd -P)"
  } >"$LOG/observed.txt"
fi

emit() { printf '%s\n' "$1"; }

# CT-06zzzz: the quota text of a real Codex run (D10-993).
USAGE_LIMIT_TEXT="You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 15th, 2026 12:25 AM."

start_events() {
  emit '{"type":"thread.started","thread_id":"0199fake-0000-7000-8000-000000000001"}'
  emit '{"type":"turn.started"}'
}

finish_events() {
  emit '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}'
  emit '{"type":"turn.completed","usage":{"input_tokens":13000,"cached_input_tokens":0,"output_tokens":200}}'
}

write_output() {
  if [ -n "${FAKE_CODEX_OUTPUT_FILE:-}" ]; then
    cat "$FAKE_CODEX_OUTPUT_FILE" >"$out"
    return
  fi
  # Only the file name decides the shape: a checkout path containing "review" must not.
  case "${schema##*/}" in
    review.schema.json)
      emit '{"verdict":"pass","summary":"fake review: nothing found","findings":[],"out_of_scope":[],"checklist":[]}' >"$out"
      ;;
    impl.schema.json)
      emit '{"task_done":true,"files_changed":["src/a.ts"],"commands":[{"cmd":"pnpm verify:fast","exit_code":0}],"tests_passed":true,"deps_needed":[],"outside_needed":[],"blocked_reason":"","notes":"fake"}' >"$out"
      ;;
    *)
      echo "fake codex: unknown output schema: $schema" >&2
      exit 64
      ;;
  esac
}

test_git() {
  git -C "$wt" -c user.name=test -c user.email=test@example.invalid \
    -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@" >/dev/null 2>&1
}

case "$SCENARIO" in
  ok)
    start_events
    write_output
    finish_events
    ;;
  fail)
    start_events
    emit '{"type":"error","message":"boom"}'
    emit '{"type":"turn.failed","error":{"message":"boom"}}'
    exit 1
    ;;
  fail-quoting-capacity)
    # The capacity text appears only inside an ordinary item (quoted file content).
    start_events
    emit '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","aggregated_output":"Selected model is at capacity"}}'
    emit '{"type":"turn.failed","error":{"message":"boom"}}'
    exit 1
    ;;
  bad-json)
    start_events
    printf 'not json {' >"$out"
    finish_events
    ;;
  bad-schema)
    start_events
    emit '{"task_done":true}' >"$out"
    finish_events
    ;;
  no-turn-completed)
    start_events
    write_output
    ;;
  capacity)
    emit '{"type":"thread.started","thread_id":"0199fake-0000-7000-8000-000000000001"}'
    emit '{"type":"error","message":"Selected model is at capacity. Please try a different model."}'
    emit '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}'
    echo 'ERROR: Selected model is at capacity. Please try a different model.' >&2
    exit 1
    ;;
  usage-limit)
    # CT-06zzzz (D10-993): what a real `codex exec` printed when the account was out of its
    # usage window: no output, the quota text in an error and a turn.failed event, exit 1.
    start_events
    emit "{\"type\":\"error\",\"message\":\"$USAGE_LIMIT_TEXT\"}"
    emit "{\"type\":\"turn.failed\",\"error\":{\"message\":\"$USAGE_LIMIT_TEXT\"}}"
    echo 'Reading additional input from stdin...' >&2
    exit 1
    ;;
  fail-quoting-usage-limit)
    # The quota text appears only inside an ordinary item (quoted file content).
    start_events
    emit "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"command_execution\",\"aggregated_output\":\"$USAGE_LIMIT_TEXT\"}}"
    emit '{"type":"turn.failed","error":{"message":"boom"}}'
    exit 1
    ;;
  hang)
    start_events
    bash "$0" --grandchild "$out" &
    [ -z "$LOG" ] || printf 'grandchild=%s\n' "$!" >>"$LOG/observed.txt"
    while :; do sleep 0.1 || true; done
    ;;
  stragglers)
    start_events
    write_output
    (
      trap '' TERM
      while :; do sleep 0.1 || true; done
    ) &
    [ -z "$LOG" ] || printf 'grandchild=%s\n' "$!" >>"$LOG/observed.txt"
    finish_events
    ;;
  busy-then-finish)
    # No event for 5 seconds, but a descendant burns CPU the whole time (a test run inside
    # the sandbox): the CPU half of the liveness rule must keep the run alive. Sub-second clock,
    # so the silence lasts the full 5 s and not anything between 4 and 5.
    start_events
    perl -MTime::HiRes=time -e 'my $end = time + 5; my $x = 0; while (time < $end) { $x += $_ for 1 .. 100000 }'
    write_output
    finish_events
    ;;
  escape-setsid)
    # A descendant leaves the process group with setsid() and keeps running after the leader
    # has finished normally; it would write into the worktree once the guards have run.
    start_events
    perl -e '
      use POSIX qw(setsid);
      my $log = shift; my $wt = shift;
      exit 0 if fork;            # the intermediate parent returns at once
      setsid();
      if (open(my $fh, ">", "$log/escaped.pid")) { print {$fh} "$$\n"; close($fh); }
      sleep 4;
      if (open(my $fh, ">", "$wt/src/a.ts")) { print {$fh} "export const a = 666; // injected after guards\n"; close($fh); }
      sleep 60;
    ' "${LOG:-/dev/null}" "$wt"
    write_output
    finish_events
    ;;
  git-commit)
    start_events
    test_git commit --allow-empty -m 'rogue commit'
    write_output
    finish_events
    ;;
  git-add)
    start_events
    echo 'rogue' >"$wt/rogue.txt"
    test_git add rogue.txt
    write_output
    finish_events
    ;;
  git-branch)
    start_events
    test_git branch rogue-branch
    write_output
    finish_events
    ;;
  git-branch-other-task)
    # What the orchestrator does for another task while this run is in flight.
    start_events
    test_git branch task/Z9-99
    write_output
    finish_events
    ;;
  git-move-main)
    start_events
    rogue="$(git -C "$wt" -c user.name=test -c user.email=test@example.invalid \
      commit-tree -m rogue 'HEAD^{tree}')"
    test_git update-ref refs/heads/main "$rogue"
    write_output
    finish_events
    ;;
  git-stash)
    start_events
    echo 'export const a = 99;' >"$wt/src/a.ts"
    test_git stash
    write_output
    finish_events
    ;;
  git-config)
    start_events
    test_git config core.hooksPath /somewhere/else
    write_output
    finish_events
    ;;
  git-hook)
    start_events
    hooks="$(cd "$wt" && cd "$(git rev-parse --git-common-dir)" && pwd -P)/hooks"
    mkdir -p "$hooks"
    printf '#!/bin/sh\necho rogue\n' >"$hooks/pre-commit"
    write_output
    finish_events
    ;;
  *)
    echo "fake codex: unknown scenario: $SCENARIO" >&2
    exit 64
    ;;
esac
exit 0
