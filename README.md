# aerial-wallpaper

Plays the Aerial videos (`wall-aerial`, mpv) as the GNOME desktop background on GNOME Shell 51 (Wayland).

- `extension/` — GNOME Shell extension `aerial-wallpaper@viablesys`. It finds mpv's window (Wayland app id
  `aerial-wallpaper`), retypes it as a DESKTOP window (`Meta.Window.set_type`), hides it from window lists,
  sticks it to all workspaces and sizes it to the primary monitor. It pauses mpv over its IPC socket
  (`$XDG_RUNTIME_DIR/aerial-mpv.sock`) while the screen shield is up, there is no monitor, or a fullscreen or
  fully maximized window covers the primary monitor. It starts `aerial-wallpaper.service` on enable and stops it
  on disable; the shell disables user extensions on lock, so mpv stops while locked.
- `bin/wall-aerial` — the mpv launcher (playlists from `~/Videos/aerial/.meta/playlists/`, default from `.meta/default`,
  skip list, IPC socket). `AERIAL_MODE=wallpaper` gives a borderless `aerial-wallpaper` window with all mpv
  keyboard/mouse input off; otherwise fullscreen with mpv's bindings. Installed as a symlink in `~/.local/bin/`.
- `systemd/aerial-wallpaper.service` — runs `wall-aerial` with `AERIAL_MODE=wallpaper` (default playlist).
  Conflicts with `aerial.service` (the fullscreen player).
- `tests/headless-test.sh` — runs a throwaway headless gnome-shell (own D-Bus, dconf, data and runtime dirs)
  with the extension, checks adoption, size, playback and pause/resume under a maximized window.

Install (needs a log out and back in on Wayland before the shell sees a new extension):

    ln -s "$PWD/extension" ~/.local/share/gnome-shell/extensions/aerial-wallpaper@viablesys
    ln -sfn "$PWD/bin/wall-aerial" ~/.local/bin/wall-aerial
    cp systemd/aerial-wallpaper.service ~/.config/systemd/user/ && systemctl --user daemon-reload
    # log out and in, then:
    gnome-extensions enable aerial-wallpaper@viablesys

Test hooks: `AERIAL_WALLPAPER_NO_SYSTEMD=1` (don't start/stop the unit), `AERIAL_WALLPAPER_DEBUG=1` (log placement).
