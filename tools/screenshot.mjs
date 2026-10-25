// Screenshot the live page with headless Chromium over the DevTools protocol.
// Plain `chromium --screenshot` fires before the WebSocket delivers data, so this waits for real ticks.
//
// usage: node tools/screenshot.mjs [url] [out.png] [width] [height] [dark]
//   node tools/screenshot.mjs http://localhost:8090/ /tmp/desk.png 1400 1000
//   node tools/screenshot.mjs http://localhost:8090/ /tmp/mobile.png 390 900 dark
// KONGO_ANON=1 swaps host name, IPs, MAC, users, mounts and container names for made-up values
// before the page renders them; use it for screenshots that will be published (docs/screenshot.png).
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
      (m.procs || []).forEach((p) => { if (p.user !== "root") p.user = "user"; p.cmd = p.name; });
    }
    return m;
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
  await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 500 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await send("Page.navigate", { url });
  await sleep(6000);

  const state = await send("Runtime.evaluate", {
    expression: "[document.getElementById('hostname').textContent, document.getElementById('v-cpu').textContent, document.querySelectorAll('#proc-body tr').length + ' procs'].join(' | ')",
    returnByValue: true,
  });
  console.log("STATE", state.result.value);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved", out);
} finally {
  chrome.kill();
}
process.exit(0);
