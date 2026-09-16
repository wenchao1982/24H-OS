# 24H-OS 进度与排期

> 更新方式：每次有实质进展就往最后一节追一行，并更新下面的状态表。
> 架构与决策依据见 [`PLAN.md`](PLAN.md)；契约结论见 [`CORE-CONTRACT.md`](CORE-CONTRACT.md)；Windows 步骤见 [`WINDOWS.md`](WINDOWS.md)。
> 本表最后更新：2026-09-16（周三）

## 1. 架构（一句话确认）

四层，彼此只走一条通道：

```
渲染层 src/            只认 window.hermes.*（传输可替换 → 将来同一套 UI 能当网页版）
   │ preload.cjs（CJS 白名单）
主进程 electron/        窗口/生命周期/运行时管理/REST 与 WS 通道/更新（token 不出壳）
   │ 本地回环：HTTP + WS(JSON-RPC)
核心（外部运行时）       hermes serve；217 方法 / 69 事件 / 227 REST；不 fork、不 patch
   │
数据分层               核心数据 → HERMES_HOME；壳偏好 → userData/ui-prefs.json
```

产品边界：**只做"运行时可分发 + 中文可用 + 桌面产品化"**，agent 能力一律复用核心。
当前对外只提供 **DeepSeek** 一个模型（`PROVIDER_ALLOWLIST`），其它服务商走「高级 → 自定义端点」。

## 2. 进度总表

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| M0 底座 | 壳 + 对话闭环 + 会话 + 文件面板 | ✅ 完成 | `smoke 44/44`、`ui-smoke 33/33` |
| M1 界面与交付 | 设计系统/深浅色/Markdown；设置无法关闭等三个真因；图标；签名配置；打包自检 | 🟡 代码侧 6/10 | 见 §3 清单（剩 4 项要 Windows 机器） |
| M2 打磨 | 一级导航、命令面板、设置分节、面板合流、启动进度、错误中文化、上下文用量、导出/撤销/分叉、诊断复制、连通性测试 | ✅ 完成（本机可验证的部分） | `ui-smoke 33/33`（新增 13 条断言） |
| M3 运行时与更新 | 运行时清单（commit/树指纹/platform）、运行时回退、契约快照与比对、CI、壳自更新接线 | 🟡 大部分完成，差分发源 | 见 §2.1 |
| M4 商业化 | 门户兼容后端最小验证 → 账号/额度；语音（可选） | 🟡 **验证已完成：可行（核心零改动，5/5）**；登录链待定方案 | `CORE-CONTRACT.md` §四 + `npm run portal:spike` |

### 2.1 M3 明细

| 事项 | 状态 | 证据 |
|---|---|---|
| 运行时清单带 `coreCommit` / `coreTreeSha256` / `coreFileCount` / `platform` | ✅ | `scripts/write-runtime-manifest.mjs`（单一实现；与体检脚本共用 `lib/runtime-tree.mjs` 的指纹函数） |
| 运行时体检（清单 vs 目录实际） | ✅ | `npm run verify:runtime`（本机实跑：指纹一致、8013 个文件、336MB） |
| 运行时切换 / 回退 | ✅ | 「设置 → 高级」列出候选并可切换重启核心；`pinnedRoot` 实测生效，失效时自动兜底（实验：pinned 指向不存在/坏目录 → 仍能起） |
| 打包自检读清单并核对（缺字段给告警） | ✅ | `afterPack` + `npm run verify:package`（本机实跑通过） |
| 契约快照与比对（防方法/事件名写错） | ✅ | `scripts/gen-contract.mjs` → `electron/contract.generated.json`（217 方法/69 事件）；`smoke --static` 12→13 条护栏 |
| 运行时回退（新运行时起不来就退回 `runtime.prev`） | ✅ | 实验：坏的 `runtime` + 好的 `runtime.prev` → 壳成功回退启动 |
| CI（静态护栏 + 契约比对 + 无头界面冒烟） | ✅ | `.github/workflows/ci.yml`（两个 job，都不需要图形环境与核心运行时）；推送该文件要求 token 有 **Workflows: Read and write**，推送脚本已做 403 自动降级 |
| 壳自更新（electron-updater） | 🟡 已接线 | `electron-updater` 进 dependencies；没配更新源时"检查更新"给人话；**差** `build.publish` 指向分发源 |
| 运行时资产化：**产出**（`npm run package:runtime` → 100MB 资产 + sha256 + 清单） | ✅ | 本机实跑，336MB→100MB |
| 运行时资产化：**下载**（下载 → sha256 校验 → 解压 → 原子落地） | ✅ | 端到端 4/4，含「落地后的 python 真能 import 核心包」与「sha256 篡改必拒、不留半成品」 |
| 壳里的分发源 UI（设置 → 高级：填地址 / 检查更新 / 下载并安装） | ✅ | `ui-smoke 39/39` |
| 公网分发源 | ✅ **已上线并实测** | `http://111.229.225.8:8899/linux-x64/...`（NAS 静态服务 → 用户服务器 frp 代理 → 公网）；端到端 3/3：读清单 → 下载 100MB → sha256 校验 → 解压落地 → **落地后的 python 真能 import 核心包** |

**已用能力**：核心 217 个 gateway 方法里用了 15 个、69 个事件里用了 11 个、227 个 REST 端点里用了 9 个。
→ 后续路线是"把核心已有能力搬进 UI"，不是自研（`session.usage`/`session.undo`/`session.foreign.*`/`profiles.*` 等都还没接）。

## 3. M1 收口清单（当前冲刺）

| # | 事项 | 谁做 | 状态 |
|---|---|---|---|
| 1 | 界面重做（设计系统 + 深浅色 + Markdown + CSS 图标） | 我 | ✅ `ui-smoke 19/19` |
| 2 | 设置弹层关不掉 / 首屏永远「读取中…」三个真因 | 我 | ✅ `smoke` 静态护栏 + `ui-smoke` |
| 3 | 图标：`build/icon.png` 母版 + `build/icon.ico`（7 尺寸） | 我 | ✅ `npm run icons` |
| 4 | 签名配置（`build.win.signtoolOptions`，证书走环境变量） | 我 | ✅ 配置就位 |
| 5 | 打包自检（`afterPack` 钩子 + `npm run verify:package`） | 我 | ✅ 本机 Linux 解包产物实测 |
| 6 | **签名证书**（OV 证书或 Azure Trusted Signing） | 你 | 🟡 **内测阶段暂缓**（2026-09-16 决定：先不买，出未签名包给内测用户，用户点「更多信息 - 仍要运行」即可；正式对外发布前再办） |
| 7 | `build-runtime.ps1` 在 Windows 上首次跑通 | **你（机器）** | ⬜ 阻塞 8–10 |
| 8 | Windows：`npm run smoke` 38/38 | **你（机器）** | ⬜ |
| 9 | Windows：`npm run dev` 界面可用（设置开关 / 填 DeepSeek key / 发消息） | **你（机器）** | ⬜ |
| 10 | Windows：`npm run dist` 出 NSIS（内测不签名）+ `npm run verify:package` + 装包首启验收 | **你（机器）** | ⬜ 只需第 7 项（运行时构建） |

## 4. 排期（按日，遇阻顺延）

| 日期 | 目标 | 依赖 | 验收 |
|---|---|---|---|
| 9/16 周三（今天） | M1 代码侧全部落地（界面/图标/签名配置/打包自检/契约实测） | — | `smoke 38/38`、`ui-smoke 19/19`、`verify:package` 通过 |
| 9/17 周四 | Windows：跑通运行时构建 + smoke + 界面；把报错贴回来 | 你的 Windows 机器 | `smoke 38/38`、界面能发消息 |
| 9/18 周五 | 修 Windows 首次运行暴露的问题；确认证书方案（买 OV 还是 Azure） | 上一步输出 | 干净机器上 `npm run dev` 可用 |
| 9/21 周一 – 9/23 周三 | **M2**：启动分阶段进度 + 失败三件套；错误中文化；上下文用量；会话导出/撤销/分支；诊断一键复制；连通性测试 | 无 | 新增断言 + 手工清单 |
| 9/24 周四 – 9/25 周五 | **M1 收尾**：签名 + `npm run dist` 出包 + §7.2 装包验收清单 | 证书已买 | `24H-0.1.0-x64.exe` 签名 Valid、装包可用 |
| 9/26 起 | **M3**：运行时清单/资产 + 壳自更新 + 核心独立升级回滚；随后 M4 商业化验证 | — | 装 v1 → 升 v2 数据不丢 |

（M2 与"证书办理"可以并行：证书审批通常要几个工作日，越早提交越好。）

## 5. 依赖与卡点

| 事项 | 谁 | 影响 |
|---|---|---|
| Windows 机器上跑第一条命令（运行时构建） | 你 | M1 剩下的 4 项全卡在这里 |
| 代码签名证书（OV 约 ¥1000–3000/年；Azure Trusted Signing 按量） | 你 | 不签 → 用户装包会看到 SmartScreen"未知发布者" |
| 发版推代码用的 PAT | 你（已提供） | 我无法用 git push（本机网络不通 github.com），只能走 API |
| 上游核心升级（0.21.x → 更高） | 我 | 契约版本会变（`desktop_contract` 已是 6→7），升级后要跑全量冒烟 |

## 6. 变更记录

- 2026-09-16（第八次）：**公网分发源打通**。用户在服务器上加好 frp 代理（8899 端口）；
  NAS 侧起静态分发服务（`scripts/dev/serve-dist.mjs`，只读 + 防路径穿越，`setsid` 后台常驻），资产按平台分目录。
  实测（从公网地址走完整链路）：读清单 ✓ → 下载 100MB ✓ → sha256 校验 ✓ → 解压落地 ✓ →
  **落地后的运行时用它自己的 python import 了 hermes_cli（3.12.4）** ✓（3/3）。
  顺带：下载器加**平台护栏**（清单平台与本机不符直接拒绝）；`package:runtime` 产出改到 `dist-assets/<平台>/`。
  **待办（需要你）**：Windows 机器要下载的那份资产必须在 Windows 上构建后放到 `<dist>/win-x64/`（venv 平台锁定）。

- 2026-09-16（第七次）：**M4 的关键验证做完了** —— 「门户兼容后端」可行，核心零改动。
  `scripts/dev/mock-portal.mjs` 实现 8 个 `/api/billing/*`，`scripts/dev/portal-spike.mjs` 用
  `HERMES_PORTAL_BASE_URL` 把核心指过去，实测 5/5：余额/套餐/用量读数与下单、查单全部走通，
  mock 日志证明 4 个请求都打到我们的服务端。**唯一没验的是"登录链"**（本次直接写 auth.json 绕过），
  建议二期走"壳侧登录 + 壳写 auth.json"，细节与字段表见 `docs/CORE-CONTRACT.md` §四。

- 2026-09-16（第六次）：修用户实机报的「读取历史失败: session not found」。
  真因：核心有**两套 id** —— 列表里的 stored id 与运行时的 session_id。`session.resume` 之后运行时 id 会**变**，
  而壳里原来的恢复逻辑是"resume 完拿**旧 id** 重试"，等于白重试；渲染层读历史时也用的是 stored id。
  修法：`electron/session-remap.mjs`（resume → 用返回的新 id 重试 → 把新 id 推给渲染层），
  渲染层区分 `sessionId`（列表/高亮）与 `runtimeSessionId`（所有核心调用）。
  证据：`smoke` 打真核心跑出 `stale=4001 remap=20260916_225246_8d6eec→228a5966 retried=count=0`（45/45）；
  `ui-smoke` 的桩改成"history 只认运行时 id，用 stored id 就 4001"（37/37）。
  另外：错误态不再转圈（`.empty.static`），读取失败走 `explainError` 给人话。

- 2026-09-16（第五次）：
  - 运行时清单**写入与校验改成同一个实现**（`scripts/lib/runtime-tree.mjs`；此前 bash 与 JS 各算一套、
    排序与行尾不同 → 永远对不上，现已实测一致）；新增 `npm run verify:runtime`（指纹/结构/体积体检）。
  - 新增**运行时切换**：「设置 → 高级 → 运行时」列出 `runtime` / `runtime.prev` / `runtime.<版本>`，
    可手动切换并重启核心（选择存 `ui-prefs.json`）；实测 `pinnedRoot` 生效，指向不存在/坏目录时自动兜底。
  - 模块调整：删掉 `scripts/write-runtime-manifest.sh|ps1`（避免两套实现再分叉），改由 Node 版统一生成。
  - 「文件访问路径白名单」**明确不做**（理由见 PLAN F5：本机应用里它挡不住真风险、只添堵）。
  - 说明：token 折腾了几轮（旧 token 被 regenerate 作废；中间一版只有 Contents: Read，建 blob 403）。
    最终版本同时具备 **Contents: Read and write** 与 **Workflows: Read and write**，
    于是 CI 文件从 `docs/ci/ci.yml` 模板挪回真路径 `.github/workflows/ci.yml`。

- 2026-09-16（第四次）：用户决定**暂不买签名证书，先进内测**。
  同时修掉用户截图里暴露的一个界面 bug：设置弹层最后一个分节的内容被底部「完成」栏裁掉半个字
  （根因：`.settings-body` 的网格隐式行是 `auto`，内容一高就顶破容器；改成 `grid-template-rows: minmax(0, 1fr)`）。
  已加 ui-smoke 几何断言：「底部完成栏必须在滚动区之下、卡片之内」，并在 780px 矮窗口下复现验证通过。

- 2026-09-16（第三次，自主推进）：
  - **菜单改版三步全部落地**：① 设置分五节 + 会话行原生「⋯」菜单 + 右侧面板（文件/预览/日志）合流；
    ② 左轨一级导航（对话/技能/任务/用量/设置）；③ `Ctrl/Cmd + K` 命令面板（28 条命令，含按模型动态生成）。
  - **M2 打磨项清空**：启动分阶段进度、错误中文化（未配模型/会话回收/Key 失效/限流/网络/余额）、
    上下文用量条（`session.usage`，事件推送即更新）、会话导出 Markdown、撤销上一轮、分叉、诊断一键复制、
    连通性测试、数据与目录页。
  - **契约比对发现真问题**：渲染层监听的 `turn.started` 并不在核心契约里（核心声明的是 `message.start`）
    —— 回合开始事件一直没接上，已改名并补上 `session.usage`/`session.reclaimed`/`message.interim`/`subagent.*`。
  - **M3 大部分**：运行时清单加 `coreCommit`/`coreTreeSha256`/`platform`；运行时回退实测通过；
    契约快照 + 静态比对护栏；CI 两个 job；`electron-updater` 接线（差分发源）。
  - 本机验证：`smoke 44/44`、`smoke --static 13/13`、`ui-smoke 33/33`、`afterPack` + `verify:package` 通过。
  - 仍然只有 4 件事在等你：Windows 上跑运行时构建 / smoke / 界面、买签名证书、配更新分发源（可选）。
- 2026-09-16（第二次）：设置弹层关不掉 + 首屏永远「读取中…」三个真因修复；核心契约"是否开放"实测；
  界面重做（设计系统 + 深浅色 + Markdown）；模型收窄为只提供 DeepSeek。
- 2026-09-16（第一次）：M1 代码侧完成 5/10（界面/设置真因/图标/签名配置/打包自检）。
