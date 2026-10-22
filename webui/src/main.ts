// loop-agent WebUI 入口（Task-20261017-001 D1）
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import './mermaid.css'; // mermaid 图表容器全局样式（ChatView / FilesView 共用）
import 'katex/dist/katex.min.css'; // KaTeX 公式样式（独立公式 + mermaid 图内公式共用，Task-20261023-001 D6）

createApp(App).mount('#app');
