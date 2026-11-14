// Builds the Conky config for the panel from the extension's settings.
//
// Conky runs as a native Wayland client (out_to_wayland). GNOME has no layer-shell, so Conky
// cannot place, stack or pin its own window there; the extension does that instead, finding
// the window by its class (WINDOW_CLASS). Only GLib/Gio here: prefs.js imports this module too.

import GLib from 'gi://GLib';

export const WINDOW_CLASS = 'AerialConky';
export const UNIT = 'aerial-conky.service';
export const SECTIONS = ['header', 'clock', 'system', 'cpu', 'cores', 'memory', 'gpu', 'disks',
    'network', 'processes', 'aerial', 'custom'];
export const SECTION_TITLES = {
    header: 'Header (host, time, date, uptime)',
    clock: 'Big clock',
    system: 'System (kernel, load, uptime)',
    cpu: 'CPU (total, frequency, temperature)',
    cores: 'CPU cores',
    memory: 'Memory and swap',
    gpu: 'NVIDIA GPU',
    disks: 'Disks',
    network: 'Network',
    processes: 'Top processes',
    aerial: 'Aerial (current video)',
    custom: 'Custom text',
};

export function configPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'aerial-wallpaper', 'conky.conf']);
}

// "#rrggbb" + opacity -> Conky's "#aarrggbb".
function argb(rgb, opacity) {
    const a = Math.round(Math.min(1, Math.max(0, opacity)) * 255).toString(16).padStart(2, '0');
    return `#${a}${rgb.replace(/^#/, '').slice(0, 6)}`;
}

function hex(rgb) {
    return rgb.replace(/^#/, '').slice(0, 6);
}

function luaString(s) {
    return JSON.stringify(s);
}

// Pango "Family Name Bold 12" -> {family, size}; style words are dropped.
function parseFont(desc) {
    const m = desc.trim().match(/^(.*?)\s+(\d+(?:\.\d+)?)$/);
    const family = (m ? m[1] : desc).replace(/\s+(Bold|Italic|Regular|Medium|Light|Oblique)\b/gi, '').trim();
    return {family: family || 'Monospace', size: m ? Number(m[2]) : 12};
}

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

// Interface of the default IPv4 route, or null.
export function defaultInterface() {
    const route = readText('/proc/net/route');
    const line = route?.split('\n').slice(1).map(l => l.trim().split(/\s+/))
        .find(f => f.length > 2 && f[1] === '00000000');
    return line ? line[0] : null;
}

// Index of the hwmon device with this name ("k10temp", "coretemp"), or null. Indexes can change
// between boots; the extension rewrites the config each time it is enabled.
function hwmonIndex(names) {
    for (let i = 0; i < 32; i++) {
        const name = readText(`/sys/class/hwmon/hwmon${i}/name`)?.trim();
        if (name && names.includes(name))
            return i;
    }
    return null;
}

// Groups mount points by the filesystem they are on (mountinfo's major:minor), so Btrfs subvolumes
// such as / and /home, which report the same used/size, get one row. Unknown mounts stay alone.
function groupMounts(mounts) {
    const devs = new Map();
    for (const line of readText('/proc/self/mountinfo')?.split('\n') ?? []) {
        const f = line.split(' ');
        if (f.length > 4)
            devs.set(f[4].replace(/\\040/g, ' '), f[2]);
    }
    const groups = new Map();
    for (const mount of mounts) {
        const key = devs.get(mount) ?? `mount:${mount}`;
        groups.set(key, [...groups.get(key) ?? [], mount]);
    }
    return [...groups.values()];
}

function cpuCount() {
    const text = readText('/proc/cpuinfo') ?? '';
    return Math.max(1, (text.match(/^processor\s*:/gm) ?? []).length);
}

export function buildConfig(settings) {
    if (settings.get_string('conky-mode') === 'custom')
        return buildCustomWrapper(settings);

    const font = parseFont(settings.get_string('conky-font'));
    const width = settings.get_int('conky-width');
    const pad = 14;
    const inner = width - 2 * pad;
    const half = Math.floor(inner / 2);
    const graphs = settings.get_boolean('conky-graphs');
    const graphH = Math.round(font.size * 2.4);
    const accent = hex(settings.get_string('conky-accent-color'));
    const fontSpec = (scale = 1, bold = false) =>
        `${font.family}:${bold ? 'bold:' : ''}size=${Math.round(font.size * scale)}`;
    const heading = (title, right = '') =>
        `\${color0}\${font ${fontSpec(1, true)}}${title}\${font}\${color}${right ? `\${alignr}${right}` : ''}`;
    const label = text => `\${color1}${text}\${color}`;

    const parts = {
        header: () => [
            `\${color0}\${font ${fontSpec(1.5, true)}}\${nodename}\${font}\${color}\${alignr}\${font ${fontSpec(1.5)}}\${time %H:%M}\${font}`,
            `${label('${time %A %d %B %Y}')}\${alignr}${label('up')} \${uptime_short}`,
        ],
        clock: () => [
            `\${alignc}\${font ${fontSpec(3.2)}}\${time %H:%M}\${font}`,
            `\${alignc}${label('${time %A, %d %B}')}`,
        ],
        system: () => [
            heading('System', '${sysname} ${kernel}'),
            `${label('Load')}\${alignr}\${loadavg}`,
            `${label('Uptime')}\${alignr}\${uptime}`,
        ],
        cpu: () => {
            const mon = hwmonIndex(['k10temp', 'coretemp', 'zenpower']);
            const temp = mon === null ? '' : `  \${hwmon ${mon} temp 1}°C`;
            return [
                heading('CPU', `\${cpu cpu0}%  \${freq_g 1} GHz${temp}`),
                graphs ? `\${color0}\${cpugraph cpu0 ${graphH},${inner} ${accent} ${accent}}\${color}`
                    : `\${color0}\${cpubar cpu0 6}\${color}`,
            ];
        },
        cores: () => {
            const n = cpuCount();
            const bar = half - Math.round(font.size * 4);
            const rows = [heading('Cores', `${n} threads`)];
            for (let i = 1; i <= n; i += 2) {
                const cell = c => `${label(String(c).padStart(2))} \${color0}\${cpubar cpu${c} 6,${bar}}\${color}`;
                rows.push(i + 1 <= n ? `${cell(i)}\${goto ${pad + half}}${cell(i + 1)}` : cell(i));
            }
            return rows;
        },
        memory: () => [
            heading('Memory', '${mem} / ${memmax}'),
            `\${color0}\${membar 6}\${color}`,
            `${label('Swap')}\${alignr}\${swap} / \${swapmax}`,
            `\${color0}\${swapbar 6}\${color}`,
        ],
        gpu: () => {
            if (!GLib.find_program_in_path('nvidia-smi'))
                return [heading('GPU', 'nvidia-smi not found')];
            const q = f => `nvidia-smi --query-gpu=${f} --format=csv,noheader,nounits`;
            return [
                heading('GPU', `\${execi 600 ${q('name')} | head -n1}`),
                `${label('Load')} \${execi 5 ${q('utilization.gpu')} | head -n1}%` +
                    // Recent drivers report temperature.gpu with decimals ("40.03"); round to match the CPU.
                    `\${goto ${pad + half}}${label('Temp')} \${execi 5 ${q('temperature.gpu')} | head -n1 | xargs printf '%.0f'}°C`,
                `${label('VRAM')} \${execi 5 ${q('memory.used,memory.total')} | head -n1 | sed 's/, / \\/ /'} MiB` +
                    `\${alignr}\${execi 5 ${q('power.draw')} | head -n1} W`,
                `\${color0}\${execibar 5 ${q('utilization.gpu')} | head -n1}\${color}`,
            ];
        },
        disks: () => {
            const rows = [
                heading('Disks'),
                `${label('Read')} \${diskio_read}\${goto ${pad + half}}${label('Write')} \${diskio_write}`,
            ];
            for (const group of groupMounts(settings.get_strv('conky-disks'))) {
                const mount = group[0];
                rows.push(`${label(group.join(' · '))}\${alignr}\${fs_used ${mount}} / \${fs_size ${mount}}`);
                rows.push(`\${color0}\${fs_bar 6 ${mount}}\${color}`);
            }
            return rows;
        },
        network: () => {
            const iface = settings.get_string('conky-interface') || defaultInterface();
            if (!iface)
                return [heading('Network', 'no default route')];
            const rows = [
                heading('Network', `${iface}  \${addr ${iface}}`),
                `${label('Down')} \${downspeed ${iface}}\${goto ${pad + half}}${label('Up')} \${upspeed ${iface}}`,
            ];
            if (graphs) {
                const w = half - 6;
                rows.push(`\${color0}\${downspeedgraph ${iface} ${graphH},${w} ${accent} ${accent}}` +
                    `\${goto ${pad + half}}\${upspeedgraph ${iface} ${graphH},${w} ${accent} ${accent}}\${color}`);
            }
            rows.push(`${label('Total')} \${totaldown ${iface}}\${goto ${pad + half}}${label('Total')} \${totalup ${iface}}`);
            return rows;
        },
        processes: () => {
            const n = settings.get_int('conky-process-count');
            const cpuX = pad + inner - Math.round(font.size * 9.5);
            const memX = pad + inner - Math.round(font.size * 4.5);
            const rows = [
                heading('Processes', '${running_processes} running / ${processes}'),
                `${label('Name')}\${goto ${cpuX}}${label('CPU%')}\${goto ${memX}}${label('MEM%')}`,
            ];
            for (let i = 1; i <= n; i++)
                rows.push(`\${top name ${i}}\${goto ${cpuX}}\${top cpu ${i}}\${goto ${memX}}\${top mem ${i}}`);
            return rows;
        },
        aerial: () => {
            const log = GLib.build_filenamev([GLib.get_home_dir(), 'Videos', 'aerial', '.meta', 'played.log']);
            const playlist = settings.get_string('playlist') || 'default';
            return [
                heading('Aerial', playlist),
                `\${execi 10 tail -n1 '${log}' | sed -E 's|.*/aerial/||; s| [[].*||; s|/| · |'}`,
            ];
        },
        custom: () => settings.get_string('conky-custom-text').split('\n'),
    };

    const body = settings.get_strv('conky-sections')
        .filter(s => parts[s])
        .map(s => parts[s]().join('\n'))
        .join('\n${voffset 8}\n');

    return `-- Written by aerial-wallpaper@viablesys from its settings; edits here are overwritten.
-- Change it with \`aerial-wallpaper set conky-...\`, gsettings or the extension preferences.
conky.config = {
${windowSettings(settings)}
  minimum_width = ${width}, maximum_width = ${width},
  border_inner_margin = ${pad}, border_outer_margin = 0,
  font = ${luaString(fontSpec())},
  use_xft = true,
  default_color = ${luaString(settings.get_string('conky-color'))},
  color0 = ${luaString(settings.get_string('conky-accent-color'))},
  color1 = ${luaString(settings.get_string('conky-label-color'))},
  update_interval = ${settings.get_double('conky-interval')},
  double_buffer = true,
  draw_shades = false, draw_outline = false, draw_borders = false, draw_graph_borders = false,
  default_bar_height = 6, default_graph_height = ${graphH},
  cpu_avg_samples = 2, net_avg_samples = 2, no_buffers = true, short_units = true,
  top_name_width = 22, text_buffer_size = 4096,
}

conky.text = [=[
${body}
]=]
`;
}

// The window settings the extension relies on: a native Wayland window with our class.
// Placement, stacking and pinning are done by the extension.
function windowSettings(settings, target = 'conky.config') {
    const lines = {
        out_to_x: 'false',
        out_to_wayland: 'true',
        own_window: 'true',
        own_window_type: luaString('normal'),
        own_window_class: luaString(WINDOW_CLASS),
        own_window_title: luaString('Aerial Conky'),
        own_window_colour: luaString(argb(settings.get_string('conky-background'),
            settings.get_double('conky-opacity'))),
        alignment: luaString('top_left'),
        gap_x: '0',
        gap_y: '0',
    };
    if (target === 'conky.config')
        return Object.entries(lines).map(([k, v]) => `  ${k} = ${v},`).join('\n');
    return Object.entries(lines).map(([k, v]) => `${target}.${k} = ${v}`).join('\n');
}

function buildCustomWrapper(settings) {
    const path = settings.get_string('conky-custom-path').replace(/^~(?=\/|$)/, GLib.get_home_dir());
    if (!path)
        return `-- Written by aerial-wallpaper@viablesys: conky-mode is custom but conky-custom-path is empty.
conky.config = {
${windowSettings(settings)}
}
conky.text = [[Set conky-custom-path (aerial-wallpaper set conky-custom-path ~/.config/conky/conky.conf)]]
`;
    return `-- Written by aerial-wallpaper@viablesys: your config, then the window settings the extension needs.
-- Edit ${path} instead; Conky reloads this file, not that one, so run \`aerial-wallpaper conky restart\` after edits.
dofile(${luaString(path)})
${windowSettings(settings, 'conky.config')}
`;
}

export function writeConfig(settings) {
    const path = configPath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const text = buildConfig(settings);
    if (readText(path) === text)
        return false;
    GLib.file_set_contents(path, text);
    return true;
}
