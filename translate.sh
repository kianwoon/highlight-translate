/usr/bin/python3 << 'PY'
import sys, json, urllib.parse, urllib.request

# Read selected text from stdin (fallback to clipboard if empty)
sel = sys.stdin.read().strip()
if not sel:
    import subprocess
    sel = subprocess.run(["pbpaste"], capture_output=True, text=True).stdout.strip()
    if not sel:
        print("")  # must return *something* to Automator
        sys.exit(0)

q = urllib.parse.quote(sel)
url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q={q}"

with urllib.request.urlopen(url, timeout=10) as r:
    data = json.loads(r.read().decode("utf-8"))

# Stitch fragments
out = "".join(chunk[0] for chunk in data[0] if chunk[0])
# Print to stdout: Automator treats this as the Quick Action's *output*
print(out.strip())
PY
