# Verifying a patch on a browser that is running

`git apply --check` says a patch applies. A compiler says it builds. Neither
says it works, and three times now the difference has been the whole story: the
`--lang` conclusion was right about the source and wrong about the browser,
patch 0110 typechecked in every language it was written in and did not compile,
and patch 0082 applied, linked, and answered every `getCurrentPosition` with
"Timeout expired" because macOS asks the operating system for permission before
it asks any provider for a position.

So: scripts here drive the built core over CDP and ask it questions.

    core/verify/verify-0082.py core/src/out/macos-arm64-lowmem.noindex/Fury.app/Contents/MacOS/Fury

Each one launches the core itself with a hand-written config on fd 3 — no agent,
no relay, no proxy — so a failure is the patch and not the stack around it. They
print one line per claim and exit non-zero if any claim is false.

`cdp.py` is a CDP client in about a hundred lines. It exists because neither
node nor python-websockets is on this machine, and a verification that depends
on installing something is a verification that gets skipped.

## Writing one

State claims, not steps. "position is the configured one" is a claim; "call
getCurrentPosition" is a step, and a step cannot fail informatively.

Run headed. `--headless=new` denies notification permission by policy and
reports `navigator.webdriver`, and a browser configured in a way the product
never uses answers questions nobody asked. Park the window off-screen
(`--window-position=-4000,-4000`) instead.

Watch what the harness itself changes. `Browser.grantPermissions` *replaces* an
origin's permissions — everything not in the list becomes denied — which cost a
rebuild spent blaming patch 0090 for a result the test had caused.

## Windows (QueuePilot port, 2026-11-13)

Upstream's Windows half was written but never run; it now runs. On Windows
the config and the os_crypt key ride INHERITED HANDLES instead of fixed fds:
`--fury-fp-file-handle=<h>` and `--fury-oscrypt-file-handle=<h>` (the core's
Windows half of the same patches reads them). `fpconfig.py` is the shim —
`config_switch(fd)`, `config_preexec(fd)`, `process_command_line(pid)` —
and `harness.py` marks handles inheritable and launches with
`close_fds=False` (preexec_fn does not exist on Windows). Graceful shutdown
is CDP `Browser.close` (there is no SIGHUP).

Run: `python run-all.py "C:\qe\src\out\<outdir>\chrome.exe"`.

Host-dependent controls SKIP loudly rather than fake green:
persona==host platform (0011), persona==host screen (0020), no real GPU /
SwiftShader (0031), host at 100% on mains (0121 picks a discharging tuple
instead), Windows Hello gating the password APIs (0303, use --human), a host
sensor stack feeding desktop devicemotion (0135). A SKIP prints why; the
claim it guards is documented in the script.

Windows quirks found by running, not guessing: chrome:// pages draw a
classic 15px scrollbar (0131), DWM adds a ~16px invisible frame to outer
window width (0134), Chrome's cookie store commits on a 30s timer and
Browser.close does not wait for it (0110 polls the DB), and the cookie DB
lives at `Default\Network\Cookies` since M96.
