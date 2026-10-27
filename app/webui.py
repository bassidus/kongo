"""Which running containers serve a web page, and on which host port: for the Open buttons in the Docker popup.

The candidates are the TCP ports Docker publishes on all addresses, and for containers on the host's network the
ports their processes listen on. When containers share a network namespace (an app routed through a VPN
container), a port goes to the container whose process listens on it, not to the one that publishes it. Each
candidate is asked for "/" over http, then https: an HTML page, a redirect or a login prompt counts as a web UI.
The page's <title> names it on the Docker panel's cards ("Nginx Proxy Manager" rather than "proxy-manager").
"""

import html
import http.client
import os
import re
import ssl
import time
import urllib.parse

import psutil

# How long a port's answer is trusted; the candidates themselves are worked out on every check (cheap)
PROBE_CACHE = 600.0
LOOPBACK = {"0100007F", "00000000000000000000000001000000"}
DEFAULT_PORT = {"http": 80, "https": 443}
TITLE_RE = re.compile(rb"<title[^>]*>(.*?)</title", re.I | re.S)
# Parts of a title that name the page, not the app: "NUT Web - Home", "Login – Nextcloud"
TITLE_SEP_RE = re.compile(r"\s+[-–—|·:]+\s+")
GENERIC_RE = re.compile(r"^(home|log ?in|sign ?in|dashboard|welcome|overview|index|main|start|loading.*)$", re.I)


def app_name(raw: bytes) -> str:
    # The app's name from a page's HTML, or "" (the card then shows the container's name)
    m = TITLE_RE.search(raw)
    if not m:
        return ""
    title = " ".join(html.unescape(m.group(1).decode("utf-8", "replace")).split())
    name = next((p for p in TITLE_SEP_RE.split(title) if p and not GENERIC_RE.match(p)), "")
    return name[0].upper() + name[1:] if name.islower() else name


def pids_of(main_pid: int) -> set[int]:
    # The listening process is often a child (an s6 or tini init runs as the container's main process)
    try:
        return {main_pid, *(c.pid for c in psutil.Process(main_pid).children(recursive=True))}
    except psutil.Error:
        return set()


def socket_inodes(pids: set[int]) -> set[int]:
    inodes = set()
    for pid in pids:
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                link = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if link.startswith("socket:["):
                inodes.add(int(link[8:-1]))
    return inodes


def listening(pid: int) -> list[tuple[int, int, bool]]:
    # (port, socket inode, reachable from outside) for TCP sockets listening in pid's network namespace
    found = []
    for name in ("tcp", "tcp6"):
        try:
            with open(f"/proc/{pid}/net/{name}") as f:
                lines = f.read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != "0A":  # 0A = LISTEN
                continue
            addr, port = fields[1].rsplit(":", 1)
            found.append((int(port, 16), int(fields[9]), addr not in LOOPBACK))
    return found


def get(scheme: str, port: int, path: str) -> http.client.HTTPResponse:
    if scheme == "http":
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    else:
        conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=2, context=ssl._create_unverified_context())
    conn.request("GET", path, headers={"User-Agent": "kongo", "Accept": "text/html"})
    r = conn.getresponse()
    r.conn = conn  # closed by the caller
    return r


def page_title(r: http.client.HTTPResponse) -> str:
    return app_name(r.read(65536)) if "html" in r.getheader("Content-Type", "") else ""


def followed_title(scheme: str, port: int, location: str) -> str:
    # The title of the page a redirect leads to (often a login page, after "/" → "/manage" → "/manage/login"),
    # following a few more redirects as long as they stay on this port
    path = "/"
    for _ in range(4):
        target = urllib.parse.urlsplit(urllib.parse.urljoin(f"{scheme}://127.0.0.1:{port}{path}", location))
        if (target.scheme, target.port or DEFAULT_PORT[target.scheme]) != (scheme, port):
            return ""
        path = (target.path or "/") + (f"?{target.query}" if target.query else "")
        try:
            r = get(scheme, port, path)
        except (http.client.HTTPException, ssl.SSLError, OSError):
            return ""
        try:
            if r.status in (301, 302, 303, 307, 308):
                location = r.getheader("Location", "")
                continue
            return page_title(r) if r.status < 400 else ""
        finally:
            r.conn.close()
    return ""


def probe(port: int) -> dict | None:
    # {"scheme", "title"} of the web page on this port, or None
    for scheme in ("http", "https"):
        try:
            r = get(scheme, port, "/")
        except (http.client.HTTPException, ssl.SSLError, OSError):
            continue
        try:
            if r.status == 400 and scheme == "http":
                continue  # often "plain HTTP sent to an HTTPS port"
            if r.status in (301, 302, 303, 307, 308):
                # a redirect elsewhere (another port, or https on this http port) isn't this port's page
                target = urllib.parse.urlsplit(r.getheader("Location", ""))
                if target.scheme and (target.scheme, target.port or DEFAULT_PORT[target.scheme]) != (scheme, port):
                    return None
                return {"scheme": scheme, "title": followed_title(scheme, port, r.getheader("Location", ""))}
            # a page, or a login prompt; an error page (a proxy's 404) or JSON (an API) is not a UI
            if r.status == 401 or (r.status < 400 and "html" in r.getheader("Content-Type", "")):
                return {"scheme": scheme, "title": page_title(r) if r.status < 400 else ""}
            return None
        except (http.client.HTTPException, ssl.SSLError, OSError):
            continue
        finally:
            r.conn.close()
    return None


class WebFinder:
    def __init__(self) -> None:
        # (container id, host port) -> (when asked, {"scheme", "title"} or None)
        self.probes: dict[tuple[str, int], tuple[float, dict | None]] = {}

    def candidates(self, inspect, containers: list[dict]) -> set[tuple[str, int]]:
        # (container id, host port) pairs worth asking
        by_name = {c["Names"][0].lstrip("/"): c["Id"] for c in containers}
        members: dict[str, list[str]] = {}
        for c in containers:
            mode = (c.get("HostConfig") or {}).get("NetworkMode", "")
            if mode.startswith("container:"):
                target = mode.split(":", 1)[1]
                members.setdefault(by_name.get(target, target), []).append(c["Id"])
        out = set()
        for c in containers:
            mode = (c.get("HostConfig") or {}).get("NetworkMode", "")
            if mode.startswith("container:"):
                continue  # its ports are published by the container whose network it shares
            if mode == "host":
                pid = inspect(c["Id"])
                pids = pids_of(pid)
                if os.getpid() in pids:
                    continue  # Kongo itself
                inodes = socket_inodes(pids)
                out |= {(c["Id"], port) for port, inode, outside in listening(pid) if outside and inode in inodes}
                continue
            ports = {
                (p["PublicPort"], p["PrivatePort"]) for p in c.get("Ports", [])
                if p.get("Type") == "tcp" and p.get("PublicPort") and p.get("IP", "0.0.0.0") in ("0.0.0.0", "::", "")
            }
            group = [c["Id"], *members.get(c["Id"], [])]
            if len(group) == 1:
                out |= {(c["Id"], public) for public, _ in ports}
                continue
            # A shared namespace: whose process listens on the port inside it?
            pid = inspect(c["Id"])
            inode_of = {port: inode for port, inode, _ in listening(pid)}
            owned = {cid: socket_inodes(pids_of(inspect(cid))) for cid in group}
            for public, private in ports:
                inode = inode_of.get(private)
                out.add((next((cid for cid in group if inode in owned[cid]), c["Id"]), public))
        return out

    def find(self, inspect, containers: list[dict]) -> dict[str, list[dict]]:
        now = time.time()
        found: dict[str, list[dict]] = {}
        alive = set()
        for cid, port in sorted(self.candidates(inspect, containers), key=lambda x: x[1]):
            alive.add((cid, port))
            cached = self.probes.get((cid, port))
            if not cached or now - cached[0] > PROBE_CACHE:
                cached = self.probes[(cid, port)] = (now, probe(port))
            if cached[1]:
                found.setdefault(cid, []).append({"port": port, **cached[1]})
        self.probes = {k: v for k, v in self.probes.items() if k in alive}
        return found


finder = WebFinder()
