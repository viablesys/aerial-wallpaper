// Aerial Wallpaper: turns mpv's "aerial-wallpaper" window into the desktop background.
//
// mpv (started by aerial-wallpaper.service) opens a normal Wayland window with app id
// "aerial-wallpaper". This extension retypes it as a DESKTOP window, so mutter keeps it
// in the desktop layer under every other window and out of alt-tab, the overview and
// window lists, and sizes it to the primary monitor. It pauses mpv over its IPC socket
// while the screen is blanked or the desktop is covered, and the service runs only
// while the extension is enabled (the shell disables extensions on lock).
//
// In the overview the shell hides the window layer and paints a static background per
// workspace (ui/workspace.js WorkspaceBackground), so the extension puts a live
// Clutter.Clone of the video window into each of those backgrounds.
//
// Widget windows (setting widget-classes, by default the extension's own Conky panel) are
// retyped the same way and kept just above the video. The Conky panel itself is a native
// Wayland Conky run as aerial-conky.service from a config built from the settings (conky.js);
// the extension places its window, since Conky cannot position itself on GNOME.
//
// Settings: schemas/, the preferences window (prefs.js) and bin/aerial-wallpaper on the CLI.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import Shell from 'gi://Shell';

import * as Conky from './conky.js';

const APP_ID = 'aerial-wallpaper';
const UNIT = 'aerial-wallpaper.service';
const SOCKET = 'aerial-mpv.sock';

export default class AerialWallpaper extends Extension {
    enable() {
        this._watched = new Map();  // MetaWindow -> signal ids
        this._ours = new Set();     // video windows
        this._widgets = new Set();  // widget windows (Conky)
        this._signals = [];
        this._timers = new Set();
        this._paused = null;
        // Test hook: in a headless test shell, don't touch the real user's systemd units.
        this._manageService = !GLib.getenv('AERIAL_WALLPAPER_NO_SYSTEMD');
        this._settings = this.getSettings();
        this._connectSettings();

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
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._ours.forEach(win => this._place(win));
            this._widgets.forEach(win => this._placeWidget(win));
            this._updatePause();
        });
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
        if (this._manageService)
            this._systemctl('start');
        this._writeConky();
        this._updateConkyService();
        this._testShots();
    }

    disable() {
        if (this._manageService) {
            this._systemctl('stop');
            this._systemctl('stop', Conky.UNIT);
        }
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
    }

    _connectSettings() {
        const on = (keys, fn) => keys.forEach(key =>
            this._settingsIds.push(this._settings.connect(`changed::${key}`, fn)));
        this._settingsIds = [];
        on(['playlist'], () => {
            this._writeConkySoon();  // the aerial section shows the playlist
            if (this._manageService)
                this._systemctl('restart');
        });
        on(['pause-when-covered'], () => this._updatePause());
        on(['overview-video'], () => this._updateClones());
        on(['widget-classes'], () => global.get_window_actors().forEach(a => this._recheck(a.meta_window)));
        on(['conky-enabled'], () => this._updateConkyService());
        on(['conky-position', 'conky-margin-x', 'conky-margin-y'],
            () => this._widgets.forEach(win => this._placeWidget(win)));
        on(this._settings.settings_schema.list_keys().filter(k =>
            k.startsWith('conky-') && !['conky-enabled', 'conky-position', 'conky-margin-x', 'conky-margin-y'].includes(k)),
        () => this._writeConkySoon());
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

    // Settings arrive one key at a time (a CLI loop, a slider): write once they settle.
    _writeConkySoon() {
        if (this._writeTimer)
            return;
        this._writeTimer = this._later(300, () => {
            this._writeTimer = null;
            this._writeConky();
        });
    }

    // Conky reloads its config when the file changes, so writing it is enough.
    _writeConky() {
        try {
            if (Conky.writeConfig(this._settings))
                this._debug(`conky config written to ${Conky.configPath()}`);
        } catch (e) {
            console.warn(`${this.uuid}: writing the Conky config failed: ${e.message}`);
        }
    }

    _updateConkyService() {
        if (this._manageService)
            this._systemctl(this._settings.get_boolean('conky-enabled') ? 'start' : 'stop', Conky.UNIT);
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
        if (cls === APP_ID)
            this._adopt(win);
        else if (cls && this._settings.get_strv('widget-classes').includes(cls))
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
        if (win.has_focus())
            global.display.focus_default_window(global.get_current_time());
        this._paused = null;  // a new mpv starts playing: resend the current state
        this._updatePause();
        this._updateClones();
        this._keepWidgetsAbove();
        if (GLib.getenv('AERIAL_WALLPAPER_TEST_OVERVIEW'))
            this._testOverview();
        console.log(`${this.uuid}: adopted window type=${win.get_window_type()} ` +
            `skip_taskbar=${win.is_skip_taskbar()}`);
    }

    // A widget gets the video's treatment (desktop layer, all workspaces, out of window lists)
    // and sits above the video. Only our own Conky is placed; other widgets keep their position.
    _adoptWidget(win) {
        this._widgets.add(win);
        win.set_type(Meta.WindowType.DESKTOP);
        win.hide_from_window_list();
        win.stick();
        const ids = this._watched.get(win);
        if (win.get_wm_class() === Conky.WINDOW_CLASS) {
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
        if (win.get_wm_class() !== Conky.WINDOW_CLASS)
            return;
        const display = global.display;
        const area = global.workspace_manager.get_active_workspace()
            .get_work_area_for_monitor(display.get_primary_monitor());
        const rect = win.get_frame_rect();
        if (rect.width === 0 || rect.height === 0)  // not mapped yet; 'shown' places it
            return;
        const [v, h] = this._settings.get_string('conky-position') === 'center'
            ? ['middle', 'center'] : this._settings.get_string('conky-position').split('-');
        const mx = this._settings.get_int('conky-margin-x');
        const my = this._settings.get_int('conky-margin-y');
        const x = {left: area.x + mx, center: area.x + Math.round((area.width - rect.width) / 2),
            right: area.x + area.width - rect.width - mx}[h];
        const y = {top: area.y + my, middle: area.y + Math.round((area.height - rect.height) / 2),
            bottom: area.y + area.height - rect.height - my}[v];
        if (rect.x === x && rect.y === y)
            return;
        win.move_frame(false, x, y);
        this._debug(`place widget ${rect.x},${rect.y} ${rect.width}x${rect.height} -> ${x},${y}`);
    }

    // Video and widgets share the desktop layer; keep every widget above every video window.
    _keepWidgetsAbove() {
        if (this._ours.size === 0 || this._widgets.size === 0)
            return;
        // Windows not shown yet have no stack position; 'shown' calls this again.
        const mapped = w => w.get_compositor_private()?.is_mapped();
        const sorted = global.display.sort_windows_by_stacking([...this._ours, ...this._widgets].filter(mapped));
        if (!sorted.some(w => this._ours.has(w)))
            return;
        const topVideo = Math.max(...[...this._ours].map(w => sorted.indexOf(w)));
        sorted.filter((w, i) => this._widgets.has(w) && i < topVideo).forEach(w => w.raise());
    }

    _place(win) {
        const display = global.display;
        const want = display.get_monitor_geometry(display.get_primary_monitor());
        const have = win.get_frame_rect();
        if (have.width === 0 || have.height === 0)  // not mapped yet; 'shown' places it
            return;
        if (have.x === want.x && have.y === want.y &&
            have.width === want.width && have.height === want.height)
            return;
        win.move_resize_frame(false, want.x, want.y, want.width, want.height);
        if (GLib.getenv('AERIAL_WALLPAPER_DEBUG'))
            console.log(`${this.uuid}: place ${have.x},${have.y} ${have.width}x${have.height} -> ${want.width}x${want.height}`);
    }

    // Hidden = screen shield up (blanked), no monitor, a fullscreen window, or a fully maximized window
    // on the primary monitor in the active workspace.
    _isHidden() {
        const display = global.display;
        if (Main.screenShield?.active)
            return true;
        if (Main.overview.visible)  // the clones show the video in the overview
            return false;
        if (Main.layoutManager.monitors.length === 0)
            return true;
        if (!this._settings.get_boolean('pause-when-covered'))
            return false;
        const primary = display.get_primary_monitor();
        if (display.get_monitor_in_fullscreen(primary))
            return true;
        const workspace = global.workspace_manager.get_active_workspace();
        return workspace.list_windows().some(win =>
            !this._ours.has(win) && !this._widgets.has(win) && !win.minimized && win.showing_on_its_workspace() &&
            win.get_monitor() === primary &&
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

    _updateClone(bg) {
        const entry = this._backgrounds.get(bg);
        const [win] = this._ours;
        const source = win?.get_compositor_private() ?? null;
        const wanted = source && this._settings.get_boolean('overview-video') && bg._monitorIndex === global.display.get_primary_monitor() ? source : null;
        if (entry.clone && entry.clone.source === wanted)
            return;
        entry.clone?.destroy();
        entry.clone = null;
        if (!wanted)
            return;
        entry.clone = new Clutter.Clone({
            source: wanted,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        bg._backgroundGroup.add_child(entry.clone);
    }

    // Test hook (headless shell): open the overview, screenshot it, close it.
    _testOverview() {
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
        if (this._ours.size === 0)
            return;
        const paused = this._isHidden();
        if (paused === this._paused)
            return;
        this._paused = paused;
        this._mpv(['set_property', 'pause', paused]);
    }

    _mpv(command) {
        const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), SOCKET]);
        const client = new Gio.SocketClient();
        client.connect_async(new Gio.UnixSocketAddress({path}), null, (c, res) => {
            try {
                const conn = c.connect_finish(res);
                const line = `${JSON.stringify({command})}\n`;
                conn.get_output_stream().write_all(new TextEncoder().encode(line), null);
                conn.close(null);
            } catch (e) {
                console.warn(`${this.uuid}: mpv IPC failed: ${e.message}`);
            }
        });
    }

    _systemctl(action, unit = UNIT) {
        try {
            Gio.Subprocess.new(['systemctl', '--user', '--no-block', action, unit],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`${this.uuid}: systemctl ${action} ${unit} failed: ${e.message}`);
        }
    }

    // Test hook (headless shell): AERIAL_WALLPAPER_TEST_SHOTS="seconds:name,..." takes screenshots
    // into the runtime dir, and AERIAL_WALLPAPER_TEST_REPORT=seconds logs where our windows show up.
    _testShots() {
        for (const spec of (GLib.getenv('AERIAL_WALLPAPER_TEST_SHOTS') ?? '').split(',').filter(Boolean)) {
            const [seconds, name] = spec.split(':');
            this._later(Number(seconds) * 1000, () => this._screenshot(`${name}.png`));
        }
        if (GLib.getenv('AERIAL_WALLPAPER_TEST_SHOTS'))  // a fresh session starts in the overview
            this._later(3000, () => Main.overview.hide());
        const report = GLib.getenv('AERIAL_WALLPAPER_TEST_REPORT');
        if (report)
            this._later(Number(report) * 1000, () => this._report());
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
                `app=${tracker.get_window_app(win)?.get_id() ?? 'none'} rect=${rect.x},${rect.y},${rect.width}x${rect.height}`);
        }
        const running = Shell.AppSystem.get_default().get_running();
        console.log(`${this.uuid}: report running apps (dash): ${running.map(a => a.get_id()).join(', ') || 'none'}`);
    }
}
