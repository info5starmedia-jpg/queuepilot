"""Windows/POSIX shim for handing the persona config to the core.

POSIX scripts dup2 the config onto descriptor 3 and name --fury-fp-fd=3;
the core's Windows half (0001 patch) reads an inherited HANDLE named by
--fury-fp-file-handle instead. preexec_fn does not exist on Windows, so
the handle is marked inheritable and rides close_fds=False. Ported by
QueuePilot 2026-11-13; upstream marked this half "never run" — we run it.
"""
import os


def config_switch(fd):
    """The argv switch naming where the config arrives, for this platform."""
    if os.name == "nt":
        import msvcrt
        import ctypes
        h = msvcrt.get_osfhandle(fd)
        # HANDLE_FLAG_INHERIT = 1; without it the child never sees the handle.
        ctypes.windll.kernel32.SetHandleInformation(h, 1, 1)
        return f"--fury-fp-file-handle={h & 0xFFFFFFFF}"
    os.set_inheritable(fd, True)
    return "--fury-fp-fd=3"


def config_preexec(fd):
    """The preexec_fn that places the fd in slot 3 — POSIX only."""
    if os.name == "nt" or fd is None:
        return None
    return lambda: os.dup2(fd, 3)


def process_command_line(pid):
    """argv of a running process: ps on POSIX, CIM on Windows."""
    import subprocess
    if os.name == "nt":
        return subprocess.run(
            [
                "powershell", "-NoProfile", "-NonInteractive", "-Command",
                f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine",
            ],
            capture_output=True, text=True,
        ).stdout
    return subprocess.run(
        ["ps", "-o", "command=", "-p", str(pid)],
        capture_output=True, text=True,
    ).stdout
