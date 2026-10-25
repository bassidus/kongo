"use strict";

const HISTORY = 60;
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function fmtBytes(n, digits = 1) {
  if (n == null) return "—";
  let u = 0;
  while (Math.abs(n) >= 1024 && u < UNITS.length - 1) { n /= 1024; u++; }
  return (u === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : digits)) + " " + UNITS[u];
}
const fmtRate = (n) => (n == null ? "—" : fmtBytes(n) + "/s");
const fmtPct = (n) => (n == null ? "—" : (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + "%");

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
}

// Round a byte rate up to a 1/2/5 step in its display unit so the y-axis label stays readable
function niceRateMax(v) {
  v = Math.max(v * 1.15, 64 * 1024);
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => s >= v) || 1024;
  return step * 1024 ** u;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// "#rrggbb" + alpha 0..1 -> "#rrggbbaa"; canvas gradients need this, since "transparent" fades through black
const withAlpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, "0");

// ---------- charts ----------

class Chart {
  constructor(el, { color, percent }) {
    this.wrap = el.querySelector(".chart");
    this.canvas = this.wrap.querySelector("canvas");
    this.scaleEl = this.wrap.querySelector(".scale");
    this.tip = this.wrap.querySelector(".tip");
    this.color = color;
    this.percent = percent;
    this.values = [];
    this.hover = null;

    new ResizeObserver(() => this.draw()).observe(this.wrap);
    this.canvas.addEventListener("pointermove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      const slot = Math.round(((e.clientX - r.left) / r.width) * (HISTORY - 1));
      this.hover = Math.min(HISTORY - 1, Math.max(0, slot));
      this.draw();
    });
    this.canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
  }

  set(values) { this.values = values.slice(-HISTORY); this.draw(); }

  fmt(v) { return this.percent ? fmtPct(v) : fmtRate(v); }

  draw() {
    const { canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const max = this.percent ? 100 : niceRateMax(Math.max(0, ...this.values));
    this.scaleEl.textContent = this.percent ? "100%" : fmtRate(max);

    const pad = 1;
    const x = (i) => (i / (HISTORY - 1)) * w;
    const y = (v) => h - pad - (Math.min(v, max) / max) * (h - pad * 2);

    // recessive grid: dashed quarters + baseline
    ctx.lineWidth = 1;
    ctx.strokeStyle = cssVar("--grid");
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let q = 1; q < 4; q++) {
      const gy = Math.round((h * q) / 4) + 0.5;
      ctx.moveTo(0, gy); ctx.lineTo(w, gy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = cssVar("--baseline");
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();

    // newest sample sits at the right edge
    const off = HISTORY - this.values.length;
    if (this.values.length > 1) {
      const color = cssVar(this.color);
      const pts = this.values.map((v, i) => [x(off + i), y(v)]);
      // smooth line: quadratic curves through the midpoints, which never overshoot the samples
      const trace = () => {
        ctx.moveTo(...pts[0]);
        for (let i = 1; i < pts.length - 1; i++) {
          ctx.quadraticCurveTo(...pts[i], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
        }
        ctx.lineTo(...pts[pts.length - 1]);
      };
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, withAlpha(color, 0.32));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.beginPath();
      trace();
      ctx.lineTo(pts[pts.length - 1][0], h);
      ctx.lineTo(pts[0][0], h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      trace();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();

      // live dot on the newest sample
      if (this.hover == null) {
        const [lx, ly] = pts[pts.length - 1];
        ctx.beginPath();
        ctx.arc(lx - 3, ly, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    // crosshair + tooltip
    const idx = this.hover == null ? -1 : this.hover - off;
    if (idx >= 0 && idx < this.values.length) {
      const hx = Math.round(x(this.hover)) + 0.5, v = this.values[idx];
      ctx.strokeStyle = cssVar("--muted");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke();
      ctx.beginPath();
      ctx.arc(hx, y(v), 4, 0, Math.PI * 2);
      ctx.fillStyle = cssVar(this.color);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = cssVar("--surface");
      ctx.stroke();

      const ago = this.values.length - 1 - idx;
      this.tip.replaceChildren();
      const strong = document.createElement("strong");
      strong.textContent = this.fmt(v);
      const span = document.createElement("span");
      span.textContent = ago ? `${ago}s ago` : "now";
      this.tip.append(strong, span);
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = Math.min(Math.max(0, hx - tw / 2), w - tw) + "px";
      this.scaleEl.style.visibility = "hidden";
    } else {
      this.tip.hidden = true;
      this.scaleEl.style.visibility = "";
    }
  }
}

const METERS = {
  cpu: { color: "--c-cpu", percent: true },
  mem: { color: "--c-mem", percent: true },
  disk_read: { color: "--c-disk-r" },
  disk_write: { color: "--c-disk-w" },
  net_in: { color: "--c-net-in" },
  net_out: { color: "--c-net-out" },
};
const charts = {};
for (const [key, opts] of Object.entries(METERS)) {
  charts[key] = new Chart(document.querySelector(`.meter[data-key="${key}"]`), opts);
}
let history = [];

const $ = (id) => document.getElementById(id);

function renderMeters(tick) {
  for (const key of Object.keys(METERS)) {
    charts[key].set(history.map((m) => m[key]));
    $("v-" + key).textContent = charts[key].fmt(tick.metrics[key]);
  }

  const { host, mem, cpu, disks, ifaces } = tick;
  $("hostname").textContent = host.hostname;
  document.title = `Kongo · ${host.hostname}`;
  $("uptime").textContent = fmtDuration(host.uptime);
  $("load").textContent = host.load.map((l) => l.toFixed(2)).join("  ");

  $("s-cpu").textContent = `${host.cores} cores`;
  const cores = $("cores");
  if (cores.children.length !== cpu.per_core.length) {
    cores.replaceChildren(...cpu.per_core.map(() => {
      const d = document.createElement("div");
      d.className = "core";
      d.append(document.createElement("i"));
      return d;
    }));
  }
  cpu.per_core.forEach((p, i) => {
    const c = cores.children[i];
    c.firstChild.style.width = p + "%";
    c.title = `Core ${i}: ${fmtPct(p)}`;
  });

  $("s-mem").textContent =
    `${fmtBytes(mem.used)} of ${fmtBytes(mem.total)} · Cache ${fmtBytes(mem.cached)} · Swap ${fmtBytes(mem.swap_used)} / ${fmtBytes(mem.swap_total)}`;

  // non-breaking spaces keep each "name value" pair on one line when the text wraps
  const pair = (...parts) => parts.join("\u00a0");
  const names = Object.keys(disks).sort();
  $("s-disk_read").textContent = names.map((n) => pair(n, fmtRate(disks[n].read))).join(" · ");
  $("s-disk_write").textContent = names.map((n) => pair(n, fmtRate(disks[n].write))).join(" · ");

  const nics = Object.keys(ifaces).sort();
  $("s-net_in").textContent = nics.map((n) => `${n} · ${fmtBytes(ifaces[n].rx_total)} total`).join("  ");
  $("s-net_out").textContent = nics.map((n) => `${n} · ${fmtBytes(ifaces[n].tx_total)} total`).join("  ");
}

// ---------- system ----------

const fmtGHz = (mhz) => (mhz / 1000).toFixed(2) + " GHz";
// "31 days, 16 hours ago": the two largest units
function fmtAgo(sec) {
  const parts = [[Math.floor(sec / 86400), "day"], [Math.floor((sec % 86400) / 3600), "hour"], [Math.floor((sec % 3600) / 60), "minute"]];
  const from = parts.findIndex(([n]) => n > 0);
  if (from < 0) return "just now";
  return parts.slice(from, from + 2).filter(([n]) => n > 0).map(([n, u]) => `${n} ${u}${n === 1 ? "" : "s"}`).join(", ") + " ago";
}
const fmtSpeed =(mbit) => (mbit >= 1000 ? mbit / 1000 + " Gbit/s" : mbit + " Mbit/s");

// Line icons for the tiles (24×24, stroked like the meter icons)
const SYS_ICONS = {
  os: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"/>',
  kernel: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5"/>',
  machine: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
  temp: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 17.5v-6"/>',
  mem: '<rect x="2.5" y="7" width="19" height="10" rx="2"/><path d="M7 10.5v3M12 10.5v3M17 10.5v3M6 17v2.5M10 17v2.5M14 17v2.5M18 17v2.5"/>',
  disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  net: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5.5 9.5V20h13V9.5M10 20v-5h4v5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
};

function renderSystem(s) {
  const temp = s.cpu_temp;
  // [label, value, sub, icon, colour token, extra class]; colours follow the meters where a tile matches one
  const tiles = [
    ["Operating system", s.os, s.arch, "os", "--c-net-out"],
    ["Kernel", s.kernel, "", "kernel", "--c-net-out"],
    ["Machine", s.machine || "—", "", "machine", "--c-disk-r"],
    ["Processor", s.cpu_model, [`${s.cores} cores · ${s.threads} threads`, s.cpu_base && `${s.cpu_base} base`].filter(Boolean).join(" · "), "cpu", "--c-cpu"],
    ["CPU temperature", temp ? `${Math.round(temp.current)} °C` : "—",
      [s.cpu_freq && `${fmtGHz(s.cpu_freq)} now`, temp?.high && `high ${Math.round(temp.high)} °C`].filter(Boolean).join(" · "),
      "temp", "--c-net-in", temp?.high && temp.current >= temp.high ? "crit" : ""],
    ["Memory", fmtBytes(s.mem_total), `Swap ${fmtBytes(s.swap_total)}`, "mem", "--c-mem"],
    ["Storage", `${s.disks.length} disks · ${fmtBytes(s.disks.reduce((t, d) => t + d.size, 0))}`,
      s.disks.map((d) => `${d.name} ${fmtBytes(d.size, 0)} ${d.kind}`).join(" · "), "disk", "--c-disk-r"],
    ["Network", s.nics.map((n) => n.speed > 0 ? `${n.name} · ${fmtSpeed(n.speed)}` : n.name).join(", ") || "—", s.nics.map((n) => n.mac).join(", "), "net", "--c-net-in"],
    ["Private IP", s.private_ips.join(", ") || "—", s.gateway ? `Gateway ${s.gateway}` : "", "home", "--c-net-in"],
    ["Public IP", s.public_ip || (s.public_ip_enabled ? "Looking up…" : "Off"), s.public_ip_enabled ? "Checked every 30 min" : "", "globe", "--c-net-out"],
    ["Docker", `${s.containers} containers running`, "", "box", "--c-cpu"],
    ["Booted", new Date(s.boot * 1000).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }), fmtAgo(Date.now() / 1000 - s.boot), "power", "--c-disk-w"],
  ];
  $("sysinfo").innerHTML = tiles.map(([label, value, sub, icon, color, cls]) => `
    <div class="${cls || ""}" style="--series: var(${color})">
      <dt><span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SYS_ICONS[icon]}</svg></span>${esc(label)}</dt>
      <dd title="${esc(value)}">${esc(value)}</dd>
      ${sub ? `<dd class="sub2" title="${esc(sub)}">${esc(sub)}</dd>` : ""}
    </div>`).join("");
}

// ---------- filesystems ----------

// duf's colour thresholds: yellow from 50 %, red from 90 %
const fsLevel = (pct) => (pct >= 90 ? "crit" : pct >= 50 ? "warn" : "ok");

function renderFilesystems(list) {
  const html = [];
  for (const [kind, label] of [["local", "local device"], ["fuse", "fuse device"]]) {
    const rows = list.filter((f) => f.kind === kind);
    if (!rows.length) continue;
    html.push(`<tr class="section"><td colspan="7">${rows.length} ${label}${rows.length > 1 ? "s" : ""}</td></tr>`);
    for (const f of rows) {
      const pct = (f.used / f.size) * 100;
      html.push(`
        <tr>
          <td class="name" title="${esc(f.mount)}">${esc(f.mount)}</td>
          <td class="num">${fmtBytes(f.size)}</td>
          <td class="num">${fmtBytes(f.used)}</td>
          <td class="num">${fmtBytes(f.avail)}</td>
          <td><div class="use ${fsLevel(pct)}"><span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span><span class="num">${pct.toFixed(1)}%</span></div></td>
          <td class="dim">${esc(f.type)}</td>
          <td class="dim" title="${esc(f.device)}">${esc(f.device)}</td>
        </tr>`);
    }
  }
  $("fs-body").innerHTML = html.join("");
}

// ---------- network by container ----------

const NETC_TOP = 6;
let netcAll = false;

function renderContainers(list) {
  const rows = list.slice().sort((a, b) => b.rx_avg + b.tx_avg - (a.rx_avg + a.tx_avg) || a.name.localeCompare(b.name));
  const shown = netcAll ? rows : rows.slice(0, NETC_TOP);
  const cell = (v) => `<td class="num${v >= 1 ? "" : " dim"}">${fmtRate(v)}</td>`;
  $("netc-body").innerHTML = shown.map((c) => `
    <tr>
      <td class="name" title="${esc(c.name)}">${esc(c.name)}</td>
      ${cell(c.rx)}${cell(c.tx)}${cell(c.rx_avg)}${cell(c.tx_avg)}
    </tr>`).join("");
  const toggle = $("netc-toggle");
  toggle.hidden = rows.length <= NETC_TOP;
  toggle.textContent = netcAll ? "Show top " + NETC_TOP : `Show all (${rows.length})`;
}

let lastContainers = [];
$("netc-toggle").addEventListener("click", (e) => {
  netcAll = !netcAll;
  e.currentTarget.setAttribute("aria-expanded", netcAll);
  renderContainers(lastContainers);
});

// ---------- process table ----------

const TEXT_KEYS = new Set(["name", "user", "status"]);
const table = { key: "mem", dir: -1, filter: "", paused: false, selected: null, expanded: new Set(), procs: [], groups: {} };

const sumOrNull = (list, key) => (list.some((p) => p[key] != null) ? list.reduce((s, p) => s + (p[key] ?? 0), 0) : null);

// One row per process name, like Task Manager's app groups; CPU comes from the server's per-name accounting
function buildGroups(procs) {
  const byName = new Map();
  for (const p of procs) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  const exited = Object.entries(table.groups)
    .filter(([name, g]) => !g.live && !byName.has(name))
    .map(([name, g]) => ({
      name, members: [], pid: -1, user: "", cpu: g.cpu, cpu_avg: g.cpu_avg,
      mem: null, read: null, write: null, threads: null, status: "exited", cmd: "",
    }));
  return exited.concat([...byName].map(([name, members]) => {
    const users = [...new Set(members.map((p) => p.user))];
    const g = table.groups[name];
    return {
      name,
      members,
      pid: Math.min(...members.map((p) => p.pid)),
      user: users.join(", "),
      cpu: g ? g.cpu : members.reduce((s, p) => s + p.cpu, 0),
      cpu_avg: g ? g.cpu_avg : members.reduce((s, p) => s + p.cpu_avg, 0),
      mem: members.reduce((s, p) => s + p.mem, 0),
      read: sumOrNull(members, "read"),
      write: sumOrNull(members, "write"),
      threads: members.reduce((s, p) => s + p.threads, 0),
      status: members.some((p) => p.status === "running") ? "running" : members[0].status,
      cmd: members.map((p) => p.cmd).join("\n"),
    };
  }));
}

function compareBy(key, dir) {
  return (a, b) => {
    let av = a[key], bv = b[key];
    if (TEXT_KEYS.has(key)) return dir * String(av).localeCompare(String(bv)) || a.pid - b.pid;
    av = av ?? -1; bv = bv ?? -1;
    return dir * (av - bv) || a.pid - b.pid;
  };
}

function rowHtml(p, { id, cls = "", pidCell, nameCell, title }) {
  return `
    <tr data-id="${esc(id)}" class="${cls}${id === table.selected ? " sel" : ""}">
      <td class="num dim">${pidCell}</td>
      <td class="name" title="${esc(title)}">${nameCell}</td>
      <td>${esc(p.user)}</td>
      <td class="num">${p.cpu.toFixed(1)}%</td>
      <td class="num">${p.cpu_avg.toFixed(1)}%</td>
      <td class="num">${fmtBytes(p.mem)}</td>
      <td class="num${p.read ? "" : " dim"}">${fmtRate(p.read)}</td>
      <td class="num${p.write ? "" : " dim"}">${fmtRate(p.write)}</td>
      <td class="num">${p.threads ?? "—"}</td>
      <td class="dim">${esc(p.status)}</td>
    </tr>`;
}

function renderProcs() {
  const q = table.filter.toLowerCase();
  let groups = buildGroups(table.procs);
  if (q) groups = groups.filter((g) => g.name.toLowerCase().includes(q) || g.user.toLowerCase().includes(q) || g.cmd.toLowerCase().includes(q));

  const { key, dir } = table;
  const cmp = compareBy(key, dir);
  groups.sort(cmp);

  const html = [];
  for (const g of groups) {
    if (!g.members.length) {
      html.push(rowHtml(g, { id: `g:${g.name}`, cls: "exited", pidCell: "", nameCell: esc(g.name), title: "No running process – exited within the last 60 s" }));
      continue;
    }
    if (g.members.length === 1) {
      const p = g.members[0];
      html.push(rowHtml(g, { id: `p:${p.pid}`, pidCell: p.pid, nameCell: esc(p.name), title: p.cmd }));
      continue;
    }
    const open = table.expanded.has(g.name);
    html.push(rowHtml(g, {
      id: `g:${g.name}`,
      cls: "group",
      pidCell: "",
      nameCell: `<span class="caret">${open ? "▾" : "▸"}</span>${esc(g.name)} <span class="count">(${g.members.length})</span>`,
      title: `${g.members.length} processes – click to ${open ? "collapse" : "expand"}`,
    }));
    if (open) {
      for (const p of g.members.slice().sort(cmp)) {
        html.push(rowHtml(p, { id: `p:${p.pid}`, cls: "child", pidCell: p.pid, nameCell: esc(p.name), title: p.cmd }));
      }
    }
  }
  $("proc-body").innerHTML = html.join("");

  $("shown").textContent = q ? `${groups.length} of ${new Set(table.procs.map((p) => p.name)).size}` : "";
  $("proc-count").textContent = table.procs.length;

  document.querySelectorAll("#proc-table thead th").forEach((th) => {
    if (th.dataset.sort === key) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
}

document.querySelector("#proc-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  if (table.key === key) table.dir = -table.dir;
  else { table.key = key; table.dir = TEXT_KEYS.has(key) || key === "pid" ? 1 : -1; }
  renderProcs();
});
$("proc-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const id = tr.dataset.id;
  if (id.startsWith("g:")) {
    const name = id.slice(2);
    if (table.expanded.has(name)) table.expanded.delete(name);
    else table.expanded.add(name);
  }
  table.selected = table.selected === id ? null : id;
  renderProcs();
});
$("search").addEventListener("input", (e) => { table.filter = e.target.value.trim(); renderProcs(); });
$("pause").addEventListener("click", (e) => {
  table.paused = !table.paused;
  e.currentTarget.setAttribute("aria-pressed", table.paused);
  e.currentTarget.textContent = table.paused ? "Resume" : "Pause";
});

// ---------- connection ----------

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  const dot = $("status-dot");
  ws.onopen = () => { dot.classList.add("on"); dot.title = "Live"; };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "init") { history = msg.history; return; }
    history.push(msg.metrics);
    if (history.length > HISTORY) history = history.slice(-HISTORY);
    renderMeters(msg);
    if (msg.system) renderSystem(msg.system);
    if (msg.filesystems) renderFilesystems(msg.filesystems);
    if (msg.containers) { lastContainers = msg.containers; renderContainers(msg.containers); }
    if (msg.procs && !table.paused) { table.procs = msg.procs; table.groups = msg.groups || {}; renderProcs(); }
  };
  ws.onclose = () => {
    dot.classList.remove("on");
    dot.title = "Disconnected – reconnecting…";
    setTimeout(connect, 2000);
  };
}

// ---------- theme ----------

const THEME_KEY = "kongo-theme";
const themeBtn = $("theme-toggle");

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.setAttribute("aria-checked", theme === "dark");
  Object.values(charts).forEach((c) => c.draw());
}
themeBtn.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  applyTheme(theme);
});
// follow the system setting until the user picks a theme with the switch
matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  if (!saved) applyTheme(e.matches ? "light" : "dark");
});
applyTheme(document.documentElement.dataset.theme);

connect();
