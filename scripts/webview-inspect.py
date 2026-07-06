#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p "python3.withPackages(ps: [ps.websocket-client])" -p android-tools
"""
Inspect the on-device Android WebView of the health app directly, over the
Chrome DevTools protocol. The wrapper enables WebView remote debugging on
debug builds (MainActivity: setWebContentsDebuggingEnabled), which exposes a
`webview_devtools_remote_<pid>` unix socket; this forwards a local TCP port to
it and drives CDP against the live dashboard — the same capability as
`cdp-inspect.py`, but for the phone's WebView instead of the Mac's Chrome.

The device is picked by MODEL (Pixel 9), never by IP — DHCP/VPN drift the
address, and a Pixel 5 is often also adb-connected. Pass --device to override.

Usage (from repo root or anywhere):
  scripts/webview-inspect.py url                 # current page URL
  scripts/webview-inspect.py text                # body innerText (what's on screen)
  scripts/webview-inspect.py eval '<js>'         # evaluate JS in the page, print result
  scripts/webview-inspect.py console [secs]      # stream console + uncaught errors (default 30s)
  scripts/webview-inspect.py net [secs]          # stream network requests/responses (default 30s)

Options:
  --device <ip:port|serial>   target device (default: auto-pick the Pixel 9)
  --package <id>              app package (default: org.xinutec.health)
  --match <substr>           page URL substring to attach to (default: health.xinutec.org)
  --port <n>                 local forward port (default: 9333)

`eval` awaits promises and returns by value, so async probes work, e.g.:
  scripts/webview-inspect.py eval "fetch('/api/me').then(r=>r.status)"
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request
from websocket import create_connection

DEFAULT_PACKAGE = "org.xinutec.health"
DEFAULT_MATCH = "health.xinutec.org"
DEFAULT_MODEL = "Pixel 9"
# Endpoints to probe when auto-picking: persistent tcpip :5555 on the VPN IP
# (stable) then the LAN DHCP reservation. Mirrors android/deploy.sh.
CANDIDATE_ENDPOINTS = ["10.100.0.12:5555", "192.168.1.133:5555"]


def adb(*args, device=None):
    cmd = ["adb"] + (["-s", device] if device else []) + list(args)
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


def pick_device(explicit):
    if explicit:
        adb("connect", explicit)
        return explicit
    # Try the known endpoints, then whatever is already attached; keep only a
    # device that really reports itself as the target model.
    for ep in CANDIDATE_ENDPOINTS:
        adb("connect", ep)
    listing = adb("devices").splitlines()[1:]
    serials = [ln.split()[0] for ln in listing if ln.strip() and "device" in ln.split()]
    for s in serials:
        if adb("shell", "getprop", "ro.product.model", device=s) == DEFAULT_MODEL:
            return s
    sys.exit(f"No '{DEFAULT_MODEL}' on adb. Attached: {serials or '(none)'}. Pass --device.")


def forward_devtools(device, package, port):
    pid = adb("shell", "pidof", package, device=device)
    if not pid:
        sys.exit(f"{package} is not running on {device}. Open the app first.")
    pid = pid.split()[0]
    socket = f"webview_devtools_remote_{pid}"
    adb("forward", f"tcp:{port}", f"localabstract:{socket}", device=device)
    return socket


def pick_page(port, match):
    pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
    cand = [p for p in pages if match in p.get("url", "") and p.get("webSocketDebuggerUrl")]
    if not cand:
        urls = ", ".join(p.get("url", "?") for p in pages) or "(no pages)"
        sys.exit(f"No WebView page with '{match}' in its URL. Open pages: {urls}")
    return cand[0]


class CDP:
    def __init__(self, ws_url, timeout=15):
        self.ws = create_connection(ws_url, max_size=None, suppress_origin=True)
        self._id = 0
        self._timeout = timeout

    def call(self, method, params=None):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        # A backgrounded WebView is paused and won't service evaluates — bound the
        # wait so we fail with a clear hint instead of blocking forever.
        self.ws.settimeout(self._timeout)
        deadline = time.time() + self._timeout
        while True:
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                if time.time() >= deadline:
                    sys.exit(f"timed out waiting for '{method}' — is the health app in the foreground? "
                             "(a backgrounded WebView is paused). Open it and retry.")
                continue
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def evaluate(self, expr):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        res = r.get("result", {})
        return res.get("value", res.get("description"))

    def stream(self, seconds, on_event):
        deadline = time.time() + seconds
        self.ws.settimeout(1.0)
        while time.time() < deadline:
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                continue
            if "method" in msg:
                on_event(msg["method"], msg.get("params", {}))


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("mode", choices=["url", "text", "eval", "console", "net"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--device")
    ap.add_argument("--package", default=DEFAULT_PACKAGE)
    ap.add_argument("--match", default=DEFAULT_MATCH)
    ap.add_argument("--port", type=int, default=9333)
    a = ap.parse_args()

    device = pick_device(a.device)
    forward_devtools(device, a.package, a.port)
    page = pick_page(a.port, a.match)
    cdp = CDP(page["webSocketDebuggerUrl"])

    if a.mode == "url":
        print(cdp.evaluate("location.href"))
    elif a.mode == "text":
        print(cdp.evaluate("document.body.innerText"))
    elif a.mode == "eval":
        if not a.arg:
            sys.exit("eval needs a JS expression argument")
        v = cdp.evaluate(a.arg)
        print(v if isinstance(v, str) else json.dumps(v))
    elif a.mode == "console":
        secs = int(a.arg) if a.arg else 30
        cdp.call("Runtime.enable")
        cdp.call("Log.enable")
        print(f"streaming console for {secs}s… (Ctrl-C to stop)", file=sys.stderr)

        def on(method, p):
            if method == "Runtime.consoleAPICalled":
                args = " ".join(str(x.get("value", x.get("description", ""))) for x in p.get("args", []))
                print(f"[{p.get('type')}] {args}")
            elif method == "Log.entryAdded":
                e = p.get("entry", {})
                print(f"[{e.get('level')}] {e.get('text')}  {e.get('url','')}")
            elif method == "Runtime.exceptionThrown":
                d = p.get("exceptionDetails", {})
                print(f"[exception] {d.get('text')} {d.get('url','')}:{d.get('lineNumber','')}")

        cdp.stream(secs, on)
    elif a.mode == "net":
        secs = int(a.arg) if a.arg else 30
        cdp.call("Network.enable")
        print(f"streaming network for {secs}s… (Ctrl-C to stop)", file=sys.stderr)

        def on(method, p):
            if method == "Network.requestWillBeSent":
                r = p.get("request", {})
                print(f"→ {r.get('method')} {r.get('url')}")
            elif method == "Network.responseReceived":
                r = p.get("response", {})
                print(f"← {r.get('status')} {r.get('url')}")

        cdp.stream(secs, on)


if __name__ == "__main__":
    main()
