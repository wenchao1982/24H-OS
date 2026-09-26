import { expect, test } from "@playwright/test";
import { installSseMock, releaseSignal, streamBodies } from "./sse-mock";
import { gotoApp, openOutlinePanel } from "./helpers";

/**
 * B. mock SSE 的确定性交互链路。
 *
 * `/api/hermes/chat/stream` 在浏览器层被 `e2e/sse-mock.ts` 覆写为可控流，
 * **零模型成本**；prompt 插值在页面内捕获；`/api/hermes/chat/decide` 由
 * `page.route` 捕获并断言。
 */

/** 打开 outline 面板并填好必填字段。 */
async function prepareOutlineForm(page: import("@playwright/test").Page): Promise<void> {
  await gotoApp(page);
  await openOutlinePanel(page);
  await page.getByPlaceholder("例如：AI 产品年度规划").fill("AI 产品年度规划");
  await page.getByRole("combobox", { name: /目标读者/ }).selectOption("工程师");
  await page.getByPlaceholder("可补充风格、必须包含的章节等").fill("务必包含风险章节");
}

test.describe("B · mock SSE 交互", () => {
  test("B4 生成动作：{{key}} 插值正确 + delta 逐步渲染到 done", async ({ page }) => {
    await installSseMock(page, [
      { event: { type: "delta", text: "第一段。" }, delayMs: 80 },
      { event: { type: "delta", text: "第二段。" }, delayMs: 80 },
      { event: { type: "done", status: "complete" } },
    ]);

    await prepareOutlineForm(page);
    await page.getByRole("button", { name: "生成大纲" }).click();

    // 渐进渲染：先看到第一段，再看到累积全文。
    await expect(page.locator(".decl-stream")).toContainText("第一段。");
    await expect(page.locator(".decl-stream")).toHaveText("第一段。第二段。");

    const bodies = await streamBodies(page);
    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0]) as { prompt: string; chatId: string };
    expect(payload.prompt).toContain(
      "请以「AI 产品年度规划」为主题，面向工程师，生成一份 2 级深度的结构化大纲。",
    );
    expect(payload.prompt).toContain("补充要求：务必包含风险章节");
    expect(payload.prompt).not.toContain("{{");
    expect(payload.chatId.length).toBeGreaterThan(0);

    await expect(page.getByText(/完成（complete）/)).toBeVisible();
  });

  test("B5 审批卡片：四个按钮 → POST decide（body 正确）→ 续流到 done", async ({ page }) => {
    await installSseMock(page, [
      { event: { type: "delta", text: "准备。" }, delayMs: 40 },
      {
        event: {
          type: "approval",
          chatId: "e2e-chat-1",
          requestId: "req-1",
          command: "rm -rf /tmp/x",
          description: "危险命令需审批",
          choices: ["once", "session", "always", "deny"],
        },
      },
      { wait: "decision" },
      { event: { type: "delta", text: "已批准，继续。" } },
      { event: { type: "done", status: "complete" } },
    ]);

    const decideCalls: unknown[] = [];
    await page.route("**/api/hermes/chat/decide", async (route) => {
      decideCalls.push(route.request().postDataJSON());
      await releaseSignal(page, "decision");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await prepareOutlineForm(page);
    await page.getByRole("button", { name: "生成大纲" }).click();

    // 审批卡片出现，四个标准按钮齐全。
    await expect(page.locator(".chat-decision")).toBeVisible();
    await expect(page.locator(".chat-decision-title")).toContainText("危险命令需审批");
    for (const label of ["once", "session", "always", "deny"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }

    await page.getByRole("button", { name: "once", exact: true }).click();

    await expect.poll(() => decideCalls.length).toBe(1);
    expect(decideCalls[0]).toEqual({
      chatId: "e2e-chat-1",
      type: "approval",
      choice: "once",
    });

    // 决策后流继续，到 done 且卡片消失。
    await expect(page.locator(".decl-stream")).toContainText("已批准，继续。");
    await expect(page.getByText(/完成（complete）/)).toBeVisible();
    await expect(page.locator(".chat-decision")).toHaveCount(0);
  });
});
