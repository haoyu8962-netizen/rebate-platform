#!/usr/bin/env bash
# B1-01zzu（编排 D10-1288 / D10-1290）：把负责人本机 ~/.couli/aliyun-review.env 里阿里云内容安全的三个值
# 同步到 staging 节点的 /etc/couli/staging.env。用法与前提见 infra/staging/README.md 1.13。
#
#   sync-aliyun-review.sh --check
#   sync-aliyun-review.sh --apply <ssh 目的地> [--identity <私钥文件>]
#
# 值的去向：值只在本脚本的 shell 变量与管道里，只用 shell 内建（read / case / printf）处理，
# 不作为任何外部命令的参数，也不用 here-document（它可能落临时文件）；经 ssh 的标准输入传到节点。
# 节点上执行的是下面 NODE_SCRIPT 这段固定脚本（作为 ssh 的参数，不含值），目标路径作为它的参数。
# 任何输出只有键名、yes/no、ok/bad、行号、步骤与原因，不带值。
#
# 退出码：0 成功；1 本地核对不过；2 用法错误；3 节点上的同步没有完成（节点脚本已说明原因）。
# 测试钩子（只改位置与程序）：COULI_SYNC_ENV_FILE、COULI_SYNC_SSH、COULI_SYNC_TARGET。
set +x
set +v
set -u
LC_ALL=C
export LC_ALL

KEY_ID=AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID
KEY_SK=AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET
KEY_ENDPOINT=AGENT_REVIEW_ALIYUN_ENDPOINT

usage() {
  {
    printf '%s\n' "用法: sync-aliyun-review.sh --check"
    printf '%s\n' "      sync-aliyun-review.sh --apply <ssh 目的地> [--identity <私钥文件>]"
    if [ -n "${1:-}" ]; then printf '用法错误: %s\n' "$1"; fi
  } >&2
  exit 2
}

# 节点上运行的固定脚本：不含值，不含单引号（整段放在单引号里交给远端 shell）。
# 参数 $1 是目标文件；标准输入是三行 KEY=值。
NODE_SCRIPT='set +x
set +v
set -u
umask 077
LC_ALL=C
export LC_ALL
target=$1
k_id=AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID
k_sk=AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET
k_endpoint=AGENT_REVIEW_ALIYUN_ENDPOINT
backup="$target.bak-sync-aliyun-review"
tmp=
backup_made=0
renamed=0
done_ok=0
cleanup() {
  exec 3<&- 4<&-
  if [ -n "$tmp" ]; then rm -f -- "$tmp" 2>/dev/null; fi
  if [ "$done_ok" -eq 0 ] && [ "$backup_made" -eq 1 ]; then
    if [ "$renamed" -eq 1 ]; then
      mv -f -- "$backup" "$target" 2>/dev/null && printf "%s\n" "sync-aliyun-review (node): restored the target from the backup" >&2
    else
      rm -f -- "$backup" 2>/dev/null
    fi
  fi
}
trap cleanup EXIT
trap "exit 4" HUP INT TERM PIPE
fail() {
  printf "sync-aliyun-review (node): %s\n" "$1" >&2
  exit 3
}
file_mode() {
  stat -c %a -- "$1" 2>/dev/null || stat -f %Lp -- "$1" 2>/dev/null
}
case "$target" in
  /*) ;;
  *) fail "step 1 target: the path is not absolute" ;;
esac
if [ -L "$target" ]; then fail "step 1 target: it is a symbolic link"; fi
if [ ! -e "$target" ]; then fail "step 1 target: it does not exist"; fi
if [ ! -f "$target" ]; then fail "step 1 target: it is not a regular file"; fi
if [ ! -O "$target" ]; then fail "step 1 target: its owner is not the user running this step"; fi
mode=$(file_mode "$target")
if [ "$mode" != "600" ]; then fail "step 1 target: its mode is not 600"; fi
if [ ! -r "$target" ] || [ ! -w "$target" ]; then fail "step 1 target: it is not readable and writable"; fi
if [ -e "$backup" ] || [ -L "$backup" ]; then
  fail "step 1 target: an old backup next to it exists; inspect it and remove it first"
fi
alnum_ok() {
  case "$1" in
    "" | *[!A-Za-z0-9]*) return 1 ;;
  esac
  return 0
}
sq=$(printf "\047")
endpoint_ok() {
  case "$1" in
    https://?*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[[:space:]]* | *[[:cntrl:]]* | *\$* | *\"* | *"$sq"* | *\`* | *\\*) return 1 ;;
  esac
  return 0
}
n_id=0
n_sk=0
n_endpoint=0
n_input=0
new_id=
new_sk=
new_endpoint=
while IFS= read -r line || [ -n "$line" ]; do
  n_input=$((n_input + 1))
  case "$line" in
    "$k_id="*) n_id=$((n_id + 1)); new_id=$line ;;
    "$k_sk="*) n_sk=$((n_sk + 1)); new_sk=$line ;;
    "$k_endpoint="*) n_endpoint=$((n_endpoint + 1)); new_endpoint=$line ;;
    *) fail "step 2 input: line $n_input is not one of the three keys" ;;
  esac
done
if [ "$n_id" -ne 1 ] || [ "$n_sk" -ne 1 ] || [ "$n_endpoint" -ne 1 ]; then
  fail "step 2 input: each of the three keys must come exactly once"
fi
alnum_ok "${new_id#"$k_id="}" || fail "step 2 input: $k_id has a bad format"
alnum_ok "${new_sk#"$k_sk="}" || fail "step 2 input: $k_sk has a bad format"
endpoint_ok "${new_endpoint#"$k_endpoint="}" || fail "step 2 input: $k_endpoint has a bad format"
t_id=0
t_sk=0
t_endpoint=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "$k_id="*) t_id=$((t_id + 1)) ;;
    "$k_sk="*) t_sk=$((t_sk + 1)) ;;
    "$k_endpoint="*) t_endpoint=$((t_endpoint + 1)) ;;
  esac
done < "$target"
if [ "$t_id" -gt 1 ] || [ "$t_sk" -gt 1 ] || [ "$t_endpoint" -gt 1 ]; then
  fail "step 2 target: one of the three keys has more than one line in the target; fix it by hand first"
fi
cp -p -- "$target" "$backup" 2>/dev/null || { rm -f -- "$backup" 2>/dev/null; fail "step 3 backup: copy failed"; }
backup_made=1
chmod 600 "$backup" 2>/dev/null || fail "step 3 backup: chmod failed"
tmp=$(mktemp "$target.tmp-sync-aliyun-review.XXXXXX" 2>/dev/null) || { tmp=; fail "step 4 temp file: mktemp failed"; }
[ -n "$tmp" ] || fail "step 4 temp file: mktemp failed"
chmod 600 "$tmp" 2>/dev/null || fail "step 4 temp file: chmod failed"
# Content is produced in a pipeline subshell and written by an external cat: a failed or partial
# write leaves nothing buffered in this shell, so no line can ever reach this shell standard output.
{
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$k_id="*) printf "%s\n" "$new_id" || exit 1 ;;
      "$k_sk="*) printf "%s\n" "$new_sk" || exit 1 ;;
      "$k_endpoint="*) printf "%s\n" "$new_endpoint" || exit 1 ;;
      *) printf "%s\n" "$line" || exit 1 ;;
    esac
  done < "$target" || exit 1
  if [ "$t_id" -eq 0 ]; then printf "%s\n" "$new_id" || exit 1; fi
  if [ "$t_sk" -eq 0 ]; then printf "%s\n" "$new_sk" || exit 1; fi
  if [ "$t_endpoint" -eq 0 ]; then printf "%s\n" "$new_endpoint" || exit 1; fi
  exit 0
} | cat > "$tmp" 2>/dev/null
write_status=("${PIPESTATUS[@]}")
if [ "${write_status[0]:-1}" -ne 0 ] || [ "${write_status[1]:-1}" -ne 0 ]; then
  fail "step 4 temp file: writing it failed (for example a full disk); the target is unchanged"
fi
replaced=$((t_id + t_sk + t_endpoint))
added=$((3 - replaced))
# Step 5a: before the rename, compare the temp file with the target line by line: every other line
# byte for byte, every key line the new line, then exactly the missing keys, then the end.
exec 3< "$target" 4< "$tmp" || fail "step 5 compare: could not open the files"
n_orig=0
n_tmp=0
n_keys=0
while IFS= read -r line <&3 || [ -n "$line" ]; do
  n_orig=$((n_orig + 1))
  case "$line" in
    "$k_id="*) want=$new_id; n_keys=$((n_keys + 1)) ;;
    "$k_sk="*) want=$new_sk; n_keys=$((n_keys + 1)) ;;
    "$k_endpoint="*) want=$new_endpoint; n_keys=$((n_keys + 1)) ;;
    *) want=$line ;;
  esac
  IFS= read -r got <&4 || fail "step 5 compare: the temp file is shorter than expected; the target is unchanged"
  n_tmp=$((n_tmp + 1))
  [ "$got" = "$want" ] || fail "step 5 compare: line $n_orig of the temp file differs from what was expected; the target is unchanged"
done
line=
want=
got=
[ "$n_keys" -eq "$replaced" ] || fail "step 5 compare: the target changed while it was being read; the target is unchanged"
for want in "$new_id" "$new_sk" "$new_endpoint"; do
  case "$want" in
    "$k_id="*) [ "$t_id" -eq 0 ] || continue ;;
    "$k_sk="*) [ "$t_sk" -eq 0 ] || continue ;;
    "$k_endpoint="*) [ "$t_endpoint" -eq 0 ] || continue ;;
  esac
  IFS= read -r got <&4 || fail "step 5 compare: an appended key line is missing in the temp file; the target is unchanged"
  n_tmp=$((n_tmp + 1))
  [ "$got" = "$want" ] || fail "step 5 compare: an appended key line differs in the temp file; the target is unchanged"
done
want=
got=
if IFS= read -r got <&4 || [ -n "$got" ]; then
  got=
  fail "step 5 compare: the temp file has more lines than expected; the target is unchanged"
fi
exec 3<&- 4<&-
[ "$n_tmp" -eq $((n_orig + added)) ] || fail "step 5 compare: the temp file line count is wrong; the target is unchanged"
mv -f -- "$tmp" "$target" 2>/dev/null || fail "step 5 rename: mv failed; the target is unchanged"
tmp=
renamed=1
c_id=0
c_sk=0
c_endpoint=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "$k_id="*) c_id=$((c_id + 1)); [ "$line" = "$new_id" ] || c_id=9 ;;
    "$k_sk="*) c_sk=$((c_sk + 1)); [ "$line" = "$new_sk" ] || c_sk=9 ;;
    "$k_endpoint="*) c_endpoint=$((c_endpoint + 1)); [ "$line" = "$new_endpoint" ] || c_endpoint=9 ;;
  esac
done < "$target"
line=
if [ "$c_id" -ne 1 ] || [ "$c_sk" -ne 1 ] || [ "$c_endpoint" -ne 1 ]; then
  fail "step 5 verify: the three keys are not exactly one new line each after the rename"
fi
mode=$(file_mode "$target")
if [ "$mode" != "600" ] || [ ! -O "$target" ]; then
  fail "step 5 verify: owner or mode 600 of the new target is wrong"
fi
done_ok=1
rm -f -- "$backup" 2>/dev/null || fail "step 6 cleanup: the target is updated, but the backup next to it could not be removed"
backup_made=0
printf "apply: %s: replaced %d, added %d, other lines unchanged; backup removed\n" "$target" "$replaced" "$added"
'

# ---- 参数 ----
action=
destination=
identity=
if [ "$#" -eq 1 ] && [ "$1" = "--check" ]; then
  action=check
elif [ "$#" -ge 2 ] && [ "$1" = "--apply" ]; then
  action=apply
  destination=$2
  shift 2
  if [ "$#" -eq 0 ]; then
    :
  elif [ "$#" -eq 2 ] && [ "$1" = "--identity" ]; then
    identity=$2
  else
    usage "--apply 之后只接受 <ssh 目的地> 与可选的 --identity <私钥文件>"
  fi
  case "$destination" in
    "" | -* | *[[:space:]]* | *[[:cntrl:]]*) usage "ssh 目的地为空、以 - 开头或含空白" ;;
  esac
  if [ -n "$identity" ] || [ "$#" -eq 2 ]; then
    case "$identity" in
      "" | -*) usage "--identity 缺私钥文件" ;;
    esac
    if [ ! -f "$identity" ]; then usage "--identity 指定的私钥文件不存在"; fi
  fi
else
  usage
fi

SOURCE_FILE=${COULI_SYNC_ENV_FILE:-"${HOME:-}/.couli/aliyun-review.env"}
SSH_PROGRAM=${COULI_SYNC_SSH:-ssh}
TARGET_FILE=${COULI_SYNC_TARGET:-/etc/couli/staging.env}

# ---- 本地核对（--check 与 --apply 都做）----
file_mode() {
  stat -L -c %a -- "$1" 2>/dev/null || stat -L -f %Lp -- "$1" 2>/dev/null
}

f_exists=no
f_regular=no
f_mode600=no
if [ -e "$SOURCE_FILE" ] || [ -L "$SOURCE_FILE" ]; then f_exists=yes; fi
if [ "$f_exists" = yes ] && [ -f "$SOURCE_FILE" ]; then f_regular=yes; fi
if [ "$f_regular" = yes ] && [ "$(file_mode "$SOURCE_FILE")" = "600" ]; then f_mode600=yes; fi

n_id=0
n_sk=0
n_endpoint=0
v_id=
v_sk=
v_endpoint=
bad_lines=
dup_note=
read_ok=no
if [ "$f_regular" = yes ] && [ -r "$SOURCE_FILE" ]; then
  read_ok=yes
  line_no=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    case "$line" in
      "") ;;
      "#"*) ;;
      "$KEY_ID="*) n_id=$((n_id + 1)); v_id=${line#"$KEY_ID="} ;;
      "$KEY_SK="*) n_sk=$((n_sk + 1)); v_sk=${line#"$KEY_SK="} ;;
      "$KEY_ENDPOINT="*) n_endpoint=$((n_endpoint + 1)); v_endpoint=${line#"$KEY_ENDPOINT="} ;;
      *) bad_lines="$bad_lines $line_no" ;;
    esac
  done < "$SOURCE_FILE"
fi
line=

alnum_ok() {
  case "$1" in
    "" | *[!A-Za-z0-9]*) return 1 ;;
  esac
  return 0
}

endpoint_ok() {
  case "$1" in
    https://?*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[[:space:]]* | *[[:cntrl:]]* | *\$* | *\"* | *\'* | *\`* | *\\*) return 1 ;;
  esac
  return 0
}

all_ok=yes
[ "$f_exists" = yes ] && [ "$f_regular" = yes ] && [ "$f_mode600" = yes ] || all_ok=no
printf 'file: exists=%s regular=%s mode600=%s\n' "$f_exists" "$f_regular" "$f_mode600"
if [ "$f_regular" = yes ] && [ "$read_ok" = no ]; then
  printf '%s\n' "note: the source file is not readable" >&2
fi

# report_key <键名> <出现次数> <格式核对函数> <值>：只打印 present / format，不打印值。
report_key() {
  present=no
  format=bad
  if [ "$2" -ge 1 ]; then present=yes; fi
  if [ "$2" -eq 1 ] && "$3" "$4"; then format=ok; fi
  if [ "$2" -gt 1 ]; then dup_note="$dup_note $1"; fi
  printf '%s: present=%s format=%s\n' "$1" "$present" "$format"
  [ "$present" = yes ] && [ "$format" = ok ] || all_ok=no
}
report_key "$KEY_ID" "$n_id" alnum_ok "$v_id"
report_key "$KEY_SK" "$n_sk" alnum_ok "$v_sk"
report_key "$KEY_ENDPOINT" "$n_endpoint" endpoint_ok "$v_endpoint"

if [ -n "$dup_note" ]; then
  for key in $dup_note; do printf 'note: %s appears more than once\n' "$key"; done
fi
if [ -n "$bad_lines" ]; then
  all_ok=no
  for n in $bad_lines; do
    printf 'note: line %s is not one of the three keys, a blank line or a # comment\n' "$n"
  done
fi

if [ "$all_ok" != yes ]; then
  v_id=
  v_sk=
  v_endpoint=
  printf '%s\n' "check: failed"
  exit 1
fi
printf '%s\n' "check: ok"

if [ "$action" = check ]; then
  exit 0
fi

# ---- --apply：值只经 ssh 的标准输入 ----
case "$TARGET_FILE" in
  /*) ;;
  *) usage "COULI_SYNC_TARGET 必须是绝对路径" ;;
esac
case "$TARGET_FILE" in
  *\'* | *[[:cntrl:]]*) usage "COULI_SYNC_TARGET 不能含单引号或控制字符" ;;
esac
case "$NODE_SCRIPT" in
  *\'*)
    printf '%s\n' "internal error: the node script must not contain a single quote" >&2
    exit 3
    ;;
esac

# 远端 shell 收到的是一条命令：bash -c '<固定脚本>' sync-aliyun-review '<目标路径>'。
remote_command="bash -c '$NODE_SCRIPT' sync-aliyun-review '$TARGET_FILE'"

if [ -n "$identity" ]; then
  printf '%s=%s\n' "$KEY_ID" "$v_id" "$KEY_SK" "$v_sk" "$KEY_ENDPOINT" "$v_endpoint" |
    "$SSH_PROGRAM" -i "$identity" "$destination" "$remote_command"
  statuses=("${PIPESTATUS[@]}")
else
  printf '%s=%s\n' "$KEY_ID" "$v_id" "$KEY_SK" "$v_sk" "$KEY_ENDPOINT" "$v_endpoint" |
    "$SSH_PROGRAM" "$destination" "$remote_command"
  statuses=("${PIPESTATUS[@]}")
fi
v_id=
v_sk=
v_endpoint=

ssh_status=${statuses[1]:-1}
if [ "$ssh_status" -ne 0 ]; then
  printf 'apply: failed (ssh or node step exit %s); see the node message above\n' "$ssh_status" >&2
  exit 3
fi
exit 0
