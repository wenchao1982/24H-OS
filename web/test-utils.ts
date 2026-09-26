import type {
  Agent,
  AgentConfig,
  HermesStatus,
  LifecycleResult,
  PanelSpec,
  SkillUiInfo,
} from "@shared/types";

/**
 * web 测试通用工具：所有网络调用都用这里的假 response / fixture 替代，
 * 绝不真连后端或模型，也不触碰 `~/.hermes`。
 *
 * 说明：这里只构造「组件/封装实际会用到的最小字段」（ok / status / json / body），
 * 不依赖 jsdom 是否提供全局 fetch / Response。
 */

/** 构造一个 JSON Response 替身。 */
export function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    body: null,
  } as unknown as Response;
}

/** 构造一个按给定文本块顺序吐出的 SSE Response 替身（可跨块切断）。 */
export function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;
  const body = {
    getReader() {
      return {
        read: async () =>
          index < encoded.length
            ? { done: false as const, value: encoded[index++] }
            : { done: true as const, value: undefined },
        cancel: async () => {},
      };
    },
  };
  return {
    ok: true,
    status: 200,
    body,
    json: async () => ({}),
    text: async () => chunks.join(""),
  } as unknown as Response;
}

/** 把一组事件对象序列化成 SSE 帧，并交给 sseResponse。 */
export function sseFromEvents(events: unknown[], splitEvery = 0): Response {
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (splitEvery <= 0) return sseResponse([frames.join("")]);
  const chunks: string[] = [];
  for (let i = 0; i < frames.length; i += splitEvery) {
    chunks.push(frames.slice(i, i + splitEvery).join(""));
  }
  return sseResponse(chunks);
}

/** 一个可用的 Hermes 状态（默认 CLI 可用，便于渲染生命周期入口）。 */
export function makeStatus(overrides: Partial<HermesStatus> = {}): HermesStatus {
  return {
    available: true,
    mode: "live",
    version: "1.2.3",
    cliPath: "/usr/local/bin/hermes",
    cliSource: "path",
    homePath: "/home/user/.hermes",
    activeHome: "/home/user/.hermes",
    hermesHomes: ["/home/user/.hermes"],
    profileCount: 1,
    message: "已检测到 Hermes",
    ...overrides,
  };
}

/** 一个最小 Agent fixture。 */
export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "alpha",
    name: "Alpha",
    description: "示例 agent",
    model: "deepseek/deepseek-flash",
    skills: [],
    mcpServers: [],
    path: "/home/user/.hermes/profiles/alpha",
    source: "profiles",
    ...overrides,
  };
}

/** 一个声明式面板 skill fixture。 */
export function makeDeclarativeSkill(
  panel: Partial<PanelSpec> = {},
  overrides: Partial<SkillUiInfo> = {},
): SkillUiInfo {
  const spec: PanelSpec = {
    protocol: "24os-skill-panel/1",
    skill: "outline",
    title: "大纲生成器",
    view: "form",
    fields: [],
    actions: [],
    ...panel,
  };
  return {
    id: spec.skill,
    title: spec.title,
    skillPath: "/skills/outline",
    uiRoot: "/skills/outline/ui",
    uiHost: "declarative",
    panel: spec,
    hasUi: true,
    ...overrides,
  };
}

/** 一个命令式（iframe）skill fixture。 */
export function makeIframeSkill(overrides: Partial<SkillUiInfo> = {}): SkillUiInfo {
  return {
    id: "ppt",
    title: "PPT 生成器",
    skillPath: "/skills/ppt",
    uiRoot: "/skills/ppt/ui",
    uiHost: "iframe",
    hasUi: true,
    manifest: {
      protocol: "24os-skill-ui/1",
      id: "ppt",
      title: "PPT 生成器",
      entry: "index.html",
      host: "iframe",
      capabilities: ["readFile", "writeFile", "chatStream"],
      permissions: ["workspace:read"],
      size: { width: 800, height: 600 },
    },
    ...overrides,
  };
}

/** 一个最小 AgentConfig fixture。 */
export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "alpha",
    model: "deepseek/deepseek-flash",
    description: "示例 agent",
    soul: "",
    tags: ["review", "ci"],
    mcpServers: [],
    envKeys: [],
    configPath: "/home/user/.hermes/profiles/alpha/config.yaml",
    envPath: "/home/user/.hermes/profiles/alpha/.env",
    metaPath: "/home/user/.hermes/.24os/agents/alpha/meta.json",
    source: "profiles",
    ...overrides,
  };
}

/** 一个最小 LifecycleResult fixture。 */
export function makeLifecycleResult(
  overrides: Partial<LifecycleResult> = {},
): LifecycleResult {
  return {
    ok: true,
    action: "update",
    command: "hermes profile update alpha",
    stdout: "",
    stderr: "",
    code: 0,
    ...overrides,
  };
}
