// loop-agent WebUI 入口（Task-20261017-001 D1）
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import './mermaid.css'; // mermaid 图表容器全局样式（ChatView / FilesView 共用）

createApp(App).mount('#app');
