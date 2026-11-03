import type { AgentTool } from "@earendil-works/pi-agent-core";
import { codemodeAllowedTools } from "./loadout.ts";

type CatalogTool = Pick<AgentTool, "name" | "description" | "parameters" | "outputSchema">;

/** 从真实 schema 生成 Python 调用目录，不重复暴露 JSON 工具声明。 */
export function codemodeCatalog(tools: readonly CatalogTool[]): string {
	return tools.filter(tool => tool.name !== "codemode" && codemodeAllowedTools.has(tool.name)).map(tool => {
		const schema: unknown = tool.parameters;
		const output = tool.outputSchema === undefined ? "str" : pythonType(tool.outputSchema);
		if (!isRecord(schema)) return `${tool.name}() -> ${output} - ${tool.description}`;
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		const properties = isRecord(schema.properties) ? schema.properties : {};
		const args = Object.entries(properties).map(([name, value]) => `${name}${required.has(name) ? "" : "?"}: ${pythonType(value)}`);
		return [`${tool.name}(${args.join(", ")}) -> ${output} - ${tool.description}`, ...parameterNotes(properties)].join("\n");
	}).join("\n");
}

function pythonType(schema: unknown): string {
	if (!isRecord(schema)) return "object";
	if ("const" in schema) return JSON.stringify(schema.const);
	if (Array.isArray(schema.enum)) return schema.enum.map(value => JSON.stringify(value)).join("|");
	const choices = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(choices)) return choices.map(pythonType).join("|");
	switch (schema.type) {
		case "string": return "str";
		case "integer": return "int";
		case "number": return "float";
		case "boolean": return "bool";
		case "null": return "None";
		case "array": return `list[${pythonType(schema.items)}]`;
		case "object": {
			if (!isRecord(schema.properties)) return "dict";
			const required = new Set(Array.isArray(schema.required) ? schema.required : []);
			return `{${Object.entries(schema.properties).map(([name, value]) => `${name}${required.has(name) ? "" : "?"}: ${pythonType(value)}`).join(", ")}}`;
		}
		default: return "object";
	}
}

function parameterNotes(properties: Record<string, unknown>, prefix = ""): string[] {
	return Object.entries(properties).flatMap(([name, value]) => {
		if (!isRecord(value)) return [];
		const key = `${prefix}${name}`;
		const notes = typeof value.description === "string" ? [`  ${key}: ${value.description}`] : [];
		const nested = value.type === "array" && isRecord(value.items) ? value.items : value;
		if (isRecord(nested.properties)) notes.push(...parameterNotes(nested.properties, `${key}${value.type === "array" ? "[]" : ""}.`));
		return notes;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
