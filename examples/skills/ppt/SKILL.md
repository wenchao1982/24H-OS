# PPT（功能型 Skill · 自带 UI）

> 这是一个 **24H-OS 功能性 Skill** 示例：除了本 `SKILL.md`，它还自带一个
> 由宿主在沙箱 iframe 中加载的前端（`ui/`），并通过 postMessage RPC 桥调用宿主能力。

## 能力

- 选择模板（简约 / 商务 / 活泼）、切换主题色；
- 编辑每页的标题 / 副标题 / 要点，增删幻灯片；
- 通过 RPC `runTool('ppt.export', { deck })` 让宿主用 pptxgenjs 生成 `.pptx`
  （写入宿主沙箱工作区 `~/.24os/workspace/ppt/deck.pptx`）；
- 通过 RPC `callModel(...)` 演示调用宿主模型（M4 为桩实现）。

## 目录

```
ppt/
  SKILL.md           本说明
  ui/
    manifest.json    24os-skill-ui/1 协议声明（capabilities / permissions）
    index.html       入口（无内联脚本，遵守严格 CSP）
    main.js          UI 逻辑 + RPC 客户端
    styles.css       样式
```

## 协议

详见仓库根目录 `docs/SKILL_UI_PROTOCOL.md`。
