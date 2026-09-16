#!/usr/bin/env bash
# 写运行时清单（runtime/.24h-os-runtime.json）—— 被 build-runtime.sh 调用，也可以单独跑。
#
# 为什么要单独一个文件：清单是"这份运行时到底是什么"的身份证，诊断页、打包自检、
# 回滚判断都读它。字段要么能对上上游（coreCommit），要么能指纹化这份产物（coreTreeSha256）。
#
# 用法：scripts/write-runtime-manifest.sh <runtime目录> <coreRef> <coreVersion> <python版本> <pip镜像>
set -euo pipefail

RUNTIME="${1:?缺 runtime 目录}"
REF="${2:-main}"
CORE_VER="${3:-unknown}"
PY_VER="${4:-unknown}"
MIRROR="${5:-}"
CORE_DIR="$RUNTIME/core"

# 上游 commit：能连 api.github.com 就记下来（连不上不阻塞构建，只是这一格留空）
CORE_COMMIT="$(curl -s --max-time 20 "https://api.github.com/repos/NousResearch/hermes-agent/commits/$REF" 2>/dev/null \
  | sed -n 's/.*"sha" *: *"\([0-9a-f]\{40\}\)".*/\1/p' | head -1 || true)"

# 源码树指纹：按 "相对路径 大小" 排序后取 sha256 —— 换核心/改文件都会变，用来识别"跑的是哪一份代码"
TREE_SHA=""
if [ -d "$CORE_DIR" ]; then
  TREE_SHA="$(cd "$CORE_DIR" && find . -type f -printf '%p %s\n' 2>/dev/null | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"
fi

PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
cat > "$RUNTIME/.24h-os-runtime.json" <<JSON
{"schema":1,"coreRef":"$REF","coreVersion":"$CORE_VER","coreCommit":"${CORE_COMMIT:-}","coreTreeSha256":"${TREE_SHA:-}","builtAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","python":"$PY_VER","platform":"$PLATFORM","pipMirror":"$MIRROR","layout":"venv+core-source"}
JSON
echo "    清单: coreVersion=$CORE_VER commit=${CORE_COMMIT:0:8}${CORE_COMMIT:+…} tree=${TREE_SHA:0:8}${TREE_SHA:+…} platform=$PLATFORM"
