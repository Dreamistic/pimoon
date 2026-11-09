import path from "node:path";
import { pimoonHome } from "../../pimoon/profile.ts";
import { lstat, readFile } from "node:fs/promises";
import type { ApprovalRequest } from "./types.ts";
import { trackedFile } from "./routine-repository.ts";
import { missing, routinePath, within } from "./routine-paths.ts";

const READ_TOOLS = new Set(["read", "find", "grep", "ls"]);
const EDITABLE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".c", ".h", ".cpp", ".cs", ".css", ".scss", ".html", ".vue", ".svelte", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml", ".sql"]);

export async function routineFile(request: ApprovalRequest, workspace: string, created: ReadonlySet<string> = new Set()): Promise<string | undefined> {
	const writing = request.tool === "write" || request.tool === "edit";
	if (writing) {
		const target = request.detail.path;
		if (await memoryEntry(target, workspace, true)) return "memory_entry";
		if (EDITABLE.has(path.extname(target).toLowerCase()) && await routinePath(workspace, target, true)) {
			try {
				if (!(await lstat(target)).isFile()) return;
				if (created.has(target) || await trackedFile(workspace, target)) return "project_edit";
			} catch (error) { if (missing(error)) return "project_new_file"; }
		}
		return;
	}
	if (request.tool !== "other" || !READ_TOOLS.has(request.detail.name)) return;
	const input = request.detail.input;
	const targets = input.path === undefined && request.detail.name !== "read" ? [workspace]
		: Array.isArray(input.path) ? input.path : [input.path];
	if (!targets.length || !targets.every((target): target is string => typeof target === "string")) return;
	for (const target of targets) {
		if (await routinePath(workspace, target)) continue;
		if (await memoryEntry(path.resolve(workspace, target), workspace, false)) continue;
		return;
	}
	return "local_inspection";
}

/** 只读取现有项目映射，不通过审批探针创建目录或写入 registry。 */
async function memoryEntry(target: string, workspace: string, write: boolean): Promise<boolean> {
	const root = path.join(pimoonHome, "memory");
	if (!within(root, target)) return false;
	const parts = path.relative(root, target).split(path.sep);
	let scope: string;
	if (parts[0] === "user") scope = path.join(root, "user");
	else if (parts[0] === "projects" && parts[1]) {
		try {
			const value: unknown = JSON.parse(await readFile(path.join(root, "projects.json"), "utf8"));
			if (typeof value !== "object" || value === null || !("projects" in value) || typeof value.projects !== "object" || value.projects === null) return false;
			// 映射按 git-common-dir 或非 Git 根命名；当前工作区的绑定由调用方提供的目录校验。
			const entries = Object.entries(value.projects);
			const project = parts[1];
			if (!entries.some(([key, id]) => id === project && (path.resolve(key) === path.resolve(workspace) || within(workspace, key)))) return false;
			scope = path.join(root, "projects", project);
		} catch { return false; }
	} else return false;
	const relative = path.relative(scope, target).replaceAll("\\", "/");
	if (!(relative === "MEMORY.md" && !write || /^entries\/[\p{L}\p{N}_.-]+\.md$/u.test(relative))) return false;
	return routinePath(scope, target, write);
}
