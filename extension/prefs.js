// Preferences window for aerial-wallpaper@viablesys: wallpaper, the Conky panel, monitors, widget windows.
// Everything here is a GSettings key; bin/aerial-wallpaper exposes the same keys on the CLI.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Conky from './conky.js';
import * as Monitors from './monitors.js';

const PLAYLISTS = GLib.build_filenamev([GLib.get_home_dir(), 'Videos', 'aerial', '.meta', 'playlists']);
// wall-aerial also takes a category name as the playlist.
const CATEGORIES = ['Space', 'Underwater', 'Cities', 'Landscapes'];
const POSITIONS = [
    ['top-left', 'Top left'], ['top-center', 'Top centre'], ['top-right', 'Top right'],
    ['middle-left', 'Middle left'], ['center', 'Centre'], ['middle-right', 'Middle right'],
    ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right'],
];

function listPlaylists() {
    const names = [];
    try {
        const dir = Gio.File.new_for_path(PLAYLISTS);
        const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = iter.next_file(null));) {
            if (info.get_name().endsWith('.txt'))
                names.push(info.get_name().slice(0, -4));
        }
    } catch {}
    return names.sort();
}

function toHex(rgba) {
    const c = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${c(rgba.red)}${c(rgba.green)}${c(rgba.blue)}`;
}

// The layout the running extension wrote ({monitors: [...]}), or null.
function readState() {
    try {
        const [ok, bytes] = GLib.file_get_contents(Monitors.statePath());
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch {
        return null;
    }
}

// Connected monitors: [{connector, primary}], from the extension's state, else from GDK (which
// cannot tell which one is primary).
function connectedMonitors() {
    const state = readState();
    if (state)
        return state.monitors.map(m => ({connector: m.connector, primary: m.primary}));
    const list = Gdk.Display.get_default().get_monitors();
    const out = [];
    for (let i = 0; i < list.get_n_items(); i++)
        out.push({connector: list.get_item(i).get_connector(), primary: false});
    return out;
}

function mpvCommand(command, connector = null) {
    const m = readState()?.monitors.find(x => (connector ? x.connector === connector : x.primary) && x.video);
    if (!m)
        return;
    const path = m.socket;
    new Gio.SocketClient().connect_async(new Gio.UnixSocketAddress({path}), null, (c, res) => {
        try {
            const conn = c.connect_finish(res);
            conn.get_output_stream().write_all(new TextEncoder().encode(`${JSON.stringify({command})}\n`), null);
            conn.close(null);
        } catch (e) {
            console.warn(`aerial-wallpaper prefs: mpv IPC failed: ${e.message}`);
        }
    });
}

function systemctl(...args) {
    Gio.Subprocess.new(['systemctl', '--user', ...args], Gio.SubprocessFlags.NONE);
}

export default class AerialWallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;  // keep it alive with the window
        window.set_default_size(720, 860);
        window.set_search_enabled(true);
        window.add(this._wallpaperPage(settings));
        window.add(this._conkyPage(settings, window));
        window.add(this._monitorsPage(settings));
        window.add(this._widgetsPage(settings));
        window.add(this._cliPage());
        // Test hooks (headless shell): open on one page, or step through the pages so each can be screenshotted.
        if (GLib.getenv('AERIAL_WALLPAPER_TEST_PAGE')) {
            window.set_default_size(760, 1400);
            window.set_visible_page_name(GLib.getenv('AERIAL_WALLPAPER_TEST_PAGE'));
        }
        const step = Number(GLib.getenv('AERIAL_WALLPAPER_TEST_PAGES') || 0);
        if (step) {
            window.set_default_size(760, 2100);  // tall enough to show whole pages
            const names = ['wallpaper', 'conky', 'monitors', 'widgets', 'cli'];
            let i = 0;
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, step, () => {
                window.set_visible_page_name(names[++i % names.length]);
                return i < names.length * 3 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            });
        }
    }

    // Helpers that bind a row to a key.
    _switch(settings, key) {
        const k = settings.settings_schema.get_key(key);
        const row = new Adw.SwitchRow({title: k.get_summary(), subtitle: k.get_description()});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spin(settings, key, step, digits = 0) {
        const k = settings.settings_schema.get_key(key);
        const [, [min, max]] = k.get_range().recursiveUnpack();
        const row = new Adw.SpinRow({
            title: k.get_summary(), subtitle: k.get_description(), digits,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _entry(settings, key) {
        const k = settings.settings_schema.get_key(key);
        const row = new Adw.EntryRow({title: k.get_summary(), show_apply_button: true});
        row.set_text(settings.get_string(key));
        row.connect('apply', () => settings.set_string(key, row.get_text()));
        settings.connect(`changed::${key}`, () => {
            if (row.get_text() !== settings.get_string(key))
                row.set_text(settings.get_string(key));
        });
        return row;
    }

    _listEntry(settings, key, hint) {
        const k = settings.settings_schema.get_key(key);
        const row = new Adw.EntryRow({title: `${k.get_summary()} ${hint}`, show_apply_button: true});
        const show = () => row.set_text(settings.get_strv(key).join(', '));
        show();
        row.connect('apply', () => settings.set_strv(key,
            row.get_text().split(',').map(s => s.trim()).filter(Boolean)));
        settings.connect(`changed::${key}`, show);
        return row;
    }

    _choice(settings, key, choices) {
        const k = settings.settings_schema.get_key(key);
        const row = new Adw.ComboRow({
            title: k.get_summary(), tooltip_text: k.get_description(),
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });
        const sync = () => row.set_selected(Math.max(0, choices.findIndex(([v]) => v === settings.get_string(key))));
        sync();
        row.connect('notify::selected', () => {
            const value = choices[row.get_selected()]?.[0];
            if (value !== undefined && value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        settings.connect(`changed::${key}`, sync);
        return row;
    }

    _color(settings, key) {
        const k = settings.settings_schema.get_key(key);
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}), valign: Gtk.Align.CENTER,
        });
        const sync = () => {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(settings.get_string(key)))
                button.set_rgba(rgba);
        };
        sync();
        button.connect('notify::rgba', () => {
            const hex = toHex(button.get_rgba());
            if (hex !== settings.get_string(key))
                settings.set_string(key, hex);
        });
        settings.connect(`changed::${key}`, sync);
        const row = new Adw.ActionRow({title: k.get_summary(), subtitle: k.get_description()});
        row.add_suffix(button);
        row.set_activatable_widget(button);
        return row;
    }

    _button(label, callback, css = null) {
        const button = new Gtk.Button({label, valign: Gtk.Align.CENTER});
        if (css)
            button.add_css_class(css);
        button.connect('clicked', callback);
        return button;
    }

    _wallpaperPage(settings) {
        const page = new Adw.PreferencesPage({name: 'wallpaper', title: 'Wallpaper', icon_name: 'preferences-desktop-wallpaper-symbolic'});

        const video = new Adw.PreferencesGroup({title: 'Video'});
        const playlists = listPlaylists();
        video.add(this._choice(settings, 'playlist',
            [['', 'Default'], ...playlists.map(p => [p, p]), ...CATEGORIES.map(c => [c, `${c} (category)`])]));
        video.add(this._switch(settings, 'pause-when-covered'));
        video.add(this._switch(settings, 'overview-video'));
        const skip = new Adw.ActionRow({title: 'Current video', subtitle: 'Skip to the previous or next video on the primary monitor (others: Monitors page)'});
        skip.add_suffix(this._button('Previous', () => mpvCommand(['playlist-prev', 'force'])));
        skip.add_suffix(this._button('Next', () => mpvCommand(['playlist-next', 'force'])));
        video.add(skip);
        const restart = new Adw.ActionRow({title: 'Wallpaper services', subtitle: 'aerial-wallpaper@MONITOR.service, one per monitor that plays'});
        restart.add_suffix(this._button('Restart', () => systemctl('restart', 'aerial-wallpaper@*.service')));
        video.add(restart);
        page.add(video);
        return page;
    }

    _conkyPage(settings, window) {
        const page = new Adw.PreferencesPage({name: 'conky', title: 'Conky', icon_name: 'computer-symbolic'});

        const panel = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'A native Wayland Conky over the video, placed and pinned by the extension.',
        });
        panel.add(this._switch(settings, 'conky-enabled'));
        panel.add(this._choice(settings, 'conky-mode',
            [['generated', 'Generated'], ['custom', 'Custom file']]));
        const custom = this._entry(settings, 'conky-custom-path');
        const pick = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Choose a file'});
        pick.add_css_class('flat');
        pick.connect('clicked', () => {
            new Gtk.FileDialog({title: 'Conky config'}).open(window, null, (d, res) => {
                try {
                    settings.set_string('conky-custom-path', d.open_finish(res).get_path());
                } catch {}
            });
        });
        custom.add_suffix(pick);
        const showCustom = () => custom.set_visible(settings.get_string('conky-mode') === 'custom');
        showCustom();
        settings.connect('changed::conky-mode', showCustom);
        panel.add(custom);
        const actions = new Adw.ActionRow({
            title: 'Config', subtitle: `${Conky.configPath('MONITOR')}; these are the defaults, overridable per monitor`,
        });
        actions.add_suffix(this._button('Show', () => this._showConfig(settings, window)));
        actions.add_suffix(this._button('Restart Conky', () => systemctl('restart', Conky.UNIT_PATTERN)));
        panel.add(actions);
        page.add(panel);

        const place = new Adw.PreferencesGroup({title: 'Placement'});
        place.add(this._choice(settings, 'conky-position', POSITIONS));
        place.add(this._spin(settings, 'conky-margin-x', 5));
        place.add(this._spin(settings, 'conky-margin-y', 5));
        place.add(this._spin(settings, 'conky-width', 10));
        page.add(place);

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        // An entry plus a chooser: the key is a plain Pango description, so it can also be typed.
        const fontRow = this._entry(settings, 'conky-font');
        fontRow.set_title('Font (Pango description; its size scales the whole panel)');
        const choose = new Gtk.Button({icon_name: 'font-select-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Choose a font'});
        choose.add_css_class('flat');
        choose.connect('clicked', () => {
            const initial = Pango.FontDescription.from_string(settings.get_string('conky-font'));
            new Gtk.FontDialog({title: 'Conky font'}).choose_font(window, initial, null, (d, res) => {
                try {
                    settings.set_string('conky-font', d.choose_font_finish(res).to_string());
                } catch {}
            });
        });
        fontRow.add_suffix(choose);
        look.add(fontRow);
        look.add(this._color(settings, 'conky-color'));
        look.add(this._color(settings, 'conky-accent-color'));
        look.add(this._color(settings, 'conky-label-color'));
        look.add(this._color(settings, 'conky-background'));
        look.add(this._spin(settings, 'conky-opacity', 0.05, 2));
        look.add(this._spin(settings, 'conky-interval', 0.5, 1));
        look.add(this._switch(settings, 'conky-graphs'));
        page.add(look);

        const sections = new Adw.PreferencesGroup({
            title: 'Sections',
            description: 'Switch sections on or off and change their order.',
        });
        const rows = [];
        const rebuild = () => {
            rows.splice(0).forEach(r => sections.remove(r));
            const enabled = settings.get_strv('conky-sections');
            const order = [...enabled, ...Conky.SECTIONS.filter(s => !enabled.includes(s))];
            for (const name of order) {
                const on = enabled.includes(name);
                const row = new Adw.ActionRow({title: Conky.SECTION_TITLES[name], subtitle: name});
                const up = new Gtk.Button({icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER, sensitive: on && enabled.indexOf(name) > 0});
                const down = new Gtk.Button({icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER, sensitive: on && enabled.indexOf(name) < enabled.length - 1});
                [up, down].forEach(b => b.add_css_class('flat'));
                const move = delta => {
                    const list = settings.get_strv('conky-sections');
                    const i = list.indexOf(name);
                    list.splice(i, 1);
                    list.splice(i + delta, 0, name);
                    settings.set_strv('conky-sections', list);
                };
                up.connect('clicked', () => move(-1));
                down.connect('clicked', () => move(1));
                const toggle = new Gtk.Switch({active: on, valign: Gtk.Align.CENTER});
                toggle.connect('notify::active', () => {
                    const list = settings.get_strv('conky-sections').filter(s => s !== name);
                    settings.set_strv('conky-sections', toggle.active ? [...list, name] : list);
                });
                row.add_suffix(up);
                row.add_suffix(down);
                row.add_suffix(toggle);
                sections.add(row);
                rows.push(row);
            }
        };
        rebuild();
        settings.connect('changed::conky-sections', rebuild);
        page.add(sections);

        const options = new Adw.PreferencesGroup({title: 'Section options'});
        options.add(this._listEntry(settings, 'conky-disks', '(comma separated)'));
        const iface = this._entry(settings, 'conky-interface');
        iface.set_title(`Network interface (empty: ${Conky.defaultInterface() ?? 'none found'})`);
        options.add(iface);
        options.add(this._spin(settings, 'conky-process-count', 1));
        const text = new Gtk.TextView({monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8});
        text.buffer.set_text(settings.get_string('conky-custom-text'), -1);
        const save = this._button('Apply', () => settings.set_string('conky-custom-text', text.buffer.text));
        const customRow = new Adw.ExpanderRow({title: 'Custom text', subtitle: 'Raw Conky text for the custom section; Conky variables work'});
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6});
        const scroll = new Gtk.ScrolledWindow({child: text, min_content_height: 120});
        box.append(scroll);
        save.set_halign(Gtk.Align.END);
        box.append(save);
        customRow.add_row(box);
        options.add(customRow);
        page.add(options);
        return page;
    }

    _showConfig(settings, window) {
        const view = new Gtk.TextView({monospace: true, editable: false, top_margin: 12, left_margin: 12, right_margin: 12, bottom_margin: 12});
        // The primary monitor's panel, the one most configs are about.
        const primary = connectedMonitors().find(m => m.primary)?.connector ?? Monitors.PRIMARY;
        const settingsFor = Monitors.resolve(settings, Monitors.readEntries(settings), primary, true).settings;
        view.buffer.set_text(Conky.buildConfig(settingsFor, Monitors.instanceId(primary)), -1);
        const toolbar = new Adw.ToolbarView({content: new Gtk.ScrolledWindow({child: view, vexpand: true})});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({title: 'Generated Conky config', content_width: 760, content_height: 640, child: toolbar});
        dialog.present(window);
    }

    // One group per monitor (connected, or with settings): video, playlist, Conky panel and its
    // position. Edits go to the monitor's connector entry; other keys through the CLI.
    _monitorsPage(settings) {
        const page = new Adw.PreferencesPage({name: 'monitors', title: 'Monitors', icon_name: 'video-display-symbolic'});
        const intro = new Adw.PreferencesGroup({
            title: 'Monitors',
            description: 'What each monitor shows. Without settings here only the primary monitor plays. ' +
                'Any conky-* setting can be overridden per monitor from the CLI: aerial-wallpaper monitor M set KEY VALUE.',
        });
        page.add(intro);

        const playlists = [['', 'Default'], ...listPlaylists().map(p => [p, p]), ...CATEGORIES.map(c => [c, `${c} (category)`])];
        const entries = () => Monitors.readEntries(settings);
        // On the primary monitor a key may come from the "primary" entry; clearing it there too makes
        // "Same as ..." and Reset stick. Set values go to the connector's entry, which wins.
        const setKey = (connector, primary, key, value) => {
            const all = entries();
            const names = primary ? [connector, Monitors.PRIMARY] : [connector];
            for (const name of names) {
                const entry = all[name] ?? {};
                delete entry[key];
                if (value !== undefined && name === connector)
                    entry[key] = value;
                all[name] = entry;
                if (Object.keys(entry).length === 0)
                    delete all[name];
            }
            Monitors.writeEntries(settings, all);
        };

        const connected = connectedMonitors();
        const configured = Object.keys(entries()).filter(c => c !== Monitors.PRIMARY && !connected.some(m => m.connector === c));
        const syncs = [];
        for (const {connector, primary} of [...connected, ...configured.map(c => ({connector: c, primary: false, gone: true}))]) {
            const gone = !connected.some(m => m.connector === connector);
            const group = new Adw.PreferencesGroup({
                title: connector + (primary ? ' (primary)' : '') + (gone ? ' (not connected)' : ''),
            });
            // The monitor's effective entry, "primary" entry included for the primary monitor.
            const effective = () => Monitors.entryFor(entries(), connector, primary);

            const video = new Adw.SwitchRow({title: 'Video', subtitle: 'Play the Aerial video on this monitor'});
            const playlist = new Adw.ComboRow({title: 'Playlist', model: Gtk.StringList.new(['Same as the Wallpaper page', ...playlists.map(([, l]) => l)])});
            const conky = new Adw.SwitchRow({title: 'Conky panel', subtitle: 'Needs the panel switched on on the Conky page'});
            const position = new Adw.ComboRow({title: 'Panel position', model: Gtk.StringList.new(['Same as the Conky page', ...POSITIONS.map(([, l]) => l)])});
            let syncing = false;
            const sync = () => {
                syncing = true;
                const e = effective();
                video.set_active(e !== null && (e.aerial ?? true));
                conky.set_active(e !== null && (e.conky ?? primary));
                playlist.set_selected(e && 'playlist' in e ? 1 + Math.max(0, playlists.findIndex(([v]) => v === e.playlist)) : 0);
                position.set_selected(e && 'conky-position' in e ? 1 + Math.max(0, POSITIONS.findIndex(([v]) => v === e['conky-position'])) : 0);
                syncing = false;
            };
            sync();
            syncs.push(sync);
            video.connect('notify::active', () => !syncing && setKey(connector, primary, 'aerial', video.active));
            conky.connect('notify::active', () => !syncing && setKey(connector, primary, 'conky', conky.active));
            playlist.connect('notify::selected', () => {
                const i = playlist.get_selected();
                if (!syncing)
                    setKey(connector, primary, 'playlist', i === 0 ? undefined : playlists[i - 1][0]);
            });
            position.connect('notify::selected', () => {
                const i = position.get_selected();
                if (!syncing)
                    setKey(connector, primary, 'conky-position', i === 0 ? undefined : POSITIONS[i - 1][0]);
            });
            [video, playlist, conky, position].forEach(r => group.add(r));

            const actions = new Adw.ActionRow({title: 'Overrides', subtitle: `aerial-wallpaper monitor ${connector} show`});
            if (!gone) {
                actions.add_suffix(this._button('Previous', () => mpvCommand(['playlist-prev', 'force'], connector)));
                actions.add_suffix(this._button('Next', () => mpvCommand(['playlist-next', 'force'], connector)));
            }
            actions.add_suffix(this._button('Reset', () => {
                const all = entries();
                delete all[connector];
                if (primary)
                    delete all[Monitors.PRIMARY];
                Monitors.writeEntries(settings, all);
            }, 'destructive-action'));
            group.add(actions);
            page.add(group);
        }
        settings.connect('changed::monitors', () => syncs.forEach(f => f()));
        return page;
    }

    _widgetsPage(settings) {
        const page = new Adw.PreferencesPage({name: 'widgets', title: 'Widgets', icon_name: 'view-grid-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Widget windows',
            description: 'Windows with these classes (Wayland app id or X11 WM_CLASS) sit just above the video, ' +
                'on every workspace, out of alt-tab and the overview. The Conky panels (AerialConky-*) always are.',
        });
        const rows = [];
        const add = new Adw.EntryRow({title: 'Add a window class', show_apply_button: true});
        add.connect('apply', () => {
            const cls = add.get_text().trim();
            const list = settings.get_strv('widget-classes');
            if (cls && !list.includes(cls))
                settings.set_strv('widget-classes', [...list, cls]);
            add.set_text('');
        });
        const rebuild = () => {
            rows.splice(0).forEach(r => group.remove(r));
            for (const cls of settings.get_strv('widget-classes')) {
                const row = new Adw.ActionRow({title: cls});
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Remove'});
                remove.add_css_class('flat');
                remove.connect('clicked', () => settings.set_strv('widget-classes',
                    settings.get_strv('widget-classes').filter(c => c !== cls)));
                row.add_suffix(remove);
                group.add(row);
                rows.push(row);
            }
            group.remove(add);
            group.add(add);
        };
        group.add(add);
        rebuild();
        settings.connect('changed::widget-classes', rebuild);
        page.add(group);
        return page;
    }

    _cliPage() {
        const page = new Adw.PreferencesPage({name: 'cli', title: 'CLI', icon_name: 'utilities-terminal-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Command line',
            description: 'Every setting here is also on the command line, for scripts and agents. Add --json for machine output.',
        });
        const commands = [
            ['aerial-wallpaper status', 'Extension, services, current video, Conky'],
            ['aerial-wallpaper keys', 'Every setting with type, value, default and allowed values'],
            ['aerial-wallpaper set KEY VALUE', 'Change a setting; it applies immediately'],
            ['aerial-wallpaper next | prev | now [--monitor M]', 'Skip or show the current video'],
            ['aerial-wallpaper monitors', 'Connected monitors and what each one shows'],
            ['aerial-wallpaper monitor M set KEY VALUE', 'Per-monitor override: aerial, conky, playlist, pause-when-covered, any conky-* key'],
            ['aerial-wallpaper monitor M unset KEY | reset', 'Drop one or all of a monitor\'s overrides'],
            ['aerial-wallpaper conky sections', 'Sections, in order'],
            ['aerial-wallpaper conky enable gpu', 'Show a section; disable hides it, move reorders'],
            ['aerial-wallpaper conky on | off | restart | config', 'Run or stop the panel, or print its config'],
            ['gsettings list-recursively org.gnome.shell.extensions.aerial-wallpaper', 'The same keys through gsettings (needs --schemadir if the schema is not installed)'],
        ];
        for (const [cmd, what] of commands) {
            const row = new Adw.ActionRow({title: cmd, subtitle: what, title_selectable: true});
            row.add_css_class('monospace');
            group.add(row);
        }
        page.add(group);
        return page;
    }
}
