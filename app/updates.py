"""Available package updates on the host, from the host's own package manager.

The checks run in a chroot into the host's root as nobody, so they read the host's package state and can't
change it. Refreshing the repository lists needs root: when the host's lists are older than REFRESH, Kongo runs
the host's own refresh (apt-get update, dnf makecache, ...), as the distributions' own timers do. Installed
packages are never touched. pacman is synced into a private copy of its sync databases instead (as
pacman-contrib's checkupdates does), because syncing the host's own would set up partial upgrades.
"""

import glob
import os
import re
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

import psutil
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Iterator

NOBODY = 65534
# Refresh the repository lists when they are older than this; 0 = never, Kongo then only reads
REFRESH = float(os.environ.get("UPDATES_REFRESH_HOURS", "12")) * 3600
# pacman's private sync databases on the host; pacman writes there as root, so not under the world-writable /tmp
PACMAN_DB = "/var/cache/kongo/pacman"
APT_RE = re.compile(r"^(\S+?)/(\S+) (\S+) \S+ \[upgradable from: (.+)\]$")
PACMAN_RE = re.compile(r"^(\S+) (\S+) -> (\S+)")
APK_RE = re.compile(r"^(\S+) \S+ \{\S+\} \(.*\) \[upgradable from: (\S+)\]$")
APK_VER_RE = re.compile(r"^(.+)-([^-]+-r\d+)$")
# "name.arch version repo", with an optional epoch in the version
DNF_VER_RE = re.compile(r"^(\d+:)?[^\s:-]+-[^\s-]+$")


@dataclass
class Manager:
    name: str
    binary: str  # found in the host's root means this is the host's manager
    installed: tuple[str, ...]  # globs that change on every install or upgrade
    lists: tuple[str, ...]  # globs that change when the repository metadata is refreshed
    check: Callable[[str, str], list[dict]]  # (root, home) -> packages
    upgrade: str  # shown in the popup
    update: Callable[[str, str], None]  # (root, home): refresh the repository lists, as root
    recheck: float = 3600.0  # recheck at least this often, even without changes
    reboot: Callable[[str, str], str | None] | None = None
    # Installs the updates without questions, for the Install button (app/admin.py). No "$": systemd-run expands it
    install: str = ""


def run_proc(root: str, args: list[str], home: str, *, root_user: bool = False, ok: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess:
    cmd = ["chroot", *([] if root_user else [f"--userspec={NOBODY}:{NOBODY}"]), root, *args]
    p = subprocess.run(
        cmd, capture_output=True, text=True, timeout=300,
        env={"LC_ALL": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": home},
    )
    if p.returncode not in ok:
        raise RuntimeError(f"{args[0]} exited {p.returncode}: {p.stderr.strip()[:300]}")
    return p


def run(root: str, args: list[str], home: str, **kw) -> str:
    return run_proc(root, args, home, **kw).stdout


def updater(args: list[str]) -> Callable[[str, str], None]:
    def update(root: str, home: str) -> None:
        run(root, args, home, root_user=True)
    return update


def newest_mtime(root: str, patterns: tuple[str, ...]) -> float:
    return max((os.stat(p).st_mtime for pat in patterns for p in glob.glob(root + pat)), default=0.0)


def read_text(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def package(name: str, old: str, new: str, source: str = "", security: bool = False) -> dict:
    return {"name": name, "old": old, "new": new, "source": source, "security": security}


# ---------- apt (Debian, Ubuntu) ----------

def check_apt(root: str, home: str) -> list[dict]:
    out = run(root, ["apt", "list", "--upgradable"], home)
    rows = []
    for line in out.splitlines():
        if m := APT_RE.match(line):
            name, suites, new, old = m.groups()
            rows.append(package(name, old, new, suites.replace(",", ", "), "-security" in suites))
    return rows


# ---------- dnf (Fedora, RHEL and its rebuilds) ----------

def dnf_table(out: str) -> list[tuple[str, str, str]]:
    # "name.arch  version  repo"; a long name pushes the rest onto the next line
    words, rows = [], []
    for line in out.splitlines():
        if line.lower().startswith("obsoleting"):
            break
        words += line.split()
        while len(words) >= 3:
            if "." in words[0] and DNF_VER_RE.match(words[1]):
                rows.append((words[0], words[1], words[2]))
                del words[:3]
            else:
                del words[0]
    return rows


def rpm_installed(root: str, home: str) -> dict[str, str]:
    # the newest installed version per name.arch (kernels are installed side by side)
    out = run(root, ["rpm", "-qa", "--qf", "%{NAME}.%{ARCH} %{INSTALLTIME} %{EPOCHNUM}:%{VERSION}-%{RELEASE}\n"], home)
    newest: dict[str, tuple[int, str]] = {}
    for line in out.splitlines():
        f = line.split()
        if len(f) == 3 and f[1].isdigit() and int(f[1]) >= newest.get(f[0], (-1, ""))[0]:
            newest[f[0]] = (int(f[1]), f[2].removeprefix("0:"))
    return {k: v for k, (_, v) in newest.items()}


def dnf_checker(args: list[str]) -> Callable[[str, str], list[dict]]:
    def check(root: str, home: str) -> list[dict]:
        # exit code 100 means updates are available
        rows = dnf_table(run(root, args, home, ok=(0, 100)))
        security = {r[0] for r in dnf_table(run(root, [*args, "--security"], home, ok=(0, 100)))}
        installed = rpm_installed(root, home)
        return [
            package(na.rsplit(".", 1)[0], installed.get(na, ""), ver, repo, na in security)
            for na, ver, repo in rows
        ]
    return check


# ---------- zypper (openSUSE, SLES) ----------

def check_zypper(root: str, home: str) -> list[dict]:
    out = run(root, ["zypper", "--non-interactive", "--no-refresh", "--xmlout", "list-updates"], home)
    rows = []
    for u in ET.fromstring(out).iter("update"):
        if u.get("kind", "package") == "package":
            src = u.find("source")
            rows.append(package(u.get("name", ""), u.get("edition-old", ""), u.get("edition", ""), src.get("alias", "") if src is not None else ""))
    return rows


def zypper_reboot(root: str, home: str) -> str | None:
    # exit code 102: a reboot is needed
    p = run_proc(root, ["zypper", "--non-interactive", "needs-rebooting"], home, ok=(0, 102))
    return "core libraries or services were updated" if p.returncode == 102 else None


# ---------- pacman (Arch and its derivatives) ----------

def update_pacman(root: str, home: str) -> None:
    # Seeded from the host's own sync databases, so pacman only downloads the ones that are newer
    db = root + PACMAN_DB
    os.makedirs(db + "/sync", mode=0o755, exist_ok=True)
    for f in glob.glob(root + "/var/lib/pacman/sync/*.db"):
        dst = f"{db}/sync/{os.path.basename(f)}"
        if not os.path.exists(dst) or os.stat(f).st_mtime > os.stat(dst).st_mtime:
            shutil.copy2(f, dst)
    if not os.path.islink(db + "/local"):
        os.symlink("/var/lib/pacman/local", db + "/local")
    run(root, ["pacman", "-Sy", "--dbpath", PACMAN_DB, "--logfile", "/dev/null"], home, root_user=True)


def check_pacman(root: str, home: str) -> list[dict]:
    # The private copy once it has been synced, else the host's own sync databases
    db = PACMAN_DB if glob.glob(root + PACMAN_DB + "/sync/*.db") else "/var/lib/pacman"
    # exit code 1 means nothing to upgrade
    out = run(root, ["pacman", "-Qu", "--dbpath", db], home, ok=(0, 1))
    return [package(*m.groups()) for line in out.splitlines() if (m := PACMAN_RE.match(line))]


# ---------- apk (Alpine) ----------

def check_apk(root: str, home: str) -> list[dict]:
    out = run(root, ["apk", "list", "--upgradable"], home)
    rows = []
    for line in out.splitlines():
        if (m := APK_RE.match(line)) and (new := APK_VER_RE.match(m.group(1))) and (old := APK_VER_RE.match(m.group(2))):
            rows.append(package(new.group(1), old.group(2), new.group(2)))
    return rows


RPMDB = ("/var/lib/rpm/*", "/usr/lib/sysimage/rpm/*")
MANAGERS = [
    Manager("apt", "/usr/bin/apt", ("/var/lib/dpkg/status",),
            ("/var/lib/apt/lists", "/var/lib/apt/periodic/update-success-stamp"), check_apt, "sudo apt upgrade",
            updater(["apt-get", "-q", "update"]),
            install="apt-get -q -o DPkg::Lock::Timeout=300 update && apt-get -q -y -o DPkg::Lock::Timeout=300"
                    " -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold --with-new-pkgs upgrade"),
    Manager("dnf", "/usr/bin/dnf5", RPMDB, ("/var/cache/libdnf5/*", "/var/cache/libdnf5/*/repodata/*"),
            dnf_checker(["dnf5", "-C", "-q", "--setopt=system_cachedir=/var/cache/libdnf5", "check-upgrade"]),
            "sudo dnf upgrade", updater(["dnf5", "-q", "makecache"]),
            install="dnf5 -y upgrade --refresh"),
    Manager("dnf", "/usr/bin/dnf", RPMDB, ("/var/cache/dnf/*", "/var/cache/dnf/*/repodata/*"),
            dnf_checker(["dnf", "-C", "-q", "check-update"]), "sudo dnf upgrade",
            updater(["dnf", "-q", "makecache"]), install="dnf -y upgrade --refresh"),
    Manager("zypper", "/usr/bin/zypper", RPMDB, ("/var/cache/zypp/solv/*/solv", "/var/cache/zypp/raw/*/repodata/*"),
            check_zypper, "sudo zypper update", updater(["zypper", "--non-interactive", "--quiet", "refresh"]),
            reboot=zypper_reboot, install="zypper --non-interactive refresh && zypper --non-interactive update"),
    Manager("pacman", "/usr/bin/pacman", ("/var/lib/pacman/local",), (PACMAN_DB + "/sync/*.db", "/var/lib/pacman/sync/*.db"),
            check_pacman, "sudo pacman -Syu", update_pacman,
            install="pacman -Syu --noconfirm"),
    Manager("apk", "/sbin/apk", ("/lib/apk/db/installed",), ("/var/cache/apk/APKINDEX.*", "/etc/apk/cache/APKINDEX.*"),
            check_apk, "apk upgrade", updater(["apk", "-q", "update"]),
            install="apk update && apk upgrade"),
]


def detect(root: str) -> Manager | None:
    return next((m for m in MANAGERS if os.path.exists(root + m.binary)), None)


def state(root: str, mgr: Manager) -> tuple[float, ...]:
    return newest_mtime(root, mgr.installed), newest_mtime(root, mgr.lists), newest_mtime(root, ("/run/reboot-required",))


def reboot_reason(root: str, mgr: Manager, home: str) -> str | None:
    if os.path.exists(root + "/run/reboot-required"):
        pkgs = sorted(set(read_text(root + "/run/reboot-required.pkgs").split()))
        return ", ".join(pkgs) or "requested by an update"
    # Arch and others remove the old kernel's modules when they install a new one
    release = os.uname().release
    kernels = {os.path.basename(d) for base in ("/usr/lib/modules", "/lib/modules") for d in glob.glob(root + base + "/*")}
    if kernels and release not in kernels:
        return f"the running kernel {release} is no longer installed"
    # A kernel installed since the last boot isn't running yet. ctime, not mtime: packages keep their build date
    # as mtime, but the ctime is when the file was written. Debian's /run/reboot-required can go missing.
    boot = psutil.boot_time()
    installed = [
        (os.stat(p).st_ctime, os.path.basename(os.path.dirname(p)) if p.endswith("/vmlinuz") else os.path.basename(p).removeprefix("vmlinuz-"))
        for pat in ("/boot/vmlinuz-*", "/usr/lib/modules/*/vmlinuz") for p in glob.glob(root + pat)
    ]
    newer = sorted((t, name) for t, name in installed if t > boot and name != release)
    if newer:
        return f"kernel {newer[-1][1]} was installed after the last boot"
    return mgr.reboot(root, home) if mgr.reboot else None


@contextmanager
def scratch_home(root: str, owner: int) -> Iterator[str]:
    # A HOME on the host for one run (dnf5 writes its log there), owned by whoever the run is as
    path = tempfile.mkdtemp(prefix="kongo-updates-", dir=root + "/tmp")
    try:
        os.chown(path, owner, owner)
        yield path[len(root):]
    finally:
        shutil.rmtree(path, ignore_errors=True)


def lists_updated(root: str, mgr: Manager, refreshed: float) -> float:
    # A refresh that found nothing new may leave every file as it was
    return max(newest_mtime(root, mgr.lists), refreshed)


def refresh(root: str, mgr: Manager) -> None:
    with scratch_home(root, 0) as home:
        mgr.update(root, home)


def check(root: str, mgr: Manager, refreshed: float) -> dict:
    with scratch_home(root, NOBODY) as home:
        packages = sorted(mgr.check(root, home), key=lambda p: (not p["security"], p["name"]))
        reboot = reboot_reason(root, mgr, home)
    return {
        "manager": mgr.name,
        "upgrade": mgr.upgrade,
        "packages": packages,
        "lists_updated": lists_updated(root, mgr, refreshed),
        "checked": time.time(),
        "reboot": reboot,
    }
