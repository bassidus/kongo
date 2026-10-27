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
  mem: '<rect x="2.5" y="7" width="19" height="10" rx="2"/><path d="M7 10.5v3M12 10.5v3M17 10.5v3M6 17v2.5M10 17v2.5M14 17v2.5M18 17v2.5"/>',
  disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  net: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5.5 9.5V20h13V9.5M10 20v-5h4v5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/>',
  gateway: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M11 16.5h.01M17 13V8M14.5 5.5a3.5 3.5 0 0 1 5 0"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
};

function renderSystem(s, upd) {
  const temp = s.cpu_temp;
  // [label, value, sub, icon, colour token, extra class, aside]; colours follow the meters where a row matches one.
  // The aside sits at the right end of the row: the CPU temperature
  const groups = [
    ["Machine", [
      ["Motherboard", s.machine || "—", "", "machine", "--c-disk-r"],
      ["CPU", s.cpu_model,
        [`${s.cores} cores · ${s.threads} threads`, s.cpu_freq && `${fmtGHz(s.cpu_freq)} now`, s.cpu_base && `${s.cpu_base} base`].filter(Boolean).join(" · "),
        "cpu", "--c-cpu", temp?.high && temp.current >= temp.high ? "crit" : "",
        temp && { text: `${Math.round(temp.current)} °C`, title: temp.high ? `CPU temperature · high ${Math.round(temp.high)} °C` : "CPU temperature" }],
      ["RAM", fmtBytes(s.mem_total), `Swap ${fmtBytes(s.swap_total)}`, "mem", "--c-mem"],
      ["Storage", `${s.disks.length} disks · ${fmtBytes(s.disks.reduce((t, d) => t + d.size, 0))}`,
        s.disks.map((d) => `${d.name} ${fmtBytes(d.size, 0)} ${d.kind}`).join(" · "), "disk", "--c-disk-r"],
    ]],
    ["Network", [
      ["NIC", s.nics.map((n) => n.speed > 0 ? `${n.name} · ${fmtSpeed(n.speed)}` : n.name).join(", ") || "—", s.nics.map((n) => n.mac).join(", "), "net", "--c-net-in"],
      ["Public IP", s.public_ip || (s.public_ip_enabled ? "Looking up…" : "Off"), s.public_ip_enabled ? "Checked every 30 min" : "", "globe", "--c-net-out"],
      ["Private IP", s.private_ips.join(", ") || "—", "", "home", "--c-net-in"],
      ["Gateway", s.gateway || "—", "", "gateway", "--c-net-in"],
    ]],
    ["Software", [
      ["OS", s.os, s.arch, "os", "--c-net-out"],
      ["Kernel", s.kernel, "", "kernel", "--c-net-out"],
      // clickable when the container check runs: it opens the list of containers
      ["Docker", `${s.containers} containers running`,
        upd?.images ? (upd.containers ? `${upd.containers} update${upd.containers === 1 ? "" : "s"} available` : "All images up to date") : "",
        "box", "--c-cpu", upd?.images ? "clickable" + (upd.containers ? " warn" : "") : ""],
    ]],
  ];
  const row = ([label, value, sub, icon, color, cls, aside]) => `
    <div class="${cls || ""}" style="--series: var(${color})" data-tile="${icon}"${cls?.includes("clickable") ? ' role="button" tabindex="0"' : ""}>
      <dt><span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SYS_ICONS[icon]}</svg></span>${esc(label)}</dt>
      <dd title="${esc(value)}">${esc(value)}</dd>
      ${aside ? `<dd class="aside" title="${esc(aside.title)}">${esc(aside.text)}</dd>` : ""}
      ${sub ? `<dd class="sub2" title="${esc(sub)}">${esc(sub)}</dd>` : ""}
    </div>`;
  $("sysinfo").innerHTML = groups.map(([title, rows]) => `
    <section class="sysgroup" aria-label="${title}">
      <h3>${title}</h3>
      <dl>${rows.map(row).join("")}</dl>
    </section>`).join("");
}

// ---------- package updates ----------

const updatesBtn = $("updates");
const updatesDlg = $("updates-dialog");
let updatesKey = "";

function renderUpdatesBadge(u) {
  const ctr = u?.containers || 0;
  updatesBtn.hidden = !u || (!u.count && !ctr && !u.reboot);
  if (updatesBtn.hidden) return;
  const s = (n) => (n === 1 ? "" : "s");
  const parts = [];
  if (u.count) parts.push(`${u.count} update${s(u.count)}`);
  if (u.security) parts.push(`${u.security} security`);
  if (ctr) parts.push(u.count ? `${ctr} container${s(ctr)}` : `${ctr} container update${s(ctr)}`);
  $("updates-text").textContent = (parts.length ? parts : ["Restart required"]).join(" · ");
  updatesBtn.classList.toggle("crit", u.security > 0);
  const what = ctr ? "click to see the updates" : "click to see the packages";
  updatesBtn.title = !u.count && !ctr ? "A recent update requires a restart"
    : u.reboot ? `A recent update requires a restart · ${what}` : what[0].toUpperCase() + what.slice(1);
  // the server's list changed while the popup is open: fetch it again
  const key = `${u.count}/${u.security}/${u.reboot}/${ctr}`;
  if (updatesDlg.open && key !== updatesKey) loadUpdates();
  updatesKey = key;
}

// u: a list the caller already has (from /api/updates/check); otherwise fetch the current one
async function loadUpdates(u) {
  const seq = ++loadSeq;
  if (!u) {
    try { u = await (await fetch("/api/updates")).json(); } catch {}
    // a slower, older reply must not overwrite a newer list
    if (seq !== loadSeq) return;
  }
  const body = $("updates-body");
  if (!u) {
    $("updates-note").textContent = "";
    body.innerHTML = `<tr><td colspan="4" class="dim">Could not load the list.</td></tr>`;
    return;
  }
  const n = u.packages.length, sec = u.packages.filter((p) => p.security).length;
  const ctrs = (u.images?.containers || []).filter((c) => c.status in CTR_STATUS);
  const ctrPending = ctrs.filter((c) => c.status !== "error").length;
  $("updates-note").textContent = [
    `${n} package${n === 1 ? "" : "s"}`,
    sec && `${sec} security`,
    ctrPending && `${ctrPending} container${ctrPending === 1 ? "" : "s"}`,
    u.manager,
    checking ? "checking for new updates…" : u.lists_updated && `lists updated ${fmtAgo(Date.now() / 1000 - u.lists_updated)}`,
  ].filter(Boolean).join(" · ");
  const hint = $("updates-hint");
  hint.innerHTML = u.actions ? "" : "Install the updates on the server with <code></code>.";
  if (!u.actions) hint.querySelector("code").textContent = u.upgrade;
  adminEnabled = u.actions;
  adminUsers = u.admin_users || [];
  updatesCount = n;
  updatesReboot = u.reboot;
  updatesChecked = u.checked;
  imagesChecked = u.images?.checked ?? Infinity;
  $("admin-actions").hidden = !u.actions || !$("admin-form").hidden;
  $("admin-actions").querySelector('[data-action="restart"]').classList.toggle("attn", !!u.reboot);
  if (u.actions) pollJob();
  const reboot = $("updates-reboot");
  if (!restarting) {
    reboot.hidden = !u.reboot && !restartedBack;
    reboot.className = "dialog-note" + (u.reboot ? "" : " good");
    reboot.textContent = u.reboot ? `Restart required – ${u.reboot}` : "The server has restarted and is back.";
  }
  body.innerHTML = n ? u.packages.map((p) => `
    <tr>
      <td class="name" title="${esc(p.name)}">${esc(p.name)}${p.security ? ' <span class="tag">security</span>' : ""}</td>
      <td class="dim" title="${esc(p.old)}">${esc(p.old)}</td>
      <td title="${esc(p.new)}">${esc(p.new)}</td>
      <td class="dim" title="${esc(p.source)}">${esc(p.source) || "—"}</td>
    </tr>`).join("") : `<tr><td colspan="4" class="dim">${ctrs.length ? "No package updates." : "Everything is up to date."}</td></tr>`;
  renderContainerUpdates(u.images, u.actions);
}

// Show the list at once, then ask the server for fresh lists and a new check, so a restart doesn't miss updates
async function checkUpdates() {
  checking = true;
  loadUpdates();
  let u = null;
  try {
    const r = await fetch("/api/updates/check", { method: "POST" });
    if (r.ok) u = await r.json();
  } catch {}
  checking = false;
  loadUpdates(u);
}

const CTR_STATUS = {
  pull: ["Newer image available", "The registry has a newer image for this tag"],
  recreate: ["Newer image pulled – recreate", "A newer image is already pulled, but the container still runs the old one"],
  error: ["Could not check", ""],
};

function renderContainerUpdates(images, actions) {
  const list = (images?.containers || []).filter((c) => c.status in CTR_STATUS);
  $("ctr-section").hidden = !list.length;
  if (!list.length) return;
  const byHand = list.filter((c) => c.status !== "error" && !updatable(c)).length;
  $("ctr-hint").innerHTML = !actions
    ? "Update a container with <code>docker compose pull &amp;&amp; docker compose up -d</code> in its project's folder."
    : byHand ? `${byHand} of them ${byHand === 1 ? "was" : "were"} not started with docker compose, so update ${byHand === 1 ? "it" : "them"} by hand.` : "";
  $("ctr-note").textContent = images.registry_checked ? `registries checked ${fmtAgo(Date.now() / 1000 - images.registry_checked)}` : "";
  $("ctr-body").innerHTML = list.map((c) => {
    const [label, title] = CTR_STATUS[c.status];
    return `
    <tr class="${c.status === "error" ? "dim-row" : ""}">
      <td class="name" title="${esc(c.name)}">${esc(c.name)}</td>
      <td class="dim" title="${esc(c.image)}">${esc(c.image)}</td>
      <td title="${esc(c.detail ? "Could not check: " + c.detail : title)}">${esc(label)}</td>
      <td class="dim" title="${esc(c.dir)}">${esc(c.project) || "—"}</td>
      <td class="act">${actions && updatable(c) ? `<button class="btn small" type="button" data-update="${esc(c.name)}">Update</button>` : ""}</td>
    </tr>`;
  }).join("");
}

$("ctr-body").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-update]");
  if (!b || b.disabled) return;
  adminTarget = b.dataset.update;
  openAdminForm("containers");
});

updatesBtn.addEventListener("click", () => {
  jobView = false;
  mountAdmin(updatesDlg);
  checkUpdates();
  updatesDlg.showModal();
});
// a click on the backdrop lands on the dialog element itself
updatesDlg.addEventListener("click", (e) => { if (e.target === updatesDlg && !restarting) updatesDlg.close(); });
// While the server restarts the popup stays open: Esc is refused, and if the browser closes it anyway it comes back
updatesDlg.addEventListener("cancel", (e) => { if (restarting) e.preventDefault(); });
updatesDlg.addEventListener("close", () => {
  if (restarting) { updatesDlg.showModal(); return; }
  clearTimeout(jobTimer);
  closeAdminForm();
  restartedBack = false;
});

// ---------- install updates / restart (behind a Linux admin's password) ----------

const ADMIN_ACTIONS = {
  upgrade: { title: "Install the updates as", submit: "Install" },
  restart: { title: "Restart the server as", submit: "Restart" },
  containers: { title: "Update the containers as", submit: "Update" },
};
const JOB_TEXT = {
  packages: { title: "Install updates", running: "Installing updates…", done: "Updates installed", failed: "Installing failed", end: "Done – the updates are installed." },
  containers: { title: "Update containers", running: "Updating containers…", done: "Containers updated", failed: "Updating failed", end: "Done – the containers are updated." },
};

// The password form and the job's log are shared by both popups: they move into the one that is open
// adminTarget: the container whose Update button was clicked; null = Update all
let activeDlg = null, lastJobKind = "packages", adminTarget = null;
function mountAdmin(dlg) {
  activeDlg = dlg;
  dlg.querySelector(".job-slot").append($("job"));
  dlg.querySelector(".dialog-foot").append($("admin-form"));
}
const dlgActions = () => activeDlg.querySelector(".admin-actions");
const reloadActive = () => (activeDlg === dockerDlg ? loadContainers() : loadUpdates());
// jobView: the popup shows only the Install run's output, from the click until "Back to the list"
let adminEnabled = false, adminAction = null, jobTimer = null, restarting = false, jobView = false;
// restartAt: when Restart was confirmed; restartedBack: the server came back while the popup was open
let restartAt = 0, restartedBack = false, restartTimer = null;
// imagesChecked: when the containers in the updates popup were checked (Infinity without Docker)
let updatesCount = 0, updatesReboot = null, updatesChecked = 0, imagesChecked = Infinity, checking = false, loadSeq = 0;
// the users on the server who may do this; with just one, only the password is asked for
let adminUsers = [];
const ADMIN_USER_KEY = "kongo-admin-user";

function openAdminForm(action) {
  adminAction = action;
  const sole = adminUsers.length === 1;
  const title = action !== "containers" ? ADMIN_ACTIONS[action].title
    : adminTarget ? `Update ${adminTarget} as` : `Update ${dockerPending.length === 1 ? "the container" : `all ${dockerPending.length} containers`} as`;
  $("admin-title").textContent = title + (sole ? " " + adminUsers[0] : "");
  const user = $("admin-user");
  let last = null;
  try { last = localStorage.getItem(ADMIN_USER_KEY); } catch {}
  user.replaceChildren(...adminUsers.map((name) => new Option(name, name)));
  user.value = adminUsers.includes(last) ? last : adminUsers[0];
  user.hidden = sole;
  $("admin-submit").textContent = ADMIN_ACTIONS[action].submit;
  $("admin-error").textContent = "";
  $("admin-password").value = "";
  dlgActions().hidden = true;
  $("admin-form").hidden = false;
  $("admin-password").focus();
}

function closeAdminForm() {
  $("admin-form").hidden = true;
  $("admin-password").value = "";
  if (activeDlg) dlgActions().hidden = !adminEnabled;
}

for (const actions of document.querySelectorAll(".admin-actions")) {
  actions.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-action]");
    if (!b || b.disabled) return;
    if (b.dataset.action === "list") { jobView = false; reloadActive(); }
    else { adminTarget = null; openAdminForm(b.dataset.action); }
  });
}
$("admin-cancel").addEventListener("click", closeAdminForm);
$("admin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("admin-submit");
  submit.disabled = true;
  $("admin-error").textContent = "";
  try {
    const r = await fetch(`/api/admin/${adminAction}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: $("admin-user").value,
        password: $("admin-password").value,
        // the containers the popup shows, so nothing the user didn't see gets recreated
        ...(adminAction === "containers" ? { names: adminTarget ? [adminTarget] : dockerPending } : {}),
      }),
    });
    if (!r.ok) {
      $("admin-error").textContent = (await r.json().catch(() => ({}))).detail || `Failed (${r.status})`;
      $("admin-password").select();
      return;
    }
    const action = adminAction;
    try { localStorage.setItem(ADMIN_USER_KEY, $("admin-user").value); } catch {}
    closeAdminForm();
    if (action === "upgrade" || action === "containers") { jobView = true; pollJob(); }
    else startRestartView();
  } catch {
    $("admin-error").textContent = "Could not reach Kongo.";
  } finally {
    submit.disabled = false;
  }
});

// ---------- restart: the popup shows only its progress, and stays until the server is back ----------

function setRestartNote(text, cls = "info") {
  const note = $("updates-reboot");
  note.hidden = false;
  note.className = "dialog-note " + cls;
  note.textContent = text;
}

function startRestartView() {
  restarting = true;
  restartAt = Date.now() / 1000;
  jobView = false;
  clearTimeout(jobTimer);
  updatesDlg.classList.remove("job-mode");
  updatesDlg.classList.add("restart-mode");
  $("updates-title").textContent = "Restart the server";
  setRestartNote("Restarting the server… The page reconnects when it is back.");
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!restarting) return;
    endRestartView();
    setRestartNote("The server has not come back after 10 minutes. It may need a look.", "");
  }, 600000);
}

function endRestartView() {
  restarting = false;
  clearTimeout(restartTimer);
  updatesDlg.classList.remove("restart-mode");
  $("updates-title").textContent = "Available updates";
}

// from the WebSocket: the connection dropped, or a tick arrived
function restartDisconnected() {
  if (restarting) setRestartNote("The server is shutting down… waiting for it to come back.");
}
function restartTick(host) {
  // back = it has been up for less time than since the click, so it really restarted
  if (!restarting || host.uptime >= Date.now() / 1000 - restartAt) return;
  endRestartView();
  restartedBack = true;
  setRestartNote("The server has restarted and is back.", "good");
  checkUpdates();
}

async function pollJob() {
  let j;
  try { j = await (await fetch("/api/admin/job")).json(); } catch { j = undefined; }
  const wait = renderJob(j);
  clearTimeout(jobTimer);
  if (!activeDlg?.open) return;
  // undefined = Kongo is down for a moment, as when Docker itself is updated
  if (j === undefined || wait === "job") jobTimer = setTimeout(pollJob, 2000);
  // the job view doesn't show the list; "Back to the list" loads it
  else if (wait === "list" && !jobView) jobTimer = setTimeout(reloadActive, 2000);
}

// The log follows its end until the user scrolls up. A flag rather than the scroll position, because the browser
// resets that when the log is hidden or moved to the other popup
let logFollow = true, logStarted = null;
$("job-log").addEventListener("scroll", (e) => {
  const pre = e.target;
  logFollow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
});

// What to wait for: "job" while it runs, "list" until the server has rechecked the list after it
function renderJob(j) {
  const box = $("job");
  if (j === undefined) {
    if (jobView) $("job-state").textContent = `${JOB_TEXT[lastJobKind].running} (Kongo is restarting, waiting for it)`;
    return "job";
  }
  const text = JOB_TEXT[(lastJobKind = j?.kind || lastJobKind)];
  const docker = activeDlg === dockerDlg;
  const running = j?.state === "running";
  // settled once the list the run changed has been checked again: a container run leaves the packages alone
  const checkedAfter = docker ? containersChecked : j?.kind === "containers" ? imagesChecked : updatesChecked;
  const settling = j?.state === "done" && checkedAfter < j.finished;
  if (running) jobView = true;
  activeDlg.classList.toggle("job-mode", jobView);
  const h2 = activeDlg.querySelector(".toolbar h2");
  h2.textContent = jobView ? text.title : h2.dataset.title;
  const hint = activeDlg.querySelector(".dialog-foot p");
  // the end of a run is said down here too: the status line above the log is out of sight after a long run
  const ended = jobView && j && !running;
  hint.classList.toggle("done", ended && j.state === "done");
  hint.classList.toggle("failed", ended && j.state !== "done");
  if (jobView) hint.textContent = running ? "It runs on the server, so you can close this window and come back."
    : !j ? ""
    : j.state === "done" ? text.end + (lastJobKind === "packages" && updatesReboot ? " Restart the server to finish." : "")
    : `${text.failed} (exit code ${j.exit}) – the log above says why.`;
  else if (adminEnabled) hint.textContent = settling ? "Checking what is left after the run…" : docker ? dockerHint : "";
  const nothing = { upgrade: !updatesCount && "Nothing to install", containers: !dockerPending.length && "Nothing to update" };
  for (const b of dlgActions().querySelectorAll("button")) {
    const a = b.dataset.action;
    const main = a === "upgrade" || a === "containers";
    b.hidden = jobView ? running || main : a === "list";
    b.disabled = !jobView && (running || settling || (!docker && checking) || !!nothing[a]);
    if (main) b.title = b.disabled && !running && !settling ? nothing[a] || "" : "";
  }
  // the per-container Update buttons in both popups
  for (const b of document.querySelectorAll("#docker-body button[data-update], #ctr-body button[data-update]")) b.disabled = running || settling || (!docker && checking);
  const wait = running ? "job" : settling ? "list" : null;
  const shown = !box.hidden;
  box.hidden = !jobView || !j;
  if (box.hidden) return wait;
  // a new run, or the log just came into view: follow its end again
  if (!shown || j.started !== logStarted) { logFollow = true; logStarted = j.started; }
  box.className = "job " + j.state;
  $("job-state").textContent = running ? text.running : j.state === "done" ? text.done : `${text.failed} (exit code ${j.exit})`;
  $("job-time").textContent = j.started ? "started " + new Date(j.started * 1000).toLocaleTimeString("sv-SE", { timeStyle: "short" }) : "";
  const pre = $("job-log");
  pre.textContent = j.log.join("\n") || "Starting…";
  if (logFollow) pre.scrollTop = pre.scrollHeight;
  return wait;
}

// ---------- docker containers (the Docker row) ----------

const dockerDlg = $("docker-dialog");
// [label, title, cell class]; the ones that need something are worded as in the updates popup
const DOCKER_STATUS = {
  pull: [...CTR_STATUS.pull, "attn"],
  recreate: [...CTR_STATUS.recreate, "attn"],
  error: [...CTR_STATUS.error, "dim"],
  ok: ["Up to date", "The registry has no newer image for this tag", "dim"],
  local: ["Built locally", "Built on this server, so there is no registry to ask", "dim"],
  pinned: ["Pinned to a digest", "The image is pinned to a digest, so there is no tag to follow", "dim"],
};
let dockerKey = "", dockerHint = "", dockerPending = [], containersChecked = 0;
// a container's web UI on this server, by the name the page was opened with
const webUrl = (w) => `${w.scheme}://${location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname}:${w.port}/`;
// as images.updatable() on the server: only compose containers can be recreated as they were
const updatable = (c) => (c.status === "pull" || c.status === "recreate") && c.project && c.dir && c.service;

async function loadContainers() {
  let d = null;
  try { d = await (await fetch("/api/containers")).json(); } catch {}
  const body = $("docker-body");
  if (!d) {
    $("docker-note").textContent = "";
    body.innerHTML = `<tr><td colspan="6" class="dim">Could not load the containers.</td></tr>`;
    return;
  }
  const pending = d.containers.filter((c) => c.status === "pull" || c.status === "recreate").length;
  $("docker-note").textContent = [
    `${d.containers.length} running`,
    pending && `${pending} update${pending === 1 ? "" : "s"}`,
    d.registry_checked && `registries checked ${fmtAgo(Date.now() / 1000 - d.registry_checked)}`,
  ].filter(Boolean).join(" · ");
  adminEnabled = d.actions;
  adminUsers = d.admin_users || [];
  containersChecked = d.checked;
  dockerPending = d.containers.filter(updatable).map((c) => c.name);
  const byHand = pending - dockerPending.length;
  dockerHint = byHand ? `${byHand} of them ${byHand === 1 ? "was" : "were"} not started with docker compose, so update ${byHand === 1 ? "it" : "them"} by hand.` : "";
  const hint = $("docker-hint");
  if (d.actions) hint.textContent = dockerHint;
  else hint.innerHTML = "Update a container with <code>docker compose pull &amp;&amp; docker compose up -d</code> in its project's folder.";
  $("docker-actions").hidden = !d.actions || (activeDlg === dockerDlg && !$("admin-form").hidden);
  body.innerHTML = d.containers.map((c) => {
    const [label, title, cls] = DOCKER_STATUS[c.status];
    return `
    <tr>
      <td class="name" title="${esc(c.name + (c.state ? " · " + c.state : ""))}">${esc(c.name)}</td>
      <td class="dim" title="${esc(c.image)}">${esc(c.image)}</td>
      <td class="${cls}" title="${esc(c.detail ? "Could not check: " + c.detail : title + (cls === "attn" && !updatable(c) ? " – not from docker compose, update it by hand" : ""))}">${esc(label)}</td>
      <td class="dim" title="${esc(c.dir)}">${esc(c.project) || "—"}</td>
      <td class="web">${c.web.map((w) => `<a class="btn small" href="${esc(webUrl(w))}" target="_blank" rel="noopener noreferrer" title="${esc(webUrl(w))}">${c.web.length > 1 ? w.port : "Open"} ↗</a>`).join("")}</td>
      <td class="act">${d.actions && updatable(c) ? `<button class="btn small" type="button" data-update="${esc(c.name)}">Update</button>` : ""}</td>
    </tr>`;
  }).join("");
  // after the rows exist, so a running job can disable their buttons
  if (d.actions) pollJob();
}

$("docker-body").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-update]");
  if (!b || b.disabled) return;
  adminTarget = b.dataset.update;
  openAdminForm("containers");
});

function openContainers() {
  jobView = false;
  mountAdmin(dockerDlg);
  loadContainers();
  dockerDlg.showModal();
}

$("sysinfo").addEventListener("click", (e) => {
  if (e.target.closest('[data-tile="box"].clickable')) openContainers();
});
$("sysinfo").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches('[data-tile="box"].clickable')) {
    e.preventDefault();
    openContainers();
  }
});
dockerDlg.addEventListener("click", (e) => { if (e.target === dockerDlg) dockerDlg.close(); });
dockerDlg.addEventListener("close", () => { clearTimeout(jobTimer); closeAdminForm(); });

// the list changed while the popup is open: fetch it again
function refreshContainers(s, upd) {
  const key = `${s?.containers}/${upd?.containers}`;
  if (dockerDlg.open && key !== dockerKey) loadContainers();
  dockerKey = key;
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

// Kongo's version when the page loaded; a reconnect to another version (Kongo was updated) reloads the page,
// once no popup is open, so a running job's log or the restart view isn't cut off
let pageVersion = null, reloadPending = false;
function reloadIfNew(version) {
  pageVersion ??= version;
  if (version === pageVersion) return;
  reloadPending = true;
  if (!document.querySelector("dialog[open]")) location.reload();
}
for (const dlg of document.querySelectorAll("dialog")) {
  dlg.addEventListener("close", () => { if (reloadPending && !document.querySelector("dialog[open]")) location.reload(); });
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  const dot = $("status-dot");
  ws.onopen = () => { dot.classList.add("on"); dot.title = "Live"; };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "init") { history = msg.history; reloadIfNew(msg.version); return; }
    history.push(msg.metrics);
    if (history.length > HISTORY) history = history.slice(-HISTORY);
    renderMeters(msg);
    restartTick(msg.host);
    if (msg.system) { renderSystem(msg.system, msg.updates); refreshContainers(msg.system, msg.updates); }
    renderUpdatesBadge(msg.updates);
    if (msg.filesystems) renderFilesystems(msg.filesystems);
    if (msg.containers) { lastContainers = msg.containers; renderContainers(msg.containers); }
    if (msg.procs && !table.paused) { table.procs = msg.procs; table.groups = msg.groups || {}; renderProcs(); }
  };
  ws.onclose = () => {
    restartDisconnected();
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
