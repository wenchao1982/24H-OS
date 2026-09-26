import type { Page } from "@playwright/test";

/**
 * SSE 浏览器层 mock（确定性、零模型成本）。
 *
 * 为什么不用 `page.route("/api/hermes/chat/stream")`：
 *   `route.fulfill({ body })` 只能**一次性**把整个响应体交给浏览器；审批场景需要
 *   「发 delta → 发 approval → 暂停等用户决策 → 继续发 delta/done」，缓冲式返回会让
 *   全部事件在同一 microtask 内被 React 批处理，审批卡片根本来不及渲染。
 *
 * 因此在 **browser layer** 覆写 `window.fetch`（`addInitScript`，页面脚本运行前注入）：
 *   - 仅拦截 `/api/hermes/chat/stream`，用可控 `ReadableStream` 逐帧推送；
 *   - 其余请求（含 `POST /api/hermes/chat/decide`）原样交给原生 fetch，
 *     所以 decide 仍可被 `page.route` 捕获/断言（见用例）。
 *
 * prompt 请求体在页面内记录，供断言 `{{key}}` 插值正确。
 */

export interface SseStep {
  /** 要推送的 SSE 事件（序列化为 `data: {...}\n\n`）。 */
  event?: unknown;
  /** 推送前等待的毫秒数（让 React 有机会渲染增量）。 */
  delayMs?: number;
  /** 等待某个信号被 `release()` 置位后再推送（审批/澄清续流）。 */
  wait?: string;
}

interface E2eWire {
  __e2e?: { streamBodies: string[]; signals: Record<string, boolean> };
}

/** 在页面加载前安装 SSE mock；`steps` 决定这一轮流的全部事件与节奏。 */
export async function installSseMock(page: Page, steps: SseStep[]): Promise<void> {
  await page.addInitScript((scenario: SseStep[]) => {
    const w = window as unknown as {
      __e2e: { streamBodies: string[]; signals: Record<string, boolean> };
    };
    w.__e2e = { streamBodies: [], signals: {} };

    const nativeFetch = window.fetch.bind(window);
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const isStream = (url: string): boolean => url.includes("/api/hermes/chat/stream");

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (!isStream(url)) return nativeFetch(input, init);

      w.__e2e.streamBodies.push(init?.body ? String(init.body) : "");
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const step of scenario) {
            if (step.delayMs) await sleep(step.delayMs);
            if (step.wait) {
              while (!w.__e2e.signals[step.wait]) await sleep(15);
            }
            if (step.event !== undefined) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(step.event)}\n\n`),
              );
            }
          }
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    };
  }, steps);
}

/** 读取页面内捕获的 chat/stream 请求体（JSON 字符串）。 */
export async function streamBodies(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as E2eWire).__e2e?.streamBodies ?? []);
}

/** 置位某个等待信号（放行被 `wait` 卡住的流）。 */
export async function releaseSignal(page: Page, signal: string): Promise<void> {
  await page.evaluate((name) => {
    const w = window as unknown as E2eWire;
    if (w.__e2e) w.__e2e.signals[name] = true;
  }, signal);
}

/** 页面内注入结构的窄类型（仅供 evaluate 回调使用）。 */
interface E2eWire {
  __e2e?: { streamBodies: string[]; signals: Record<string, boolean> };
}
