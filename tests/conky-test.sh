#!/bin/bash
# Headless test for the Conky panel and settings: a throwaway gnome-shell (own D-Bus, dconf, data and
# runtime dirs) with the extension, which starts the video and Conky from the generated config, and a normal window.
# Settings are changed through bin/aerial-wallpaper. Screenshots land in tmp/conky-test/run/*.png.
# Touches nothing in the real session.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
glib-compile-schemas --strict "$repo/extension/schemas" || exit 1
T=$repo/tmp/conky-test; rm -rf "$T"; mkdir -p "$T"/{config,data/gnome-shell/extensions,run}; chmod 700 "$T/run"
ln -s "$repo/extension" "$T/data/gnome-shell/extensions/aerial-wallpaper@viablesys"
export XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_RUNTIME_DIR=$T/run AERIAL_WALLPAPER_NO_SYSTEMD=1 AERIAL_WALLPAPER_DEBUG=1
# The extension starts wall-aerial and Conky itself (no systemd in the test); use this checkout's.
export PATH=$repo/bin:$PATH
export AERIAL_WALLPAPER_TEST_SHOTS=14:desktop,26:moved,62:prefs-wallpaper,68:prefs-conky,74:prefs-monitors,80:prefs-widgets,86:prefs-cli AERIAL_WALLPAPER_TEST_REPORT=13 AERIAL_WALLPAPER_TEST_PAGES=6 repo
unset WAYLAND_DISPLAY DISPLAY NOTIFY_SOCKET
exec dbus-run-session -- bash -c '
  cli() { "$repo/bin/aerial-wallpaper" "$@"; }
  log() { grep -a "aerial-wallpaper@viablesys" "$XDG_RUNTIME_DIR/shell.log" | sed "s/.*aerial-wallpaper@viablesys: /   /"; }
  cli set conky-enabled true >/dev/null
  cli conky enable cores system >/dev/null
  gsettings set org.gnome.shell enabled-extensions "[\"aerial-wallpaper@viablesys\"]"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
  gnome-shell --headless --no-x11 --virtual-monitor 3840x2160 --wayland-display aerial-test > "$XDG_RUNTIME_DIR/shell.log" 2>&1 &
  shell=$!
  for i in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/aerial-test" ] && break; sleep 0.2; done
  export WAYLAND_DISPLAY=aerial-test
  sleep 2
  conf=$XDG_CONFIG_HOME/aerial-wallpaper/conky-Meta-0.conf
  echo "== config written: $([ -s "$conf" ] && echo yes, $(wc -l < "$conf") lines || echo NO)"
  sleep 5
  mpv --idle=yes --force-window=immediate --geometry=1600x1000+2000+40 --wayland-app-id=normal-window > /dev/null 2>&1 &
  sleep 8
  echo "== adoption and placement"; log | grep -E "adopted|place widget" | head -8
  sleep 3
  echo "== report (stacking order bottom to top)"; log | grep report
  echo "== move to bottom-left, margin 80, via the CLI"
  cli set conky-position bottom-left; cli set conky-margin-x 80
  sleep 2; log | grep "place widget" | tail -1
  echo "== change sections and colour; Conky reloads the file"
  cli conky disable processes; cli set conky-accent-color "#ff9a3c"
  sleep 4
  grep -a -c "processes" "$conf" | sed "s/^/   processes lines in config: /"
  grep -a -iE "conky.*(reload|config file)" "$XDG_RUNTIME_DIR/shell.log" | head -3 | sed "s/^/   conky: /"
  echo "== conky errors:"; grep -a "conky" "$XDG_RUNTIME_DIR/shell.log" | grep -a -iE "\[(error|warn)" | head -5 || true
  sleep 3
  echo "== prefs window"; gnome-extensions prefs aerial-wallpaper@viablesys > "$XDG_RUNTIME_DIR/prefs.log" 2>&1 & sleep 70
  grep -a -iE "error|exception|critical" "$XDG_RUNTIME_DIR/prefs.log" "$XDG_RUNTIME_DIR/shell.log" | grep -aiE "prefs|aerial|conky|Extensions" | grep -v "invalid window geometry" | head -10 || true
  echo "== screenshots"; log | grep screenshot
  echo "== extension errors:"; grep -a -iE "error|exception|warn|critical" "$XDG_RUNTIME_DIR/shell.log" | grep -a -iE "aerial|conky|is_ready" | grep -v "invalid window geometry" | head -10 || echo "   (none)"
  kill $shell; wait 2>/dev/null; pkill -f "$repo/tmp/"  # players and panels the shell started
'
