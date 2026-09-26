import { expect, type Page } from "@playwright/test";

/**
 * e2e 共用操作与断言工具。
 * 所有断言都针对具体文本/角色/属性，避免 `expect(...).toBeTruthy()` 式的空断言。
 */

/** 收集页面的 console error 与未捕获异常（在 goto 前调用）。 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** 打开首页并等待真实后端返回的 agent 列表渲染完成。 */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible();
  await expect(page.getByRole("button", { name: /^main\b/ })).toBeVisible();
}

/** 切到 Skill 列表 tab（真实后端 `/api/skill-uis`）。 */
export async function openSkillTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Skill\b/ }).click();
  await expect(page.locator("li.market-item", { hasText: "大纲生成" })).toBeVisible();
}

/** 从 Skill 列表打开 outline 声明式面板。 */
export async function openOutlinePanel(page: Page): Promise<void> {
  await openSkillTab(page);
  await page
    .locator("li.market-item", { hasText: "大纲生成" })
    .getByRole("button", { name: "打开 Skill UI" })
    .click();
  await expect(page.locator(".skill-host-panel")).toBeVisible();
  await expect(page.locator(".decl-form")).toBeVisible();
}
