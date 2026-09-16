#!/usr/bin/env bash
# 构建"可随壳发行的核心运行时"。
#
#   scripts/build-runtime.sh [ref]        # ref 默认 main（codeload 拉源码，不需要 git 访问 github.com）
#
# 关键约束（踩过）：Hermes 的 setup.py **拒绝**构建 wheel/sdist：
#     "Building wheels or sdists for hermes-agent is not supported."
#   官方只支持：shell installer / Docker / Nix / 开发用 editable 安装。
#   所以随包运行时的正确形态是 —— **依赖装进 venv + 核心源码树一起发**，
#   壳启动时用 PYTHONPATH 指向源码树跑 `python -m hermes_cli.main`（上游桌面自己也是这么启动的）。
#
# 产物布局：
#   runtime/venv/     只装依赖的虚拟环境
#   runtime/core/     核心源码树（去掉 tests/website 省体积，保留 scripts/tui_gateway 等）
#   runtime/.24h-os-runtime.json   构建元数据（ref/版本/时间）
#
# 环境变量：
#   PYTHON=/path/to/python     构建用解释器（3.11–3.13，默认 python3）
#   PIP_MIRROR=https://...     pip 索引（默认阿里云；本机 pypi.org 不可达）
#   RUNTIME_DIR=/path          产物目录（默认 <repo>/runtime）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${1:-main}"
SAFE_REF="$(printf '%s' "$REF" | tr '/:' '__')"
CACHE="${TMPDIR:-/tmp}/24h-os-runtime"
SRC="$CACHE/src-$SAFE_REF"
TGZ="$CACHE/hermes-agent-$SAFE_REF.tgz"
RUNTIME="${RUNTIME_DIR:-$REPO_ROOT/runtime}"
PIP_MIRROR="${PIP_MIRROR:-https://mirrors.aliyun.com/pypi/simple/}"
PY="${PYTHON:-python3}"

echo "==> 构建核心运行时"
echo "    ref=$REF  解释器=$PY  产物=$RUNTIME"
echo "    pip 索引=$PIP_MIRROR"

VER="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
case "$VER" in
  3.11|3.12|3.13) echo "    python $VER ✓" ;;
  *) echo "✗ 需要 python 3.11–3.13（Hermes requires-python >=3.11,<3.14），当前 $VER" >&2; exit 2 ;;
esac

mkdir -p "$CACHE"
if [[ ! -f "$SRC/pyproject.toml" ]]; then
  if [[ ! -s "$TGZ" ]]; then
    echo "==> 拉取核心源码（codeload）"
    curl -fsSL -m 600 -o "$TGZ.part" "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/$REF"
    mv "$TGZ.part" "$TGZ"
  fi
  echo "==> 解压到 $SRC"
  rm -rf "$SRC"; mkdir -p "$SRC"
  tar xzf "$TGZ" -C "$SRC" --strip-components=1
fi

CORE_VER="$(python3 - "$SRC/pyproject.toml" <<'PYEOF'
import sys, re
t = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r'^version\s*=\s*"([^"]+)"', t, re.M)
print(m.group(1) if m else "unknown")
PYEOF
)"
echo "    核心版本: $CORE_VER"

# 1) 核心源码树（去掉 tests/website：随包不需要，省 70+ MB）
echo "==> 拷贝源码树 → runtime/core"
rm -rf "$RUNTIME"; mkdir -p "$RUNTIME/core"
rsync -a --exclude 'tests/' --exclude 'website/' --exclude '.git/' --exclude 'node_modules/' \
      --exclude '__pycache__/' --exclude '.github/' --exclude 'contributors/' \
      "$SRC/" "$RUNTIME/core/"

# 2) 依赖清单（从 pyproject 的 [project].dependencies 抽；不能走 wheel 构建）
echo "==> 解析依赖清单"
python3 - "$RUNTIME/core/pyproject.toml" "$RUNTIME/deps.txt" <<'PYEOF'
import re, sys
raw = open(sys.argv[1], encoding="utf-8").read()
block = re.search(r"^dependencies\s*=\s*\[(.*?)^\]", raw, re.S | re.M).group(1)
deps = []
for line in block.splitlines():
    # 去掉行内注释（依赖清单里夹着大段说明文字，必须先砍掉再取引号内容）
    code = line.split("#", 1)[0]
    for item in re.findall(r'"([^"]+)"', code):
        if re.match(r"^[A-Za-z0-9_.\-]+(\[[^\]]*\])?\s*(==|>=|<=|~=|>|<|!=)", item):
            deps.append(item.strip())
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(deps) + "\n")
print(f"    {len(deps)} 个直接依赖")
PYEOF

# 3) venv + 装依赖
echo "==> 建 venv 并安装依赖（最慢的一步）"
"$PY" -m venv "$RUNTIME/venv"
"$RUNTIME/venv/bin/python" -m pip install -q --upgrade pip -i "$PIP_MIRROR"
"$RUNTIME/venv/bin/python" -m pip install -q -r "$RUNTIME/deps.txt" -i "$PIP_MIRROR"

# 4) 验证：从源码树里把核心跑起来
echo "==> 冒烟：用 PYTHONPATH 指向源码树启动核心"
OUT="$(cd "$RUNTIME/core" && PYTHONPATH="$RUNTIME/core" HERMES_HOME="$(mktemp -d)" timeout 90 \
      "$RUNTIME/venv/bin/python" -m hermes_cli.main serve --host 127.0.0.1 --port 0 2>&1 | head -3 || true)"
echo "$OUT" | sed 's/^/    /'
if ! grep -q "HERMES_BACKEND_READY port=" <<<"$OUT"; then
  echo "✗ 核心没能起来（上面是它的输出）" >&2
  exit 1
fi

SIZE="$(du -sh "$RUNTIME" | cut -f1)"
# 清单统一由 scripts/write-runtime-manifest.mjs 生成（coreCommit / 源码树指纹 / platform 都在那）
node "$REPO_ROOT/scripts/write-runtime-manifest.mjs" --dir "$RUNTIME" --ref "$REF" --core-version "$CORE_VER" --python "$VER" --mirror "$PIP_MIRROR"
echo "==> 完成：$RUNTIME（$SIZE）"
echo "    元数据: $RUNTIME/.24h-os-runtime.json"
echo
echo "下一步："
echo "  npm run smoke      # 壳会自动发现 runtime/（venv+core）并跑端到端自检"
