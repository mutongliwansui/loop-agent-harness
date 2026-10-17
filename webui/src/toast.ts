// 全局 Toast 状态（右下角轻提示；error 默认停留更久）
import { ref } from 'vue';

export interface ToastMsg {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

export const toasts = ref<ToastMsg[]>([]);

let seq = 0;

export function showToast(text: string, kind: ToastMsg['kind'] = 'info', ms?: number): void {
  const id = ++seq;
  toasts.value.push({ id, text, kind });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, ms ?? (kind === 'error' ? 5000 : 3000));
}
