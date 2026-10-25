"""Install the package updates or restart the host, after a check of a Linux user's password.

The user must be root or in an admin group (sudo, wheel, admin) on the host, and the password is checked against
the host's /etc/shadow. Both actions run as transient systemd units on the host (systemd-run in a chroot into the
host's root), not inside the container: installing a Docker update restarts Docker, which would kill the
container and leave the package manager half done.
"""

import ctypes
import hmac
import os
import subprocess
import threading
import time
from collections import deque

ROOT = "/proc/1/root"
UNIT = "kongo-upgrade"
# Off unless docker-compose.yml turns it on: the page has no TLS, so the password crosses the LAN in clear text
ENABLED = os.environ.get("ADMIN_ACTIONS", "off").lower() in ("on", "1", "true", "yes")
ADMIN_GROUPS = {"sudo", "wheel", "admin"}
MAX_FAILURES = 5
LOCKOUT = 900.0
# A finished upgrade's log stays in the popup this long
SHOW_FINISHED = 3600.0


class Busy(Exception):
    pass


# libcrypt knows every hash /etc/shadow uses (yescrypt, sha512, ...); Python's crypt module is gone in 3.13
_libcrypt = ctypes.CDLL("libcrypt.so.1")
_libcrypt.crypt.restype = ctypes.c_char_p
_libcrypt.crypt.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
_crypt_lock = threading.Lock()


def crypt(password: str, setting: str) -> bytes:
    with _crypt_lock:
        return _libcrypt.crypt(password.encode(), setting.encode()) or b""


def host_file(path: str) -> list[list[str]]:
    with open(ROOT + path) as f:
        return [line.rstrip("\n").split(":") for line in f if ":" in line]


def is_admin(user: str) -> bool:
    if user == "root":
        return True
    return any(g[0] in ADMIN_GROUPS and user in g[3].split(",") for g in host_file("/etc/group") if len(g) > 3)


def admin_users() -> list[str]:
    # The users who can pass verify(): the popup's choice of user (none shown when there is just one)
    return [e[0] for e in host_file("/etc/shadow") if len(e) > 1 and e[1].startswith("$") and is_admin(e[0])]


def verify(user: str, password: str) -> bool:
    stored = next((e[1] for e in host_file("/etc/shadow") if e[0] == user and len(e) > 1), "")
    # "!" and "*" mark locked accounts; hash anyway so an unknown user takes as long as a known one
    usable = stored.startswith("$") and is_admin(user)
    got = crypt(password, stored if usable else "$6$kongo$")
    return usable and hmac.compare_digest(got, stored.encode())


class Guard:
    # Global, not per client, so guessing from several machines on the LAN is locked out too
    def __init__(self) -> None:
        self.failures: deque[float] = deque()
        self.locked_until = 0.0

    def locked_for(self) -> float:
        return max(0.0, self.locked_until - time.monotonic())

    def check(self, user: str, password: str) -> bool:
        if self.locked_for():
            return False
        if verify(user, password):
            self.failures.clear()
            return True
        now = time.monotonic()
        self.failures.append(now)
        while now - self.failures[0] > LOCKOUT:
            self.failures.popleft()
        if len(self.failures) >= MAX_FAILURES:
            self.locked_until = now + LOCKOUT
            self.failures.clear()
        return False


guard = Guard()


def host(args: list[str], ok: tuple[int, ...] | None = (0,)) -> str:
    # As root on the host; ok=None accepts any exit code
    p = subprocess.run(
        ["chroot", ROOT, *args], capture_output=True, text=True, timeout=60,
        env={"LC_ALL": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
    )
    if ok is not None and p.returncode not in ok:
        raise RuntimeError(f"{args[0]} exited {p.returncode}: {p.stderr.strip()[:300]}")
    return p.stdout


def available() -> bool:
    return ENABLED and os.path.isdir(ROOT + "/run/systemd/system")


def unit() -> dict[str, str]:
    out = host(["systemctl", "show", UNIT, "--timestamp=unix",
                "--property=ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,InvocationID"])
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def job() -> dict | None:
    props = unit()
    if not props.get("InvocationID"):
        return None

    def ts(key: str) -> float | None:
        v = props.get(key, "")
        return float(v[1:]) if v.startswith("@") else None

    if props.get("SubState") in ("start", "running"):
        state = "running"
    elif props.get("ActiveState") == "active" and props.get("Result") == "success":
        state = "done"
    else:
        state = "failed"
    log = host(["journalctl", f"_SYSTEMD_INVOCATION_ID={props['InvocationID']}", "-o", "cat", "--no-pager", "-n", "400"], ok=None)
    return {
        "state": state,
        "exit": int(props.get("ExecMainStatus") or 0),
        "started": ts("ExecMainStartTimestamp"),
        "finished": ts("ExecMainExitTimestamp"),
        "log": log.splitlines(),
    }


def status() -> tuple[bool, str]:
    # (running, when the last run ended): cheap enough for the update checker's every poll
    props = unit()
    return props.get("SubState") in ("start", "running"), props.get("ExecMainExitTimestamp", "")


def running() -> bool:
    return status()[0]


def start_upgrade(command: str) -> None:
    if running():
        raise Busy("The updates are already being installed.")
    # The last run stays loaded (RemainAfterExit) so its result and log can be shown; clear it first
    host(["systemctl", "stop", UNIT], ok=None)
    host(["systemctl", "reset-failed", UNIT], ok=None)
    host([
        "systemd-run", f"--unit={UNIT}", "--description=Kongo: install package updates",
        "--property=RemainAfterExit=yes", "--setenv=LC_ALL=C",
        # no questions from dpkg or needrestart; services are not restarted, the Restart button does that
        "--setenv=DEBIAN_FRONTEND=noninteractive", "--setenv=NEEDRESTART_MODE=l",
        "/bin/sh", "-c", command,
    ])


def restart() -> None:
    if running():
        raise Busy("Wait until the updates are installed.")
    systemctl = next(p for p in ("/usr/bin/systemctl", "/bin/systemctl") if os.path.exists(ROOT + p))
    # a few seconds' delay, so the reply reaches the browser first
    p = subprocess.run(
        ["chroot", ROOT, "systemd-run", "--unit=kongo-restart", "--collect", "--on-active=3",
         "--description=Kongo: restart the host", systemctl, "reboot"],
        capture_output=True, text=True, timeout=60, env={"LC_ALL": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
    )
    if p.returncode:
        raise Busy("A restart is already on its way.") if "already exists" in p.stderr else RuntimeError(p.stderr.strip())
