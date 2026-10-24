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
const HISTORY = 90; // 90 x 2 seconds = 3 minutes
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 400;

const decoder = new TextDecoder();

const numbers = list => list.filter(v => v !== null);
const joinDetail = (...parts) => parts.filter(p => p).join('   ');
const average = list => {
    const nums = numbers(list);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
};

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

async function readFile(path, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

async function listDir(path, cancellable) {
    try {
        const iter = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        const names = [];
        let infos;
        while ((infos = await iter.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable)).length)
            names.push(...infos.map(info => info.get_name()));
        await iter.close_async(GLib.PRIORITY_DEFAULT, cancellable);
        return names;
    } catch {
        return [];
    }
}

// Find the CPU temperature sensor, most accurate source first
async function findCpuTempPath(cancellable) {
    const wanted = [
        ['coretemp', /^Package id/],
        ['k10temp', /^(Tctl|Tdie)$/],
        ['zenpower', /^Tdie$/],
        ['thinkpad', /^CPU$/],
    ];
    const hwmons = await Promise.all((await listDir('/sys/class/hwmon', cancellable)).map(async dir => {
        const base = `/sys/class/hwmon/${dir}`;
        const [name, files] = await Promise.all([
            readFile(`${base}/name`, cancellable),
            listDir(base, cancellable),
        ]);
        return {base, name: name?.trim(), files};
    }));
    for (const [name, label] of wanted) {
        for (const hw of hwmons.filter(h => h.name === name)) {
            for (const file of hw.files.filter(f => /^temp\d+_label$/.test(f))) {
                if (label.test((await readFile(`${hw.base}/${file}`, cancellable))?.trim() ?? ''))
                    return `${hw.base}/${file.replace('_label', '_input')}`;
            }
        }
    }
    const zones = (await listDir('/sys/class/thermal', cancellable)).filter(z => z.startsWith('thermal_zone'));
    for (const zone of zones) {
        const type = (await readFile(`/sys/class/thermal/${zone}/type`, cancellable))?.trim();
        if (['x86_pkg_temp', 'TCPU', 'cpu-thermal', 'acpitz'].includes(type))
            return `/sys/class/thermal/${zone}/temp`;
    }
    return null;
}

class Sampler {
    constructor(cancellable) {
        this._cancellable = cancellable;
        this._prevCpu = null;
        this._tempPath = undefined;
        this.cpu = [];
        this.ram = [];
        this.temp = [];
        this.info = {};
    }

    async sample() {
        const c = this._cancellable;
        if (this._tempPath === undefined)
            this._tempPath = await findCpuTempPath(c);
        const [stat, loadavg, meminfo, temp] = await Promise.all([
            readFile('/proc/stat', c),
            readFile('/proc/loadavg', c),
            readFile('/proc/meminfo', c),
            this._tempPath ? readFile(this._tempPath, c) : null,
        ]);
        this._push(this.cpu, this._parseCpu(stat, loadavg));
        this._push(this.ram, this._parseRam(meminfo));
        this._push(this.temp, this._parseTemp(temp));
    }

    _push(list, value) {
        list.push(value);
        if (list.length > HISTORY)
            list.shift();
    }

    _parseCpu(stat, loadavg) {
        const load = loadavg?.split(' ', 3);
        if (load)
            this.info.load = load.join('  ');
        const line = stat?.split('\n', 1)[0];
        if (!line)
            return null;
        const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
        const idle = v[3] + v[4];
        const total = v.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        if (!prev || total === prev.total)
            return null;
        return 100 * (1 - (idle - prev.idle) / (total - prev.total));
    }

    _parseRam(text) {
        if (!text)
            return null;
        const kb = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
        const total = kb('MemTotal');
        const used = total - kb('MemAvailable');
        const swapTotal = kb('SwapTotal');
        const swapUsed = swapTotal - kb('SwapFree');
        const gib = n => (n / 1048576).toFixed(1);
        this.info.ram = `${gib(used)} / ${gib(total)} GiB`;
        this.info.ramTotalKb = total;
        // Only list swap when it is in use, to keep the detail line short
        this.info.swap = swapUsed > 52428 ? `swap ${gib(swapUsed)} GiB` : '';
        return total ? 100 * used / total : null;
    }

    _parseTemp(text) {
        const raw = Number(text);
        return text && Number.isFinite(raw) && raw > 0 ? raw / 1000 : null;
    }
}

// [light theme, dark theme] from the GNOME palette
const COLORS = {
    cpu: [[0.21, 0.52, 0.89], [0.38, 0.63, 0.92]],
    ram: [[0.15, 0.64, 0.41], [0.34, 0.89, 0.54]],
    temp: [[0.9, 0.38, 0], [1, 0.64, 0.28]],
};

const Graph = GObject.registerClass(
class Graph extends St.DrawingArea {
    _init(series, color, min, max, showAvg) {
        super._init({style_class: 'sysmon-graph'});
        this._showAvg = showAvg;
        this._series = series;
        this._color = color;
        this._min = min;
        this._max = max;
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const values = this._series();

        // Follow the theme text color so the grid shows on light and dark themes
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

        const avg = this._showAvg ? average(values) : null;
        if (avg !== null && points.length > 1) {
            const ay = Math.round(y(avg)) + 0.5;
            cr.setDash([3, 3], 0);
            cr.setLineWidth(1);
            cr.setSourceRGBA(r, g, b, 0.8);
            cr.moveTo(points[0][0], ay);
            cr.lineTo(points.at(-1)[0], ay);
            cr.stroke();
            cr.setDash([], 0);
        }
        cr.$dispose();
    }
});

const Section = GObject.registerClass(
class Section extends PopupMenu.PopupBaseMenuItem {
    _init(title, series, color, min, max, showAvg = false) {
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
        this.graph = new Graph(series, color, min, max, showAvg);
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
        this._cpu = new Section('CPU', () => sampler.cpu, COLORS.cpu, 0, 100, true);
        this._ram = new Section('RAM', () => sampler.ram, COLORS.ram, 0, 100);
        this._temp = new Section('CPU Temp', () => sampler.temp, COLORS.temp, 30, 100, true);
        for (const s of [this._cpu, this._ram, this._temp])
            this.menu.addMenuItem(s);
        this._last = last;

        // Click: if the menu was opened by hover, clicking pins it open
        this._clickGesture.set_enabled(false);
        this._click = new Clutter.ClickGesture();
        this._click.set_recognize_on_press(true);
        this._clickId = this._click.connect('recognize', () => {
            if (this.menu.isOpen && this._hoverOpened)
                this._stopHover();
            else
                this.menu.toggle();
        });
        this.add_action(this._click);

        this._hoverId = this.connect('notify::hover', () => this._onHover());
        this._menuStateId = this.menu.connect('open-state-changed', (menu, open) => {
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

    // Close a hover-opened menu once the pointer leaves both button and menu
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
        this._cpu.detail.text = joinDetail(
            `avg ${fmt(average(s.cpu), '%')}`,
            s.info.load ? `load ${s.info.load}` : '');

        this._ram.value.text = fmt(ram, '%');
        const rams = numbers(s.ram);
        const peak = rams.length && s.info.ramTotalKb
            ? `peak ${(Math.max(...rams) / 100 * s.info.ramTotalKb / 1048576).toFixed(1)} GiB`
            : '';
        this._ram.detail.text = joinDetail(s.info.ram, peak, s.info.swap);

        this._temp.value.text = fmt(temp, '°C');
        const temps = numbers(s.temp);
        this._temp.detail.text = temps.length
            ? `min ${fmt(Math.min(...temps), '°C')}   avg ${fmt(average(temps), '°C')}   max ${fmt(Math.max(...temps), '°C')}`
            : 'sensor not found';

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
        this._click.disconnect(this._clickId);
        this.menu.disconnect(this._menuStateId);
        this.disconnect(this._hoverId);
        super.destroy();
    }
});

export default class SysMonExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._busy = false;
        this._sampler = new Sampler(this._cancellable);
        this._button = new SysMonButton(this._sampler);
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');

        this._refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVAL_SECS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        if (this._busy)
            return;
        this._busy = true;
        const cancellable = this._cancellable;
        try {
            await this._sampler.sample();
            if (!cancellable.is_cancelled())
                this._button.update();
        } catch (e) {
            logError(e, 'sysmon: sampling failed');
        } finally {
            if (cancellable === this._cancellable)
                this._busy = false;
        }
    }

    disable() {
        this._cancellable.cancel();
        this._cancellable = null;
        GLib.source_remove(this._timerId);
        this._timerId = 0;
        this._button.destroy();
        this._button = null;
        this._sampler = null;
    }
}
