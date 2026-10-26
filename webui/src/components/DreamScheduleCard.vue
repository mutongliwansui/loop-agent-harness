<script setup lang="ts">
// 记忆页「自动晋升」卡片（需求 20261026-003 / 任务 20261026-003-02 D11/D12）
//
// 职责：定时开关 + 三档触发时间（每天 / 每周 / 自定义 cron）+ 服务端防抖预览 + 高级折叠 + 保存并生效。
// 边界：本组件**不做 cron 解析**；输入的每次变化都防抖后问后端 GET /memory/dream/preview，
//       错误文案与下一次触发时间全部来自 src/api/cron.ts 的单点实现。
import { computed, onMounted, ref, watch } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import StatusBadge from './StatusBadge.vue';
import {
  buildCron,
  clampInt,
  cronToState,
  DOW_LABELS,
  DEFAULT_STATE,
  fmtLocal,
  relText,
  tzLabel,
  type CronMode,
} from '../cron-ui';
import type { DreamStatus } from '../dream-types';

const props = defineProps<{ status?: DreamStatus | null; memoryEnabled?: boolean }>();
const emit = defineEmits<{ saved: []; refresh: [] }>();

interface Preview {
  ok: boolean;
  describe?: string;
  next: string[];
  error?: string;
  timezoneOffsetMin?: number;
}

const mode = ref<CronMode>('daily');
const hour = ref(3);
const minute = ref(0);
const dow = ref(1);
const rawCron = ref('0 3 * * *');
const enabled = ref(true);
const grace = ref(60);
const daysBack = ref(3);
const onExit = ref(true);

const advOpen = ref(false);
const saving = ref(false);
const preview = ref<Preview | null>(null);
/** 最近一次合法预览：cron 非法时右侧排期保持不变（D9 / 原型缺陷 2） */
const lastGood = ref<Preview | null>(null);
/** 已保存的基线（判断「有未保存改动」） */
const baseline = ref('');
const hydrated = ref(false);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let reqSeq = 0;

const ADV_KEY = 'loop_agent_dream_adv_open';

const currentCron = computed(() =>
  buildCron({ mode: mode.value, hour: hour.value, minute: minute.value, dow: dow.value, raw: rawCron.value }),
);
const cronInvalid = computed(() => preview.value !== null && !preview.value.ok);
const shown = computed<Preview | null>(() => (cronInvalid.value ? lastGood.value : preview.value));
const nextAbs = computed(() => (shown.value?.next?.[0] ? fmtLocal(shown.value.next[0]) : '—'));
const nextRel = computed(() => {
  if (!enabled.value) return '定时已关闭';
  if (cronInvalid.value) return '表达式非法，排期保持不变';
  const t = shown.value?.next?.[0];
  return t ? relText(t) : '—';
});
const afterNext = computed(() => (shown.value?.next ?? []).slice(1, 4));
const tz = computed(() => tzLabel(shown.value?.timezoneOffsetMin ?? props.status?.timezoneOffsetMin));
const snapshot = computed(() =>
  JSON.stringify([enabled.value, currentCron.value, grace.value, daysBack.value, onExit.value]),
);
const dirty = computed(() => hydrated.value && snapshot.value !== baseline.value);
const canSave = computed(() => !cronInvalid.value && !saving.value && dirty.value);

const hours = Array.from({ length: 24 }, (_, i) => i);
const minutes = Array.from({ length: 60 }, (_, i) => i);

/** 用服务端状态回填表单（首次必填；后续仅在用户无未保存改动时覆盖，避免刷掉正在编辑的内容） */
function hydrate(force = false): void {
  const d = props.status;
  if (!d) return;
  if (!force && dirty.value) return;
  const st = cronToState(d.cron || DEFAULT_STATE.raw);
  mode.value = st.mode;
  hour.value = st.hour;
  minute.value = st.minute;
  dow.value = st.dow;
  rawCron.value = d.cron || DEFAULT_STATE.raw;
  enabled.value = d.scheduleEnabled !== false;
  grace.value = clampInt(d.misfireGraceMin, 0, 24 * 60, 60);
  baseline.value = snapshot.value;
  hydrated.value = true;
}

/** 问后端预演（防抖 300ms；错误与下一次均由后端算） */
async function runPreview(): Promise<void> {
  const expr = currentCron.value;
  const seq = ++reqSeq;
  try {
    const res = await api<Preview>(`/memory/dream/preview?cron=${encodeURIComponent(expr)}`);
    if (seq !== reqSeq) return; // 已被更新的输入覆盖
    preview.value = res;
    if (res.ok) lastGood.value = res;
  } catch (e) {
    if (seq !== reqSeq) return;
    // 网络/鉴权失败不当作「表达式非法」，避免误禁用保存
    preview.value = { ok: true, next: lastGood.value?.next ?? [], describe: lastGood.value?.describe };
    if (!(e instanceof AuthError)) {
      showToast(e instanceof ApiError ? e.message : `排期预览失败：${errText(e)}`, 'error');
    }
  }
}

function schedulePreview(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runPreview();
  }, 300);
}

watch(currentCron, schedulePreview);

watch(
  () => props.status,
  () => hydrate(),
  { deep: true },
);

function pickMode(m: CronMode): void {
  mode.value = m;
}

function resetDefault(): void {
  mode.value = DEFAULT_STATE.mode;
  hour.value = DEFAULT_STATE.hour;
  minute.value = DEFAULT_STATE.minute;
  dow.value = DEFAULT_STATE.dow;
  rawCron.value = DEFAULT_STATE.raw;
  enabled.value = true;
  grace.value = 60;
  daysBack.value = 3;
  onExit.value = true;
}

function toggleAdv(): void {
  advOpen.value = !advOpen.value;
  try {
    localStorage.setItem(ADV_KEY, advOpen.value ? '1' : '0');
  } catch {
    // localStorage 不可用（隐私模式）时按会话内状态处理
  }
}

/** 保存并生效：cron 走专用端点（校验 + 热重排），高级项走通用配置键 */
async function save(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const res = await api<{ ok: boolean; nextRunAt?: string; describe?: string; warning?: string }>(
      '/memory/dream/schedule',
      { method: 'PUT', json: { enabled: enabled.value, cron: currentCron.value, misfireGraceMin: grace.value } },
    );

    // 高级项：关停兜底 / 读取窗口（与 schedule 不同键，走通用配置写入）
    const advanced: Promise<unknown>[] = [];
    if (Number(daysBack.value) !== 3) {
      advanced.push(
        api('/config/memory.dreaming.daysBack', {
          method: 'PUT',
          json: { value: daysBack.value, scope: 'workspace' },
        }),
      );
    }
    if (onExit.value !== true) {
      advanced.push(
        api('/config/memory.dreaming.onExit', { method: 'PUT', json: { value: onExit.value, scope: 'workspace' } }),
      );
    }
    if (advanced.length) await Promise.all(advanced);

    const when = res.nextRunAt ? fmtLocal(res.nextRunAt) : '—';
    showToast(res.warning ? `已保存；${res.warning}` : `已保存并生效：下次 ${when}`, res.warning ? 'error' : 'success');
    baseline.value = snapshot.value;
    emit('saved');
  } catch (e) {
    if (e instanceof AuthError) return;
    showToast(e instanceof ApiError ? e.message : `保存失败：${errText(e)}`, 'error');
    // 保存失败多半是后端判定非法：再拉一次预览让错误文案与红框立刻可见
    void runPreview();
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  try {
    advOpen.value = localStorage.getItem(ADV_KEY) === '1';
  } catch {
    advOpen.value = false;
  }
  hydrate(true);
  void runPreview();
});
</script>

<template>
  <section class="card dream-card" :class="{ running: !!status?.running, off: !enabled }">
    <div class="card-h">
      <span>自动晋升</span>
      <span class="ch-hint">把 L2 情景记忆提炼进 L3 长期记忆</span>
      <span class="spacer"></span>
      <StatusBadge v-if="status?.running" kind="brand"><span class="spin"></span>正在晋升</StatusBadge>
      <StatusBadge v-else kind="dim">空闲</StatusBadge>
      <label class="switch" title="关闭后不再按排期触发，关停兜底由「高级」里的开关独立控制">
        <input v-model="enabled" type="checkbox">
        <span class="track"></span>
        <span>启用定时</span>
      </label>
    </div>

    <div class="card-b">
      <div class="dgrid">
        <!-- 左：触发时间 -->
        <div>
          <div class="flabel">触发时间</div>
          <div class="seg">
            <button :class="{ on: mode === 'daily' }" @click="pickMode('daily')">每天</button>
            <button :class="{ on: mode === 'weekly' }" @click="pickMode('weekly')">每周</button>
            <button :class="{ on: mode === 'cron' }" @click="pickMode('cron')">自定义 cron</button>
          </div>

          <div v-show="mode !== 'cron'" class="row-time">
            <select v-if="mode === 'weekly'" v-model.number="dow" class="dow" aria-label="星期">
              <option v-for="(label, i) in DOW_LABELS" :key="i" :value="i">{{ label }}</option>
            </select>
            <select v-model.number="hour" class="hh" aria-label="小时">
              <option v-for="h in hours" :key="h" :value="h">{{ String(h).padStart(2, '0') }}</option>
            </select>
            <span class="colon">:</span>
            <select v-model.number="minute" class="mm" aria-label="分钟">
              <option v-for="m in minutes" :key="m" :value="m">{{ String(m).padStart(2, '0') }}</option>
            </select>
          </div>

          <div v-show="mode === 'cron'" class="row-cron">
            <input
              v-model="rawCron"
              class="mono"
              :class="{ bad: cronInvalid }"
              spellcheck="false"
              aria-label="cron 表达式"
              placeholder="分 时 日 月 周，如 0 3 * * *"
            >
          </div>

          <div class="echo">
            等价 cron <code>{{ currentCron }}</code>
            <span>· {{ tz }}</span>
          </div>

          <div v-if="cronInvalid" class="err">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="8" cy="8" r="6.4" /><path d="M8 5v4" /><path d="M8 11.2v.1" />
            </svg>
            <span>{{ preview?.error }}</span>
          </div>
        </div>

        <!-- 右：排期预览 -->
        <div>
          <div class="flabel">排期预览</div>
          <div class="preview" :class="{ 'is-off': !enabled }">
            <div class="pn-abs">{{ nextAbs }}</div>
            <div class="pn-rel" :class="{ bad: cronInvalid }">{{ nextRel }}</div>
            <div class="pn-desc">{{ shown?.describe ?? status?.describe ?? '—' }}</div>
            <ul v-if="afterNext.length" class="next-list">
              <li v-for="(t, i) in afterNext" :key="t">
                <span class="idx">{{ i + 1 }}</span>{{ fmtLocal(t) }}
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 高级（默认折叠，D12） -->
      <div class="adv">
        <button class="adv-toggle" :class="{ open: advOpen }" :aria-expanded="advOpen" @click="toggleAdv">
          <span class="car">▸</span> 高级（关停兜底 / 读取窗口 / 错过补跑）
        </button>
        <div v-show="advOpen" class="adv-body">
          <div class="adv-item">
            <label>关停时兜底晋升</label>
            <select v-model="onExit">
              <option :value="true">开启（最多等 30s）</option>
              <option :value="false">关闭</option>
            </select>
            <span class="tip">进程退出前补最后一轮</span>
          </div>
          <div class="adv-item">
            <label>读取窗口（天）</label>
            <input v-model.number="daysBack" class="mono" type="number" min="1" max="30">
            <span class="tip">停机多日会按缺口自动放大，上限 30 天</span>
          </div>
          <div class="adv-item">
            <label>错过补跑宽限（分钟）</label>
            <input v-model.number="grace" class="mono" type="number" min="0" max="1440">
            <span class="tip">休眠越过触发点后的容忍时长，超出记「错过」</span>
          </div>
        </div>
      </div>

      <div class="foot">
        <span v-if="dirty" class="dirty">● 有未保存改动</span>
        <span v-else-if="memoryEnabled === false" class="dirty warn">当前记忆未启用，定时不会执行</span>
        <span class="spacer"></span>
        <button @click="resetDefault">恢复默认</button>
        <button class="primary" :disabled="!canSave" @click="save">保存并生效</button>
      </div>
    </div>
  </section>
</template>
