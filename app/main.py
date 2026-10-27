"""Kongo - live system stats for the host, pushed to the browser over a WebSocket."""

import asyncio
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import socket
import time
import urllib.request
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import psutil
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import admin, images, updates

INTERVAL = 1.0
HISTORY = 60
STATIC_DIR = Path(__file__).parent / "static"
# Changes with every new page: it busts the browser's cache of app.js and style.css, and an open page that
# reconnects to a Kongo with another version reloads itself instead of running the old code
VERSION = hashlib.sha256(b"".join((STATIC_DIR / f).read_bytes() for f in ("index.html", "app.js", "style.css"))).hexdigest()[:12]

# Whole disks only; partitions (sda1) and loop/ram devices would double count
DISK_RE = re.compile(r"^(sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$")

# Docker's per-container config, mounted read-only, maps a cgroup's container id to its name
DOCKER_DIR = Path(os.environ.get("DOCKER_CONTAINERS_DIR", "/host/docker-containers"))
CGROUP_ID_RE = re.compile(r"docker-([0-9a-f]{64})\.scope|/docker/([0-9a-f]{64})")
NETNS_RESCAN = 10.0
FS_RESCAN = 10.0
# Host mounts as duf lists them: block devices and FUSE, minus boot/snap internals
FS_SKIP_RE = re.compile(r"^/(boot|snap)(/|$)")
# Fetched server-side for the System panel; set PUBLIC_IP_URL= (empty) to turn it off
PUBLIC_IP_URL = os.environ.get("PUBLIC_IP_URL", "https://api.ipify.org")
PUBLIC_IP_REFRESH = 1800.0
# Package updates (app/updates.py): rechecked when the package database or repository lists change
UPDATES_POLL = 60.0
UPDATES_RETRY = 600.0
# While Install updates runs: the list would be half done, so wait and check as soon as it ends
UPDATES_BUSY_POLL = 5.0
# Opening the popup refreshes the lists first, unless they are younger than this
UPDATES_ON_OPEN = 600.0
UPDATES_MGR = updates.detect("/proc/1/root")


def read_text(path: str | Path) -> str:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


# What firmware writes into DMI fields it didn't fill in; such a field counts as empty
DMI_PLACEHOLDER_RE = re.compile(
    r"^(system (manufacturer|product name|version)|to be filled by o\.?e\.?m\.?|default string|o\.?e\.?m\.?|"
    r"not (applicable|specified|available)|none|unknown|type1productconfigid|x\.x+)$", re.I)
# Long company names, so the Machine tile fits: "ASUSTeK COMPUTER INC." -> "ASUS"
VENDOR_NAMES = {"asustek": "ASUS", "micro-star": "MSI", "hewlett-packard": "HP", "gigabyte": "Gigabyte", "lenovo": "Lenovo"}
VENDOR_SUFFIX_RE = re.compile(r"[,.]?\s+(inc|corp(oration)?|co|ltd|llc|gmbh|computer|technology|international)\b\.?", re.I)


def dmi(name: str) -> str:
    value = read_text(f"/sys/class/dmi/id/{name}")
    return "" if DMI_PLACEHOLDER_RE.match(value) else value


def short_vendor(vendor: str) -> str:
    for key, short in VENDOR_NAMES.items():
        if vendor.lower().startswith(key):
            return short
    return VENDOR_SUFFIX_RE.split(vendor, 1)[0].strip(" ,.") or vendor


def physical_ifaces() -> list[str]:
    wanted = [i.strip() for i in os.environ.get("NET_IFACES", "").split(",") if i.strip()]
    if wanted:
        return wanted
    # Physical NICs have a backing device; bridges, veth and lo do not
    return sorted(
        p.name for p in Path("/sys/class/net").iterdir() if (p / "device").exists()
    )


class Sampler:
    def __init__(self) -> None:
        self.ncpu = psutil.cpu_count() or 1
        self.ifaces = physical_ifaces()
        self.history: deque[dict] = deque(maxlen=HISTORY)
        self.latest: dict | None = None
        self.clients: set[WebSocket] = set()

        self._last_t = time.monotonic()
        self._last_disk = self._disk_counters()
        self._last_net = self._net_counters()
        self._procs: dict[int, psutil.Process] = {}
        self._proc_io: dict[int, tuple[int, int]] = {}
        # (time, cumulative cpu seconds) per pid, covering the last HISTORY seconds
        self._proc_cpu: dict[int, deque[tuple[float, float]]] = {}
        # Per-name accounting so a group keeps the CPU time of members that have exited
        self._pid_used: dict[int, tuple[str, float]] = {}
        self._group_dead: dict[str, float] = {}
        self._group_cpu: dict[str, deque[tuple[float, float]]] = {}
        self._group_seen: dict[str, float] = {}
        self._users: dict[int, str] = {}
        self._proc_t = time.monotonic()
        self.want_procs_until = 0.0
        self._host_netns = os.readlink("/proc/1/ns/net")
        self._netns: dict[str, dict] = {}
        self._netns_t = 0.0
        self._netns_hist: dict[str, deque[tuple[float, int, int]]] = {}
        self._container_names: dict[str, str] = {}
        self._fs: list[dict] = []
        self._fs_t = 0.0
        self._sys_static = self._static_info()
        self._sys_slow: dict = {}
        self._sys_t = 0.0
        self.public_ip: str | None = None
        self.updates: dict | None = None
        self.images: dict | None = None
        psutil.cpu_percent(percpu=True)

    @staticmethod
    def _disk_counters() -> dict[str, tuple[int, int]]:
        counters = psutil.disk_io_counters(perdisk=True) or {}
        return {
            name: (c.read_bytes, c.write_bytes)
            for name, c in counters.items()
            if DISK_RE.match(name)
        }

    def _net_counters(self) -> dict[str, tuple[int, int]]:
        counters = psutil.net_io_counters(pernic=True)
        return {
            name: (counters[name].bytes_recv, counters[name].bytes_sent)
            for name in self.ifaces
            if name in counters
        }

    def _username(self, uid: int) -> str:
        if uid not in self._users:
            try:
                import pwd

                self._users[uid] = pwd.getpwuid(uid).pw_name
            except KeyError:
                self._users[uid] = str(uid)
        return self._users[uid]

    def _container_name(self, cid: str) -> str:
        if cid not in self._container_names:
            try:
                cfg = json.loads((DOCKER_DIR / cid / "config.v2.json").read_text())
                self._container_names[cid] = cfg["Name"].lstrip("/")
            except (OSError, ValueError, KeyError):
                self._container_names[cid] = cid[:12]
        return self._container_names[cid]

    def _scan_netns(self) -> None:
        # Group processes by network namespace; the host's own namespace is the NIC meters
        found: dict[str, dict] = {}
        for pid in psutil.pids():
            try:
                ns = os.readlink(f"/proc/{pid}/ns/net")
                if ns == self._host_netns:
                    continue
                cgroup = Path(f"/proc/{pid}/cgroup").read_text()
            except OSError:
                continue
            m = CGROUP_ID_RE.search(cgroup)
            if ns not in found:
                found[ns] = {"pid": pid, "containers": set(), "label": self._ns_label(pid, cgroup)}
            if m:
                found[ns]["containers"].add(self._container_name(m.group(1) or m.group(2)))
        # Several containers can share one namespace (an app routed through a VPN container)
        self._netns = {
            ns: {"pid": e["pid"], "name": " + ".join(sorted(e["containers"])) or e["label"]}
            for ns, e in found.items()
        }
        for ns in list(self._netns_hist):
            if ns not in self._netns:
                del self._netns_hist[ns]

    def _ns_label(self, pid: int, cgroup: str) -> str:
        # Not a Docker container (e.g. rootless Docker's rootlesskit): name it by systemd unit and owner
        unit = cgroup.strip().rsplit("/", 1)[-1]
        try:
            proc = psutil.Process(pid)
            name = unit if unit.endswith(".service") else proc.name()
            uid = proc.uids().real
        except psutil.Error:
            return unit
        return f"{name} ({self._username(uid)})" if uid else name

    @staticmethod
    def _read_netdev(pid: int) -> tuple[int, int]:
        rx = tx = 0
        ifaces = []
        for line in Path(f"/proc/{pid}/net/dev").read_text().splitlines()[2:]:
            name, data = line.split(":", 1)
            fields = data.split()
            ifaces.append((name.strip(), int(fields[0]), int(fields[8])))
        # eth* is the container's end of its veth; tun0/wg0 inside it would count VPN traffic twice
        eth = [i for i in ifaces if i[0].startswith("eth")] or [i for i in ifaces if i[0] != "lo"]
        for _, r, t in eth:
            rx += r
            tx += t
        return rx, tx

    def _container_net(self) -> list[dict]:
        now = time.monotonic()
        if now - self._netns_t > NETNS_RESCAN:
            self._scan_netns()
            self._netns_t = now
        rows = []
        for ns, info in self._netns.items():
            try:
                rx, tx = self._read_netdev(info["pid"])
            except (OSError, ValueError, IndexError):
                self._netns_t = 0.0
                continue
            hist = self._netns_hist.setdefault(ns, deque())
            hist.append((now, rx, tx))
            while now - hist[0][0] > HISTORY:
                hist.popleft()
            row = {"name": info["name"], "rx": 0.0, "tx": 0.0, "rx_avg": 0.0, "tx_avg": 0.0}
            if len(hist) > 1:
                (t0, rx0, tx0), (t1, rx1, tx1) = hist[0], hist[-2]
                row["rx"] = max(0, rx - rx1) / (now - t1)
                row["tx"] = max(0, tx - tx1) / (now - t1)
                row["rx_avg"] = max(0, rx - rx0) / (now - t0)
                row["tx_avg"] = max(0, tx - tx0) / (now - t0)
            rows.append(row)
        return rows

    def _filesystems(self) -> list[dict]:
        now = time.monotonic()
        if now - self._fs_t < FS_RESCAN:
            return self._fs
        self._fs_t = now
        # The container's own mounts are not the host's; pid 1 sees the host's mount namespace
        found: dict[str, dict] = {}
        for line in Path("/proc/1/mounts").read_text().splitlines():
            dev, mnt, fstype = line.split()[:3]
            mnt = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), mnt)
            local = dev.startswith("/dev/") and not dev.startswith("/dev/loop")
            if not (local or fstype.startswith("fuse.")) or FS_SKIP_RE.match(mnt):
                continue
            # Bind mounts repeat a device; keep its shortest mount point
            if dev in found and len(found[dev]["mount"]) <= len(mnt):
                continue
            try:
                st = os.statvfs("/proc/1/root" + mnt)
            except OSError:
                continue
            if not st.f_blocks:
                continue
            size = st.f_blocks * st.f_frsize
            found[dev] = {
                "mount": mnt,
                "device": dev,
                "type": fstype,
                "kind": "local" if local else "fuse",
                "size": size,
                "used": (st.f_blocks - st.f_bfree) * st.f_frsize,
                "avail": st.f_bavail * st.f_frsize,
            }
        self._fs = sorted(found.values(), key=lambda f: (f["kind"] != "local", f["mount"]))
        return self._fs

    def _static_info(self) -> dict:
        # The host's files are under /proc/1/root; the container's own /etc is python:3.12-slim
        release = dict(
            line.split("=", 1) for line in read_text("/proc/1/root/etc/os-release").splitlines() if "=" in line
        )
        cpuinfo = read_text("/proc/cpuinfo")
        m = re.search(r"^model name\s*:\s*(.+)$", cpuinfo, re.M)
        model, _, base = (m.group(1) if m else "").partition("@")
        model = " ".join(re.sub(r"\((R|TM)\)|\bCPU\b|\bProcessor\b", "", model).split())
        disks = []
        for p in sorted(Path("/sys/block").iterdir()):
            if not DISK_RE.match(p.name):
                continue
            kind = "NVMe" if p.name.startswith("nvme") else "HDD" if read_text(p / "queue/rotational") == "1" else "SSD"
            disks.append({"name": p.name, "size": int(read_text(p / "size") or 0) * 512, "kind": kind})
        nics = []
        addrs = psutil.net_if_addrs()
        for name in self.ifaces:
            speed = read_text(f"/sys/class/net/{name}/speed")
            mac = next((a.address for a in addrs.get(name, []) if a.family == psutil.AF_LINK), "")
            nics.append({"name": name, "speed": int(speed) if speed.lstrip("-").isdigit() else None, "mac": mac})
        try:
            tz = os.readlink("/proc/1/root/etc/localtime").split("zoneinfo/", 1)[-1]
        except OSError:
            tz = os.environ.get("TZ", "")
        # The board names the machine best; prebuilt PCs without one fall back to the product. A vendor that
        # is only in the board fields (sys_vendor left as "System manufacturer") is taken from there
        board = dmi("board_name") or dmi("product_name")
        vendor = short_vendor(dmi("sys_vendor") or dmi("board_vendor"))
        return {
            "os": release.get("PRETTY_NAME", "Linux").strip('"'),
            "kernel": os.uname().release,
            "arch": os.uname().machine,
            # no "Lenovo Lenovo ThinkCentre" when the product name already starts with the vendor
            "machine": board if vendor and board.startswith(vendor) else " ".join(x for x in (vendor, board) if x),
            "cpu_model": model,
            "cpu_base": re.sub(r"(\d)([GM]Hz)", r"\1 \2", base.strip()),
            "cores": psutil.cpu_count(logical=False) or self.ncpu,
            "threads": self.ncpu,
            "mem_total": psutil.virtual_memory().total,
            "swap_total": psutil.swap_memory().total,
            "disks": disks,
            "nics": nics,
            "timezone": tz,
        }

    def _slow_info(self) -> dict:
        # Things that rarely change: DHCP address, default route, running containers
        now = time.monotonic()
        if now - self._sys_t < FS_RESCAN:
            return self._sys_slow
        self._sys_t = now
        addrs = psutil.net_if_addrs()
        ips = [a.address for name in self.ifaces for a in addrs.get(name, []) if a.family == socket.AF_INET]
        gateway = None
        for line in read_text("/proc/1/net/route").splitlines()[1:]:
            f = line.split()
            if len(f) > 2 and f[1] == "00000000":
                gateway = socket.inet_ntoa(int(f[2], 16).to_bytes(4, "little"))
                break
        # Docker's state files, not cgroups: our own processes see their cgroup as "/"
        containers = 0
        for cfg in DOCKER_DIR.glob("*/config.v2.json"):
            try:
                containers += bool(json.loads(cfg.read_text())["State"]["Running"])
            except (OSError, ValueError, KeyError):
                pass
        self._sys_slow = {"private_ips": ips, "gateway": gateway, "containers": containers}
        return self._sys_slow

    @staticmethod
    def _cpu_temp() -> dict | None:
        try:
            temps = psutil.sensors_temperatures()
        except (OSError, AttributeError):
            return None
        # Intel package sensor, AMD Tctl, else the first sensor that has a reading
        for chip, label in (("coretemp", "Package"), ("k10temp", "Tctl"), ("zenpower", "Tctl")):
            for t in temps.get(chip, []):
                if t.label.startswith(label):
                    return {"current": t.current, "high": t.high}
        for entries in temps.values():
            for t in entries:
                if t.current:
                    return {"current": t.current, "high": t.high}
        return None

    def _system(self) -> dict:
        freq = psutil.cpu_freq()
        return {
            **self._sys_static,
            **self._slow_info(),
            "cpu_freq": freq.current if freq else None,
            "cpu_temp": self._cpu_temp(),
            "public_ip": self.public_ip,
            "public_ip_enabled": bool(PUBLIC_IP_URL),
        }

    def _updates_summary(self) -> dict | None:
        # The lists themselves are fetched from /api/updates when the popup opens
        u, i = self.updates, self.images
        if u is None and i is None:
            return None
        packages = u["packages"] if u else []
        return {
            "count": len(packages),
            "security": sum(p["security"] for p in packages),
            "reboot": bool(u and u["reboot"]),
            "containers": sum(c["status"] in ("pull", "recreate") for c in i["containers"]) if i else 0,
            "images": i is not None,
        }

    def _apps(self) -> list[dict] | None:
        # The containers that serve a web page, for the Docker panel's cards (webui.py finds them)
        if self.images is None:
            return None
        rows = [c for c in self.images["containers"] if c["web"]]
        return [{"name": c["name"], "web": c["web"], "update": c["status"] in ("pull", "recreate")}
                for c in sorted(rows, key=lambda c: c["name"])]

    def _collect_procs(self) -> tuple[list[dict], dict[str, dict]]:
        now = time.monotonic()
        dt = max(now - self._proc_t, 1e-3)
        self._proc_t = now
        seen: set[int] = set()
        rows = []
        used_now: dict[int, tuple[str, float]] = {}
        for pid in psutil.pids():
            seen.add(pid)
            proc = self._procs.get(pid)
            if proc is None:
                try:
                    proc = psutil.Process(pid)
                    proc.cpu_percent(None)
                except psutil.Error:
                    continue
                self._procs[pid] = proc
                cpu = 0.0
            else:
                cpu = None
            try:
                with proc.oneshot():
                    if cpu is None:
                        cpu = proc.cpu_percent(None) / self.ncpu
                    name = proc.name()
                    mem = proc.memory_info().rss
                    threads = proc.num_threads()
                    status = proc.status()
                    uid = proc.uids().real
                    ct = proc.cpu_times()
                    try:
                        cmdline = " ".join(proc.cmdline())
                    except psutil.AccessDenied:
                        cmdline = ""
                    try:
                        io = proc.io_counters()
                        io_now = (io.read_bytes, io.write_bytes)
                    except (psutil.AccessDenied, AttributeError):
                        io_now = None
            except psutil.Error:
                self._procs.pop(pid, None)
                continue

            # Average over the window from cumulative CPU time, so gaps without clients stay correct
            used = ct.user + ct.system
            used_now[pid] = (name, used)
            hist = self._proc_cpu.setdefault(pid, deque())
            hist.append((now, used))
            while now - hist[0][0] > HISTORY:
                hist.popleft()
            t0, u0 = hist[0]
            cpu_avg = max(0.0, used - u0) / (now - t0) / self.ncpu * 100 if now > t0 else cpu

            read = write = None
            if io_now is not None:
                prev = self._proc_io.get(pid)
                self._proc_io[pid] = io_now
                if prev is not None:
                    read = max(0, io_now[0] - prev[0]) / dt
                    write = max(0, io_now[1] - prev[1]) / dt
                else:
                    read = write = 0.0

            rows.append(
                {
                    "pid": pid,
                    "name": name,
                    "user": self._username(uid),
                    "cpu": round(cpu, 2),
                    "cpu_avg": round(cpu_avg, 2),
                    "mem": mem,
                    "read": read,
                    "write": write,
                    "threads": threads,
                    "status": status,
                    "cmd": cmdline or f"[{name}]",
                }
            )

        for pid in list(self._procs):
            if pid not in seen:
                self._procs.pop(pid, None)
                self._proc_io.pop(pid, None)
                self._proc_cpu.pop(pid, None)
        return rows, self._group_totals(now, rows, used_now)

    def _group_totals(self, now: float, rows: list[dict], used_now: dict[int, tuple[str, float]]) -> dict[str, dict]:
        # A group's cumulative CPU time = exited members' last seen time + live members' time
        for pid, (name, used) in self._pid_used.items():
            cur = used_now.get(pid)
            if cur is None:
                self._group_dead[name] = self._group_dead.get(name, 0.0) + used
            elif cur[0] != name:
                # exec changed the name: close it out under the old name, carry on under the new one
                self._group_dead[name] = self._group_dead.get(name, 0.0) + used
                self._group_dead[cur[0]] = self._group_dead.get(cur[0], 0.0) - used
        self._pid_used = used_now

        live: dict[str, float] = {}
        fallback: dict[str, float] = {}
        for name, used in used_now.values():
            live[name] = live.get(name, 0.0) + used
        for r in rows:
            fallback[r["name"]] = fallback.get(r["name"], 0.0) + r["cpu"]

        groups = {}
        for name in set(live) | set(self._group_dead):
            if name in live:
                self._group_seen[name] = now
            elif now - self._group_seen.get(name, 0.0) > HISTORY:
                self._group_dead.pop(name, None)
                self._group_cpu.pop(name, None)
                self._group_seen.pop(name, None)
                continue
            total = self._group_dead.get(name, 0.0) + live.get(name, 0.0)
            hist = self._group_cpu.setdefault(name, deque())
            hist.append((now, total))
            while now - hist[0][0] > HISTORY:
                hist.popleft()
            if len(hist) < 2:
                cpu = cpu_avg = fallback.get(name, 0.0)
            else:
                (t0, u0), (t1, u1) = hist[0], hist[-2]
                cpu = max(0.0, total - u1) / (now - t1) / self.ncpu * 100
                cpu_avg = max(0.0, total - u0) / (now - t0) / self.ncpu * 100
            # Recently exited groups stay listed while they still weigh on the average (crash loops)
            if name in live or cpu_avg >= 0.1:
                groups[name] = {"cpu": round(cpu, 2), "cpu_avg": round(cpu_avg, 2), "live": name in live}
        return groups

    def sample(self, with_procs: bool) -> dict:
        now = time.monotonic()
        dt = max(now - self._last_t, 1e-3)
        self._last_t = now

        per_core = psutil.cpu_percent(percpu=True)
        vm = psutil.virtual_memory()
        sw = psutil.swap_memory()

        disk = self._disk_counters()
        per_disk = {}
        for name, (r, w) in disk.items():
            pr, pw = self._last_disk.get(name, (r, w))
            per_disk[name] = {"read": max(0, r - pr) / dt, "write": max(0, w - pw) / dt}
        self._last_disk = disk

        net = self._net_counters()
        per_if = {}
        for name, (rx, tx) in net.items():
            prx, ptx = self._last_net.get(name, (rx, tx))
            per_if[name] = {
                "rx": max(0, rx - prx) / dt,
                "tx": max(0, tx - ptx) / dt,
                "rx_total": rx,
                "tx_total": tx,
            }
        self._last_net = net

        procs, groups = self._collect_procs() if with_procs else (None, None)

        metrics = {
            "t": time.time(),
            "cpu": sum(per_core) / len(per_core),
            "mem": (vm.total - vm.available) / vm.total * 100,
            "disk_read": sum(d["read"] for d in per_disk.values()),
            "disk_write": sum(d["write"] for d in per_disk.values()),
            "net_in": sum(n["rx"] for n in per_if.values()),
            "net_out": sum(n["tx"] for n in per_if.values()),
        }
        self.history.append(metrics)

        return {
            "type": "tick",
            "metrics": metrics,
            "host": {
                "hostname": socket.gethostname(),
                "uptime": time.time() - psutil.boot_time(),
                "load": os.getloadavg(),
                "cores": self.ncpu,
            },
            "cpu": {"per_core": per_core},
            "mem": {
                "total": vm.total,
                "used": vm.total - vm.available,
                "cached": getattr(vm, "cached", 0) + getattr(vm, "buffers", 0),
                "swap_total": sw.total,
                "swap_used": sw.used,
            },
            "disks": per_disk,
            "ifaces": per_if,
            "containers": self._container_net(),
            "filesystems": self._filesystems(),
            "system": self._system(),
            "updates": self._updates_summary(),
            "apps": self._apps(),
            "procs": procs,
            "groups": groups,
        }

    async def run(self) -> None:
        while True:
            started = time.monotonic()
            with_procs = bool(self.clients) or started < self.want_procs_until
            data = await asyncio.to_thread(self.sample, with_procs)
            self.latest = data
            if self.clients:
                text = json.dumps(data, separators=(",", ":"))
                await asyncio.gather(
                    *(self._send(ws, text) for ws in list(self.clients))
                )
            await asyncio.sleep(max(0.0, INTERVAL - (time.monotonic() - started)))

    async def _send(self, ws: WebSocket, text: str) -> None:
        try:
            await ws.send_text(text)
        except Exception:
            self.clients.discard(ws)


sampler = Sampler()


def fetch_public_ip() -> str:
    with urllib.request.urlopen(PUBLIC_IP_URL, timeout=5) as resp:
        return str(ipaddress.ip_address(resp.read(64).decode().strip()))


async def public_ip_loop() -> None:
    while True:
        try:
            sampler.public_ip = await asyncio.to_thread(fetch_public_ip)
            delay = PUBLIC_IP_REFRESH
        except Exception:
            # keep the last known address and retry soon
            delay = 60.0
        await asyncio.sleep(delay)


updates_wake = asyncio.Event()
images_wake = asyncio.Event()
# Popups waiting for a fresh check (POST /api/updates/check); one refresh serves them all
updates_waiters: list[asyncio.Future] = []


def resolve(waiters: list[asyncio.Future]) -> None:
    for f in waiters:
        if not f.done():
            f.set_result(None)


async def updates_loop(mgr: updates.Manager) -> None:
    last, next_check, refreshed, next_refresh = None, 0.0, 0.0, 0.0
    while True:
        waiters = updates_waiters[:]
        updates_waiters.clear()
        busy, job_ended = False, ""
        if admin.available():
            try:
                busy, job_ended = await asyncio.to_thread(admin.status)
            except Exception:
                pass
        if busy:
            resolve(waiters)
            await asyncio.sleep(UPDATES_BUSY_POLL)
            continue
        # Refresh the lists when the host's own timers have let them get older than REFRESH,
        # or when a popup was opened and they are older than UPDATES_ON_OPEN
        if updates.REFRESH and time.monotonic() >= next_refresh:
            try:
                age = time.time() - updates.lists_updated("/proc/1/root", mgr, refreshed)
                if age > updates.REFRESH or (waiters and age > UPDATES_ON_OPEN):
                    await asyncio.to_thread(updates.refresh, "/proc/1/root", mgr)
                    refreshed = time.time()
            except Exception as e:
                # offline, or the package manager is busy: check the lists we have and try again later
                print(f"updates ({mgr.name}) refresh: {e}")
                next_refresh = time.monotonic() + UPDATES_RETRY
        try:
            # a finished Install run counts as a change, even one that changed no package
            state = (*await asyncio.to_thread(updates.state, "/proc/1/root", mgr), job_ended)
            if state != last or waiters or time.monotonic() >= next_check:
                last = state
                sampler.updates = await asyncio.to_thread(updates.check, "/proc/1/root", mgr, refreshed)
                next_check = time.monotonic() + mgr.recheck
        except Exception as e:
            # keep the last list
            print(f"updates ({mgr.name}): {e}")
            next_check = time.monotonic() + UPDATES_RETRY
        resolve(waiters)
        # Install wakes the loop at once, so it doesn't check halfway through the run
        try:
            await asyncio.wait_for(updates_wake.wait(), UPDATES_POLL)
        except asyncio.TimeoutError:
            pass
        updates_wake.clear()


async def images_loop() -> None:
    # Docker is asked every minute (local, cheap), the registries every images.REFRESH (cached in the checker)
    while True:
        busy = False
        if admin.available():
            try:
                busy = await asyncio.to_thread(admin.running)
            except Exception:
                pass
        if busy:
            # an Update containers run: look again as soon as it ends
            await asyncio.sleep(UPDATES_BUSY_POLL)
            continue
        try:
            sampler.images = await asyncio.to_thread(images.checker.check)
        except Exception as e:
            print(f"container updates: {e}")
        try:
            await asyncio.wait_for(images_wake.wait(), UPDATES_POLL)
        except asyncio.TimeoutError:
            pass
        images_wake.clear()


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = [asyncio.create_task(sampler.run())]
    if PUBLIC_IP_URL:
        tasks.append(asyncio.create_task(public_ip_loop()))
    # apt, dnf, zypper, pacman or apk; with none of them the badge stays hidden
    if UPDATES_MGR:
        tasks.append(asyncio.create_task(updates_loop(UPDATES_MGR)))
    if images.REFRESH and images.socket_path():
        tasks.append(asyncio.create_task(images_loop()))
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(title="Kongo", lifespan=lifespan)


@app.get("/")
async def index() -> HTMLResponse:
    html = (STATIC_DIR / "index.html").read_text()
    for name in ("app.js", "style.css"):
        html = html.replace(f'"/static/{name}"', f'"/static/{name}?v={VERSION}"')
    # always asked again, so a new Kongo's page is never taken from the cache
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/api/snapshot")
async def snapshot() -> JSONResponse:
    # Ask the loop for process data and wait two ticks so CPU/IO deltas are valid
    sampler.want_procs_until = time.monotonic() + 5
    await asyncio.sleep(2.2)
    return JSONResponse({**sampler.latest, "history": list(sampler.history)})


@app.post("/api/updates/check")
async def updates_check() -> JSONResponse:
    # The popup was opened: refresh the lists unless they are fresh, check again, then reply with the list
    if UPDATES_MGR:
        waiter = asyncio.get_running_loop().create_future()
        updates_waiters.append(waiter)
        updates_wake.set()
        try:
            await asyncio.wait_for(waiter, 180)
        except asyncio.TimeoutError:
            pass
    return await updates_list()


@app.get("/api/updates")
async def updates_list() -> JSONResponse:
    if sampler.updates is None and sampler.images is None:
        return JSONResponse(None)
    base = sampler.updates or {"manager": None, "upgrade": "", "packages": [], "lists_updated": 0, "checked": 0, "reboot": None}
    users = await asyncio.to_thread(admin.admin_users) if UPDATES_MGR and admin.available() and UPDATES_MGR.install else []
    # without a user who can log in, the buttons would be no use
    return JSONResponse({**base, "images": sampler.images, "actions": bool(users), "admin_users": users})


@app.get("/api/containers")
async def containers_list() -> JSONResponse:
    # Every running container and whether its image has a newer version (the Docker panel's popup)
    if sampler.images is None:
        return JSONResponse(None)
    users = await asyncio.to_thread(admin.admin_users) if admin.available() else []
    return JSONResponse({**sampler.images, "actions": bool(users), "admin_users": users})


class Credentials(BaseModel):
    user: str
    password: str


class ContainerCredentials(Credentials):
    # the containers the popup showed as updatable, so nothing the user didn't see gets recreated
    names: list[str]


async def authorize(c: Credentials) -> None:
    if not (UPDATES_MGR and admin.available()):
        raise HTTPException(404, "Not available on this server.")
    if wait := admin.guard.locked_for():
        raise HTTPException(429, f"Too many wrong passwords. Try again in {wait / 60:.0f} min.")
    if not await asyncio.to_thread(admin.guard.check, c.user, c.password):
        raise HTTPException(401, "Wrong user name or password, or the user is not an administrator.")


async def admin_action(fn, *args) -> None:
    try:
        await asyncio.to_thread(fn, *args)
    except admin.Busy as e:
        raise HTTPException(409, str(e))


@app.post("/api/admin/upgrade")
async def admin_upgrade(c: Credentials) -> JSONResponse:
    await authorize(c)
    await admin_action(admin.start_upgrade, UPDATES_MGR.install)
    updates_wake.set()
    return JSONResponse({"ok": True})


@app.post("/api/admin/containers")
async def admin_containers(c: ContainerCredentials) -> JSONResponse:
    await authorize(c)
    rows = [r for r in (sampler.images or {}).get("containers", []) if r["name"] in c.names and images.updatable(r)]
    if not rows:
        raise HTTPException(409, "There is nothing to update.")
    await admin_action(admin.start_containers, images.update_script(rows))
    images_wake.set()
    return JSONResponse({"ok": True, "containers": [r["name"] for r in rows]})


@app.post("/api/admin/restart")
async def admin_restart(c: Credentials) -> JSONResponse:
    await authorize(c)
    await admin_action(admin.restart)
    return JSONResponse({"ok": True})


@app.get("/api/admin/job")
async def admin_job() -> JSONResponse:
    # The upgrade's state and log; not secret, the package list is public on the page too
    if not admin.available():
        return JSONResponse(None)
    return JSONResponse(await asyncio.to_thread(admin.job))


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await ws.send_text(
        json.dumps({"type": "init", "version": VERSION, "history": list(sampler.history)}, separators=(",", ":"))
    )
    sampler.clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sampler.clients.discard(ws)


# python:3.12-slim has no /etc/mime.types, so woff2 would be served as text/plain
mimetypes.add_type("font/woff2", ".woff2")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
