#!/usr/bin/env bash
# 打 Windows 安装包（NSIS）。
#
#   前提：① node_modules 已装（npm install）
#         ② runtime/ 已构建（scripts/build-runtime.sh）—— 安装包里会随带这份运行时
#
# 建议在 Windows 机器上跑（原生不必装 wine）；Linux/macOS 上打 NSIS 需要 wine。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -d node_modules ]]; then
  echo "✗ 先装依赖：NODE_ENV=development npm install --include=dev" >&2
  exit 2
fi
if [[ ! -x "runtime/bin/python" && ! -x "runtime/Scripts/python.exe" ]]; then
  echo "✗ 缺少运行时。先构建：" >&2
  echo "    PYTHON=python3.12 scripts/build-runtime.sh main" >&2
  exit 2
fi
if [[ ! -f build/icon.ico ]]; then
  echo "提示：build/icon.ico 不存在 —— 会用 Electron 默认图标；发布前请放 256×256 的 ico"
fi

echo "==> 运行时信息"
cat runtime/.24h-os-runtime.json 2>/dev/null || echo "    （无元数据文件）"
echo "    体积: $(du -sh runtime | cut -f1)"

echo "==> electron-builder --win nsis"
npx electron-builder --win nsis

echo
echo "==> 产物"
ls -lh release/*.exe 2>/dev/null || ls -lh release 2>/dev/null
echo
echo "提醒：正式发布前需要代码签名证书，否则用户会遇到 SmartScreen 拦截。"
