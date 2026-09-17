#!/usr/bin/env bash
# 分发源的启停控制（给 crontab 的"开机自启 + 掉线自愈"用，也可以手动跑）。
#
#   scripts/dev/serve-dist-ctl.sh start|stop|restart|status|ensure
#
# 为什么需要它：分发源是个纯 Node 小服务，NAS 重启或进程被杀之后就没了；
# 而"用户点检查更新却下载失败"往往就是它没在跑（我第一次就踩了这个：以为是协议问题，
# 其实服务早停了）。所以用 crontab 挂"开机自启 + 每 5 分钟自愈"，和本机既有服务的做法一致。
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DIST_DIR="${DIST_DIR:-$HOME/24h-dist}"
PORT="${DIST_PORT:-8899}"
HOST="${DIST_HOST:-127.0.0.1}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /usr/bin/node)}"
PIDFILE="$DIST_DIR/serve.pid"
LOG="$DIST_DIR/logs/serve.log"
TOKEN_FILE="$DIST_DIR/upload-token.txt"

port_open() { (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null; }
pid_alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

start() {
  mkdir -p "$DIST_DIR/logs"
  if port_open; then
    echo "已在运行（${HOST}:${PORT}）"
    return 0
  fi
  local token_arg=()
  if [ -f "$TOKEN_FILE" ]; then
    # shellcheck disable=SC1090
    token_arg=(--upload-token "$(sed -n 's/^DIST_UPLOAD_TOKEN=//p' "$TOKEN_FILE" | head -1)")
  fi
  setsid "$NODE_BIN" "$REPO/scripts/dev/serve-dist.mjs" --dir "$DIST_DIR" --host "$HOST" --port "$PORT" "${token_arg[@]}" \
    < /dev/null >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  if port_open; then
    echo "已启动：PID $(cat "$PIDFILE")，${HOST}:${PORT}，目录 $DIST_DIR"
  else
    echo "启动失败，看日志：$LOG" >&2
    tail -5 "$LOG" >&2 || true
    return 1
  fi
}

stop() {
  local pid=""
  [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" && echo "已停止 PID $pid"
  else
    echo "（PID 文件没有或进程已不在）"
  fi
  rm -f "$PIDFILE"
}

status() {
  if port_open; then
    echo "运行中：${HOST}:${PORT}$(pid_alive && echo "（PID $(cat "$PIDFILE")）" || echo "（PID 文件缺失）")"
    echo "目录：$DIST_DIR"
    ls -1 "$DIST_DIR" 2>/dev/null | grep -v -E '^(logs|serve.pid|upload-token.txt)$' | sed 's/^/  平台目录: /' || true
    return 0
  fi
  echo "未运行"
  return 1
}

case "${1:-ensure}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; start ;;
  status) status ;;
  ensure) port_open && exit 0 || start ;;
  *) echo "用法：$0 start|stop|restart|status|ensure" >&2; exit 2 ;;
esac
