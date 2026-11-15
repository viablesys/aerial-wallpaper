# aerial-wallpaper: agent cold start

Apple Aerial videos (mpv) as the live desktop background on GNOME Shell 51 (Wayland), with Conky panels
over them, per monitor. A GNOME Shell extension (`extension/`) turns ordinary mpv and Conky windows into
desktop-layer windows; it runs them as systemd user units; a CLI (`bin/aerial-wallpaper`) and a
preferences window drive one set of GSettings. README.md has screenshots and the user-facing summary;
this file is what you need to install, change and extend it.

Target: Fedora 45, GNOME Shell 51.1 (`gnome-shell --version`), mpv 0.41, Conky 1.24 built with Wayland
and Lua (`conky -v`). Wayland only; nothing here is tested on X11.

## Layout

| Path | What |
|---|---|
| `extension/extension.js` | The extension: adopts windows, places them, pauses mpv, starts/stops units, overview clones |
| `extension/monitors.js` | Per-monitor resolution (`monitors` key), `Overlay`, state/socket/now paths. GLib only |
| `extension/conky.js` | Builds each Conky config from settings: sections, custom-mode wrapper, window class. GLib only |
| `extension/prefs.js` | Preferences window (Wallpaper, Conky, Monitors, Widgets, CLI pages) |
| `extension/schemas/*.gschema.xml` | Every setting; `gschemas.compiled` is gitignored and must be built |
| `bin/aerial-wallpaper` | CLI (Python, gi). Reads the schema from the repo, the layout from the state file |
| `bin/wall-aerial` | mpv launcher: playlists, skip list, wallpaper vs fullscreen mode, per-monitor instance |
| `bin/aerial-now.lua` | mpv script: writes each monitor's current video for its panel |
| `bin/log-played.lua` | mpv script: appends every video start to `~/Videos/aerial/.meta/played.log` |
| `bin/aerial-fetch` | Downloads the catalogue and the videos from Apple (aerial.md) |
| `aerial.md` | The video library: where it lives, building, checking, playlists, skip list |
| `systemd/aerial-wallpaper@.service`, `aerial-conky@.service` | Template units, instance = monitor id |
| `tests/*.sh` | Headless gnome-shell tests (see Testing) |

Not in this repo, and never to be added: the videos. `~/Videos/aerial/<Category>/*.mov` (≈45 GB, 4K SDR)
plus `~/Videos/aerial/.meta/` (catalogue, playlists, default, skip list, played log). **Read aerial.md**:
how to download them from Apple with `bin/aerial-fetch`, check them, and curate what plays. Each machine
builds its own; playlists and the skip list are per machine and per user.

Optional, outside the repo: a fullscreen (non-wallpaper) player as a user unit running `wall-aerial` with no
`AERIAL_MODE`; it uses the socket `aerial-mpv.sock`. If the user has one named `aerial.service`,
`aerial-wallpaper@.service` stops it (`Conflicts=aerial.service`).

## Install

```sh
cd aerial-wallpaper                               # wherever the user keeps the checkout
sudo dnf install mpv conky                        # mpv must decode HEVC: see aerial.md, Checking it
glib-compile-schemas extension/schemas            # after EVERY schema change
ln -s "$PWD/extension" ~/.local/share/gnome-shell/extensions/aerial-wallpaper@viablesys
ln -sfn "$PWD/bin/wall-aerial" ~/.local/bin/wall-aerial
ln -sfn "$PWD/bin/aerial-wallpaper" ~/.local/bin/aerial-wallpaper
cp systemd/aerial-wallpaper@.service systemd/aerial-conky@.service ~/.config/systemd/user/
systemctl --user daemon-reload
# The user logs out and in (Wayland cannot reload the shell), then:
gnome-extensions enable aerial-wallpaper@viablesys
aerial-wallpaper status && aerial-wallpaper monitors
```

Everything is symlinked to the checkout, so **editing the repo edits the live install**: the shell loads
`extension.js`/`conky.js`/`monitors.js` once per login, but the CLI, `wall-aerial` and the schema are read
fresh on every run (and `prefs.js` when the preferences process starts; whether that process outlives a
closed window is unverified). Do risky work in a git worktree (`git worktree add ../aerial-wallpaper-x -b x`);
the tests use the checkout they live in.

Upgrading from the single-monitor version (units `aerial-wallpaper.service`, `aerial-conky.service`,
config `conky.conf`): install the template units, re-login; the old files are then unused.

Logging out, rebooting and anything under `/etc` are the user's call: say what is needed and wait.

## Configuration

One GSettings schema, `org.gnome.shell.extensions.aerial-wallpaper`, three equal front ends; the running
extension applies every change within ~300 ms (it debounces and re-syncs on any key):

```sh
aerial-wallpaper keys                       # every key: type, value, default, allowed values
aerial-wallpaper set playlist deepsea       # a playlist name, a category (Space...), or '' = .meta/default
aerial-wallpaper set conky-enabled true     # master switch for all panels
gsettings --schemadir extension/schemas get org.gnome.shell.extensions.aerial-wallpaper monitors
```

Global keys: `playlist`, `pause-when-covered`, `overview-video`, `widget-classes`, `monitors`, and the
`conky-*` keys (mode, custom path, position, margins, width, font, colours, opacity, interval, graphs,
sections, disks, interface, process count, custom text).

### Per monitor (`monitors`, type `a{sa{sv}}`)

Keys are connector names (`DP-1`, `HDMI-A-1`; `Meta-0`/`Meta-1` in the headless tests; list them with
`aerial-wallpaper monitors`) or `primary`. Values override globals:

- `aerial` (b): play a video there. Default true once the monitor has an entry.
- `conky` (b): show a panel there. Default true on the primary monitor, false elsewhere; `conky-enabled` gates all.
- `playlist`, `pause-when-covered`, and any `conky-*` key except `conky-enabled`.

The primary monitor merges the `primary` entry with its own connector's entry (connector wins) and plays
even with no entry; other monitors do nothing until they get one. So `monitors = {}` is the classic
single-monitor setup. Resolution lives in `monitors.js` `resolve()`; prefs and the CLI must agree with it.

```sh
aerial-wallpaper monitor HDMI-A-1 set playlist Space conky true conky-position bottom-left conky-sections clock,aerial
aerial-wallpaper monitor HDMI-A-1 show
aerial-wallpaper monitor HDMI-A-1 unset conky-position
aerial-wallpaper monitor HDMI-A-1 reset
aerial-wallpaper next --monitor HDMI-A-1    # next/prev/now/conky config default to the primary monitor
```

## Services and runtime files

For each monitor id (connector, sanitized to `[A-Za-z0-9_.-]`):

| Thing | Name |
|---|---|
| Video unit | `aerial-wallpaper@ID.service` → `wall-aerial` with `AERIAL_MODE=wallpaper AERIAL_INSTANCE=ID` |
| Its playlist | `$XDG_RUNTIME_DIR/aerial-wallpaper/ID.env` (`AERIAL_PLAYLIST=...`), written before (re)start |
| mpv window / socket | app id `aerial-wallpaper-ID`, `$XDG_RUNTIME_DIR/aerial-mpv-ID.sock` (JSON IPC) |
| Now playing | `$XDG_RUNTIME_DIR/aerial-wallpaper/now-ID` (`time<TAB>path`, from `aerial-now.lua`) |
| Panel unit | `aerial-conky@ID.service` → `conky --config=~/.config/aerial-wallpaper/conky-ID.conf` |
| Panel window | class `AerialConky-ID` |
| Layout | `$XDG_RUNTIME_DIR/aerial-wallpaper/state.json`: monitors, geometry, what runs where, sockets, units |

`_sync()` in `extension.js` is the single reconciler: it resolves every connected monitor, then starts,
restarts (playlist changed) or stops units, writes Conky configs, the state file, and re-places, re-pauses
and re-clones. It runs on enable, any settings change and `monitors-changed`. The extension stops
`aerial-wallpaper@*`/`aerial-conky@*` on disable, and the shell disables extensions on lock, so nothing
plays while locked. The units have no `[Install]`; never enable them.

Debugging:

```sh
aerial-wallpaper status                     # extension state, units, per-monitor video/panel
aerial-wallpaper log -n 100                 # shell lines from the extension + the units' journals
systemctl --user list-units 'aerial-*'
cat "$XDG_RUNTIME_DIR/aerial-wallpaper/state.json"
```

If the CLI says "no state file", the running shell has not loaded this version of the extension (re-login)
or the extension is disabled.

## Conky panels

`conky.js` writes one config per panel from that monitor's `Overlay` (entry over globals). Conky watches
its config and reloads on change, so settings changes need no restart; only starting/stopping a panel
touches the unit. Never hand-edit `conky-ID.conf`: it is overwritten.

- **generated** (`conky-mode generated`, default): `conky-sections` in order. Available: `header clock system cpu cores memory gpu disks network processes aerial custom`. `custom` inserts `conky-custom-text` (raw Conky text, variables allowed). `gpu` uses `nvidia-smi` (absent → a "not found" line). `disks` groups mounts on one filesystem (Btrfs subvolumes) into one row. `network` uses `conky-interface` or the default-route interface at write time. `aerial` shows this monitor's now-playing file.
- **custom** (`conky-mode custom`, `conky-custom-path ~/x.conf`): the generated file `dofile()`s yours, then re-sets the window keys the extension needs (`out_to_wayland`, `own_window_class`, colour, alignment). Your `conky.text` and other settings stay. After editing your file run `aerial-wallpaper conky restart` (Conky only watches the generated file). Both keys work per monitor.

Sizes derive from `conky-font` (Pango description, e.g. `DejaVu Sans Mono 12`) and `conky-width`; graphs
are `font.size * 2.4` tall. GNOME has no layer-shell, so Conky cannot place itself: the extension moves the
window to `conky-position` + margins inside the monitor's work area (`_placeWidget`).

## Expanding beyond AerialConky

Pick the smallest step that does the job.

1. **Another window as a desktop widget, unplaced.** Any Wayland client with a stable app id (or X11 WM_CLASS): add it to `widget-classes` (`aerial-wallpaper set widget-classes "[\"AerialConky\", \"my-widget\"]"` or the Widgets page). It gets the desktop layer just above the video, all workspaces, out of alt-tab/overview/dash. The extension does not move it; it opens wherever mutter puts it. Layer-shell programs (eww, waybar, swaybg) do not work on GNOME; a second Conky with `out_to_wayland = true` and its own `own_window_class` does.
2. **A different panel layout.** Custom mode (above), globally or per monitor: `aerial-wallpaper monitor DP-1 set conky-mode custom conky-custom-path ~/.config/conky/dp1.conf`.
3. **A new generated section.** In `conky.js`: add it to `SECTIONS` and `SECTION_TITLES` and a builder in `parts` returning lines (use `heading()`, `label()`, `fontSpec()`; `settings` is the monitor's Overlay, `id` the monitor id). Then list it in the `conky-sections` description in the schema and in `SECTIONS` in `bin/aerial-wallpaper`. Prefs picks it up from `Conky.SECTIONS`. Run `tests/conky-test.sh`.
4. **A new per-monitor key.** Globals are overridable automatically if they are `playlist`, `pause-when-covered` or `conky-*` (`monitors.js` `entryKeys`, CLI `entry_type`). A key that is not a global (like `aerial`, `conky`) goes in `OWN_KEYS` in both `monitors.js` and the CLI, with its default in `resolve()`; document it in the `monitors` schema description.
5. **A new placed widget kind** (one window per monitor that the extension starts and positions, like the panels). Follow the Conky pattern: a template unit `aerial-X@.service`; a class prefix with `idFromClass()`; adopt it in `_recheck()`/`_adoptWidget()`; place it in `_placeWidget()` (today keyed to Conky classes); start/stop it in `_sync()` from a new `resolve()` flag; test-mode spawn in `_unit()`; a column in `state.json`, the CLI and the Monitors page. Keep widgets above video through `_keepWidgetsAbove()` (it checks the actor's `visible`, not `is_mapped()`: the session starts in the overview, where nothing is mapped).

Settings plumbing for anything new: schema key (+ `glib-compile-schemas`), a row in `prefs.js`, the CLI picks
up plain keys automatically through `keys`/`get`/`set`; README.

## Testing

Headless, throwaway gnome-shells with their own D-Bus, dconf, runtime and config dirs under `tmp/`; they
touch nothing in the real session. `AERIAL_WALLPAPER_NO_SYSTEMD=1` makes the extension spawn `wall-aerial`
and Conky as child processes (found on `PATH`, which the tests point at `bin/`) instead of systemd units.

```sh
tests/headless-test.sh    # one monitor: adoption, size, playback through the overview, pause under a maximized window
tests/conky-test.sh       # panel: stacking, alt-tab/dash, CLI-driven move/restyle, live reload, prefs screenshots
tests/multimon-test.sh    # two virtual monitors: per-monitor players/panels/pause, live CLI changes, Monitors page
```

They need the real videos and `.meta`. Screenshots land in `tmp/<test>/run/*.png` (via
`AERIAL_WALLPAPER_TEST_SHOTS=sec:name,...`); `AERIAL_WALLPAPER_TEST_REPORT=sec,...` logs stacking order
(bottom to top), `AERIAL_WALLPAPER_DEBUG=1` logs starts, placement and pauses. The prefs page cycle
(`AERIAL_WALLPAPER_TEST_PAGES`) is timed: adding a page shifts which page each shot catches, so check the
images. `docs/screenshots/` are crops of these (prefs window: x 1540–2300).

Run all three before committing changes to `extension/`, `bin/` or the schema; then tell the user a
re-login is needed for the extension part.

## Conventions

- Match the surrounding code: 4-space JS, comments explain why, GLib/Gio only in modules prefs imports.
- Commit messages: imperative summary, wrapped body, `Co-Authored-By` trailer. Commit, push and merge only when the user asks.
- Known gaps: multi-monitor is tested only on virtual monitors; real connector names unverified. `pause-when-covered` ignores windows that cover a monitor without being maximized or fullscreen.
