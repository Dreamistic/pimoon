import type { AgentTool } from "@earendil-works/pi-agent-core";

type FunctionInfo = Pick<AgentTool, "name" | "description" | "parameters" | "outputSchema">;
const keywords = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));
const callableName = (name: string) => /^[A-Za-z_]\w*$/u.test(name) && !keywords.has(name) ? name : `getattr(functions,${JSON.stringify(name)})`;

/** 从 schema 提取 Python 签名和必要参数语义，不发送 JSON 工具声明。 */
export function functionCatalog(functions: readonly FunctionInfo[]): string {
	return functions.map(fn => {
		const schema: unknown = fn.parameters;
		const output = fn.outputSchema === undefined ? "str" : pythonType(fn.outputSchema);
		if (!isRecord(schema)) return `${callableName(fn.name)}() -> ${output}: ${fn.description}`;
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		const properties = isRecord(schema.properties) ? schema.properties : {};
		const signature = `${callableName(fn.name)}(${Object.entries(properties).map(([name, value]) => `${name}${required.has(name) ? "" : "?"}: ${pythonType(value)}`).join(", ")}) -> ${output}: ${fn.description}`;
		return [signature, ...parameterNotes(properties)].join("\n");
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
		const description = typeof value.description === "string" ? value.description : "";
		const minimum = typeof value.minLength === "number" && value.minLength > 0 ? `minLength=${value.minLength}` : "";
		const note = [description, minimum].filter(Boolean).join(" ");
		const notes = note ? [`  ${key}: ${note}`] : [];
		const nested = value.type === "array" && isRecord(value.items) ? value.items : value;
		return isRecord(nested.properties) ? [...notes, ...parameterNotes(nested.properties, `${key}${value.type === "array" ? "[]" : ""}.`)] : notes;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
