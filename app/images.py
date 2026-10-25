"""Running containers whose image has a newer version: in the registry, or already pulled but not in use yet.

Talks to the host's Docker over its socket (through /proc/1/root, so no extra volume) and asks each image's
registry which digest its tag points at now. A HEAD request for the manifest doesn't count against Docker Hub's
pull limit. Registry answers are cached for REFRESH, so the local side (a container recreated after a pull) is
seen within a minute without asking the registries again.
"""

import http.client
import json
import os
import re
import shlex
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = "/proc/1/root"
# Ask the registries this often; 0 = no container check at all
REFRESH = float(os.environ.get("CONTAINER_UPDATES_HOURS", "12")) * 3600
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
])


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, path: str) -> None:
        super().__init__("localhost", timeout=10)
        self.socket_path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(self.socket_path)


def socket_path() -> str | None:
    # /var/run is usually a symlink to /run, which would resolve inside the container, so /run comes first
    return next((ROOT + p for p in ("/run/docker.sock", "/var/run/docker.sock") if os.path.exists(ROOT + p)), None)


def docker(path: str, url: str):
    c = DockerConnection(path)
    try:
        c.request("GET", url)
        r = c.getresponse()
        body = r.read()
    finally:
        c.close()
    if r.status == 404:
        return None
    if r.status != 200:
        raise RuntimeError(f"Docker API {url}: {r.status}")
    return json.loads(body)


def parse_ref(ref: str) -> tuple[str, str, str]:
    # "nginx:alpine" -> (registry-1.docker.io, library/nginx, alpine); "ghcr.io/a/b" -> (ghcr.io, a/b, latest)
    name, tag = ref, "latest"
    if ":" in ref.rsplit("/", 1)[-1]:
        name, tag = ref.rsplit(":", 1)
    first = name.split("/", 1)[0]
    if "/" in name and ("." in first or ":" in first or first == "localhost"):
        registry, repo = name.split("/", 1)
    else:
        registry, repo = "docker.io", name
    if registry in ("docker.io", "index.docker.io"):
        registry = "registry-1.docker.io"
        if "/" not in repo:
            repo = "library/" + repo
    return registry, repo, tag


def head_manifest(url: str, token: str | None = None):
    headers = {"Accept": ACCEPT, "User-Agent": "kongo"}
    if token:
        headers["Authorization"] = "Bearer " + token
    return urllib.request.urlopen(urllib.request.Request(url, method="HEAD", headers=headers), timeout=15)


def registry_digest(ref: str) -> str:
    registry, repo, tag = parse_ref(ref)
    url = f"https://{registry}/v2/{repo}/manifests/{tag}"
    try:
        r = head_manifest(url)
    except urllib.error.HTTPError as e:
        if e.code != 401:
            raise
        # anonymous token for public images: the 401 says where to get it
        challenge = dict(re.findall(r'(\w+)="([^"]*)"', e.headers.get("WWW-Authenticate", "")))
        if "realm" not in challenge:
            raise
        query = urllib.parse.urlencode({k: challenge[k] for k in ("service", "scope") if k in challenge})
        with urllib.request.urlopen(f"{challenge['realm']}?{query}", timeout=15) as t:
            token = json.load(t)
        r = head_manifest(url, token.get("token") or token.get("access_token"))
    with r:
        return r.headers["Docker-Content-Digest"]


class Checker:
    def __init__(self) -> None:
        # ref -> (when asked, digest, error)
        self.remote: dict[str, tuple[float, str | None, str | None]] = {}
        self.lock = threading.Lock()

    def remote_digest(self, ref: str, max_age: float) -> tuple[str | None, str | None]:
        cached = self.remote.get(ref)
        if cached and time.time() - cached[0] < max_age:
            return cached[1], cached[2]
        digest = error = None
        try:
            digest = registry_digest(ref)
        except urllib.error.HTTPError as e:
            error = f"the registry answered {e.code}"
        except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
            error = f"the registry could not be reached ({getattr(e, 'reason', e)})"
        self.remote[ref] = (time.time(), digest, error)
        return digest, error

    def check(self) -> dict:
        path = socket_path()
        if not path:
            raise RuntimeError("no Docker socket on the host")
        with self.lock:
            rows, asked = [], set()
            for ct in docker(path, "/containers/json"):
                labels = ct.get("Labels") or {}
                row = {
                    "name": ct["Names"][0].lstrip("/"),
                    "image": ct["Image"],
                    "project": labels.get("com.docker.compose.project", ""),
                    "dir": labels.get("com.docker.compose.project.working_dir", ""),
                    "service": labels.get("com.docker.compose.service", ""),
                    "files": labels.get("com.docker.compose.project.config_files", ""),
                    "state": ct.get("Status", ""),  # "Up 3 days"
                    "status": "ok",
                    "detail": "",
                }
                rows.append(row)
                # Docker shows the image id once the tag has moved on; the container's config keeps the name
                if row["image"].startswith("sha256:"):
                    row["image"] = docker(path, f"/containers/{ct['Id']}/json")["Config"]["Image"]
                ref = row["image"]
                if "@" in ref or ref.startswith("sha256:"):
                    row["status"] = "pinned"  # to a digest: there is no tag to follow
                    continue
                current = docker(path, f"/images/{urllib.parse.quote(ref, safe='/:')}/json")
                if current is None:
                    row["status"], row["detail"] = "error", "the image is gone"
                    continue
                if not current.get("RepoDigests"):
                    row["status"] = "local"  # built here, not pulled from a registry
                    continue
                if current["Id"] != ct["ImageID"]:
                    row["status"] = "recreate"  # a newer image is pulled, the container still runs the old one
                    continue
                asked.add(ref)
                digest, error = self.remote_digest(ref, REFRESH)
                if error:
                    row["status"], row["detail"] = "error", error
                elif digest not in {d.split("@", 1)[1] for d in current["RepoDigests"]}:
                    row["status"] = "pull"
            # forget images no container uses any more
            self.remote = {ref: v for ref, v in self.remote.items() if ref in asked}
            times = [t for t, _, _ in self.remote.values()]
            order = {"pull": 0, "recreate": 0, "error": 1}
            return {
                # every running container; updates first
                "containers": sorted(rows, key=lambda r: (order.get(r["status"], 2), r["project"] or "~", r["name"])),
                "registry_checked": min(times) if times else None,
                "checked": time.time(),
            }


checker = Checker()


def updatable(row: dict) -> bool:
    # Only compose containers can be recreated as they were; a plain `docker run` left no record of its options
    return row["status"] in ("pull", "recreate") and all(row[k] for k in ("project", "dir", "service"))


def update_script(rows: list[dict]) -> str:
    # Per compose project: pull the services that have a newer image, then `up -d` the whole project, as the
    # popup's hint says. Compose then recreates only the containers whose image changed, and their dependents
    # (an app routed through a VPN container's network).
    projects: dict[tuple[str, str, str], list[str]] = {}
    for r in rows:
        projects.setdefault((r["project"], r["dir"], r["files"]), []).append(r["service"])
    lines = ["#!/bin/sh", "# Written by Kongo for the Update containers button", "failed=0"]
    for (project, folder, files), services in projects.items():
        compose = "docker compose -p " + shlex.quote(project) + "".join(
            " -f " + shlex.quote(f) for f in files.split(",") if f
        )
        names = " ".join(shlex.quote(s) for s in services)
        lines += [
            "echo " + shlex.quote(f"== {project}: {' '.join(services)}"),
            f"cd {shlex.quote(folder)} && {compose} pull {names} && {compose} up -d || failed=1",
        ]
    lines.append('exit "$failed"')
    return "\n".join(lines) + "\n"
