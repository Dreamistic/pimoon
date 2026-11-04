export interface CodeActMetadata {
	desc?: string | undefined;
	confirm?: string | undefined;
}

export const MAX_EXECUTE_TAG_LENGTH = 4096;

/** 属性只从完整开始行读取；未知、重复或损坏的属性不能静默跳过确认。 */
export function executeMetadata(line: string): CodeActMetadata {
	if (line.length > MAX_EXECUTE_TAG_LENGTH) throw new Error("CodeAct 开始标记过长，代码未执行。");
	const match = /^<execute((?:\s[^\r\n]*)?)>$/u.exec(line);
	if (!match) throw new Error("CodeAct 开始标记无效，代码未执行。");
	let remaining = match[1] ?? "";
	const metadata: CodeActMetadata = {};
	const seen = new Set<string>();
	while (remaining.trim()) {
		const attribute = /^\s+(desc|confirm)\s*=\s*(["'])([^<>\r\n]*?)\2/u.exec(remaining);
		const name = attribute?.[1];
		if (!attribute || name !== "desc" && name !== "confirm" || seen.has(name))
			throw new Error("CodeAct 仅接受不重复的 desc/confirm 引号属性，代码未执行。");
		seen.add(name);
		const value = decodeAttribute(attribute[3] ?? "").trim();
		if (!value || value.length > (name === "desc" ? 160 : 1000) || /[\x00-\x1f\x7f]/u.test(value))
			throw new Error("CodeAct 属性为空、过长或含控制字符，代码未执行。");
		metadata[name] = value;
		remaining = remaining.slice(attribute[0].length);
	}
	return metadata;
}

export function possibleExecuteStart(line: string): boolean {
	return "<execute".startsWith(line) || /^<execute(?:\s|>)/u.test(line);
}

function decodeAttribute(value: string): string {
	return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/giu, entity => {
		switch (entity.toLowerCase()) {
			case "&quot;": return '"';
			case "&apos;": return "'";
			case "&amp;": return "&";
			case "&lt;": return "<";
			case "&gt;": return ">";
		}
		const hex = entity[2]?.toLowerCase() === "x";
		const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
		if (code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw new Error("CodeAct 属性字符无效，代码未执行。");
		return String.fromCodePoint(code);
	});
}
