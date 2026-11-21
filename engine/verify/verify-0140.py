#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 Bogdan Shapovalov and the Fury authors

"""Does patch 0140 make a CDP click press like a real mouse?

Measured tell (ENG-INPUT, 2026-11-21): a real OS press (SendInput) reaches
the page as pointerdown with pressure 0.5 while buttons=1, because real input
never sets WebPointerProperties::force and Blink's GetPointerEventPressure
returns 0.5 for a pressed button with a NaN force. The CDP path forced
force=0, yielding pressure 0 with a button down -- a physically impossible
combination a detector can key on.

The check is Input.dispatchMouseEvent, which is also how the agent clicks
(MCP), so this covers automation as well as a person's mouse.

Usage: core/verify/verify-0140.py <core binary>
See core/verify/README.md.
"""

import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import browser
import fpconfig  # noqa: E402

CORE = sys.argv[1]
results = []


def check(ok, text):
    results.append((ok, text))
    print(f"  {'OK  ' if ok else 'FAIL'} {text}", flush=True)


PAGE = """<!doctype html><meta charset="utf-8"><title>t</title>
<script>
window.log = [];
for (const t of ['pointerdown', 'pointerup'])
  addEventListener(t, e => log.push({type: t, pressure: e.pressure, buttons: e.buttons,
                                      detail: e.detail, pointerType: e.pointerType,
                                      pointerId: e.pointerId, width: e.width, height: e.height,
                                      screenX: e.screenX, screenY: e.screenY}), {passive: true, capture: true});
</script>"""


class Pages(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data = PAGE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Pages)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{server.server_address[1]}/"


def launch():
    d = tempfile.mkdtemp(prefix="fury-0140-")
    cfg = os.path.join(d, "config.json")
    with open(cfg, "w") as f:
        json.dump({"schema_version": 1}, f)
    fd = os.open(cfg, os.O_RDONLY)
    args = [CORE, f"--user-data-dir={d}", "--remote-debugging-port=0",
            "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
            "--window-position=0,0", "--window-size=700,900", fpconfig.config_switch(fd)]
    p = subprocess.Popen(args, preexec_fn=fpconfig.config_preexec(fd), close_fds=False,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.close(fd)
    pf = os.path.join(d, "DevToolsActivePort")
    port = None
    for _ in range(300):
        if os.path.exists(pf):
            try:
                port = int(open(pf).readline().strip())
            except ValueError:
                port = None
            if port:
                break
        if p.poll() is not None:
            raise RuntimeError(f"core exited {p.returncode}")
        time.sleep(0.2)
    time.sleep(1)
    return p, browser(port), d


def stop(p, d):
    p.terminate()
    try:
        p.wait(timeout=12)
    except subprocess.TimeoutExpired:
        p.kill()
    shutil.rmtree(d, ignore_errors=True)


p, ws, d = launch()
try:
    t = ws.call("Target.createTarget", {"url": URL})["targetId"]
    s = ws.call("Target.attachToTarget", {"targetId": t, "flatten": True})["sessionId"]
    ws.call("Runtime.enable", session=s)
    time.sleep(2.5)

    def js(expr):
        r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True}, session=s)
        return r["result"].get("value")

    def mouse(kind, x, y, button="left", buttons=1, **extra):
        m = {"type": kind, "x": x, "y": y, "button": button, "buttons": buttons, "clickCount": 1}
        m.update(extra)
        ws.call("Input.dispatchMouseEvent", m, session=s)

    # 1. A plain press/release with no explicit force: a real mouse must
    #    report pressure 0.5 while the button is down.
    js("log.length = 0")
    mouse("mousePressed", 300, 300, buttons=1)
    mouse("mouseReleased", 300, 300, buttons=0)
    time.sleep(0.6)
    plain = js("log.slice()")

    # 2. An explicit force must still win over the default.
    js("log.length = 0")
    mouse("mousePressed", 300, 320, buttons=1, force=1)
    mouse("mouseReleased", 300, 320, buttons=0)
    time.sleep(0.6)
    forced = js("log.slice()")
finally:
    stop(p, d)

pd = next((e for e in plain if e["type"] == "pointerdown"), None)
pu = next((e for e in plain if e["type"] == "pointerup"), None)
fd = next((e for e in forced if e["type"] == "pointerdown"), None)

print(f"  plain press   {pd}")
print(f"  plain release {pu}")
print(f"  forced press  {fd}")

check(pd is not None and pu is not None,
      "a CDP press/release reaches the page as pointerdown/pointerup")
if pd:
    # PointerEvent.detail stays 0 on the pointer event itself (the count lives
    # on the compatibility mousedown); buttons=1 is what marks the press.
    check(pd["pointerType"] == "mouse" and pd["buttons"] == 1,
          f"it is a mouse press with buttons=1 (got {pd['buttons']})")
    check(pd["pressure"] == 0.5,
          f"pressure is 0.5 while the button is down, as a real mouse reports (got {pd['pressure']})")
if pu:
    check(pu["buttons"] == 0 and pu["pressure"] == 0,
          f"the release lifts the button and the pressure with it (got buttons {pu['buttons']}, "
          f"pressure {pu['pressure']})")
if fd:
    check(fd["pressure"] == 1,
          f"an explicit force still wins over the default (got {fd['pressure']} for force=1)")

server.shutdown()
bad = [t for ok, t in results if not ok]
print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
