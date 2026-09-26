import { expect, test } from "@playwright/test";
import { collectErrors, gotoApp, openOutlinePanel, openSkillTab } from "./helpers";

/**
 * A. 真实后端冒烟（这些接口**不 mock**，直接打隔离后的 24H-OS server）：
 *   1. `/` 加载：标题 / 主容器 / 无 console error；
 *   2. agent + skill 列表来自真实 `/api/agents` 与 `/api/skill-uis`（仓库 examples/skills）；
 *   3. 打开 outline 声明式面板：字段与模板画廊正常渲染。
 *
 * 隔离：HERMES_HOME/HOME 均为临时目录，CLI 为假脚本；不触碰真实 `~/.hermes`。
 */
test.describe("A · 真实后端冒烟", () => {
  test("A1 首页加载且无 console error / 未捕获异常", async ({ page }) => {
    // AgentDetail 挂载即请求官方头像；隔离环境无 gateway，官方 RPC 返回 503。
    // 头像不在本用例「真实后端」范围内，且 503 是「未配置 gateway」的环境常态，
    // 这里以「未设置头像」的 200 响应替代，确保其余真实请求的 console 干净。
    await page.route("**/api/agents/*/avatar", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ found: false, mime: null, size: null, data: null }),
      }),
    );
    const errors = collectErrors(page);
    await gotoApp(page);
    await expect(page).toHaveTitle(/24H-OS/);
    await expect(page.locator(".layout")).toBeVisible();
    await expect(page.locator(".status-bar")).toBeVisible();
    // WS 连接等异步日志可能稍后到达，给一点收敛时间后再断言。
    await page.waitForTimeout(400);
    expect(errors).toEqual([]);
  });

  test("A2 agent 与 skill 列表来自真实后端（发现 ppt 与 outline）", async ({ page }) => {
    await gotoApp(page);
    await expect(page.getByRole("button", { name: /^main\b/ })).toBeVisible();
    await openSkillTab(page);

    const ppt = page.locator("li.market-item", { hasText: "PPT 工作台" });
    const outline = page.locator("li.market-item", { hasText: "大纲生成" });
    await expect(ppt).toBeVisible();
    await expect(outline).toBeVisible();
    // outline = 声明式面板（字段数来自 panel.yaml）；ppt = 命令式（capabilities）。
    await expect(outline.locator(".market-desc")).toContainText("声明式面板");
    await expect(ppt.locator(".market-desc")).toContainText("chatStream");
  });

  test("A3 打开 outline 声明式面板：字段与模板画廊渲染", async ({ page }) => {
    await gotoApp(page);
    await openOutlinePanel(page);

    await expect(page.getByPlaceholder("例如：AI 产品年度规划")).toBeVisible();
    const audience = page.getByRole("combobox", { name: /目标读者/ });
    await expect(audience).toBeVisible();
    await expect(audience).toContainText("管理层");
    await expect(audience).toContainText("工程师");
    await expect(page.getByRole("slider")).toHaveValue("2");
    await expect(page.getByPlaceholder("可补充风格、必须包含的章节等")).toBeVisible();

    // 模板画廊（options_from templates/index.json / panel.templates.index）。
    await expect(page.getByRole("button", { name: /时间线/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /问题-方案/ })).toBeVisible();
  });
});
