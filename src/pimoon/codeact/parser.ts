import { executeMetadata, possibleExecuteStart, MAX_EXECUTE_TAG_LENGTH, type CodeActMetadata } from "./metadata.ts";

/** 开始标记独占一行，行首结束标记提交；围栏与文本 thinking 中的示例不执行。 */
export type CodeActChunk = { type: "text" | "code"; text: string } | { type: "open"; metadata: CodeActMetadata } | { type: "close" };

export class CodeActParser {
	private mode: "text" | "code" | "closed" = "text";
	private line = "";
	private emitted = 0;
	private fence: { character: string; length: number } | undefined;
	private thinking = 0;
	private codeChars = 0;
	private consumedChars = 0;

	get closed(): boolean { return this.mode === "closed"; }
	get consumed(): number { return this.consumedChars; }

	feed(text: string): CodeActChunk[] {
		const chunks: CodeActChunk[] = [];
		let start = 0;
		while (start < text.length && !this.closed) {
			const end = text.indexOf("\n", start);
			const fragment = text.slice(start, end < 0 ? undefined : end);
			this.line += fragment;
			this.consumedChars += fragment.length + (end < 0 ? 0 : 1);
			this.consume(end >= 0, end >= 0, chunks);
			if (end < 0) break;
			start = end + 1;
		}
		return chunks;
	}

	/** 独立正文块有自己的行首；不向原文或源码插入换行。 */
	textBoundary(): CodeActChunk[] {
		const chunks: CodeActChunk[] = [];
		if (this.mode === "text") this.consume(true, false, chunks);
		return chunks;
	}

	finish(): CodeActChunk[] {
		const chunks: CodeActChunk[] = [];
		if (!this.closed) this.consume(true, false, chunks);
		if (this.mode === "code") throw new Error("CodeAct 执行块未闭合，代码未执行。");
		return chunks;
	}

	private consume(complete: boolean, newline: boolean, chunks: CodeActChunk[]): void {
		const line = this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line;
		const marker = this.mode === "code" ? "</execute>" : "<execute>";
		const eligible = this.mode === "code" || !this.fence && this.thinking === 0;
		const closing = this.mode === "code" && line.startsWith(marker);
		const opening = this.mode === "text" && eligible && possibleExecuteStart(line);
		if (opening && line.length > MAX_EXECUTE_TAG_LENGTH) throw new Error("CodeAct 开始标记过长，代码未执行。");
		if (closing || opening && complete && line.startsWith("<execute")) {
			if (this.mode === "code" && this.codeChars === 0) throw new Error("CodeAct 执行块为空，代码未执行。");
			// 提交点精确到结束标签；同一行的后缀和换行都不能进入源码或重放文本。
			if (closing) this.consumedChars -= this.line.length - marker.length + Number(newline);
			chunks.push(this.mode === "code" ? { type: "close" } : { type: "open", metadata: executeMetadata(line) });
			this.mode = this.mode === "code" ? "closed" : "code";
		} else if (complete || !eligible || !(this.mode === "code" ? marker.startsWith(line) : opening)) {
			const text = this.line.slice(this.emitted) + (newline ? "\n" : "");
			if (text) {
				if (this.mode === "code") {
					this.codeChars += text.length;
					if (this.codeChars > 1024 * 1024) throw new Error("CodeAct 源码超过 1 Mi 字符，代码未执行。");
				}
				chunks.push({ type: this.mode === "code" ? "code" : "text", text });
			}
			this.emitted = this.line.length;
			if (complete && this.mode === "text") this.trackExamples(line);
		}
		if (complete) { this.line = ""; this.emitted = 0; }
	}

	private trackExamples(line: string): void {
		const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if (fence) {
			const marker = fence[1];
			if (marker) {
				if (!this.fence) this.fence = { character: marker[0] ?? "", length: marker.length };
				else if (marker[0] === this.fence.character && marker.length >= this.fence.length && !fence[2]?.trim()) this.fence = undefined;
			}
			return;
		}
		if (!this.fence) for (const match of line.matchAll(/<\/?thinking>/gu)) {
			this.thinking = Math.max(0, this.thinking + (match[0] === "<thinking>" ? 1 : -1));
		}
	}
}
