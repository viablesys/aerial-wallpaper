#!/bin/bash
# Headless test: a throwaway gnome-shell (own D-Bus, dconf, data and runtime dirs) with the
# extension enabled, wall-aerial in wallpaper mode, then a maximized window to check pausing.
# Touches nothing in the real session: no real dconf, no systemd units, no real Wayland socket.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
T=$repo/tmp/headless; rm -rf "$T"; mkdir -p "$T"/{config,data/gnome-shell/extensions,run}; chmod 700 "$T/run"
ln -s "$repo/extension" "$T/data/gnome-shell/extensions/aerial-wallpaper@viablesys"
export XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_RUNTIME_DIR=$T/run AERIAL_WALLPAPER_NO_SYSTEMD=1 AERIAL_WALLPAPER_DEBUG=1 AERIAL_WALLPAPER_TEST_OVERVIEW=1
unset WAYLAND_DISPLAY DISPLAY NOTIFY_SOCKET
ipc() { python3 - "$XDG_RUNTIME_DIR/aerial-mpv.sock" "$1" <<'EOF'
import json, socket, sys
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])
s.sendall((json.dumps({"command": ["get_property", sys.argv[2]]}) + "\n").encode())
for line in s.makefile():
    r = json.loads(line)
    if "error" in r: print(r.get("data")); break
EOF
}
export -f ipc
exec dbus-run-session -- bash -c '
  gsettings set org.gnome.shell enabled-extensions "[\"aerial-wallpaper@viablesys\"]"
  gsettings set org.gnome.shell disable-user-extensions false
  gnome-shell --headless --no-x11 --virtual-monitor 3840x2160 --wayland-display aerial-test > "$XDG_RUNTIME_DIR/shell.log" 2>&1 &
  shell=$!
  for i in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/aerial-test" ] && break; sleep 0.2; done
  export WAYLAND_DISPLAY=aerial-test
  AERIAL_MODE=wallpaper ~/.local/bin/wall-aerial > "$XDG_RUNTIME_DIR/mpv.log" 2>&1 &
  sleep 2
  echo "== playback position through the overview test (shown ~4 s after adoption, hidden ~14 s):"
  for i in $(seq 9); do echo "   $(date +%T) time=$(ipc time-pos) pause=$(ipc pause)"; sleep 2; done
  grep -a -E "test (overview|screenshot)" "$XDG_RUNTIME_DIR/shell.log" | sed "s/^/   /"
  echo "== adoption"; grep -a "aerial-wallpaper@viablesys" "$XDG_RUNTIME_DIR/shell.log" || echo "(no log line)"
  echo "== playing: $(ipc filename) pause=$(ipc pause) time=$(ipc time-pos)"; sleep 2; echo "== 2 s later: time=$(ipc time-pos) dropped=$(ipc frame-drop-count) hwdec=$(ipc hwdec-current) osd=$(ipc osd-width)x$(ipc osd-height)"
  mpv --idle=yes --force-window=immediate --window-maximized=yes --wayland-app-id=cover-test --input-ipc-server="$XDG_RUNTIME_DIR/cover.sock" > /dev/null 2>&1 &
  cover=$!; sleep 3
  echo "== maximized window on top: pause=$(ipc pause)"
  kill $cover; sleep 2
  echo "== after it closes: pause=$(ipc pause)"
  echo "== extension errors:"; grep -a -i -E "error|exception|warn" "$XDG_RUNTIME_DIR/shell.log" | grep -a -i aerial || echo "(none)"
  pkill -P $$ mpv; kill $shell; wait 2>/dev/null
'
