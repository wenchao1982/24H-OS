import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SkillFileReadResult,
  SkillFileWriteResult,
  SkillHostInvokeRequest,
  SkillHostInvokeResponse,
  SkillUiCapability,
  SkillUiError,
  SkillUiInfo,
} from "@shared/types";
import { findSkillUi } from "./discover";
import { exportPptx } from "./tools";
import { completePrompt, type CompleteResult } from "../hermes/complete";

/**
 * 能力 broker：把 Skill UI 的 RPC 请求映射到宿主能力，并做双重门禁
 * （capability 白名单 + permission 声明）。
 *
 * 工作区沙箱：readFile / writeFile 只允许访问
 *   ~/.24os/workspace/<skillId>/
 * 可用 OS_WORKSPACE_ROOT 覆盖根目录（测试时配合临时 HOME）。
 */

/** runTool 白名单。 */
const ALLOWED_TOOLS = new Set(["ppt.export"]);

/** 模型补全函数签名（便于测试注入 stub）。 */
export type ModelCompleter = (
  prompt: string,
  options?: { profile?: string },
) => Promise<CompleteResult>;

/** invokeSkill 依赖注入（测试用）。 */
export interface InvokeDeps {
  /** 替换 callModel 的实现；默认走 completePrompt 降级链。 */
  complete?: ModelCompleter;
}

/** 每个方法额外要求的 permission（runTool 动态按 tool 名推导）。 */
const CAPABILITY_PERMISSION: Partial<Record<SkillUiCapability, string>> = {
  callModel: "model:call",
  readFile: "fs:read:workspace",
  writeFile: "fs:write:workspace",
};

/** 合法 skill id（防止用 id 做路径穿越）。 */
export function isSafeSkillId(id: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(id);
}

/** 该 skill 的沙箱工作区根目录。 */
export function getWorkspaceRoot(skillId: string): string {
  const base =
    process.env.OS_WORKSPACE_ROOT ?? path.join(os.homedir(), ".24os", "workspace");
  return path.join(base, skillId);
}

/**
 * 把相对路径解析到工作区内；越界 / 非法返回 null。
 * 空路径回退到工作区根本身（不允许对根做文件操作，故 readFile 会失败）。
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  relPath: unknown,
): string | null {
  if (typeof relPath !== "string" || relPath.includes("\0")) return null;
  const root = path.resolve(workspaceRoot);
  const trimmed = relPath.trim();
  if (trimmed === "") return null;
  const absolute = path.resolve(root, trimmed);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

/** 构造失败响应。 */
function fail(status: number, code: string, message: string): InvokeOutcome {
  return { status, body: { ok: false, error: { code, message } satisfies SkillUiError } };
}

/** 构造成功响应。 */
function ok(result: unknown): InvokeOutcome {
  return { status: 200, body: { ok: true, result } };
}

/** broker 调用结果：HTTP 状态 + 响应体。 */
export interface InvokeOutcome {
  status: number;
  body: SkillHostInvokeResponse;
}

/** 校验方法是否在 skill 声明的 capabilities 内。 */
function hasCapability(skill: SkillUiInfo, method: string): method is SkillUiCapability {
  return (skill.manifest.capabilities as readonly string[]).includes(method);
}

/** 校验 skill 是否声明了某权限。 */
function hasPermission(skill: SkillUiInfo, permission: string): boolean {
  return skill.manifest.permissions.includes(permission);
}

async function dispatch(
  skill: SkillUiInfo,
  method: SkillUiCapability,
  params: Record<string, unknown>,
  deps: InvokeDeps,
): Promise<InvokeOutcome> {
  const workspace = getWorkspaceRoot(skill.id);

  switch (method) {
    case "readFile": {
      const target = resolveWorkspacePath(workspace, params.path);
      if (!target) {
        return fail(403, "PATH_OUTSIDE_WORKSPACE", "路径越出沙箱工作区，已拒绝。");
      }
      try {
        const content = await readFile(target, "utf8");
        return ok({ path: target, content } satisfies SkillFileReadResult);
      } catch (error) {
        return fail(404, "FILE_NOT_FOUND", `读取失败：${(error as Error).message}`);
      }
    }

    case "writeFile": {
      const target = resolveWorkspacePath(workspace, params.path);
      if (!target) {
        return fail(403, "PATH_OUTSIDE_WORKSPACE", "路径越出沙箱工作区，已拒绝。");
      }
      const content = typeof params.content === "string" ? params.content : "";
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        const bytes = Buffer.byteLength(content, "utf8");
        return ok({ path: target, bytes } satisfies SkillFileWriteResult);
      } catch (error) {
        return fail(500, "WRITE_FAILED", `写入失败：${(error as Error).message}`);
      }
    }

    case "runTool": {
      const tool = typeof params.tool === "string" ? params.tool : "";
      if (!ALLOWED_TOOLS.has(tool)) {
        return fail(400, "TOOL_NOT_ALLOWED", `未在工具白名单中：${tool || "(空)"}`);
      }
      if (tool === "ppt.export") {
        const outputPath = path.join(workspace, "deck.pptx");
        try {
          const result = await exportPptx(params.deck, outputPath);
          return ok(result);
        } catch (error) {
          return fail(500, "TOOL_FAILED", `ppt.export 失败：${(error as Error).message}`);
        }
      }
      return fail(400, "TOOL_NOT_ALLOWED", `工具未实现：${tool}`);
    }

    case "callModel": {
      const prompt = typeof params.prompt === "string" ? params.prompt : "";
      const profile = typeof params.profile === "string" ? params.profile : undefined;
      const complete = deps.complete ?? completePrompt;
      try {
        const result = await complete(prompt, profile ? { profile } : undefined);
        return ok({ text: result.text, via: result.via, stub: result.stub ?? false });
      } catch (error) {
        return fail(502, "MODEL_CALL_FAILED", `模型调用失败：${(error as Error).message}`);
      }
    }

    case "emitEvent":
      return ok({ ok: true });

    case "resize":
      return ok({ ok: true });

    default:
      return fail(400, "UNKNOWN_METHOD", `未知方法：${method}`);
  }
}

/** 处理一次 POST /api/skill-host/invoke。 */
export async function invokeSkill(
  request: SkillHostInvokeRequest,
  deps: InvokeDeps = {},
): Promise<InvokeOutcome> {
  const skillId = typeof request?.skillId === "string" ? request.skillId : "";
  const method = request?.method;
  const params =
    request?.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};

  if (!skillId || !method) {
    return fail(400, "BAD_REQUEST", "缺少 skillId 或 method。");
  }
  if (!isSafeSkillId(skillId)) {
    return fail(400, "BAD_SKILL_ID", "非法的 skill id。");
  }

  const skill = findSkillUi(skillId);
  if (!skill) {
    return fail(404, "SKILL_UI_NOT_FOUND", `未找到带 UI 的 skill：${skillId}`);
  }

  if (!hasCapability(skill, method)) {
    return fail(403, "CAPABILITY_NOT_DECLARED", `skill 未声明 capability：${method}`);
  }

  let permission = CAPABILITY_PERMISSION[method];
  if (method === "runTool") {
    const tool = typeof params.tool === "string" ? params.tool : "";
    permission = `tool:${tool}`;
  }
  if (permission && !hasPermission(skill, permission)) {
    return fail(403, "PERMISSION_NOT_DECLARED", `skill 未声明权限：${permission}`);
  }

  return dispatch(skill, method, params, deps);
}
