import path from "node:path";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { resolveBashWorkdir } from "../../bash-tool/workdir.ts";
import type { BashParams } from "../../bash-tool/types.ts";
import { resolveNativeInputPath } from "../../filesystem/kernel/access-policy.ts";
import { loadWebToolsConfig } from "../../web-tools/config.ts";
import { inspectWebFetchTarget, validateRequestUrl } from "../../web-tools/network/network-policy.ts";
import { buildBashApprovalRequest } from "../request/bash/parse.ts";
import { isSystemTemporaryDescendant } from "../request/path.ts";
import type { ApprovalEditReplacement, ApprovalRequest, ApprovalUnit } from "../types.ts";

type WriteApprovalInput = Record<string, unknown> & { path: string; content: string };
type EditApprovalInput = Record<string, unknown> & { path: string; edits: ApprovalEditReplacement[] };
type WebFetchApprovalInput = Record<string, unknown> & { url: string };

export function isApprovalToolCall(event: Pick<ToolCallEvent, "toolName">): boolean {
	return event.toolName === "bash" || event.toolName === "write" || event.toolName === "edit" || event.toolName === "webfetch" || event.toolName === "process_run" || event.toolName === "http";
}

/** Pi 在 tool_call 前已完成工具参数校验，这里只建立审批目标。 */
export async function buildApprovalRequest(event: ToolCallEvent, cwd: string): Promise<ApprovalRequest | undefined> {
	if (event.toolName === "process_run") {
		const argv = event.input.argv;
		if (!Array.isArray(argv) || !argv.every((value): value is string => typeof value === "string")) return undefined;
		const overrides = event.input.env;
		const env: Record<string, string> = {};
		if (typeof overrides === "object" && overrides !== null) for (const [key, value] of Object.entries(overrides)) if (typeof value === "string") env[key] = value;
		const workdir = typeof event.input.cwd === "string" ? path.resolve(cwd, event.input.cwd) : cwd;
		const replacement = event.input.inherit_env === false ? { inherit_env: false as const } : {};
		const value = JSON.stringify({ argv, ...replacement, env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) });
		return { tool: "process_run", cwd: workdir, detail: { argv, env, ...replacement }, units: [{ action: "execute", target: { kind: "command", value, effective_value: value }, remember: { session: true, persistent: Object.keys(env).length === 0 } }] };
	}
	if (isToolCallEventType("bash", event)) {
		// SDK 内置 bash 输入类型不含本项目新增的 workdir。
		const input: BashParams = event.input;
		if (input.command.trim().length === 0) return undefined;
		return buildBashApprovalRequest(input.command, resolveBashWorkdir(input.workdir, cwd));
	}
	cwd = path.resolve(cwd).replace(/\\/g, "/");
	if (isToolCallEventType<"write", WriteApprovalInput>("write", event)) {
		if (event.input.path.length === 0) return undefined;
		const targetPath = fileToolTarget(event.input.path, cwd);
		return {
			tool: "write", cwd,
			detail: { path: targetPath, content: event.input.content },
			units: [pathUnit("write_file", targetPath)],
		};
	}
	if (isToolCallEventType<"edit", EditApprovalInput>("edit", event)) {
		if (event.input.path.length === 0) return undefined;
		const targetPath = fileToolTarget(event.input.path, cwd);
		return {
			tool: "edit", cwd,
			detail: { path: targetPath, edits: event.input.edits },
			units: [pathUnit("edit_file", targetPath)],
		};
	}
	if (isToolCallEventType<"webfetch", WebFetchApprovalInput>("webfetch", event) || isToolCallEventType<"http", WebFetchApprovalInput>("http", event)) {
		const webConfig = await loadWebToolsConfig();
		const outputPath = event.toolName === "http" && typeof event.input.path === "string" ? fileToolTarget(event.input.path, cwd) : undefined;
		if (!webConfig.network.restrict_private_addresses) {
			if (outputPath === undefined) return undefined;
			const parsed = validateRequestUrl(event.input.url, undefined, false);
			if ("status" in parsed) return undefined;
			return {
				tool: event.toolName, cwd,
				detail: { url: parsed.displayUrl, origin: parsed.url.origin, path: outputPath },
				units: [pathUnit("write_file", outputPath)],
			};
		}
		const inspection = await inspectWebFetchTarget(event.input.url, { allowedFakeIpRanges: webConfig.network.fake_ip_ranges, trustedHttpsOrigins: webConfig.network.trusted_https_origins });
		// 无效请求交给工具报告错误，公网请求仍由网络边界检查 DNS 和重定向。
		if ("error" in inspection) return undefined;
		if (inspection.status !== "private" && outputPath === undefined) return undefined;
		const origin = inspection.validated.url.origin;
		return {
			tool: event.toolName, cwd,
			detail: { url: inspection.validated.displayUrl, origin, addresses: inspection.addresses, ...(outputPath ? { path: outputPath } : {}) },
			units: [
				...(inspection.status === "private" ? [{ action: "fetch_url" as const, target: { kind: "url" as const, value: origin }, remember: { session: true, persistent: true } }] : []),
				...(outputPath ? [pathUnit("write_file", outputPath)] : []),
			],
		};
	}
	return undefined;
}

function fileToolTarget(input: string, cwd: string): string {
	return input.startsWith("skill://") ? input : resolveNativeInputPath(cwd, input).replace(/\\/g, "/");
}

function pathUnit(action: "write_file" | "edit_file", targetPath: string): ApprovalUnit {
	return {
		action,
		target: { kind: "path", value: targetPath },
		...(isSystemTemporaryDescendant(targetPath) ? { effect_scope: "temporary" as const } : {}),
		remember: { session: true, persistent: true },
	};
}
