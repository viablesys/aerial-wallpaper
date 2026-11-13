// Aerial Wallpaper: turns mpv's "aerial-wallpaper" window into the desktop background.
//
// mpv (started by aerial-wallpaper.service) opens a normal Wayland window with app id
// "aerial-wallpaper". This extension retypes it as a DESKTOP window, so mutter keeps it
// in the desktop layer under every other window and out of alt-tab, the overview and
// window lists, and sizes it to the primary monitor. It pauses mpv over its IPC socket
// while the screen is blanked or the desktop is covered, and the service runs only
// while the extension is enabled (the shell disables extensions on lock).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const APP_ID = 'aerial-wallpaper';
const UNIT = 'aerial-wallpaper.service';
const SOCKET = 'aerial-mpv.sock';

export default class AerialWallpaper extends Extension {
    enable() {
        this._watched = new Map();  // MetaWindow -> signal ids
        this._ours = new Set();
        this._signals = [];
        this._paused = null;
        // Test hook: in a headless test shell, don't touch the real user's systemd units.
        this._manageService = !GLib.getenv('AERIAL_WALLPAPER_NO_SYSTEMD');

        const display = global.display;
        this._connect(display, 'window-created', (_d, win) => this._watch(win));
        this._connect(display, 'in-fullscreen-changed', () => this._updatePause());
        this._connect(display, 'restacked', () => this._updatePause());
        // The shield goes active when the screen blanks, locked or not.
        if (Main.screenShield)
            this._connect(Main.screenShield, 'active-changed', () => this._updatePause());
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._ours.forEach(win => this._place(win));
            this._updatePause();
        });
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._updatePause());

        global.get_window_actors().forEach(actor => this._watch(actor.meta_window));
        if (this._manageService)
            this._systemctl('start');
    }

    disable() {
        if (this._manageService)
            this._systemctl('stop');
        this._signals.forEach(([obj, id]) => obj.disconnect(id));
        this._watched.forEach((ids, win) => ids.forEach(id => win.disconnect(id)));
        this._signals = null;
        this._watched = null;
        this._ours = null;
    }

    _connect(obj, signal, callback) {
        this._signals.push([obj, obj.connect(signal, callback)]);
    }

    _watch(win) {
        if (this._watched.has(win))
            return;
        const check = () => {
            if (!this._ours.has(win) && win.get_wm_class() === APP_ID)
                this._adopt(win);
        };
        const ids = [
            win.connect('notify::wm-class', check),
            win.connect('unmanaged', () => {
                ids.forEach(id => win.disconnect(id));
                this._watched.delete(win);
                this._ours.delete(win);
            }),
        ];
        this._watched.set(win, ids);
        check();
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
        console.log(`${this.uuid}: adopted window type=${win.get_window_type()} ` +
            `skip_taskbar=${win.is_skip_taskbar()}`);
    }

    _place(win) {
        const display = global.display;
        const want = display.get_monitor_geometry(display.get_primary_monitor());
        const have = win.get_frame_rect();
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
        if (Main.layoutManager.monitors.length === 0)
            return true;
        const primary = display.get_primary_monitor();
        if (display.get_monitor_in_fullscreen(primary))
            return true;
        const workspace = global.workspace_manager.get_active_workspace();
        return workspace.list_windows().some(win =>
            !this._ours.has(win) && !win.minimized && win.showing_on_its_workspace() &&
            win.get_monitor() === primary &&
            win.get_maximize_flags() === Meta.MaximizeFlags.BOTH);
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

    _systemctl(action) {
        try {
            Gio.Subprocess.new(['systemctl', '--user', '--no-block', action, UNIT],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`${this.uuid}: systemctl ${action} failed: ${e.message}`);
        }
    }
}
