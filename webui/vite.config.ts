import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 构建产物输出到 webui/dist（D2：提交 git，由主工程 node:http 静态托管）。
// 开发期 npm run dev 通过 proxy 直连本地 API 服务（生产为同源静态托管，无需 proxy）。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/sessions': 'http://127.0.0.1:3000',
      '/workspaces': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/status': 'http://127.0.0.1:3000',
      '/config': 'http://127.0.0.1:3000',
      '/tools': 'http://127.0.0.1:3000',
      '/models': 'http://127.0.0.1:3000',
      '/mcp': 'http://127.0.0.1:3000',
      '/skills': 'http://127.0.0.1:3000',
      '/memory': 'http://127.0.0.1:3000',
      '/vision': 'http://127.0.0.1:3000',
      '/doctor': 'http://127.0.0.1:3000',
      '/uploads': 'http://127.0.0.1:3000',
    },
  },
});
