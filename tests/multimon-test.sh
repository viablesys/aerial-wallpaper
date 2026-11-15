#!/bin/bash
# Headless test for per-monitor settings: a throwaway gnome-shell (own D-Bus, dconf, data and runtime
# dirs) with two virtual monitors, Meta-0 (3840x2160, primary) and Meta-1 (1920x1080). The extension
# runs the players and panels as child processes (AERIAL_WALLPAPER_NO_SYSTEMD). Checks one mpv and one
# Conky per monitor, their placement, per-monitor pause, and live changes through the CLI.
# Screenshots land in tmp/multimon-test/run/*.png. Touches nothing in the real session.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
glib-compile-schemas --strict "$repo/extension/schemas" || exit 1
T=$repo/tmp/multimon-test; rm -rf "$T"; mkdir -p "$T"/{config,data/gnome-shell/extensions,run}; chmod 700 "$T/run"
ln -s "$repo/extension" "$T/data/gnome-shell/extensions/aerial-wallpaper@viablesys"
export XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_RUNTIME_DIR=$T/run AERIAL_WALLPAPER_NO_SYSTEMD=1 AERIAL_WALLPAPER_DEBUG=1
export AERIAL_WALLPAPER_TEST_SHOTS=16:desktop,31:changed,40:prefs-monitors AERIAL_WALLPAPER_TEST_REPORT=15,30 AERIAL_WALLPAPER_TEST_PAGE=monitors PATH=$repo/bin:$PATH repo
unset WAYLAND_DISPLAY DISPLAY NOTIFY_SOCKET
ipc() { python3 - "$XDG_RUNTIME_DIR/aerial-mpv-$1.sock" "$2" <<'EOF'
import json, socket, sys
s = socket.socket(socket.AF_UNIX)
try:
    s.connect(sys.argv[1])
except OSError:
    print("(no player)"); sys.exit()
s.sendall((json.dumps({"command": ["get_property", sys.argv[2]]}) + "\n").encode())
for line in s.makefile():
    r = json.loads(line)
    if "error" in r: print(r.get("data")); break
EOF
}
export -f ipc
exec dbus-run-session -- bash -c '
  cli() { "$repo/bin/aerial-wallpaper" "$@"; }
  log() { grep -a "aerial-wallpaper@viablesys" "$XDG_RUNTIME_DIR/shell.log" | sed "s/.*aerial-wallpaper@viablesys: /   /"; }
  cli set conky-enabled true >/dev/null
  cli monitor primary set conky-position top-right >/dev/null
  cli monitor Meta-1 set playlist Space conky true conky-position bottom-left conky-sections clock,aerial >/dev/null
  echo "== monitors setting"; cli get monitors
  gsettings set org.gnome.shell enabled-extensions "[\"aerial-wallpaper@viablesys\"]"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
  gnome-shell --headless --no-x11 --virtual-monitor 3840x2160 --virtual-monitor 1920x1080 --wayland-display aerial-test > "$XDG_RUNTIME_DIR/shell.log" 2>&1 &
  shell=$!
  for i in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/aerial-test" ] && break; sleep 0.2; done
  export WAYLAND_DISPLAY=aerial-test
  sleep 14
  echo "== monitors (CLI, from the state file)"; cli monitors
  echo "== started, adopted, placed"; log | grep -E "^   (start|adopted|place)" | sort | uniq
  sleep 2
  echo "== report: our windows, bottom to top"; log | grep report | grep -E "video|widget"
  echo "== playing"; for m in Meta-0 Meta-1; do echo "   $m $(ipc $m filename) pause=$(ipc $m pause)"; done
  echo "== now files"; for f in "$XDG_RUNTIME_DIR"/aerial-wallpaper/now-*; do echo "   $(basename $f): $(cut -f2 "$f" | sed "s|.*/aerial/||")"; done
  echo "== fullscreen window on Meta-1"
  mpv --idle=yes --force-window=immediate --fs --fs-screen-name=Meta-1 --wayland-app-id=cover-test > /dev/null 2>&1 &
  cover=$!; sleep 4
  for m in Meta-0 Meta-1; do echo "   $m pause=$(ipc $m pause)"; done
  kill $cover; sleep 2
  echo "== after it closes"; for m in Meta-0 Meta-1; do echo "   $m pause=$(ipc $m pause)"; done
  echo "== CLI: next on Meta-1, now"; cli next --monitor Meta-1; sleep 2; cli now --monitor Meta-1 | sed "s|.*/aerial/|   |"
  echo "== CLI: Meta-1 video off, primary panel bottom-right"
  cli monitor Meta-1 set aerial false >/dev/null; cli monitor primary set conky-position bottom-right >/dev/null
  sleep 4
  log | grep -E "^   (stop|start|place widget)" | tail -4
  echo "   Meta-1 player: $(ipc Meta-1 filename)"
  sleep 8
  echo "== second report, bottom to top"; log | grep report | grep -E "video|widget" | tail -3
  echo "== prefs, Monitors page"
  gnome-extensions prefs aerial-wallpaper@viablesys > "$XDG_RUNTIME_DIR/prefs.log" 2>&1 &
  sleep 9
  grep -a -iE "error|exception|critical" "$XDG_RUNTIME_DIR/prefs.log" | head -5
  echo "== conky configs"; ls "$XDG_CONFIG_HOME/aerial-wallpaper/"
  echo "== screenshots"; log | grep screenshot
  echo "== extension errors:"; grep -a -iE "error|exception|warn|critical" "$XDG_RUNTIME_DIR/shell.log" | grep -a -iE "aerial|conky|is_ready|JS" | grep -v "invalid window geometry" | head -10 || echo "   (none)"
  kill $shell; wait 2>/dev/null; pkill -f "$repo/tmp/"  # players and panels the shell started
'
