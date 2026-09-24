import type { Agent, McpServer, Skill } from "@shared/types";

/**
 * Mock 数据：当机器上没有可用 Hermes（既无 CLI 也无 ~/.hermes）时返回。
 * 目的：让前端在没有真实 Hermes 的环境下依然可以完整跑通 M1 界面。
 *
 * TODO(M2+): 这些 mock agent 将来会被 "profile install 向导" 创建的真实 agent 替换。
 */

/** 便捷构造 skill。 */
function skill(id: string, description?: string): Skill {
  return { id, name: id, description, enabled: true };
}

/** 便捷构造 mcp server。 */
function mcp(id: string, command?: string, args?: string[]): McpServer {
  return { id, name: id, command, args, enabled: true };
}

const MOCK_AGENTS: Agent[] = [
  {
    id: "assistant",
    name: "assistant",
    description:
      "通用个人助理：负责日程、信息检索与日常问答，是默认入口 agent。（示例数据）",
    model: "deepseek-flash",
    skills: [
      skill("web-search", "联网检索并汇总结果"),
      skill("calendar", "读写日程"),
      skill("summarize", "长文摘要"),
    ],
    mcpServers: [mcp("filesystem", "npx", ["-y", "@modelcontextprotocol/server-filesystem"]), mcp("fetch")],
    path: "~/.hermes/profiles/assistant (mock)",
    source: "mock",
  },
  {
    id: "coder",
    name: "coder",
    description:
      "软件工程 agent：擅长代码阅读、重构与测试，绑定 git / shell 相关 skill。（示例数据）",
    model: "deepseek-coder",
    skills: [
      skill("code-review", "审查改动并给出建议"),
      skill("refactor", "小步重构"),
      skill("run-tests", "运行测试并汇总结果"),
      skill("shell", "执行受限 shell 命令"),
    ],
    mcpServers: [mcp("filesystem"), mcp("git"), mcp("shell")],
    path: "~/.hermes/profiles/coder (mock)",
    source: "mock",
  },
  {
    id: "researcher",
    name: "researcher",
    description:
      "深度研究 agent：多来源检索、交叉验证并输出结构化报告。（示例数据）",
    model: "deepseek-reasoner",
    skills: [
      skill("web-search"),
      skill("arxiv", "检索 arXiv 论文"),
      skill("citations", "生成规范化引用"),
      skill("report-writer", "输出结构化报告"),
    ],
    mcpServers: [mcp("fetch"), mcp("browser")],
    path: "~/.hermes/profiles/researcher (mock)",
    source: "mock",
  },
  {
    id: "studio",
    name: "studio",
    description:
      "多媒体创作 agent：语音合成、转写与演示文稿生成，预留给 PPT Skill。（示例数据）",
    model: "deepseek-flash",
    skills: [
      skill("tts", "文本转语音"),
      skill("stt", "语音转文本"),
      skill("ppt", "生成/编辑 PPT（自带 Skill UI）"),
      skill("ppt-builder", "生成演示文稿"),
    ],
    mcpServers: [mcp("ekko-studio-api"), mcp("ekko-studio-browser")],
    path: "~/.hermes/profiles/studio (mock)",
    source: "mock",
  },
];

/** 返回一份 mock agent 列表（返回拷贝，避免调用方误改内部常量）。 */
export function getMockAgents(): Agent[] {
  return MOCK_AGENTS.map((agent) => ({
    ...agent,
    skills: agent.skills.map((item) => ({ ...item })),
    mcpServers: agent.mcpServers.map((item) => ({
      ...item,
      args: item.args ? [...item.args] : undefined,
    })),
  }));
}
