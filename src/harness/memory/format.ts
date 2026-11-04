import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const MEMORY_TYPES = ["user", "feedback", "lesson", "project", "reference"] as const;
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
	if (!/^---\r?\n/.test(text)) throw new Error("Memory requires YAML frontmatter: name, description, type.");
	const { frontmatter, body } = parseFrontmatter(text);
	const field = (key: string, max: number): string => {
		const value: unknown = frontmatter[key];
		if (typeof value !== "string" || !value.trim() || /[\r\n\x00-\x1f]/.test(value) || [...value].length > max)
			throw new Error(`Memory ${key} must be one line, 1-${max} characters.`);
		return value.trim();
	};
	const name = field("name", 80), description = field("description", 160);
	const type: unknown = frontmatter.type;
	if (!isMemoryType(type)) throw new Error(`Memory type must be ${MEMORY_TYPES.join("|")}.`);
	if (frontmatter.status !== undefined && frontmatter.status !== "active" && frontmatter.status !== "archived")
		throw new Error("Memory status must be active|archived.");
	if (!body.trim()) throw new Error("Memory body is empty; record the lesson, conditions and reason.");
	return { name, description, type, archived: frontmatter.status === "archived" };
}

function isMemoryType(value: unknown): value is MemoryType {
	return MEMORY_TYPES.some(type => type === value);
}

export function memoryIndexLine(entry: MemoryEntry): string {
	const escape = (value: string) => value.replace(/[\\[\]<>`*_]/g, "\\$&");
	return `- [${escape(entry.name)}](entries/${entry.file.replace(/[%()<>\\\\ ]/g, character => encodeURIComponent(character))}): ${escape(entry.description)}`;
}
