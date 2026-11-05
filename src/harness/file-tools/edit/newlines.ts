import type { EditReplacement } from "./types.ts";

/** 仅兼容整份文件一致的 LF/CRLF，不改变缩进、空白或混合换行文件。 */
export function adaptReplacementNewlines(text: string, replacements: readonly EditReplacement[]): readonly EditReplacement[] {
	const newline = uniformNewline(text);
	if (newline === undefined) return replacements;
	return replacements.map(replacement => ({
		...replacement,
		old: adapt(replacement.old, newline),
		new: adapt(replacement.new, newline),
	}));
}

function uniformNewline(text: string): "\n" | "\r\n" | undefined {
	const withoutPairs = text.replace(/\r\n/gu, "");
	if (withoutPairs.includes("\r")) return undefined;
	if (text.includes("\r\n")) return withoutPairs.includes("\n") ? undefined : "\r\n";
	return text.includes("\n") ? "\n" : undefined;
}

function adapt(text: string, newline: string): string {
	return uniformNewline(text) === undefined ? text : text.replace(/\r?\n/gu, newline);
}
