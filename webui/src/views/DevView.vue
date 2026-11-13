<script setup lang="ts">
// 开发者中心（需求 20261104-002）
//
// 页面按「模块（tabs）」组织，第一个模块 = API 接口文档：
// - 数据来自后端 GET /dev/api-docs（路由表反射 + 元数据合并，见 src/api/api-docs.ts）
// - 过滤 / 统计 / 路径高亮 / curl 生成全部走 ../api-docs-ui.ts 的纯函数（可单测）
// - tabs 状态进 hash query（`#/dev?tab=auth`），刷新与分享可还原（沿用 MemoryView 范式）
// 第二、三模块（鉴权与通用约定 / SSE 事件）内容全部取自既有实现，不臆造。
import { computed, onMounted, ref, watch } from 'vue';
import { api, ApiError, AuthError, fetchApiDocs, getToken } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import { hashQuery, replaceHashQuery } from '../router';
import { navIconSvg } from '../nav-menu';
import {
  AUTH_MODES,
  buildCurl,
  DEV_TABS,
  ERROR_CODES,
  filterDocs,
  docCounts,
  METHOD_FILTERS,
  methodTone,
  resolveTab,
  splitPath,
  SSE_EVENTS,
  SSE_SNIPPET,
  templatedPath,
  type ApiDocItem,
  type ApiDocsPayload,
  type DevTabKey,
} from '../api-docs-ui';

/** 当前模块（hash ?tab= 还原；非法值回落第一个模块 api） */
const tab = computed<DevTabKey>(() => resolveTab(hashQuery.value.get('tab')));

function setTab(k: DevTabKey): void {
  replaceHashQuery({ tab: k === 'api' ? undefined : k });
}

// ---------------- API 接口文档模块 ----------------

const payload = ref<ApiDocsPayload | null>(null);
const busy = ref(false);
const loadErr = ref('');
const kw = ref('');
const method = ref('all');
/** 当前展开的端点（键为 `METHOD /path`，同时只展开一条，避免长页面滚不动） */
const openKey = ref('');

/** 服务地址：取 location.origin（方案 D9，反代/局域网访问时与后端配置可能不同） */
const origin = computed(() => location.origin);

const filtered = computed(() =>
  payload.value ? filterDocs(payload.value, { kw: kw.value, method: method.value }) : null,
);
const counts = computed(() =>
  payload.value ? docCounts(payload.value) : { total: 0, documented: 0, undocumented: 0, byMethod: {} as Record<string, number> },
);
const shownCount = computed(() => (filtered.value ? docCounts(filtered.value).total : 0));

async function load(): Promise<void> {
  busy.value = true;
  loadErr.value = '';
  try {
    payload.value = await fetchApiDocs();
  } catch (e) {
    if (e instanceof AuthError) {
      loadErr.value = '未授权：请先填入访问令牌（右上角令牌入口）';
    } else if (e instanceof ApiError && e.status === 404) {
      loadErr.value = '当前服务版本不支持接口文档（后端需升级到含 GET /dev/api-docs 的版本）';
    } else {
      loadErr.value = `加载失败：${e instanceof ApiError ? e.message : errText(e)}`;
    }
  } finally {
    busy.value = false;
  }
}

function clearFilter(): void {
  kw.value = '';
  method.value = 'all';
}

function keyOf(it: ApiDocItem): string {
  return `${it.method} ${it.path}`;
}

/** 路径占位示例（含 `:param` 时才返回，用于示例下方提示文案） */
function placeholderOf(it: ApiDocItem): string {
  const t = templatedPath(it.path);
  return t.includes('<') ? t : '';
}

function isOpen(it: ApiDocItem): boolean {
  return openKey.value === keyOf(it);
}

function toggle(it: ApiDocItem): void {
  const k = keyOf(it);
  openKey.value = openKey.value === k ? '' : k;
}

async function copy(text: string, label = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label, 'success');
  } catch (e) {
    showToast(`复制失败: ${errText(e)}`, 'error');
  }
}

// ---------------- 鉴权与通用约定模块 ----------------

/** 后端生效的 api 配置（token 已被后端遮蔽为 ****xxxx，界面只判定「是否已配置」，不回显） */
const apiCfg = ref<{ host?: string; port?: number; token?: string } | null>(null);
const authLoaded = ref(false);
/** 浏览器本地是否已保存访问令牌（只判空，不回显明文） */
const hasLocalToken = computed(() => getToken().length > 0);

async function loadAuth(): Promise<void> {
  if (authLoaded.value) return;
  try {
    const res = await api<{ key: string; value: { host?: string; port?: number; token?: string } }>('/config/api');
    apiCfg.value = res?.value ?? null;
    authLoaded.value = true;
  } catch (e) {
    if (!(e instanceof AuthError)) apiCfg.value = null;
  }
}

// 首次进入鉴权模块时拉取（避免打开页面就打无用请求）
watch(
  tab,
  (t) => {
    if (t === 'auth') void loadAuth();
  },
  { immediate: true },
);

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>开发者中心</h1>
      <span v-if="busy" class="spin" title="加载中"></span>
      <span class="sub muted">本服务对外开放的接口与约定</span>
      <span class="spacer"></span>
      <button :disabled="busy" @click="load">⟳ 重新拉取</button>
    </div>

    <div class="tabs" role="tablist">
      <button
        v-for="t in DEV_TABS"
        :key="t.key"
        class="tab"
        :class="{ on: tab === t.key }"
        role="tab"
        :aria-selected="tab === t.key"
        :title="t.hint"
        @click="setTab(t.key)"
      >
        <span class="dev-ticon" v-html="navIconSvg('code')"></span>
        {{ t.label }}
        <span v-if="t.key === 'api' && counts.total > 0" class="n">{{ counts.total }}</span>
      </button>
    </div>

    <!-- ============ 模块一：API 接口文档 ============ -->
    <section v-show="tab === 'api'" role="tabpanel" aria-label="API 接口文档">
      <div v-if="loadErr" class="card">
        <div class="card-b dev-err">
          <span>{{ loadErr }}</span>
          <button class="primary" @click="load">重试</button>
        </div>
      </div>

      <template v-if="payload">
        <div class="dev-stat">
          <span>共 <b>{{ counts.total }}</b> 个端点</span>
          <span class="dev-dot">·</span>
          <span>已登记说明 <b>{{ counts.documented }}</b></span>
          <span v-if="counts.undocumented > 0" class="dev-todo">· {{ counts.undocumented }} 条待补</span>
          <span class="dev-dot">·</span>
          <span>服务地址 <code class="dev-origin">{{ origin }}</code></span>
          <span v-if="payload.version" class="dev-dot">·</span>
          <span v-if="payload.version">版本 {{ payload.version }}</span>
        </div>

        <div class="dev-tools">
          <input v-model="kw" class="dev-search" type="search" placeholder="搜索方法 / 路径 / 说明" aria-label="搜索端点" />
          <select v-model="method" class="dev-sel" aria-label="按方法过滤">
            <option v-for="m in METHOD_FILTERS" :key="m" :value="m">{{ m === 'all' ? '全部方法' : m }}</option>
          </select>
          <span class="dev-shown">显示 {{ shownCount }} / {{ counts.total }}</span>
        </div>

        <div v-if="!filtered || filtered.groups.length === 0" class="card">
          <div class="card-b dev-empty">
            <span>无匹配端点</span>
            <button @click="clearFilter">清空筛选</button>
          </div>
        </div>

        <div v-for="g in filtered ? filtered.groups : []" :key="g.key" class="card">
          <div class="card-h">
            <span>{{ g.title }}</span>
            <span class="ch-hint">{{ g.desc }}</span>
            <span class="dev-gcount">{{ g.items.length }}</span>
          </div>
          <div class="card-b dev-list">
            <div v-for="it in g.items" :key="it.method + it.path" class="dev-item" :class="{ open: isOpen(it) }">
              <button class="dev-row" :aria-expanded="isOpen(it)" @click="toggle(it)">
                <span class="mth" :class="'mth-' + methodTone(it.method)">{{ it.method }}</span>
                <span class="dev-path">
                  <span v-for="(seg, i) in splitPath(it.path)" :key="i" :class="{ param: seg.param }">{{ seg.text }}</span>
                </span>
                <span class="dev-sum" :class="{ todo: !it.documented }">{{ it.documented ? it.summary : '说明待补' }}</span>
                <span v-if="it.stream" class="dev-tag">SSE</span>
                <span class="dev-caret" aria-hidden="true" v-html="navIconSvg('caret')"></span>
              </button>

              <div v-if="isOpen(it)" class="dev-detail">
                <p v-if="!it.documented" class="dev-note">
                  该端点尚未登记中文说明（元数据缺口，已计入统计条「待补」）；参数与示例待补齐。
                </p>

                <div v-if="it.params.length" class="dev-sec">
                  <div class="dev-sec-t">参数</div>
                  <table class="dev-tbl">
                    <thead>
                      <tr><th>名称</th><th>位置</th><th>类型</th><th>必填</th><th>说明</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="p in it.params" :key="p.in + p.name">
                        <td><code>{{ p.name }}</code></td>
                        <td>{{ p.in }}</td>
                        <td>{{ p.type }}</td>
                        <td>{{ p.required ? '是' : '否' }}</td>
                        <td>{{ p.desc }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div v-if="it.body" class="dev-sec">
                  <div class="dev-sec-t">请求体</div>
                  <pre class="dev-pre">{{ it.body }}</pre>
                </div>

                <div v-if="it.response" class="dev-sec">
                  <div class="dev-sec-t">响应</div>
                  <pre class="dev-pre">{{ it.response }}</pre>
                </div>

                <div class="dev-sec">
                  <div class="dev-sec-t">
                    调用示例
                    <button class="dev-copy" @click="copy(buildCurl(it, origin))">复制 curl</button>
                  </div>
                  <pre class="dev-pre">{{ buildCurl(it, origin) }}</pre>
                  <p v-if="placeholderOf(it)" class="dev-hint">
                    路径占位（如 <code>{{ placeholderOf(it) }}</code>）需替换为真实值；鉴权要求见「鉴权与通用约定」。
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </section>

    <!-- ============ 模块二：鉴权与通用约定 ============ -->
    <section v-show="tab === 'auth'" role="tabpanel" aria-label="鉴权与通用约定">
      <div class="card">
        <div class="card-h">当前鉴权状态<span class="ch-hint">本页据此判断要不要带令牌</span></div>
        <div class="card-b">
          <div class="dev-kv">
            <span class="dev-k">服务端 api.token</span>
            <span class="dev-v">
              <template v-if="apiCfg === null">读取失败或不可用</template>
              <template v-else-if="apiCfg.token && apiCfg.token !== ''">
                已配置（后端遮蔽，不回显）→ 所有请求必须带 <code>Authorization: Bearer &lt;token&gt;</code>
              </template>
              <template v-else>未配置 → 仅本机回环地址可访问</template>
            </span>
          </div>
          <div class="dev-kv">
            <span class="dev-k">监听地址</span>
            <span class="dev-v"><code>{{ apiCfg?.host ?? '—' }}:{{ apiCfg?.port ?? '—' }}</code></span>
          </div>
          <div class="dev-kv">
            <span class="dev-k">浏览器本地令牌</span>
            <span class="dev-v">{{ hasLocalToken ? '已保存（随请求自动注入 Bearer）' : '未保存（右上角令牌入口可填入）' }}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">token 三态与启动校验<span class="ch-hint">与后端 isAuthorized / 启动校验逐条对应</span></div>
        <div class="card-b">
          <table class="dev-tbl">
            <thead>
              <tr><th>场景</th><th>服务端行为</th><th>失败响应</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in AUTH_MODES" :key="m.key">
                <td>{{ m.when }}</td>
                <td>{{ m.behavior }}</td>
                <td>{{ m.failure }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">错误码<span class="ch-hint">统一错误体 { error: { code, message } }</span></div>
        <div class="card-b">
          <table class="dev-tbl">
            <thead>
              <tr><th>状态码</th><th>code</th><th>语义</th></tr>
            </thead>
            <tbody>
              <tr v-for="e in ERROR_CODES" :key="e.code">
                <td><code>{{ e.code }}</code></td>
                <td><code>{{ e.key }}</code></td>
                <td>{{ e.desc }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">语义约定</div>
        <div class="card-b">
          <ul class="dev-ul">
            <li><b>动词即确认</b>：DELETE / PUT / PATCH 替代 CLI 的 y/N 交互（删当前激活模型直接 409，比确认更严格）。</li>
            <li><b>配置作用域</b>：所有配置只有全局一份（<code>~/.loop-agent/config.json</code>），写配置类端点不需要 <code>scope</code> 参数；传 <code>?scope=workspace</code> 会返回 <b>400</b>。</li>
            <li><b>诊断语义</b>：<code>/vision/test</code>、<code>/models/:alias/test</code>、<code>/mcp/servers/:name/test</code>、<code>/doctor</code> 检测失败也返回 200（<code>ok:false</code> + 明细），不失败端点。</li>
            <li><b>缺省空间</b>：启动空间（进程启动时的工作空间）为各空间内读写端点的缺省目标；跨空间端点须用 <code>ws</code> 参数显式指定，未知空间 404，空间内端点缺 <code>ws</code> 一律 400。</li>
            <li><b>重启生效</b>：<code>api.token</code> / <code>api.port</code> / <code>api.host</code> 修改需重启服务。</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ============ 模块三：SSE 事件 ============ -->
    <section v-show="tab === 'sse'" role="tabpanel" aria-label="SSE 事件">
      <div class="card">
        <div class="card-h">帧格式<span class="ch-hint">POST /sessions/:id/messages 默认流式</span></div>
        <div class="card-b">
          <pre class="dev-pre">[id: &lt;seq&gt;\n]event: &lt;type&gt;\ndata: &lt;JSON&gt;\n\n</pre>
          <p class="dev-hint">
            <code>id</code> 为 run 内单调递增序号，断线后可用 <code>GET /sessions/:id/stream?cursor=&lt;seq&gt;</code> 续传；
            事件名与 Agent 事件钩子一一对应（<code>onXxx</code> → <code>xxx_yyy</code> 蛇形命名）。
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-h">事件清单<span class="ch-hint">{{ SSE_EVENTS.length }} 项（含 API 层合成终态）</span></div>
        <div class="card-b">
          <table class="dev-tbl">
            <thead>
              <tr><th>event</th><th>载荷</th><th>说明</th><th>来源</th></tr>
            </thead>
            <tbody>
              <tr v-for="ev in SSE_EVENTS" :key="ev.name">
                <td><code>{{ ev.name }}</code></td>
                <td><code>{{ ev.payload }}</code></td>
                <td>{{ ev.desc }}</td>
                <td>{{ ev.kind === 'frame' ? 'Agent 透传' : 'API 合成' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          接入片段
          <button class="dev-copy" @click="copy(SSE_SNIPPET, '已复制接入代码')">复制</button>
        </div>
        <div class="card-b">
          <pre class="dev-pre">{{ SSE_SNIPPET }}</pre>
        </div>
      </div>
    </section>
  </div>
</template>
