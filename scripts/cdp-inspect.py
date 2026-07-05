#!/usr/bin/env nix-shell
#!nix-shell -i python3 -p "python3.withPackages(ps: [ps.websocket-client])"
"""
Read the rendered health-sync app from the controllable Chrome on the Mac
(launched with --remote-debugging-port=9222 — see
~/Code/xinutec-infra/mac-mini/chrome-debug.sh). Attaches to the tab whose
URL contains MATCH (default "health.xinutec.org") so we judge the UI from
the actual render, not the source.

Usage:
  cdp-inspect.py text            # innerText of the matched tab's <body>
  cdp-inspect.py eval '<js>'     # evaluate JS in the matched tab
  cdp-inspect.py shot <path>     # screenshot the matched tab to a PNG
  cdp-inspect.py [text] --match <substr>
"""
import base64
import json
import sys
import urllib.request
from websocket import create_connection

DEBUG = "http://localhost:9222"


def pick_page(match):
    pages = json.load(urllib.request.urlopen(f"{DEBUG}/json"))
    cand = [p for p in pages if p.get("type") == "page" and match in p.get("url", "")]
    if not cand:
        sys.exit(f"No page target with '{match}' in its URL. Open it first.")
    return cand[0]


class CDP:
    def __init__(self, ws_url):
        self.ws = create_connection(ws_url, max_size=None, suppress_origin=True)
        self._id = 0

    def send(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def evaluate(self, expr):
        r = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        return r.get("result", {}).get("value")


def main():
    args = sys.argv[1:]
    match = "health.xinutec.org"
    if "--match" in args:
        i = args.index("--match")
        match = args[i + 1]
        del args[i:i + 2]
    cmd = args[0] if args else "text"

    page = pick_page(match)
    cdp = CDP(page["webSocketDebuggerUrl"])
    cdp.send("Runtime.enable")

    if cmd == "text":
        print("URL:", page.get("url"))
        print("TITLE:", cdp.evaluate("document.title"))
        print("---")
        print(cdp.evaluate("document.body.innerText"))
    elif cmd == "eval":
        print(json.dumps(cdp.evaluate(args[1]), indent=2, ensure_ascii=False))
    elif cmd == "shot":
        cdp.send("Page.enable")
        r = cdp.send("Page.captureScreenshot", {"format": "png"})
        out = args[1] if len(args) > 1 else "/tmp/health-shot.png"
        with open(out, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        print(out)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
