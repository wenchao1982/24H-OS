import { expect, test } from "@playwright/test";
import { gotoApp, openSkillTab } from "./helpers";

/**
 * B6. 禁用 skill 的 UI 表现。
 *
 * 预置（`e2e/start-server.ts`）在临时 HERMES_HOME 的 profile `main/config.yaml`
 * 写入 `skills.disabled: [ppt]`；服务端 `GET /api/skill-uis` 据此标 `disabled:true`。
 * 前端应显示「已禁用」且**不渲染打开入口**（服务端 403 已在单测覆盖，这里验 UI）。
 */
test.describe("B6 · 禁用 skill", () => {
  test("被禁用的 ppt 显示「已禁用」且无打开入口；outline 仍可打开", async ({ page }) => {
    await gotoApp(page);
    await openSkillTab(page);

    const ppt = page.locator("li.market-item", { hasText: "PPT 工作台" });
    await expect(ppt).toBeVisible();
    await expect(ppt.getByText("已禁用")).toBeVisible();
    await expect(ppt.getByRole("button", { name: "打开 Skill UI" })).toHaveCount(0);

    const outline = page.locator("li.market-item", { hasText: "大纲生成" });
    await expect(outline.getByText("已禁用")).toHaveCount(0);
    await expect(outline.getByRole("button", { name: "打开 Skill UI" })).toHaveCount(1);
  });
});
