// Screenshot the live page with headless Chromium over the DevTools protocol.
// Plain `chromium --screenshot` fires before the WebSocket delivers data, so this waits for real ticks.
//
// usage: node tools/screenshot.mjs [url] [out.png] [width] [height] [dark]
//   node tools/screenshot.mjs http://localhost:8090/ /tmp/desk.png 1400 1000
//   node tools/screenshot.mjs http://localhost:8090/ /tmp/mobile.png 390 900 dark
// KONGO_ANON=1 swaps host name, IPs, MAC, users, mounts and container names for made-up values
// before the page renders them; use it for screenshots that will be published (docs/screenshot.png).
// KONGO_CLICK=<css selector> clicks that element before the screenshot, e.g. KONGO_CLICK=#updates for the popup;
// separate several with |, e.g. KONGO_CLICK='#updates|[data-action=upgrade]' for the password form.
// A step that starts with js: runs that code instead, e.g. to stage a state: 'js:adminUsers = ["a", "b"]'.
// KONGO_DEMO=updates|restart stages made-up package and container updates (or only a pending restart) in the
// ticks and the API replies, for the README's images. KONGO_CLIP=<css selector> crops to that element.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url = "http://localhost:8090/", out = "kongo.png", w = "1400", h = "1000", dark] = process.argv.slice(2);
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), "kongo-shot-"));
const chrome = spawn("chromium", [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank",
], { stdio: "ignore" });
const anonymize = `(() => {
  const parse = JSON.parse;
  JSON.parse = function (...args) {
    const m = parse.apply(this, args);
    if (m && m.type === "tick") {
      m.host.hostname = "myserver";
      if (m.system) {
        Object.assign(m.system, { public_ip: "203.0.113.42", private_ips: ["192.168.1.20"], gateway: "192.168.1.1" });
        m.system.nics.forEach((n, i) => (n.mac = "02:00:00:00:00:0" + (i + 1)));
      }
      (m.filesystems || []).forEach((f, i) => { if (f.mount !== "/") f.mount = "/mnt/data" + i; });
      (m.containers || []).forEach((c, i) => (c.name = "container-" + (i + 1)));
      // made-up web apps; the cards' host is the page's, so it is swapped in the DOM below
      if (m.apps) m.apps = [["grafana", 3000], ["home-assistant", 8123], ["jellyfin", 8096], ["nextcloud", 8443, "https"],
        ["pihole", 8053], ["portainer", 9443, "https"], ["syncthing", 8384], ["uptime-kuma", 3001]]
        .map(([name, port, scheme = "http"]) => ({ name, web: [{ port, scheme }], update: false }));
      (m.procs || []).forEach((p) => { if (p.user !== "root") p.user = "user"; p.cmd = p.name; });
    }
    return m;
  };
  new MutationObserver(() => document.querySelectorAll(".app-host").forEach((e) => {
    const host = e.textContent.replace(/[^/]+$/, "myserver");
    if (e.textContent !== host) e.textContent = host;
  })).observe(document, { subtree: true, childList: true });
})();`;
// Ubuntu-style apt updates and compose containers; nothing here comes from a real server
const demo = (mode) => `(() => {
  const now = Date.now() / 1000, restart = ${JSON.stringify(mode)} === "restart";
  const pkg = (name, old, nu, source, security = false) => ({ name, old, new: nu, source, security });
  const packages = restart ? [] : [
    pkg("libssl3t64", "3.0.13-0ubuntu3.5", "3.0.13-0ubuntu3.6", "noble-security", true),
    pkg("openssl", "3.0.13-0ubuntu3.5", "3.0.13-0ubuntu3.6", "noble-security", true),
    pkg("curl", "8.5.0-2ubuntu10.6", "8.5.0-2ubuntu10.7", "noble-security", true),
    pkg("libcurl4t64", "8.5.0-2ubuntu10.6", "8.5.0-2ubuntu10.7", "noble-security", true),
    pkg("linux-generic", "6.8.0-85.85", "6.8.0-87.88", "noble-security", true),
    pkg("linux-image-generic", "6.8.0-85.85", "6.8.0-87.88", "noble-security", true),
    pkg("tzdata", "2025b-0ubuntu0.24.04.1", "2025c-0ubuntu0.24.04.1", "noble-updates"),
    pkg("containerd.io", "1.7.28-1~ubuntu.24.04~noble", "1.7.29-1~ubuntu.24.04~noble", "noble"),
    pkg("docker-ce", "5:28.5.1-1~ubuntu.24.04~noble", "5:28.5.2-1~ubuntu.24.04~noble", "noble"),
    pkg("docker-ce-cli", "5:28.5.1-1~ubuntu.24.04~noble", "5:28.5.2-1~ubuntu.24.04~noble", "noble"),
  ];
  const ctr = (name, image, project, service, status) =>
    ({ name, image, project, service, status, dir: "/srv/" + project, files: "/srv/" + project + "/compose.yaml", state: "Up 3 days", web: [], detail: "" });
  const containers = [
    ...(restart ? [] : [
      ctr("nextcloud", "nextcloud:latest", "nextcloud", "app", "pull"),
      ctr("grafana", "grafana/grafana:latest", "monitoring", "grafana", "recreate"),
      ctr("pihole", "pihole/pihole:latest", "pihole", "pihole", "pull"),
    ]),
    ctr("nextcloud-db", "postgres:16", "nextcloud", "db", "ok"),
    ctr("prometheus", "prom/prometheus:latest", "monitoring", "prometheus", "ok"),
  ];
  const reboot = restart ? "linux-image-6.8.0-87-generic, linux-base" : null;
  const images = { containers, registry_checked: now - 240, checked: now };
  const updates = {
    manager: "apt", upgrade: "sudo apt upgrade", packages, lists_updated: now - 420, checked: now, reboot,
    images, actions: true, admin_users: ["admin"],
  };
  const parse = JSON.parse;
  JSON.parse = function (...args) {
    const m = parse.apply(this, args);
    if (m && m.type === "tick") m.updates = {
      count: packages.length, security: packages.filter((p) => p.security).length, reboot: !!reboot,
      containers: containers.filter((c) => c.status === "pull" || c.status === "recreate").length, images: true,
    };
    return m;
  };
  const replies = {
    "/api/updates": updates, "/api/updates/check": updates, "/api/admin/job": null,
    "/api/containers": { ...images, actions: true, admin_users: ["admin"] },
  };
  const realFetch = window.fetch;
  window.fetch = (url, ...rest) => {
    const path = new URL(url, location.href).pathname;
    return path in replies
      ? Promise.resolve(new Response(JSON.stringify(replies[path]), { headers: { "Content-Type": "application/json" } }))
      : realFetch(url, ...rest);
  };
})();`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await sleep(1500);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") console.log("EXCEPTION", JSON.stringify(m.params.exceptionDetails).slice(0, 600));
    if (m.method === "Runtime.consoleAPICalled") console.log("CONSOLE", m.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send("Runtime.enable");
  await send("Page.enable");
  if (process.env.KONGO_ANON) await send("Page.addScriptToEvaluateOnNewDocument", { source: anonymize });
  if (process.env.KONGO_DEMO) await send("Page.addScriptToEvaluateOnNewDocument", { source: demo(process.env.KONGO_DEMO) });
  await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 500 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await send("Page.navigate", { url });
  await sleep(6000);
  for (const sel of (process.env.KONGO_CLICK || "").split("|").filter(Boolean)) {
    const expression = sel.startsWith("js:") ? sel.slice(3) : `document.querySelector(${JSON.stringify(sel)}).click()`;
    await send("Runtime.evaluate", { expression });
    await sleep(1000);
  }

  const state = await send("Runtime.evaluate", {
    expression: "[document.getElementById('hostname').textContent, document.getElementById('v-cpu').textContent, document.querySelectorAll('#proc-body tr').length + ' procs'].join(' | ')",
    returnByValue: true,
  });
  console.log("STATE", state.result.value);
  let clip;
  if (process.env.KONGO_CLIP) {
    const r = await send("Runtime.evaluate", {
      expression: `JSON.stringify(document.querySelector(${JSON.stringify(process.env.KONGO_CLIP)}).getBoundingClientRect())`,
      returnByValue: true,
    });
    // a margin, so the rounded corners and the shadow are part of it
    const b = JSON.parse(r.result.value), m = 20;
    clip = { x: Math.max(0, b.x - m), y: Math.max(0, b.y - m), width: b.width + 2 * m, height: b.height + 2 * m, scale: 1 };
  }
  const shot = await send("Page.captureScreenshot", { format: "png", ...(clip && { clip }) });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved", out);
} finally {
  chrome.kill();
}
process.exit(0);
