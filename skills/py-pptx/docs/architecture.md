# SlideP 架构（T0.1 骨架版）

## 模块分层

| 包 | 职责 | 实现状态 |
|---|---|---|
| `slidep.errors` | 统一错误码（SLIDEP_xxxx），用户错误/系统错误分层 | ✅ T0.1 |
| `slidep.logging_setup` | JSON 结构化日志 + 上下文附加 | ✅ T0.1 |
| `slidep.cli` | typer CLI：build / validate / serve / version | ✅ T0.1 骨架 |
| `slidep.dsl` | 组件 AST 模型 | ⏳ T1.1 |
| `slidep.layout` | Flexbox 布局引擎 | ⏳ T1.2 |
| `slidep.render` | OOXML 渲染器 | ⏳ T1.3 |
| `slidep.components` | 组件库（Chart/Table/Image/...） | ⏳ T2.x |
| `slidep.validate` | 设计规范 lint | ⏳ T3.1 |

## 错误处理约定

- `SlidepUserError`：用户可修复（定位 page/file/lineno + hint），CLI 退出码 1，不打印堆栈
- `SlidepSystemError`：系统故障，CLI 退出码 2，打印堆栈
- 所有错误携带 `ErrorCode` 枚举值，消息模板集中在 `CODE_TEMPLATES`

## 日志约定

- 默认 JSON 行格式（`SLIDEP_LOG_JSON=0` 切换文本）
- 级别默认 INFO（`SLIDEP_LOG_LEVEL` 可覆盖）
- 通过 `logger.info_ctx(msg, code=..., page=...)` 附加结构化字段

## 部署约定

- 全部依赖通过 `pyproject.toml` 声明，联网环境 `pip install .` 自动解析下载
- 可选组件（matplotlib）按需安装：`pip install ".[optional]"`
- 不维护离线 wheel 仓库，依赖分发交由 pip/PyPI
