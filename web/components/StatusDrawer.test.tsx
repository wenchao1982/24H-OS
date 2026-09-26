/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import StatusDrawer from "./StatusDrawer";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    // 由测试显式调用 emitClose 控制时序。
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitClose(): void {
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe("StatusDrawer · 连接状态", () => {
  it("初始连接中，URL 指向 /api/ws", () => {
    render(<StatusDrawer />);
    expect(screen.getByText("连接中")).toBeInTheDocument();
    expect(lastSocket().url).toMatch(/\/api\/ws$/);
  });

  it("onopen 后显示「已连接」，点击展开抽屉", () => {
    render(<StatusDrawer />);
    act(() => lastSocket().emitOpen());
    expect(screen.getByText("已连接")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /状态/ }));
    expect(screen.getByText(/Dashboard 事件（最近 0 条）/)).toBeInTheDocument();
    expect(screen.getByText("暂无事件")).toBeInTheDocument();
  });

  it("断开后显示重连中，退避后创建新连接", () => {
    vi.useFakeTimers();
    render(<StatusDrawer />);
    act(() => lastSocket().emitOpen());
    act(() => lastSocket().emitClose());
    expect(screen.getByText("重连中")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("StatusDrawer · 事件渲染", () => {
  it("渲染 {type,at,payload} 摘要", () => {
    render(<StatusDrawer />);
    act(() => lastSocket().emitOpen());
    act(() =>
      lastSocket().emitMessage({
        type: "app.install",
        at: "2026-01-01T00:00:00.000Z",
        payload: { appId: "ppt-maker", status: "ok", version: "1.0.0" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /状态/ }));
    expect(screen.getByText("app.install")).toBeInTheDocument();
    expect(screen.getByText("appId=ppt-maker version=1.0.0 status=ok")).toBeInTheDocument();
    expect(screen.getByText(/最近 1 条/)).toBeInTheDocument();
  });

  it("results 数组长度作为摘要兜底", () => {
    render(<StatusDrawer />);
    act(() => lastSocket().emitOpen());
    act(() =>
      lastSocket().emitMessage({
        type: "hooks",
        at: "2026-01-01T00:00:00.000Z",
        payload: { results: [1, 2, 3] },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /状态/ }));
    expect(screen.getByText("results=3")).toBeInTheDocument();
  });

  it("无字段时摘要显示占位符 —", () => {
    render(<StatusDrawer />);
    act(() => lastSocket().emitOpen());
    act(() => lastSocket().emitMessage({ type: "ping", at: "2026-01-01T00:00:00.000Z", payload: {} }));
    fireEvent.click(screen.getByRole("button", { name: /状态/ }));
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("非法 JSON / 非对象 / 缺 type 的帧被忽略", () => {
    render(<StatusDrawer />);
    act(() => lastSocket().emitOpen());
    act(() => {
      lastSocket().emitRaw("<not json>");
      lastSocket().emitRaw("null");
      lastSocket().emitMessage({ at: "x", payload: {} });
    });
    fireEvent.click(screen.getByRole("button", { name: /状态/ }));
    expect(screen.getByText(/最近 0 条/)).toBeInTheDocument();
  });

  it("事件数量上限为 50", () => {
    render(<StatusDrawer />);
    act(() => lastSocket().emitOpen());
    act(() => {
      for (let i = 0; i < 55; i += 1) {
        lastSocket().emitMessage({
          type: `e${i}`,
          at: "2026-01-01T00:00:00.000Z",
          payload: { id: i },
        });
      }
    });
    fireEvent.click(screen.getByRole("button", { name: /状态/ }));
    expect(screen.getByText(/最近 50 条/)).toBeInTheDocument();
  });
});
