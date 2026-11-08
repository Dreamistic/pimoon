import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = typeof MEMORY_TYPES[number];
export const MAX_MEMORY_BYTES = 32 * 1024;

export interface MemoryEntry {
	file: string;
	name: string;
	description: string;
	type: MemoryType;
	archived: boolean;
	version: string;
}

export function parseMemory(text: string): Omit<MemoryEntry, "file" | "version"> {
	if (Buffer.byteLength(text) > MAX_MEMORY_BYTES) throw new Error("Memory exceeds 32 KiB; keep a short lesson and reference larger artifacts.");
	if (!/^---\r?\n/.test(text)) throw new Error("Memory requires YAML frontmatter: name, description, metadata.type.");
	const { frontmatter, body } = parseFrontmatter(text);
	if (frontmatter.type !== undefined) throw new Error("Memory type belongs in metadata.type, not the top level.");
	const field = (key: string, max: number): string => {
		const value: unknown = frontmatter[key];
		if (typeof value !== "string" || !value.trim() || /[\r\n\x00-\x1f]/.test(value) || [...value].length > max)
			throw new Error(`Memory ${key} must be one line, 1-${max} characters.`);
		return value.trim();
	};
	const name = field("name", 80), description = field("description", 160);
	const metadata: unknown = frontmatter.metadata;
	const type = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) && "type" in metadata ? metadata.type : undefined;
	if (!isMemoryType(type)) throw new Error(`Memory metadata.type must be ${MEMORY_TYPES.join("|")}.`);
	if (frontmatter.status !== undefined && frontmatter.status !== "active" && frontmatter.status !== "archived")
		throw new Error("Memory status must be active|archived.");
	if (!body.trim()) throw new Error("Memory body is empty; record the lesson, conditions and reason.");
	return { name, description, type, archived: frontmatter.status === "archived" };
}

/** 升级旧顶层 type；保留正文、未知字段和换行，旧 lesson 作为 reference 而非虚构的用户反馈。 */
export function upgradeLegacyMemory(text: string): string | undefined {
	if (Buffer.byteLength(text) > MAX_MEMORY_BYTES) return undefined;
	const header = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0];
	if (!header) return undefined;
	const { frontmatter } = parseFrontmatter(text);
	const legacy: unknown = frontmatter.type;
	if (frontmatter.metadata !== undefined || !(isMemoryType(legacy) || legacy === "lesson")) return undefined;
	const type = legacy === "lesson" ? "reference" : legacy;
	const newline = header.includes("\r\n") ? "\r\n" : "\n";
	const line = /^type[ \t]*:[^\r\n]*/m.exec(header)?.[0];
	if (!line) return undefined;
	// 迁移只处理明确的单行类型；复杂旧 YAML 留待手动修正，不猜测。
	const scalar = /^type[ \t]*:[ \t]*(?:["']?(?:user|feedback|lesson|project|reference)["']?)[ \t]*(#.*)?$/.exec(line);
	if (!scalar) return undefined;
	const comment = scalar[1] ? ` ${scalar[1]}` : "";
	const migrated = header.replace(line, `metadata:${newline}  type: ${type}${comment}`) + text.slice(header.length);
	parseMemory(migrated);
	return migrated;
}

function isMemoryType(value: unknown): value is MemoryType {
	return MEMORY_TYPES.some(type => type === value);
}

export function memoryIndexLine(entry: MemoryEntry): string {
	const escape = (value: string) => value.replace(/[\\[\]<>`*_]/g, "\\$&");
	return `- [${escape(entry.name)}](entries/${entry.file.replace(/[%()<>\\\\ ]/g, character => encodeURIComponent(character))}): ${escape(entry.description)}`;
}
