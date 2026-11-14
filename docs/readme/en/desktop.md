# 🖥 Desktop App (Windows Installer)

> [⬅ Back to README](../../../README.md)

Install LoopAgent as a **regular desktop application**: double-click the icon and a window opens — **no Node.js, no browser, no command line**.

---

### 1. Choose Your Installation Method

Build artifacts land in `dist-desktop/` as two exes — **pick one** for your situation:

| Artifact | Best for | Notes |
|---|---|---|
| `LoopAgent-Setup-<version>-x64.exe` | **Recommended.** Everyday office machines | Guided wizard install, lets you choose the install directory, creates Desktop and Start Menu shortcuts, uninstallable from "Settings → Apps" |
| `LoopAgent-Portable-<version>-x64.exe` | Company policy forbids installing software (nothing gets registered with the system) | Single-file, no install. Drop it in any folder (including paths with spaces or non-ASCII characters) and double-click. Delete the file to "uninstall" |

> Both are fully equivalent and built from the same code. The only difference is whether the app registers itself with the system.
>
> **Want it on drive D:?** The installer now **lets you choose the directory** (via the "Choose Install Location" page). If your company forbids installing software at all, use the portable build instead.

### 2. Install (Installer Method)

1. Double-click `LoopAgent-Setup-<version>-x64.exe`
2. **The first run triggers SmartScreen** (see next section) — click "More info → Run anyway"
3. Walk through the wizard:
   - **Choose Install Location** (change it to e.g. `D:\Programs\LoopAgent`, or just click "Next" to keep the default)
   - **Installing**: the progress bar runs to completion
   - **Finish**: optionally tick "Run LoopAgent" to launch it right away
4. A **LoopAgent** icon appears on your Desktop — double-click to launch

The whole process takes roughly 10–30 seconds and requires **no administrator rights and shows no UAC elevation prompt**.

The default install location (if you don't change it in the wizard) is inside your user profile:

```text
%LOCALAPPDATA%\Programs\LoopAgent\
   LoopAgent.exe                 ← the app (double-click this one)
   resources\loop-agent-core.exe ← backend service (started automatically, no manual run)
   resources\app.asar            ← UI code
   ...
```

> **Why `LOCALAPPDATA` by default and not `Program Files`**: writing to `Program Files` requires elevation, and field machines usually run **non-administrator accounts** — one UAC prompt and the install fails. Defaulting to the user profile is what lets a non-admin account click through the wizard successfully.
>
> **You will never see an "install for all users" option**: the wizard deliberately skips that page — it writes to `Program Files` and triggers elevation, which is a pure failure path for non-admin accounts. So every account installs per-user, with no administrator rights needed.
>
> Need it on drive D:? Just change the path on the "Choose Install Location" page.

### 3. First Run: SmartScreen Prompt

The app is **not code-signed** (no signing certificate available), so Windows intercepts it once. This is expected behavior, not malware:

1. A blue "**Windows protected your PC**" box appears
2. Click "**More info**" on the left
3. Click "**Run anyway**" at the bottom right

![SmartScreen interception: click "More info" → "Run anyway"]

Subsequent launches on the same machine are not intercepted.

> If double-clicking does **nothing at all, with no prompt**: your antivirus is silently quarantining it. Add the exe from `dist-desktop` to your security software's allowlist, or use the portable build from a non-scanned folder.

### 4. Using the App

After double-clicking the icon:

1. The app **starts the backend in the background** and waits for readiness (usually 1–3 s)
2. The window loads the UI and drops you straight into a conversation
3. **Set your model API key in "Settings"** on first use (identical to the Web UI)

**About ports**: the app starts at **3000** and automatically falls through to 3001, 3002, … if that port is taken (e.g. you also have `npm run serve` or another instance running). **No configuration needed** — the window connects to whatever port was actually used.

**Closing the window quits the app**: the backend process exits cleanly too, leaving nothing behind in Task Manager.

### 5. Where Your Data Lives

Configuration, sessions and memory all live in your user profile, **separate from the program itself**:

```text
%USERPROFILE%\.loop-agent\
```

| Content | Location |
|---|---|
| App config (incl. API keys) | `%USERPROFILE%\.loop-agent\config.json` |
| Session history | `%USERPROFILE%\.loop-agent\sessions\` |
| Memory (SOUL / USER / MEMORY) | `.loop-agent\` and memory files under the project workspace |

> Upgrading, reinstalling, or moving the portable build **never loses data** — data is not stored in the program directory.

### 6. Uninstall

**Installer method**:

- "Settings → Apps → Installed apps" → find **LoopAgent** → Uninstall
- Or "Start Menu → LoopAgent → Uninstall"
- **Quit the app first** (just close the window) so the backend isn't holding files open
- Uninstalling clears the program directory and **does not delete `%USERPROFILE%\.loop-agent`**

**Portable method**: just delete the exe. No registry entries, no leftovers.

> **Full removal** (including all conversations and config): after uninstalling, manually delete the `%USERPROFILE%\.loop-agent` folder.
> ⚠ This is irreversible — back up important sessions first.

### 7. Building From Source (Developers)

Build everything in one shot:

```bash
npm run build:desktop
```

The script runs 6 stages in order and stops with guidance on the first failure:

| Stage | Action | Validation |
|---|---|---|
| 1 | `npm run build:webui` | Produces `webui/dist/index.html` |
| 2 | `npm run build:sea` | Produces `dist-sea/loop-agent.exe` |
| 3 | **Verify SEA has WebUI embedded** | See note below |
| 4 | `npm --prefix desktop run build` | Produces `desktop/dist/main.cjs` |
| 5 | Prepare resources | Renames/copies the backend to `desktop/resources/loop-agent-core.exe` |
| 6 | `electron-builder --win --x64` | Produces both exes in `dist-desktop/` |

> **Stage 3 is a mandatory guard**: in the installed layout there is **no `webui/dist` directory** under `resources/`, so the UI can only come from SEA's embedded assets. Yet `build-sea.mjs` merely prints a one-line notice when `webui/dist` is missing — it **does not error or abort**. Letting that slide produces a package that "builds fine, installs fine, shows a blank window on launch". The script therefore hard-checks whether `build:sea` output contains "内嵌 WebUI 资源: N 个文件" (embedded WebUI assets: N files) and fails out if it doesn't.
>
> To confirm the guard actually works: temporarily rename `webui/dist`, re-run `npm run build:desktop`, and observe it **fail explicitly** instead of producing an installer.

**The first build downloads the Electron binary** (~100 MB). If it stalls or times out, set a mirror and retry:

```bash
# PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm run build:desktop
```

**Build requirements**: Node.js ≥ 20.10; build Windows artifacts on Windows (no cross-compilation — see [SEA single-file deployment](./sea-deployment.md)).

**Artifact sizes** (measured): backend SEA single file 102.2 MB, installer 123.8 MB, portable 114.2 MB, installed footprint 426.5 MB.

### 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Double-click does nothing | Antivirus silently quarantined it / SmartScreen suppressed | Add to allowlist; or right-click → Properties → check "Unblock"; or use the portable build |
| Blank window | WebUI wasn't embedded at build time (self-built packages only) | Re-run `npm run build:desktop` and confirm stage 3 passes |
| Port already in use | Something else owns 3000 | No action needed — the app falls through to the next port |
| Shortcut does nothing but a process is running | Single-instance lock left by a previous crash | End `LoopAgent.exe` in Task Manager and relaunch |
| Want a different install drive | You kept the default path during install | Reinstall and change the path on "Choose Install Location"; or just use the portable build on your target drive |
| Config survives uninstall | By design — data is separate from the program | Delete `%USERPROFILE%\.loop-agent` manually if needed |

---

> The desktop app and the browser path (`npm run serve` + open browser) are **fully independent** and can be used side by side.
> For the browser path see [Web UI](./web-ui.md); for the single-file backend see [SEA single-file deployment](./sea-deployment.md).
