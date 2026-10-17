<script setup lang="ts">
// Token 门（D6）：needAuth 时全屏遮罩输入 Bearer Token；保存后探测 /health 验证
import { onMounted, ref } from 'vue';
import { api, getToken, needAuth, setToken } from '../api/client';
import { showToast } from '../toast';

const draft = ref('');
const checking = ref(false);

/** 启动时主动探测：本机无 token 部署直接通过；远程未带 token → 门弹出 */
onMounted(async () => {
  try {
    await api('/health');
  } catch {
    // 401 已由 client 置 needAuth；其他错误（未启动）交由各视图提示
  }
});

async function save(): Promise<void> {
  if (!draft.value.trim()) return;
  checking.value = true;
  setToken(draft.value);
  try {
    await api('/health');
    needAuth.value = false;
    draft.value = '';
    showToast('令牌已保存', 'success');
  } catch {
    showToast('令牌校验失败，请重试', 'error');
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div v-if="needAuth" class="gate-mask">
    <form class="gate" @submit.prevent="save">
      <h3>需要访问令牌</h3>
      <p class="hint">本服务启用了 Bearer Token 鉴权，请输入 api.token（保存在浏览器本地）</p>
      <input
        v-model="draft"
        type="password"
        placeholder="粘贴 Token…"
        autofocus
      />
      <button class="primary" type="submit" :disabled="checking || !draft.trim()">
        {{ checking ? '校验中…' : '保存并继续' }}
      </button>
      <span v-if="getToken()" class="hint">当前令牌无效，已清除</span>
    </form>
  </div>
</template>

<style scoped>
.gate-mask {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 45%);
  display: grid;
  place-items: center;
  z-index: 2000;
}
.gate {
  width: 340px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gate h3 { margin: 0; }
.hint { margin: 0; color: var(--muted); font-size: 12px; }
</style>
