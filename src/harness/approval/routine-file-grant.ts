import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveNativeInputPath } from "../filesystem/kernel/access-policy.ts";
import { sensitivePath, within } from "./routine-paths.ts";

const grants = new WeakMap<object, { fingerprint: string; roots: string[] }>();

/** 执行时过滤搜索发现的子项，不为一次根目录免审扫描整棵树。 */
export async function grantRoutineInspection(input: Record<string, unknown>, workspace: string): Promise<void> {
	const roots = [workspace, await realpath(workspace)];
	const values = Array.isArray(input.path) ? input.path : [input.path];
	for (const value of values) if (typeof value === "string") {
		const target = resolveNativeInputPath(workspace, value);
		if (!within(workspace, target)) roots.push(target, await realpath(target).catch(() => target));
	}
	grants.set(input, { fingerprint: JSON.stringify(input), roots });
}

export function routineInspectionFilter(input: object): ((absolutePath: string) => boolean) | undefined {
	const grant = grants.get(input); grants.delete(input);
	if (!grant) return;
	if (JSON.stringify(input) !== grant.fingerprint) throw new Error("Routine inspection parameters changed.");
	return candidate => !grant.roots.some(root => within(root, candidate) && !sensitivePath(path.relative(root, candidate), false));
}
