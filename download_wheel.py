"""下载 PyPI wheel 到本地（全量下载，无断点续传）。"""
import json
import os
import sys
import time
import urllib.request


def download(pkg, version, out_dir, platform_tag=None):
    url = f"https://pypi.org/pypi/{pkg}/{version}/json"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.load(r)
            break
        except Exception as e:
            print(f"meta attempt {attempt} failed: {e}", flush=True)
            time.sleep(2)
    files = data["urls"]
    if platform_tag:
        files = [f for f in files if platform_tag in f["filename"]]
    if not files:
        print(f"No wheel for {pkg}=={version} tag={platform_tag}", flush=True)
        sys.exit(1)
    best = None
    for f in files:
        if "win_amd64" in f["filename"] and platform_tag in f["filename"]:
            best = f
            break
    if best is None:
        best = files[0]
    fname = best["filename"]
    fpath = os.path.join(out_dir, fname)
    expected = best.get("size", 0)
    if os.path.exists(fpath) and expected and os.path.getsize(fpath) >= expected:
        print(f"SKIP exists {fname}", flush=True)
        return fpath
    # 全量下载（PyPI CDN 不支持 Range 续传）
    req = urllib.request.Request(best["url"], headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=600) as src, open(fpath, "wb") as dst:
        total = 0
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            dst.write(chunk)
            total += len(chunk)
    size = os.path.getsize(fpath)
    if expected and size < expected:
        print(f"INCOMPLETE {fname} {size}/{expected}, retry", flush=True)
        os.remove(fpath)
        time.sleep(1)
        return download(pkg, version, out_dir, platform_tag)
    print(f"OK {fpath} ({size} bytes)", flush=True)
    return fpath


if __name__ == "__main__":
    os.makedirs("D:/trae_workspace/loop-agent-command/wheels", exist_ok=True)
    download(sys.argv[1], sys.argv[2], "D:/trae_workspace/loop-agent-command/wheels",
             sys.argv[3] if len(sys.argv) > 3 else None)
