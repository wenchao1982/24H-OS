import { expect, test } from "@playwright/test";
import { gotoApp } from "./helpers";

/**
 * C7. Dashboard 状态抽屉（真实 WS `/api/ws`，不 mock）。
 * 断言抽屉可打开、WS 连上后状态显示「已连接」。
 */
test.describe("C7 · 状态抽屉", () => {
  test("打开抽屉并显示 WS 已连接", async ({ page }) => {
    await gotoApp(page);
    await page.getByRole("button", { name: /^状态/ }).click();
    await expect(page.locator(".status-drawer")).toBeVisible();
    await expect(page.locator(".status-drawer-head")).toContainText("Dashboard 事件");
    await expect(page.locator(".status-toggle-label")).toHaveText("已连接");
  });
});
