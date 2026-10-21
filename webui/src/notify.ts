// Notify：后台完成提醒（Task-20261021-002-07）
//
// 两条感知通道：
// - 系统通知（Web Notification）：仅 document.hidden || !document.hasFocus() 时发（D3，
//   前台已有页内 toast，双通道重复打扰）；tag=sessionId 同会话通知互替防刷屏（D6）；
//   silent:true 避免系统声与 WebAudio 提示音双响
// - 提示音（WebAudio 合成双音 880→1320Hz，D5）：AudioContext 在开关手势中懒创建并 resume
//   （自动播放策略要求手势解锁），零音频资源依赖
//
// 权限请求只发生在用户手势（点开 🔔 面板勾选）中（D4）；asked 标记持久化，防止重复引导。
// 非安全上下文（局域网 IP + http）：Notification API 不可用，静默降级仅提示音 + 页内提示。

/** 通知设置（localStorage 持久化） */
export interface NotifySettings {
  /** 系统通知开关（默认关：首次使用需用户显式开启并授权） */
  system: boolean;
  /** 提示音开关（默认开：无授权依赖，随后台完成即响） */
  sound: boolean;
  /** 是否已展示过一次性开启引导（防重复打扰） */
  asked: boolean;
}

const KEY = 'loop-agent.notify';

/** 读取设置（损坏/缺失回退默认值） */
export function getNotifySettings(): NotifySettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<NotifySettings>;
      return { system: p.system === true, sound: p.sound !== false, asked: p.asked === true };
    }
  } catch {
    /* 静默 */
  }
  return { system: false, sound: true, asked: false };
}

/** 合并写入设置 */
export function setNotifySettings(patch: Partial<NotifySettings>): void {
  try {
    const next = { ...getNotifySettings(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 静默 */
  }
}

/** 系统通知能力是否可用（安全上下文 + API 存在） */
export function notifySupported(): boolean {
  try {
    return typeof window !== 'undefined' && window.isSecureContext === true && 'Notification' in window;
  } catch {
    return false;
  }
}

/**
 * 请求通知权限（仅开关手势中调用，D4）。
 * 返回最终权限；unsupported 时返回 'denied'。
 */
export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!notifySupported()) return 'denied';
  try {
    if (Notification.permission === 'granted') return 'granted';
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/** 后台完成提醒的输入（status 区分标题文案） */
export interface NotifyRunDoneInput {
  sessionId: string;
  /** 会话标题（无标题时用 id 兜底） */
  title: string;
  status: 'done' | 'failed' | 'aborted';
  durationMs?: number;
  iterations?: number;
}

const STATUS_TEXT: Record<NotifyRunDoneInput['status'], string> = {
  done: '已完成',
  failed: '已失败',
  aborted: '已停止',
};

/**
 * 发送后台完成的系统通知（授权 granted 才发；title 按 status 区分）。
 * 点击通知：聚焦窗口并回跳对应会话（D7，多窗口下 Notification 默认行为不可靠，显式处理）。
 * 返回是否实际发出。
 */
export function notifyRunDone(n: NotifyRunDoneInput): boolean {
  if (!notifySupported() || Notification.permission !== 'granted') return false;
  const stText = STATUS_TEXT[n.status];
  const sec = n.durationMs !== undefined ? `${(n.durationMs / 1000).toFixed(1)}s` : '';
  const iter = n.iterations !== undefined ? ` · ${n.iterations} 轮` : '';
  const body = [sec, iter].filter(Boolean).join(' ') || '点击查看会话';
  try {
    const notif = new Notification(`会话${stText}：${n.title || n.sessionId}`, {
      body,
      tag: n.sessionId,
      silent: true,
    });
    notif.onclick = (): void => {
      try {
        window.focus();
        location.hash = `#/chat?session=${encodeURIComponent(n.sessionId)}`;
      } catch {
        /* 静默 */
      }
      notif.close();
    };
    return true;
  } catch {
    return false;
  }
}

/** AudioContext 懒创建（首次开关手势中 resume，解锁自动播放） */
let audioCtx: AudioContext | null = null;

/**
 * 播放完成提示音：双音 880→1320Hz 各 80ms（D5）。
 * AudioContext 懒创建；被自动播放策略阻止时静默失败（下次手势再解锁）。
 */
export function playChime(): void {
  try {
    type AudioCtor = new () => AudioContext;
    const Ctor: AudioCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const t0 = audioCtx.currentTime;
    // 双音：880Hz（0-80ms）→ 1320Hz（80-160ms），正弦波 + 0.05 增益
    const tones: Array<[OscillatorType, number, number]> = [
      ['sine', 880, 0],
      ['sine', 1320, 0.08],
    ];
    for (const [type, freq, offset] of tones) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.08);
    }
  } catch {
    /* 自动播放策略 / 无音频设备：静默 */
  }
}

/** 释放音频上下文（单测清理用；普通运行无需调用） */
export function disposeAudio(): void {
  try {
    void audioCtx?.close();
  } catch {
    /* 静默 */
  }
  audioCtx = null;
}
