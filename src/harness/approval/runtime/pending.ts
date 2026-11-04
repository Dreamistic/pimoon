import { createHash } from "node:crypto";

/** 审批上下文与实际输入的稳定散列；不是执行凭证。 */
export function approvalFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => {
		if (item instanceof RegExp) return { source: item.source, flags: item.flags };
		if (typeof item === "object" && item !== null && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
		return item;
	})).digest("hex");
}
