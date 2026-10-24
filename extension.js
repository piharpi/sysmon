import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INTERVAL_SECS = 2;
const HISTORY = 90; // 90 x 2 detik = 3 menit
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 400;

const decoder = new TextDecoder();

function readFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

function listDir(path) {
    try {
        const iter = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const names = [];
        let info;
        while ((info = iter.next_file(null)))
            names.push(info.get_name());
        iter.close(null);
        return names;
    } catch {
        return [];
    }
}

// Cari sensor suhu CPU; urutan = paling akurat dulu
function findCpuTempPath() {
    const wanted = [
        ['coretemp', /^Package id/],
        ['k10temp', /^(Tctl|Tdie)$/],
        ['zenpower', /^Tdie$/],
        ['thinkpad', /^CPU$/],
    ];
    const hwmons = listDir('/sys/class/hwmon').map(dir => {
        const base = `/sys/class/hwmon/${dir}`;
        return {base, name: readFile(`${base}/name`)?.trim(), files: listDir(base)};
    });
    for (const [name, label] of wanted) {
        for (const hw of hwmons.filter(h => h.name === name)) {
            for (const file of hw.files.filter(f => /^temp\d+_label$/.test(f))) {
                if (label.test(readFile(`${hw.base}/${file}`)?.trim() ?? ''))
                    return `${hw.base}/${file.replace('_label', '_input')}`;
            }
        }
    }
    for (const zone of listDir('/sys/class/thermal').filter(z => z.startsWith('thermal_zone'))) {
        const type = readFile(`/sys/class/thermal/${zone}/type`)?.trim();
        if (['x86_pkg_temp', 'TCPU', 'cpu-thermal', 'acpitz'].includes(type))
            return `/sys/class/thermal/${zone}/temp`;
    }
    return null;
}

class Sampler {
    constructor() {
        this._prevCpu = null;
        this._tempPath = findCpuTempPath();
        this.cpu = [];
        this.ram = [];
        this.temp = [];
        this.info = {};
    }

    sample() {
        this._push(this.cpu, this._readCpu());
        this._push(this.ram, this._readRam());
        this._push(this.temp, this._readTemp());
    }

    _push(list, value) {
        list.push(value);
        if (list.length > HISTORY)
            list.shift();
    }

    _readCpu() {
        const line = readFile('/proc/stat')?.split('\n', 1)[0];
        if (!line)
            return null;
        const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
        const idle = v[3] + v[4];
        const total = v.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        const load = readFile('/proc/loadavg')?.split(' ', 3);
        if (load)
            this.info.load = load.join('  ');
        if (!prev || total === prev.total)
            return null;
        return 100 * (1 - (idle - prev.idle) / (total - prev.total));
    }

    _readRam() {
        const text = readFile('/proc/meminfo');
        if (!text)
            return null;
        const kb = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
        const total = kb('MemTotal');
        const used = total - kb('MemAvailable');
        const swapTotal = kb('SwapTotal');
        const swapUsed = swapTotal - kb('SwapFree');
        const gib = n => (n / 1048576).toFixed(1);
        this.info.ram = `${gib(used)} / ${gib(total)} GiB`;
        this.info.swap = swapTotal ? `swap ${gib(swapUsed)} / ${gib(swapTotal)} GiB` : '';
        return total ? 100 * used / total : null;
    }

    _readTemp() {
        if (!this._tempPath)
            return null;
        const raw = Number(readFile(this._tempPath));
        return Number.isFinite(raw) && raw > 0 ? raw / 1000 : null;
    }
}

// [tema terang, tema gelap] dari palet GNOME
const COLORS = {
    cpu: [[0.21, 0.52, 0.89], [0.38, 0.63, 0.92]],
    ram: [[0.15, 0.64, 0.41], [0.34, 0.89, 0.54]],
    temp: [[0.9, 0.38, 0], [1, 0.64, 0.28]],
};

const Graph = GObject.registerClass(
class Graph extends St.DrawingArea {
    _init(series, color, min, max) {
        super._init({style_class: 'sysmon-graph'});
        this.connect('style-changed', () => this.queue_repaint());
        this._series = series;
        this._color = color;
        this._min = min;
        this._max = max;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const values = this._series();

        // Ikuti warna teks tema supaya grid kelihatan di tema terang/gelap
        const fg = this.get_theme_node().get_foreground_color();
        const [fr, fg2, fb] = [fg.red / 255, fg.green / 255, fg.blue / 255];
        const dark = 0.299 * fr + 0.587 * fg2 + 0.114 * fb > 0.5;
        const [r, g, b] = this._color[dark ? 1 : 0];
        cr.setSourceRGBA(fr, fg2, fb, 0.06);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        cr.setSourceRGBA(fr, fg2, fb, 0.12);
        cr.setLineWidth(1);
        for (const frac of [0.25, 0.5, 0.75]) {
            cr.moveTo(0, Math.round(h * frac) + 0.5);
            cr.lineTo(w, Math.round(h * frac) + 0.5);
        }
        cr.stroke();

        const step = w / (HISTORY - 1);
        const offset = HISTORY - values.length;
        const y = v => h - (Math.min(Math.max(v, this._min), this._max) - this._min) /
            (this._max - this._min) * (h - 2) - 1;
        const points = values
            .map((v, i) => (v === null ? null : [(offset + i) * step, y(v)]))
            .filter(p => p);

        if (points.length > 1) {
            cr.moveTo(points[0][0], h);
            points.forEach(([px, py]) => cr.lineTo(px, py));
            cr.lineTo(points.at(-1)[0], h);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.25);
            cr.fill();

            cr.moveTo(...points[0]);
            points.slice(1).forEach(([px, py]) => cr.lineTo(px, py));
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.5);
            cr.stroke();
        }
        cr.$dispose();
    }
});

const Section = GObject.registerClass(
class Section extends PopupMenu.PopupBaseMenuItem {
    _init(title, series, color, min, max) {
        super._init({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'sysmon-section',
            x_expand: true,
        });
        const header = new St.BoxLayout();
        header.add_child(new St.Label({text: title, style_class: 'sysmon-title', x_expand: true}));
        this.value = new St.Label({style_class: 'sysmon-value'});
        header.add_child(this.value);
        box.add_child(header);
        this.graph = new Graph(series, color, min, max);
        box.add_child(this.graph);
        this.detail = new St.Label({style_class: 'sysmon-detail', opacity: 160});
        box.add_child(this.detail);
        this.add_child(box);
    }
});

const SysMonButton = GObject.registerClass(
class SysMonButton extends PanelMenu.Button {
    _init(sampler) {
        super._init(0.5, 'System Monitor');
        this._sampler = sampler;
        this._hoverOpened = false;
        this._hoverOpenId = 0;
        this._hoverPollId = 0;

        this._label = new St.Label({
            style_class: 'sysmon-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        const last = list => list.at(-1) ?? null;
        this._cpu = new Section('CPU', () => sampler.cpu, COLORS.cpu, 0, 100);
        this._ram = new Section('RAM', () => sampler.ram, COLORS.ram, 0, 100);
        this._temp = new Section('CPU Temp', () => sampler.temp, COLORS.temp, 30, 100);
        for (const s of [this._cpu, this._ram, this._temp])
            this.menu.addMenuItem(s);
        this._last = last;

        // Klik: kalau menu terbuka karena hover, klik "menyematkan" menu
        this._clickGesture.set_enabled(false);
        this._click = new Clutter.ClickGesture();
        this._click.set_recognize_on_press(true);
        this._click.connect('recognize', () => {
            if (this.menu.isOpen && this._hoverOpened)
                this._stopHover();
            else
                this.menu.toggle();
        });
        this.add_action(this._click);

        this.connect('notify::hover', () => this._onHover());
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                this._stopHover();
            else
                this._redrawGraphs();
        });
    }

    _onHover() {
        if (!this.hover || this.menu.isOpen || this._hoverOpenId)
            return;
        this._hoverOpenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_OPEN_MS, () => {
            this._hoverOpenId = 0;
            if (this.hover && !this.menu.isOpen) {
                this.menu.open();
                this._hoverOpened = true;
                this._startHoverPoll();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Tutup menu hover kalau pointer sudah keluar dari tombol & menu
    _startHoverPoll() {
        let outsideSince = 0;
        this._hoverPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const [x, y] = global.get_pointer();
            const inside = [this, this.menu.actor].some(actor => {
                const [ax, ay] = actor.get_transformed_position();
                const [aw, ah] = actor.get_transformed_size();
                return x >= ax && x < ax + aw && y >= ay && y < ay + ah;
            });
            const now = GLib.get_monotonic_time() / 1000;
            if (inside) {
                outsideSince = 0;
            } else if (!outsideSince) {
                outsideSince = now;
            } else if (now - outsideSince >= HOVER_CLOSE_MS) {
                this._hoverPollId = 0;
                this.menu.close();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopHover() {
        this._hoverOpened = false;
        if (this._hoverPollId) {
            GLib.source_remove(this._hoverPollId);
            this._hoverPollId = 0;
        }
    }

    update() {
        const s = this._sampler;
        const fmt = (v, unit) => (v === null ? '–' : `${Math.round(v)}${unit}`);
        const cpu = this._last(s.cpu), ram = this._last(s.ram), temp = this._last(s.temp);

        this._label.text = `CPU ${fmt(cpu, '%')}  RAM ${fmt(ram, '%')}  ${fmt(temp, '°C')}`;
        this._cpu.value.text = fmt(cpu, '%');
        this._cpu.detail.text = s.info.load ? `load ${s.info.load}` : '';
        this._ram.value.text = fmt(ram, '%');
        this._ram.detail.text = [s.info.ram, s.info.swap].filter(t => t).join('   ');
        this._temp.value.text = fmt(temp, '°C');
        const temps = s.temp.filter(t => t !== null);
        this._temp.detail.text = temps.length
            ? `min ${Math.round(Math.min(...temps))}°C   max ${Math.round(Math.max(...temps))}°C`
            : 'sensor tidak ditemukan';

        if (this.menu.isOpen)
            this._redrawGraphs();
    }

    _redrawGraphs() {
        for (const s of [this._cpu, this._ram, this._temp])
            s.graph.queue_repaint();
    }

    destroy() {
        if (this._hoverOpenId)
            GLib.source_remove(this._hoverOpenId);
        this._hoverOpenId = 0;
        this._stopHover();
        super.destroy();
    }
});

export default class SysMonExtension extends Extension {
    enable() {
        this._sampler = new Sampler();
        this._button = new SysMonButton(this._sampler);
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');

        this._sampler.sample();
        this._button.update();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVAL_SECS, () => {
            this._sampler.sample();
            this._button.update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        GLib.source_remove(this._timerId);
        this._timerId = 0;
        this._button.destroy();
        this._button = null;
        this._sampler = null;
    }
}
