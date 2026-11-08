/** 使用宿主解码器支持的字符集；常见 Python/Windows 别名归一后在启动前校验。 */
export function outputDecoder(encoding: string): TextDecoder {
	const name = encoding.toLowerCase().replace(/_/gu, "-");
	const aliases: Record<string, string> = {
		cp65001: "utf-8", cp936: "gbk", cp932: "shift_jis", cp949: "euc-kr", cp950: "big5",
		"utf-8-sig": "utf-8", "utf-16-le": "utf-16le", "utf-16-be": "utf-16be",
	};
	try { return new TextDecoder(aliases[name] ?? name, { fatal: true, ignoreBOM: name !== "utf-8-sig" }); }
	catch { throw new Error(`Unsupported process encoding: ${encoding}; use a supported TextDecoder charset label`); }
}

export interface DecodedOutput {
	text: string;
	error?: string;
}

/** 完整流严格解码；仅对被字节预算截断的流保留完整字符前缀。 */
export function decodeOutput(bytes: Buffer, encoding?: string, fallback?: string, truncated = false): DecodedOutput {
	const encodings = encoding ? [encoding] : ["utf-8", ...(fallback ? [fallback] : [])];
	for (const name of encodings) {
		try { return { text: outputDecoder(name).decode(bytes, { stream: truncated }) }; }
		catch { /* 编码不匹配时仅尝试本次捕获的字节，不重跑程序。 */ }
	}
	return { text: "", error: `Cannot decode process output as ${encodings.join(" or ")}; process already ran, do not replay side effects. Set encoding explicitly; original bytes are retained.` };
}
