#!/usr/bin/env bash
# 欧洲EPR控制台 - Linux 启动/停止脚本
# 用法: ./start.sh [start|stop|restart|status]
# 端口可用环境变量覆盖: PORT=8080 ./start.sh

cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}"
LOG="$(pwd)/server.log"
PIDFILE="$(pwd)/.server.pid"

# 选择可用的 node
if command -v node >/dev/null 2>&1; then
  NODE="node"
elif [ -x ./node ]; then
  NODE="./node"
else
  echo "[错误] 未找到 node，请先安装 Node.js (v16+)"
  exit 1
fi

is_running() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid=$(cat "$PIDFILE")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

do_start() {
  if is_running; then
    echo "[提示] 服务已在运行 (PID $(cat "$PIDFILE"))，访问 http://127.0.0.1:$PORT/"
    return 0
  fi
  echo "正在启动服务 (端口 $PORT)..."
  PORT="$PORT" nohup "$NODE" server.js >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 2
  if is_running; then
    echo "[成功] 服务已启动，PID $(cat "$PIDFILE")"
    echo "        本机访问: http://127.0.0.1:$PORT/"
    echo "        日志:     $LOG"
  else
    echo "[失败] 服务启动异常，请查看日志: $LOG"
    rm -f "$PIDFILE"
    exit 1
  fi
}

do_stop() {
  if ! is_running; then
    echo "[提示] 服务未在运行"
    rm -f "$PIDFILE"
    return 0
  fi
  local pid
  pid=$(cat "$PIDFILE")
  kill "$pid" 2>/dev/null
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$PIDFILE"
  echo "[成功] 服务已停止 (PID $pid)"
}

do_status() {
  if is_running; then
    echo "运行中，PID $(cat "$PIDFILE")，端口 $PORT"
  else
    echo "未运行"
  fi
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  *)       echo "用法: $0 [start|stop|restart|status]"; exit 1 ;;
esac
