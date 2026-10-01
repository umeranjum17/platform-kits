#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Private nesting prerequisite using Desklink's cage isolation invariants.

This is not a portal/cursor acceptance test. No ambient display or seat fallback.
Outputs remain in this worktree. The enclosing namespace reaps every child.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
LIMIT = 8.0


def child():
    # bwrap uses this process as the cage's PID 1. The host tree is not mounted.
    assert os.getpid() == 1, "not private PID namespace init"
    assert not Path("/dev/input").exists()
    assert not any(Path("/dev/dri").glob("card*"))
    assert not Path("/run/dbus/system_bus_socket").exists()
    runtime = Path(os.environ["XDG_RUNTIME_DIR"])
    runtime.chmod(0o700)
    assert list(runtime.iterdir()) == [], "runtime not fresh"
    evidence = Path("/task/output/nested-smoke")
    (evidence / "namespace.txt").write_text(os.readlink("/proc/self/ns/pid"))
    home = Path(os.environ["HOME"])
    (home / ".config").mkdir(parents=True)
    sway_config = home / "sway.conf"
    sway_config.write_text("output HEADLESS-1 mode 1280x720@60Hz position 0 0\n"
                           "seat seat0 fallback true\nswaybg_command -\nxwayland disable\n")
    hypr_config = home / "hyprland.conf"
    hypr_config.write_text("monitor = ,1280x720@60,0x0,1\n"
                          "misc {\n disable_hyprland_logo = true\n"
                          " disable_splash_rendering = true\n}\n"
                          "xwayland {\n enabled = false\n}\n")
    bus_config = home / "bus.conf"
    bus_config.write_text('<busconfig><type>session</type>'
        f'<listen>unix:path={runtime}/bus</listen>'
        '<policy context="default"><allow own="*"/><allow send_destination="*"/>'
        '<allow receive_sender="*"/></policy></busconfig>')
    children = []
    logs = []
    compositor_names = []

    def start(name, args, env):
        log = (evidence / f"{name}.log").open("w")
        logs.append(log)
        process = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT)
        children.append(process)
        if name in ("sway", "hyprland"):
            compositor_names.append(name)
            (evidence / "launches.json").write_text(json.dumps(compositor_names))
        return process

    def until(process, predicate, label):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"{label} exited {process.returncode}")
            result = predicate()
            if result:
                return result
            time.sleep(0.05)
        raise RuntimeError(f"{label} readiness timeout")

    env = dict(os.environ)
    try:
        bus = start("bus", ["dbus-daemon", f"--config-file={bus_config}", "--nofork"], env)
        until(bus, lambda: (runtime / "bus").is_socket(), "private bus")
        pw = start("pipewire", ["pipewire"], env)
        until(pw, lambda: (runtime / "pipewire-0").is_socket(), "private PipeWire")
        parent_env = env | {"WLR_BACKENDS": "headless", "WLR_RENDERER": "gles2",
                            "WLR_LIBINPUT_NO_DEVICES": "1"}
        parent = start("sway", ["/task/.runtime/parent/root/usr/bin/sway", "-c", str(sway_config)], parent_env)
        def sockets():
            return sorted(p.name for p in runtime.glob("wayland-*") if p.is_socket())
        parent_socket = until(parent, lambda: sockets(), "headless parent")[0]
        child_env = env | {"WAYLAND_DISPLAY": parent_socket}
        hypr = start("hyprland", ["Hyprland", "--config", str(hypr_config)], child_env)
        child_socket = until(hypr, lambda: next((s for s in sockets() if s != parent_socket), None),
                             "nested Hyprland")
        # Socket existence is startup evidence only; protocol/source identity and
        # actual render/cursor/portal delivery still require the acceptance run.
        result = {"status": "startup-only", "parent_socket": parent_socket,
                  "child_socket": child_socket, "pid_namespace_init": True,
                  "runtime_entries": sorted(p.name for p in runtime.iterdir()),
                  "dri": sorted(p.name for p in Path("/dev/dri").iterdir()),
                  "cursor_positions": "unqualified"}
        (evidence / "inside.json").write_text(json.dumps(result, indent=2) + "\n")
    finally:
        for process in reversed(children):
            if process.poll() is None:
                process.terminate()
        for process in reversed(children):
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for log in logs:
            log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inside", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.inside:
        child()
        return 0
    output = ROOT / "output/nested-smoke"
    output.mkdir(parents=True, exist_ok=True)
    # Reject stale success from an earlier run before any deferred/failed attempt.
    (output / "inside.json").unlink(missing_ok=True)
    (output / "namespace.txt").unlink(missing_ok=True)
    (output / "launches.json").unlink(missing_ok=True)
    result = {"status": "paused", "load_limit": LIMIT, "load_before": os.getloadavg()[0],
              "cursor_positions": "unqualified", "compositor_launched": False}

    def finish(code):
        result["load_after"] = os.getloadavg()[0]
        result["load_counts"] = result["load_before"] <= LIMIT and result["load_after"] <= LIMIT
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        return 1 if code == 0 and not result["load_counts"] else code

    if result["load_before"] > LIMIT:
        result["reason"] = "load gate; no compositor launched"
        return finish(75)
    required = ["bwrap", "Hyprland", "pipewire", "dbus-daemon"]
    missing = [p for p in required if not shutil.which(p)]
    parent = ROOT / ".runtime/parent/root/usr/bin/sway"
    if not parent.is_file():
        missing.append(str(parent))
    render = Path("/dev/dri/renderD129")  # same render-only node as cited cage
    if not render.is_char_device():
        missing.append(str(render))
    if missing:
        result.update(status="failed", reason="missing prerequisites", missing=missing)
        return finish(1)
    # Block outside both locks; consistent home -> Desklink lock ordering.
    home_lock = "/home/umer/.treehouse/firstmate-8bf1b0/10/firstmate/state/heavy-jobs.lock"
    with open(home_lock, "a") as first, open("/tmp/fm-desklink-heavy.lock", "a") as second:
        fcntl.flock(first, fcntl.LOCK_EX)
        fcntl.flock(second, fcntl.LOCK_EX)
        if os.getloadavg()[0] > LIMIT:
            result["reason"] = "load gate after lock acquisition; no compositor launched"
            return finish(75)
        uid = os.getuid()
        runtime = f"/run/user/{uid}"
        command = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--as-pid-1",
            "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
            "--proc", "/proc", "--dev", "/dev", "--dir", "/dev/dri",
            "--dev-bind", str(render), str(render), "--tmpfs", "/run", "--dir", runtime,
            "--tmpfs", "/tmp", "--tmpfs", "/home", "--dir", "/home/task",
            "--bind", str(ROOT), "/task", "--chdir", "/task",
            "--setenv", "PATH", "/usr/bin", "--setenv", "LANG", "C.UTF-8",
            "--setenv", "HOME", "/home/task", "--setenv", "XDG_RUNTIME_DIR", runtime,
            "--setenv", "XDG_CONFIG_HOME", "/home/task/.config",
            "--setenv", "DBUS_SESSION_BUS_ADDRESS", f"unix:path={runtime}/bus",
            "--setenv", "DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/nonexistent",
            "--setenv", "LD_LIBRARY_PATH", "/task/.runtime/parent/root/usr/lib",
            "python3", "/task/internal/cursor-producer/nested-smoke.py", "--inside"]
        # No host home/config, runtime, tmp, /sys, card or input device is mounted.
        with (output / "launcher.log").open("w") as log:
            process = subprocess.Popen(command, env={"PATH": "/usr/bin"}, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT)
            result["cage_started"] = True
            try:
                code = process.wait(timeout=75)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                code = 124
        result.update(status="startup-only" if code == 0 else "failed", exit_code=code,
                      launcher_reaped=process.poll() is not None)
        if (output / "namespace.txt").exists():
            namespace = (output / "namespace.txt").read_text()
            assert namespace != os.readlink("/proc/self/ns/pid"), "ambient PID namespace"
            def survivors():
                found = []
                for entry in Path("/proc").iterdir():
                    if not entry.name.isdigit():
                        continue
                    try:
                        if os.readlink(entry / "ns/pid") == namespace:
                            found.append(int(entry.name))
                    except (FileNotFoundError, PermissionError, ProcessLookupError):
                        pass
                return found
            remaining = survivors()
            deadline = time.monotonic() + 3
            while remaining and time.monotonic() < deadline:
                time.sleep(0.05)
                remaining = survivors()
            result["namespace_survivors"] = remaining
            if remaining:
                result["status"] = "failed"
        if (output / "launches.json").exists():
            result["compositors_started"] = json.loads((output / "launches.json").read_text())
            result["compositor_launched"] = bool(result["compositors_started"])
    return finish(0 if result["status"] == "startup-only" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
