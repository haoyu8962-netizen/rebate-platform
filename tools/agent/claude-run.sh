#!/usr/bin/env bash
# claude-run.sh — rule tests and adversarial reviews by a fresh, independent Claude context when
# Codex is not available or out of quota (owner decision 2026-10-21, ops/approvals.yaml id 36).
#
#   claude-run.sh impl   <id> [--phase test] [--worktree <dir>] [--timeout-min <n>] [--dry-run]
#   claude-run.sh review <id> [--worktree <dir>] [--review-type money|general|contract|spec-test]
#                             [--base <ref>] [--timeout-min <n>] [--full]
#                             [--confirm-round <commit>] [--dry-run]
#   claude-run.sh selfcheck
#
# The same command line, limits, exit codes (a usage limit or an overloaded model is 11), trusted
# prompts / schemas / validator, run directory and meta.json as codex-run.sh: this script runs
# codex-run.sh with the engine claude-independent, so the two cannot drift apart. What differs:
#   - every call is `claude -p` with a new session (never --resume / --continue, not persisted),
#     model claude-opus-5-5, without user, project or plugin configuration;
#   - review: read-only tools (Read, Grep, Glob, read-only git commands); the working tree must
#     be unchanged afterwards (exit 12 otherwise);
#   - impl: only --phase test; edits are allowed in the trusted ledger's test_paths and paths (the
#     NotImplemented skeletons) and nowhere else; path-guard checks the result again;
#   - meta.json records engine: "claude-independent"; the review output is
#     review-claude-independent.json, never review-codex.json.
# Codex stays first: use this only when Codex is not available (tools/agent/README.md §14).
# The Claude account is CLAUDE_INDEPENDENT_CONFIG_DIR (passed as CLAUDE_CONFIG_DIR; unset: the
# current one); no credential file is read.
set -euo pipefail

AGENT_ENGINE=claude-independent
# shellcheck source=tools/agent/codex-run.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/codex-run.sh" "$@"
