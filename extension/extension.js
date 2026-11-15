// Aerial Wallpaper: turns mpv's "aerial-wallpaper-<monitor>" windows into the desktop background.
//
// Each monitor that plays a video gets its own mpv (aerial-wallpaper@<monitor>.service, monitor =
// its connector, e.g. DP-1) with its own playlist and IPC socket. mpv opens a normal Wayland window
// with app id "aerial-wallpaper-<monitor>"; this extension retypes it as a DESKTOP window, so mutter
// keeps it in the desktop layer under every other window and out of alt-tab, the overview and window
// lists, and sizes it to its monitor. It pauses each mpv over its IPC socket while the screen is
// blanked or its monitor is covered, and the services run only while the extension is enabled (the
// shell disables extensions on lock). Which monitor runs what comes from the `monitors` setting
// (monitors.js); with it empty, only the primary monitor plays.
//
// In the overview the shell hides the window layer and paints a static background per workspace
// and monitor (ui/workspace.js WorkspaceBackground), so the extension puts a live Clutter.Clone of
// that monitor's video window into each of those backgrounds.
//
// Widget windows (setting widget-classes, and always the extension's own Conky panels) are retyped
// the same way and kept just above the video. Each Conky panel is a native Wayland Conky run as
// aerial-conky@<monitor>.service from a config built from the settings (conky.js); the extension
// places its window on its monitor, since Conky cannot position itself on GNOME.
//
// Settings: schemas/, the preferences window (prefs.js) and bin/aerial-wallpaper on the CLI, which
// reads the current layout from $XDG_RUNTIME_DIR/aerial-wallpaper/state.json.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import Shell from 'gi://Shell';

import * as Conky from './conky.js';
import * as Monitors from './monitors.js';

const APP_PREFIX = 'aerial-wallpaper-';
const VIDEO_UNIT_PATTERN = 'aerial-wallpaper@*.service';
const videoUnit = id => `aerial-wallpaper@${id}.service`;
const videoId = cls => cls?.startsWith(APP_PREFIX) ? cls.slice(APP_PREFIX.length) : null;

export default class AerialWallpaper extends Extension {
    enable() {
        this._watched = new Map();  // MetaWindow -> signal ids
        this._ours = new Set();     // video windows
        this._widgets = new Set();  // widget windows (Conky)
        this._signals = [];
        this._timers = new Set();
        this._paused = new Map();   // instance id -> last pause state sent
        this._layout = new Map();   // instance id -> {connector, index, primary, video, conky, settings}
        this._running = {video: new Map(), conky: new Set()};  // id -> playlist; ids
        this._procs = new Map();    // test mode: "video:id" / "conky:id" -> Gio.Subprocess
        // Test hook: in a headless test shell, don't touch the real user's systemd units; run the
        // players and panels as child processes instead.
        this._manageService = !GLib.getenv('AERIAL_WALLPAPER_NO_SYSTEMD');
        this._settings = this.getSettings();
        this._settingsIds = [this._settings.connect('changed', (_s, key) => {
            if (key === 'widget-classes')
                global.get_window_actors().forEach(a => this._recheck(a.meta_window));
            else
                this._syncSoon();
        })];

        const display = global.display;
        this._connect(display, 'window-created', (_d, win) => this._watch(win));
        this._connect(display, 'in-fullscreen-changed', () => this._updatePause());
        this._connect(display, 'restacked', () => {
            this._keepWidgetsAbove();
            this._updatePause();
        });
        // The shield goes active when the screen blanks, locked or not.
        if (Main.screenShield)
            this._connect(Main.screenShield, 'active-changed', () => this._updatePause());
        this._connect(Main.layoutManager, 'monitors-changed', () => this._sync());
        this._connect(display, 'workareas-changed', () => this._widgets.forEach(win => this._placeWidget(win)));
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._updatePause());
        this._connect(Main.overview, 'showing', () => this._updatePause());
        this._connect(Main.overview, 'hidden', () => this._updatePause());

        this._backgrounds = new Map();  // WorkspaceBackground -> {clone, ids}
        this._injections = new InjectionManager();
        const self = this;
        this._injections.overrideMethod(Workspace.WorkspaceBackground.prototype, '_init',
            original => function (...args) {
                original.apply(this, args);
                self._addBackground(this);
            });
        this._findBackgrounds(Main.layoutManager.overviewGroup).forEach(bg => this._addBackground(bg));

        global.get_window_actors().forEach(actor => this._watch(actor.meta_window));
        this._sync();
        this._testShots();
    }

    disable() {
        if (this._manageService) {
            this._systemctl('stop', VIDEO_UNIT_PATTERN);
            this._systemctl('stop', Conky.UNIT_PATTERN);
        }
        this._procs.forEach(proc => proc.send_signal(15));
        this._procs = null;
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settings = null;
        this._timers.forEach(id => GLib.source_remove(id));
        this._timers = null;
        this._injections.clear();
        this._backgrounds.forEach(({clone, ids}, bg) => {
            clone?.destroy();
            ids.forEach(([obj, id]) => obj.disconnect(id));
        });
        this._backgrounds = null;
        this._testTimers?.forEach(id => GLib.source_remove(id));
        this._signals.forEach(([obj, id]) => obj.disconnect(id));
        this._watched.forEach((ids, win) => ids.forEach(id => win.disconnect(id)));
        this._signals = null;
        this._watched = null;
        this._ours = null;
        this._widgets = null;
        this._layout = null;
        this._running = null;
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    // Settings arrive one key at a time (a CLI loop, a slider): sync once they settle.
    _syncSoon() {
        if (this._syncTimer)
            return;
        this._syncTimer = this._later(300, () => {
            this._syncTimer = null;
            this._sync();
        });
    }

    // The connected monitors: [{connector, id, index, primary}].
    _monitors() {
        const manager = global.backend.get_monitor_manager();
        const primary = global.display.get_primary_monitor();
        return manager.get_monitors().map(m => {
            const connector = m.get_connector();
            const index = manager.get_monitor_for_connector(connector);
            return {connector, id: Monitors.instanceId(connector), index, primary: index === primary};
        }).filter(m => m.index >= 0);
    }

    // Works out what runs on each monitor and starts, restarts or stops the players and panels to
    // match; then places, pauses and clones accordingly. Called on enable, on any settings change and
    // when monitors change.
    _sync() {
        const entries = Monitors.readEntries(this._settings);
        this._layout = new Map();
        for (const m of this._monitors()) {
            const r = Monitors.resolve(this._settings, entries, m.connector, m.primary);
            this._layout.set(m.id, {...m, ...r});
        }
        const want = kind => [...this._layout.values()].filter(l => l[kind]);

        GLib.mkdir_with_parents(Monitors.stateDir(), 0o700);
        for (const l of want('video')) {
            const playlist = l.settings.get_string('playlist');
            if (this._running.video.get(l.id) === playlist)
                continue;
            this._writeEnv(l.id, playlist);
            this._unit(this._running.video.has(l.id) ? 'restart' : 'start', 'video', l.id, {AERIAL_PLAYLIST: playlist});
            this._running.video.set(l.id, playlist);
            this._paused.delete(l.id);  // a new mpv starts playing: resend the current state
        }
        for (const id of [...this._running.video.keys()].filter(id => !this._layout.get(id)?.video)) {
            this._unit('stop', 'video', id);
            this._running.video.delete(id);
            this._paused.delete(id);
        }
        // Conky reloads its config when the file changes, so writing it is enough for a running panel.
        for (const l of want('conky')) {
            try {
                if (Conky.writeConfig(l.settings, l.id))
                    this._debug(`conky config written to ${Conky.configPath(l.id)}`);
            } catch (e) {
                console.warn(`${this.uuid}: writing the Conky config for ${l.connector} failed: ${e.message}`);
            }
            if (!this._running.conky.has(l.id)) {
                this._unit('start', 'conky', l.id);
                this._running.conky.add(l.id);
            }
        }
        for (const id of [...this._running.conky].filter(id => !this._layout.get(id)?.conky)) {
            this._unit('stop', 'conky', id);
            this._running.conky.delete(id);
        }

        this._writeState();
        this._ours.forEach(win => this._place(win));
        this._widgets.forEach(win => this._placeWidget(win));
        this._updatePause();
        this._updateClones();
    }

    _writeEnv(id, playlist) {
        const path = GLib.build_filenamev([Monitors.stateDir(), `${id}.env`]);
        GLib.file_set_contents(path, `AERIAL_PLAYLIST=${JSON.stringify(playlist)}\n`);
    }

    _writeState() {
        const monitors = [...this._layout.values()].sort((a, b) => a.index - b.index).map(l => {
            const g = global.display.get_monitor_geometry(l.index);
            return {
                connector: l.connector, id: l.id, index: l.index, primary: l.primary,
                geometry: [g.x, g.y, g.width, g.height],
                video: l.video, playlist: l.settings.get_string('playlist'), socket: Monitors.socketPath(l.id),
                unit: videoUnit(l.id),
                conky: l.conky, config: Conky.configPath(l.id), conky_unit: Conky.unit(l.id),
            };
        });
        try {
            GLib.file_set_contents(Monitors.statePath(), `${JSON.stringify({monitors}, null, 2)}\n`);
        } catch (e) {
            console.warn(`${this.uuid}: writing ${Monitors.statePath()} failed: ${e.message}`);
        }
    }

    // Start, restart or stop one player or panel: a systemd template unit, or in test mode a child process.
    _unit(action, kind, id, env = {}) {
        const unit = kind === 'video' ? videoUnit(id) : Conky.unit(id);
        this._debug(`${action} ${unit}`);
        if (this._manageService) {
            this._systemctl(action, unit);
            return;
        }
        const key = `${kind}:${id}`;
        if (action !== 'start') {
            this._procs.get(key)?.send_signal(15);
            this._procs.delete(key);
        }
        if (action === 'stop')
            return;
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE});
        let argv;
        if (kind === 'video') {
            launcher.setenv('AERIAL_MODE', 'wallpaper', true);
            launcher.setenv('AERIAL_INSTANCE', id, true);
            Object.entries(env).forEach(([k, v]) => launcher.setenv(k, v, true));
            argv = [GLib.find_program_in_path('wall-aerial') ?? 'wall-aerial'];
        } else {
            argv = ['conky', `--config=${Conky.configPath(id)}`];
        }
        try {
            this._procs.set(key, launcher.spawnv(argv));
        } catch (e) {
            console.warn(`${this.uuid}: starting ${argv[0]} for ${id} failed: ${e.message}`);
        }
    }

    _debug(message) {
        if (GLib.getenv('AERIAL_WALLPAPER_DEBUG'))
            console.log(`${this.uuid}: ${message}`);
    }

    _connect(obj, signal, callback) {
        this._signals.push([obj, obj.connect(signal, callback)]);
    }

    _watch(win) {
        if (this._watched.has(win))
            return;
        const ids = [
            win.connect('notify::wm-class', () => this._recheck(win)),
            win.connect('unmanaged', () => {
                ids.forEach(id => win.disconnect(id));
                this._watched.delete(win);
                this._ours.delete(win);
                this._widgets.delete(win);
                this._updateClones();
            }),
        ];
        this._watched.set(win, ids);
        this._recheck(win);
    }

    _recheck(win) {
        if (!this._watched.has(win) || this._ours.has(win) || this._widgets.has(win))
            return;
        const cls = win.get_wm_class();
        if (videoId(cls))
            this._adopt(win);
        else if (Conky.idFromClass(cls) || (cls && this._settings.get_strv('widget-classes').includes(cls)))
            this._adoptWidget(win);
    }

    _adopt(win) {
        this._ours.add(win);
        win.set_type(Meta.WindowType.DESKTOP);
        win.hide_from_window_list();
        win.stick();
        this._place(win);
        win.lower();
        // The first configure can land after adoption; keep the window on the monitor.
        const ids = this._watched.get(win);
        ids.push(win.connect('shown', () => this._place(win)));
        ids.push(win.connect('size-changed', () => this._place(win)));
        ids.push(win.connect('position-changed', () => this._place(win)));
        // Panels adopted before this window mapped must end up above it.
        ids.push(win.connect('shown', () => this._keepWidgetsAbove()));
        if (win.has_focus())
            global.display.focus_default_window(global.get_current_time());
        this._paused.delete(videoId(win.get_wm_class()));  // a new mpv starts playing: resend the current state
        this._updatePause();
        this._updateClones();
        this._keepWidgetsAbove();
        if (GLib.getenv('AERIAL_WALLPAPER_TEST_OVERVIEW'))
            this._testOverview();
        console.log(`${this.uuid}: adopted window ${win.get_wm_class()} type=${win.get_window_type()} ` +
            `skip_taskbar=${win.is_skip_taskbar()}`);
    }

    // A widget gets the video's treatment (desktop layer, all workspaces, out of window lists)
    // and sits above the video. Only our own Conky panels are placed; other widgets keep their position.
    _adoptWidget(win) {
        this._widgets.add(win);
        win.set_type(Meta.WindowType.DESKTOP);
        win.hide_from_window_list();
        win.stick();
        const ids = this._watched.get(win);
        if (Conky.idFromClass(win.get_wm_class())) {
            this._placeWidget(win);
            ids.push(win.connect('shown', () => this._placeWidget(win)));
            ids.push(win.connect('size-changed', () => this._placeWidget(win)));
            ids.push(win.connect('position-changed', () => this._placeWidget(win)));
        }
        ids.push(win.connect('shown', () => this._keepWidgetsAbove()));
        this._keepWidgetsAbove();
        if (win.has_focus())
            global.display.focus_default_window(global.get_current_time());
        console.log(`${this.uuid}: adopted widget ${win.get_wm_class()} type=${win.get_window_type()} ` +
            `skip_taskbar=${win.is_skip_taskbar()}`);
    }

    _placeWidget(win) {
        const l = this._layout.get(Conky.idFromClass(win.get_wm_class()));
        if (!l)
            return;
        const area = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(l.index);
        const rect = win.get_frame_rect();
        if (rect.width === 0 || rect.height === 0)  // not mapped yet; 'shown' places it
            return;
        const position = l.settings.get_string('conky-position');
        const [v, h] = position === 'center' ? ['middle', 'center'] : position.split('-');
        const mx = l.settings.get_int('conky-margin-x');
        const my = l.settings.get_int('conky-margin-y');
        const x = {left: area.x + mx, center: area.x + Math.round((area.width - rect.width) / 2),
            right: area.x + area.width - rect.width - mx}[h];
        const y = {top: area.y + my, middle: area.y + Math.round((area.height - rect.height) / 2),
            bottom: area.y + area.height - rect.height - my}[v];
        if (rect.x === x && rect.y === y)
            return;
        win.move_frame(false, x, y);
        this._debug(`place widget ${l.connector} ${rect.x},${rect.y} ${rect.width}x${rect.height} -> ${x},${y}`);
    }

    // Video and widgets share the desktop layer; keep every widget above every video window.
    _keepWidgetsAbove() {
        if (this._ours.size === 0 || this._widgets.size === 0)
            return;
        // Windows not shown yet have no stack position; 'shown' calls this again. Shown, not mapped:
        // in the overview (where a session starts) the window layer is hidden, so nothing is mapped.
        const shown = w => w.get_compositor_private()?.visible;
        const sorted = global.display.sort_windows_by_stacking([...this._ours, ...this._widgets].filter(shown));
        if (!sorted.some(w => this._ours.has(w)))
            return;
        const topVideo = Math.max(...[...this._ours].map(w => sorted.indexOf(w)));
        sorted.filter((w, i) => this._widgets.has(w) && i < topVideo).forEach(w => w.raise());
    }

    // The layout of the monitor a video window plays on, or null when that monitor is gone or no
    // longer plays (_sync stops its player).
    _videoLayout(win) {
        const l = this._layout.get(videoId(win.get_wm_class()));
        return l?.video ? l : null;
    }

    _place(win) {
        const l = this._videoLayout(win);
        if (!l)
            return;
        const want = global.display.get_monitor_geometry(l.index);
        const have = win.get_frame_rect();
        if (have.width === 0 || have.height === 0)  // not mapped yet; 'shown' places it
            return;
        if (have.x === want.x && have.y === want.y &&
            have.width === want.width && have.height === want.height)
            return;
        win.move_resize_frame(false, want.x, want.y, want.width, want.height);
        this._debug(`place ${l.connector} ${have.x},${have.y} ${have.width}x${have.height} -> ` +
            `${want.x},${want.y} ${want.width}x${want.height}`);
    }

    // Hidden = screen shield up (blanked), or a fullscreen window or a fully maximized window on this
    // monitor in the active workspace.
    _isHidden(l) {
        const display = global.display;
        if (Main.screenShield?.active)
            return true;
        if (Main.overview.visible)  // the clones show the video in the overview
            return false;
        if (!l.settings.get_boolean('pause-when-covered'))
            return false;
        if (display.get_monitor_in_fullscreen(l.index))
            return true;
        const workspace = global.workspace_manager.get_active_workspace();
        return workspace.list_windows().some(win =>
            !this._ours.has(win) && !this._widgets.has(win) && !win.minimized && win.showing_on_its_workspace() &&
            win.get_monitor() === l.index &&
            win.get_maximize_flags() === Meta.MaximizeFlags.BOTH);
    }

    _findBackgrounds(actor, out = []) {
        if (actor instanceof Workspace.WorkspaceBackground)
            out.push(actor);
        else
            actor.get_children().forEach(child => this._findBackgrounds(child, out));
        return out;
    }

    _addBackground(bg) {
        if (!this._backgrounds || this._backgrounds.has(bg))
            return;
        const entry = {clone: null, ids: []};
        entry.ids.push([bg, bg.connect('destroy', () => this._backgrounds?.delete(bg))]);
        // A changed wallpaper adds a new background actor on top; keep the clone above it.
        const group = bg._backgroundGroup;
        entry.ids.push([group, group.connect('child-added', (_g, child) => {
            if (entry.clone && child !== entry.clone)
                group.set_child_above_sibling(entry.clone, null);
        })]);
        this._backgrounds.set(bg, entry);
        this._updateClone(bg);
    }

    _updateClones() {
        this._backgrounds?.forEach((_entry, bg) => this._updateClone(bg));
    }

    // The video window playing on a monitor index, or null.
    _videoOn(index) {
        return [...this._ours].find(win => this._videoLayout(win)?.index === index) ?? null;
    }

    _updateClone(bg) {
        const entry = this._backgrounds.get(bg);
        const source = this._settings.get_boolean('overview-video')
            ? this._videoOn(bg._monitorIndex)?.get_compositor_private() ?? null : null;
        if (entry.clone && entry.clone.source === source)
            return;
        entry.clone?.destroy();
        entry.clone = null;
        if (!source)
            return;
        entry.clone = new Clutter.Clone({
            source,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        bg._backgroundGroup.add_child(entry.clone);
    }

    // Test hook (headless shell): open the overview, screenshot it, close it.
    _testOverview() {
        if (this._testTimers)  // once, for the first video adopted
            return;
        const at = (seconds, fn) => this._testTimers.push(
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                fn();
                return GLib.SOURCE_REMOVE;
            }));
        this._testTimers = [];
        at(4, () => {
            Main.overview.show();
            console.log(`${this.uuid}: test overview shown, clones=${[...this._backgrounds.values()].filter(e => e.clone).length}/${this._backgrounds.size}`);
        });
        at(9, () => this._screenshot('overview.png'));
        at(14, () => {
            Main.overview.hide();
            console.log(`${this.uuid}: test overview hidden`);
        });
    }

    _updatePause() {
        for (const win of this._ours) {
            const l = this._videoLayout(win);
            if (!l)
                continue;
            const id = l.id;
            const paused = this._isHidden(l);
            if (paused === this._paused.get(id))
                continue;
            this._paused.set(id, paused);
            this._debug(`${paused ? 'pause' : 'play'} ${l.connector}`);
            this._mpv(id, ['set_property', 'pause', paused]);
        }
    }

    _mpv(id, command) {
        const client = new Gio.SocketClient();
        client.connect_async(new Gio.UnixSocketAddress({path: Monitors.socketPath(id)}), null, (c, res) => {
            try {
                const conn = c.connect_finish(res);
                const line = `${JSON.stringify({command})}\n`;
                conn.get_output_stream().write_all(new TextEncoder().encode(line), null);
                conn.close(null);
            } catch (e) {
                console.warn(`${this.uuid}: mpv IPC (${id}) failed: ${e.message}`);
            }
        });
    }

    _systemctl(action, unit) {
        try {
            Gio.Subprocess.new(['systemctl', '--user', '--no-block', action, unit],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`${this.uuid}: systemctl ${action} ${unit} failed: ${e.message}`);
        }
    }

    // Test hook (headless shell): AERIAL_WALLPAPER_TEST_SHOTS="seconds:name,..." takes screenshots
    // into the runtime dir, and AERIAL_WALLPAPER_TEST_REPORT="seconds,..." logs where our windows show up.
    _testShots() {
        for (const spec of (GLib.getenv('AERIAL_WALLPAPER_TEST_SHOTS') ?? '').split(',').filter(Boolean)) {
            const [seconds, name] = spec.split(':');
            this._later(Number(seconds) * 1000, () => this._screenshot(`${name}.png`));
        }
        if (GLib.getenv('AERIAL_WALLPAPER_TEST_SHOTS'))  // a fresh session starts in the overview
            this._later(3000, () => Main.overview.hide());
        for (const seconds of (GLib.getenv('AERIAL_WALLPAPER_TEST_REPORT') ?? '').split(',').filter(Boolean))
            this._later(Number(seconds) * 1000, () => this._report());
    }

    _screenshot(name) {
        const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), name]);
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream, (shooter, res) => {
            try {
                shooter.screenshot_finish(res);
                console.log(`${this.uuid}: test screenshot ${path}`);
            } catch (e) {
                console.warn(`${this.uuid}: test screenshot failed: ${e.message}`);
            }
            stream.close(null);
        });
    }

    _report() {
        const tabs = new Set(global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null));
        const tracker = Shell.WindowTracker.get_default();
        const all = global.get_window_actors().map(a => a.meta_window);
        const stack = global.display.sort_windows_by_stacking(all);
        for (const win of stack) {
            const kind = this._ours.has(win) ? 'video' : this._widgets.has(win) ? 'widget' : 'other';
            const rect = win.get_frame_rect();
            console.log(`${this.uuid}: report ${kind} class=${win.get_wm_class()} type=${win.get_window_type()} ` +
                `layer=${win.get_layer?.()} stack=${stack.indexOf(win)} alt-tab=${tabs.has(win)} ` +
                `skip_taskbar=${win.is_skip_taskbar()} sticky=${win.is_on_all_workspaces()} ` +
                `monitor=${win.get_monitor()} app=${tracker.get_window_app(win)?.get_id() ?? 'none'} ` +
                `rect=${rect.x},${rect.y},${rect.width}x${rect.height}`);
        }
        const running = Shell.AppSystem.get_default().get_running();
        console.log(`${this.uuid}: report running apps (dash): ${running.map(a => a.get_id()).join(', ') || 'none'}`);
    }
}
