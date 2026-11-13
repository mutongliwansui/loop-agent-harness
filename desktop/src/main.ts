import { app, BrowserWindow, screen } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveBackend } from './backend-path.js';
import { startBackend, type BackendHandle } from './backend-process.js';
import { pickPort } from './port.js';
import { waitForHealth } from './health.js';
import { toUserFacing } from './errors.js';
import { readShellConfig } from './config.js';
import { gracefulQuit, installSingleInstance } from './lifecycle.js';
import { buildOverlayCleanupScript, buildOverlayScript } from './quit-overlay.js';
import {
  loadWindowState,
  saveWindowState,
  isStateVisible,
  MIN_HEIGHT,
  MIN_WIDTH,
} from './window-state.js';
import {
  buildActionPollScript,
  buildErrorHtml,
  buildLoadingHtml,
  buildStageScript,
  normalizeAction,
  toDataUrl,
  type SplashAction,
  type SplashStage,
} from './splash.js';

/** 端口竞态重试次数：探测后到 spawn 之间端口可能被抢占（D1-3 边界） */
const PORT_RETRY = 1;

/** 窗口 move/resize 写盘防抖（设计 2.1：500ms） */
const SAVE_STATE_DEBOUNCE_MS = 500;

/** 错误页动作轮询间隔：按钮点击是低频操作，300ms 足够且几乎不耗 CPU */
const ACTION_POLL_MS = 300;

/**
 * 应用名（决定 userData 目录：Win 下 %APPDATA%\LoopAgent）。
 *
 * 必须在任何 app.getPath('userData') 之前调用。不设的话会取 package.json 的
 * name（loop-agent-desktop），窗口状态文件就落到一个与产品名无关的目录里。
 */
app.setName('LoopAgent');

/** 开发期仓库根：dist/main.cjs → 上两级 */
function resolveRepoRoot(): string {
  return join(dirname(__filename), '..', '..');
}

/**
 * 应用图标路径（D3-6：1024×1024 PNG 为唯一源，.ico 由任务 04 的构建流程生成）。
 *
 * 打包后图标由 electron-builder 写进 exe 资源；这里的 PNG 主要解决开发期
 * 与任务栏显示的临时观感，找不到就静默跳过（不能让图标缺失阻断启动）。
 */
function resolveIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'assets', 'icon.png')]
    : [join(resolveRepoRoot(), 'desktop', 'assets', 'icon.png')];
  return candidates.find((p) => existsSync(p));
}

let backend: BackendHandle | null = null;
let mainWindow: BrowserWindow | null = null;
/** 主动退出流程已启动（关停序列只跑一次，见 D2-1 幂等要求） */
let quitting = false;
/** move/resize 写盘防抖计时器 */
let saveTimer: NodeJS.Timeout | null = null;
/** 错误页动作轮询计时器 */
let actionTimer: NodeJS.Timeout | null = null;

function log(msg: string): void {
  console.log(msg);
}

/** 保存当前窗口状态到 userData/window-state.json（原子写，失败不影响使用） */
function persistWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 最大化时 getBounds 返回的是屏幕尺寸，恢复时会得到一个「假的」最大化窗口，
  // 因此存 getNormalBounds（最大化前的还原尺寸）
  const bounds = mainWindow.getNormalBounds();
  saveWindowState(
    app.getPath('userData'),
    {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: mainWindow.isMaximized(),
    },
    log,
  );
}

/** 防抖保存：拖拽/缩放过程中事件极密集，逐次写盘既慢又可能写坏 */
function scheduleSaveState(): void {
  if (quitting) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistWindowState();
  }, SAVE_STATE_DEBOUNCE_MS);
}

/** 取消尚未触发的防抖写盘（关窗时先落盘再走关停流程） */
function flushSaveState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persistWindowState();
}

/**
 * 建窗口并渲染加载页（D3-4）。
 *
 * 先本地渲染加载页而不是直接 loadURL 后端：后端未就绪时 loadURL 会显示
 * ERR_CONNECTION_REFUSED 错误页，用户会以为程序坏了。
 */
async function createWindowWithSplash(): Promise<BrowserWindow> {
  const userData = app.getPath('userData');
  const state = loadWindowState(userData, log);
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const visible = isStateVisible(state, workAreas);
  if (!visible && state.x !== undefined) {
    log('[window] 保存的位置已不在任何显示器内，回退到居中显示');
  }

  const win = new BrowserWindow({
    // 位置不可见时不给 x/y，交给 Electron 居中（D3-3 回退）
    ...(visible && state.x !== undefined && state.y !== undefined
      ? { x: state.x, y: state.y }
      : {}),
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // 先隐藏，等 ready-to-show 再显示，避免白屏闪一下（D1-7）
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#14171c',
    ...(resolveIconPath() ? { icon: resolveIconPath() } : {}),
    title: 'LoopAgent',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  // 最大化必须在 setBounds 之后单独调用（设计 3.3：先 setBounds 再 maximize）
  if (state.maximized) win.maximize();

  win.on('resize', scheduleSaveState);
  win.on('move', scheduleSaveState);
  win.on('maximize', scheduleSaveState);
  win.on('unmaximize', scheduleSaveState);
  win.on('close', onWindowClose);
  win.on('closed', () => {
    mainWindow = null;
  });

  await win.loadURL(toDataUrl(buildLoadingHtml('starting')));
  return win;
}

/** 切换加载页阶段文案（脚本执行失败不阻断启动） */
async function setStage(win: BrowserWindow, stage: SplashStage): Promise<void> {
  try {
    await win.webContents.executeJavaScript(buildStageScript(stage));
  } catch {
    // 页面可能尚未 ready 或已跳走，忽略即可
  }
}

/**
 * 启动后端并等就绪。
 *
 * 端口竞态处理：探测到空闲端口后到真正 spawn 之间可能被别的进程抢占，
 * 表现为后端秒退且日志含 EADDRINUSE。此时换下一个端口重试一次。
 */
async function bootBackend(onStage?: (stage: SplashStage) => void): Promise<BackendHandle> {
  const target = resolveBackend({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    exeDir: dirname(app.getPath('exe')),
    repoRoot: resolveRepoRoot(),
  });

  // 首选端口来自 ~/.loop-agent/config.json 的 api.port（D3-2：跟用户设置走）
  const cfg = readShellConfig();
  let lastErr: unknown;
  let lastTail = '';

  for (let attempt = 0; attempt <= PORT_RETRY; attempt += 1) {
    const port = await pickPort(cfg.port);
    onStage?.('waiting');
    const handle = startBackend(target, port, { cwd: homedir() });

    try {
      await waitForHealth({
        port,
        // 后端提前退出时中断等待，尽快把日志尾部交给错误页，而不是干等 60s
        isAlive: () => handle.isAlive(),
        timeoutMs: 60_000,
      });
      return handle;
    } catch (err) {
      lastTail = handle.tail();
      const raced = !handle.isAlive() && /EADDRINUSE/.test(lastTail);
      await handle.stop();
      lastErr = err;
      if (!raced || attempt === PORT_RETRY) break;
    }
  }

  // 把后端日志尾部挂到错误上，供错误页原样展示
  if (lastErr && typeof lastErr === 'object') {
    const withTail = lastErr as { tail?: string };
    if (!withTail.tail) withTail.tail = lastTail;
  }
  throw lastErr;
}

/** 让窗口重新显示到前台（单实例二次启动的响应，D2-5） */
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * 关窗拦截（任务 02 P0）。
 *
 * 不能直接让窗口关掉再在 before-quit 里处理：窗口一关就没了遮罩可见区域，
 * 用户看不到「正在整理记忆」，会以为程序卡死并去任务管理器强杀。
 * 因此先 preventDefault 留住窗口，把遮罩画上，等后端退干净再真正退出。
 */
function onWindowClose(event: Electron.Event): void {
  if (quitting) {
    // 已在关停中：重复点关闭直接忽略（幂等，见任务文档 3.3）
    event.preventDefault();
    return;
  }
  event.preventDefault();
  // 关窗即最后一次机会：先把窗口状态落盘，再走关停序列
  flushSaveState();
  void quitApp();
}

/** 停止错误页的动作轮询 */
function stopActionPoll(): void {
  if (actionTimer) {
    clearInterval(actionTimer);
    actionTimer = null;
  }
}

/**
 * 在窗口内展示错误页，并等待用户选择「重试」或「退出」（D3-5）。
 *
 * 用窗口内页面替换原生 dialog：原生对话框不能滚动、复制日志困难，
 * 而且日志一长（8KB 尾部）就会被截断看不全。
 */
async function showErrorPage(err: unknown): Promise<void> {
  const info = toUserFacing(err);
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    // 窗口都建不出来时没有可渲染的容器，只能退回控制台输出后退出
    console.error(`[fatal] ${info.title}：${info.detail}\n${info.tail ?? ''}`);
    app.exit(1);
    return;
  }

  stopActionPoll();
  await win.loadURL(
    toDataUrl(
      buildErrorHtml({
        title: info.title,
        detail: info.detail,
        logTail: info.tail,
      }),
    ),
  );
  if (!win.isVisible()) win.show();

  actionTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopActionPoll();
      return;
    }
    mainWindow.webContents
      .executeJavaScript(buildActionPollScript())
      .then((raw: unknown) => {
        const action: SplashAction | null = normalizeAction(raw);
        if (!action) return;
        stopActionPoll();
        if (action === 'retry') void retryFromErrorPage();
        else void quitApp();
      })
      .catch(() => {
        // 页面正在切换时 executeJavaScript 会短暂失败，下一次轮询再试
      });
  }, ACTION_POLL_MS);
}

/** 错误页「重试」：重新拉起后端并加载界面 */
async function retryFromErrorPage(): Promise<void> {
  if (quitting) return;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;

  await win.loadURL(toDataUrl(buildLoadingHtml('starting')));
  try {
    const handle = await bootBackend((s) => void setStage(win, s));
    backend = handle;
    onBackendGone(handle);
    const { token } = readShellConfig();
    await attachWindow(handle.port, token);
  } catch (err) {
    await showErrorPage(err);
  }
}

/**
 * 把窗口连到后端地址（首次启动与「重试/重启后端」共用）。
 *
 * 窗口在启动时就已创建并显示加载页，这里只负责换地址，不重复建窗口。
 */
async function attachWindow(port: number, token: string): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;

  await setStage(win, 'loading-ui');
  await win.loadURL(`http://127.0.0.1:${port}`);

  // 配了 api.token 时预置前端存储，避免用户看到令牌输入门（前端 key 见 webui/src/api/client.ts）
  // 注意 localStorage 按源隔离（含端口），换端口重启后必须重新写入
  if (token) {
    await win.webContents.executeJavaScript(
      `localStorage.setItem('loop_agent_token', ${JSON.stringify(token)});`,
    );
    // 写入后重载，让前端首次请求就带上 token
    await win.webContents.reload();
  }
  if (!win.isVisible()) win.show();
}

/**
 * 后端意外退出（非主动关停）时的提示（D2-6）。
 *
 * 不自动无限重启：配置写错时自动重启会陷入重启风暴，用户只看到窗口反复闪。
 * 给「看懂 + 一键重试」的出口（错误页，见 D3-5）。
 */
function onBackendGone(handle: BackendHandle): void {
  handle.exited.then(async ({ code, signal }) => {
    if (quitting) return;
    const tail = handle.tail();
    const reason = `退出码 ${code ?? 'null'}${signal ? ` / 信号 ${signal}` : ''}`;
    backend = null;
    await showErrorPage({ name: 'BackendExitedError', message: reason, tail });
  });
}

/**
 * 主动退出：遮罩 → 请求优雅关停 → 等退出 → 超时强杀 → 进程退出（P0/P1）。
 *
 * 退出用 app.exit(0) 而不是 app.quit()：窗口 close 里做了 preventDefault，
 * app.quit() 会因「窗口没关掉」而中断退出流程；此时后端已退干净，无需再走 close。
 */
async function quitApp(): Promise<void> {
  if (quitting) return;
  quitting = true;
  stopActionPoll();

  const cfg = readShellConfig();
  const handle = backend;
  backend = null;

  if (!handle || !handle.isAlive()) {
    app.exit(0);
    return;
  }

  // 遮罩失败不能阻断关停（如页面已崩），只记日志
  try {
    await mainWindow?.webContents.executeJavaScript(buildOverlayScript(cfg.shutdownBudgetMs));
  } catch (err) {
    console.error('[quit] 遮罩注入失败：', err);
  }

  try {
    const outcome = await gracefulQuit(handle, {
      budgetMs: cfg.shutdownBudgetMs,
      token: cfg.token,
      log,
    });
    if (outcome !== 'graceful' && mainWindow && !mainWindow.isDestroyed()) {
      // 非优雅收场（强杀/已死）时撤掉遮罩，让用户能看到界面再消失，而不是停在遮罩上
      await mainWindow.webContents
        .executeJavaScript(buildOverlayCleanupScript())
        .catch(() => false);
    }
  } catch (err) {
    console.error('[quit] 关停流程异常：', err);
  }
  app.exit(0);
}

/**
 * 单实例锁（D2-5）：必须在建窗口前拿。
 * 拿不到说明已有实例在跑，二次启动的唯一效果是把那个窗口叫到前台。
 */
const isPrimary = installSingleInstance(app, focusMainWindow);
if (!isPrimary) {
  app.quit();
} else {
  // 其他途径触发的退出（如脚本 app.quit()）也要走优雅关停
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!backend || !backend.isAlive()) return;
    event.preventDefault();
    void quitApp();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.whenReady().then(async () => {
    try {
      const win = await createWindowWithSplash();
      mainWindow = win;
      const handle = await bootBackend((s) => void setStage(win, s));
      backend = handle;
      const { token } = readShellConfig();
      await attachWindow(handle.port, token);
      onBackendGone(handle);
    } catch (err) {
      await showErrorPage(err);
    }
  });
}

// 供调试确认窗口尺寸来源单一，避免各处硬编码漂移
export const SHELL_WINDOW_LIMITS = { MIN_WIDTH, MIN_HEIGHT };
