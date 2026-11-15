// Per-monitor configuration. The `monitors` setting maps a connector name ("DP-1", "HDMI-A-1",
// "Meta-0" in a headless shell) or "primary" to overrides of the global keys:
//
//   aerial              play the video on this monitor (default true once the monitor has an entry)
//   conky               show a Conky panel here (default: true on the primary monitor, false elsewhere;
//                       conky-enabled stays the master switch)
//   playlist, pause-when-covered and every conky-* key except conky-enabled: override the global value
//
// The primary monitor uses the "primary" entry merged with its own connector's entry, and runs with
// no entry at all, so an empty `monitors` behaves like the single-monitor extension. Other monitors
// stay plain until they get an entry. Only GLib here: prefs.js and the tests import this module too.

import GLib from 'gi://GLib';

export const PRIMARY = 'primary';
// Entry keys that are not global settings, with their GVariant types.
export const OWN_KEYS = {aerial: 'b', conky: 'b'};

// Keys an entry may hold -> GVariant type string.
export function entryKeys(settings) {
    const keys = {...OWN_KEYS};
    for (const key of settings.settings_schema.list_keys()) {
        if (key === 'playlist' || key === 'pause-when-covered' || (key.startsWith('conky-') && key !== 'conky-enabled'))
            keys[key] = settings.settings_schema.get_key(key).get_value_type().dup_string();
    }
    return keys;
}

// {connector: {key: plain value}}
export function readEntries(settings) {
    return settings.get_value('monitors').recursiveUnpack();
}

export function writeEntries(settings, entries) {
    const types = entryKeys(settings);
    const packed = {};
    for (const [connector, entry] of Object.entries(entries)) {
        const values = {};
        for (const [key, value] of Object.entries(entry)) {
            if (types[key])
                values[key] = new GLib.Variant(types[key], value);
        }
        packed[connector] = values;
    }
    settings.set_value('monitors', new GLib.Variant('a{sa{sv}}', packed));
}

// The entry for a monitor, or null when it has none (plain wallpaper).
export function entryFor(entries, connector, primary) {
    if (primary)
        return {...entries[PRIMARY] ?? {}, ...entries[connector] ?? {}};
    return entries[connector] ? {...entries[connector]} : null;
}

// Safe for systemd instance names, socket names and window classes.
export function instanceId(connector) {
    return connector.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// Reads like Gio.Settings, with the entry's values over the global ones. Enough for conky.js.
export class Overlay {
    constructor(settings, entry) {
        this.settings_schema = settings.settings_schema;
        this._settings = settings;
        this._entry = entry ?? {};
    }

    _get(key, getter) {
        return key in this._entry ? this._entry[key] : this._settings[getter](key);
    }

    get_string(key) {
        return this._get(key, 'get_string');
    }

    get_int(key) {
        return this._get(key, 'get_int');
    }

    get_double(key) {
        return this._get(key, 'get_double');
    }

    get_boolean(key) {
        return this._get(key, 'get_boolean');
    }

    get_strv(key) {
        return [...this._get(key, 'get_strv')];
    }
}

// What runs on one monitor: {video, conky, settings}.
export function resolve(settings, entries, connector, primary) {
    const entry = entryFor(entries, connector, primary);
    return {
        video: entry !== null && (entry.aerial ?? true),
        conky: entry !== null && settings.get_boolean('conky-enabled') && (entry.conky ?? primary),
        settings: new Overlay(settings, entry),
    };
}

// Written by the extension on every change, read by the CLI and the preferences window.
export function stateDir() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'aerial-wallpaper']);
}

export function statePath() {
    return GLib.build_filenamev([stateDir(), 'state.json']);
}

export function socketPath(id) {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), `aerial-mpv-${id}.sock`]);
}

// Written by bin/aerial-now.lua each time a video starts: "time<TAB>path".
export function nowPath(id) {
    return GLib.build_filenamev([stateDir(), `now-${id}`]);
}
