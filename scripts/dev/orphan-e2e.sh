#!/usr/bin/env bash
set -u
cd /vol1/@apphome/trim.openclaw/data/home/24H-OS || exit 1
ROOT=$PWD
CORE="$ROOT/runtime/venv/bin/python"
fails=0
chk() { if [ "$2" = "$3" ]; then echo "✓ $1（$2）"; else echo "✗ $1（实际 $2，期望 $3）"; fails=$((fails+1)); fi; }

# 先清干净
for p in $(ps -eo pid,args | grep -F 'hermes_cli.main serve --host' | grep -v grep | awk '{print $1}'); do kill "$p" 2>/dev/null; done
sleep 1

setsid bash -c "PYTHONPATH=$ROOT/runtime/core $CORE -m hermes_cli.main serve --host 127.0.0.1 --port 0 > /tmp/orphan3.log 2>&1 & echo \$! > /tmp/test-core.pid; sleep 120" >/dev/null 2>&1 &
echo $! > /tmp/test-wrap.pid
sleep 12
CORE_PID=$(cat /tmp/test-core.pid 2>/dev/null)
WRAP_PID=$(cat /tmp/test-wrap.pid 2>/dev/null)
echo "核心 PID=$CORE_PID（父=$WRAP_PID）"
chk "阶段1 前置：核心在跑且父进程是包装 shell" "$(ps -o ppid= -p "$CORE_PID" 2>/dev/null | tr -d ' ')" "$WRAP_PID"

K1=$(node -e 'import("./electron/orphan-sweep.mjs").then(({sweepOrphanCores})=>{const r=sweepOrphanCores({minAgeSeconds:5});console.log(r.killed.join(","))})')
chk "阶段1：父进程还在 → 不回收" "${K1:-无}" "无"

kill "$WRAP_PID" 2>/dev/null
sleep 3
chk "阶段2 前置：核心已成孤儿（PPID=1）" "$(ps -o ppid= -p "$CORE_PID" 2>/dev/null | tr -d ' ')" "1"

K2=$(node -e 'import("./electron/orphan-sweep.mjs").then(({sweepOrphanCores})=>{const r=sweepOrphanCores({minAgeSeconds:5,log:(m)=>console.error(m)});console.log(r.killed.join(","))})' 2>/dev/null)
chk "阶段2：孤儿被回收" "$K2" "$CORE_PID"
sleep 1
ps -p "$CORE_PID" >/dev/null 2>&1 && { echo "✗ 孤儿仍在"; fails=$((fails+1)); } || echo "✓ 孤儿进程已不存在"

echo
[ "$fails" = "0" ] && echo "全部通过 ✓" || echo "有 $fails 项失败 ✗"
rm -f /tmp/test-core.pid /tmp/test-wrap.pid
