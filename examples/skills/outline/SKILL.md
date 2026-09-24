# 大纲生成（声明式 Skill · 零代码 UI）

> 这是一个 **24H-OS 声明式功能性 Skill** 示例：skill 作者只写一个
> `ui/panel.yaml`（协议 `24os-skill-panel/1`），宿主就会自动渲染表单、模板画廊与
> 动作按钮，**不需要任何 HTML / JS**，比 iframe 形态更安全。

## 能力

- 填写主题（`text`，必填）、目标读者（`select`）、层级深度（`slider`）、
  补充要求（`textarea`）；
- 结构模板下拉通过 `options_from: templates/index.json` 动态枚举（也可点击模板画廊选择）；
- 点击「生成大纲」：宿主用 `{{field_key}}` 插值 `prompt`，再经
  `POST /api/hermes/chat/stream`（SSE）流式返回，面板右侧实时展示
  delta / 工具调用 / 审批 / 完成 / 错误，可随时中断。

## 目录

```
outline/
  SKILL.md              本说明
  ui/
    panel.yaml          24os-skill-panel/1 声明（fields / templates / actions）
    templates/
      index.json        模板清单（供 select.options_from 与画廊使用）
```

> 注意：本 skill **没有** `ui/manifest.json`，因此被发现为 `uiHost:"declarative"`；
> 若同时存在 `manifest.json`，则优先按命令式 iframe 处理。

## 协议

详见仓库根目录 `docs/SKILL_UI_PROTOCOL.md` 的「声明式面板」章节。
