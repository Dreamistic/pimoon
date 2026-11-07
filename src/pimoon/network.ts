import { record, fingerprint, requestBindings } from "./telemetry.ts";
import { zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";

export function allowedModelURL(value: string): boolean {
	const url = new URL(value);
	return url.protocol === "https:" && url.hostname === "chatgpt.com" && (!url.port || url.port === "443") && url.pathname === "/backend-api/codex/responses";
}
/** Codex 登录与令牌刷新不是模型调用，只放行 SDK 使用的认证 POST 接口。 */
function allowedAuthRequest(value: string, method: string): boolean {
	const url = new URL(value);
	if (method !== "POST" || url.origin !== "https://auth.openai.com" || url.username || url.password || url.search || url.hash) return false;
	return url.pathname === "/oauth/token" || url.pathname === "/api/accounts/deviceauth/usercode" || url.pathname === "/api/accounts/deviceauth/token";
}
/** 用量查询与重置卡不是模型调用，只放行精确路径及方法。 */
function allowedUsageRequest(value: string, method: string): boolean {
	const url = new URL(value);
	if (url.origin !== "https://chatgpt.com" || url.username || url.password || url.search || url.hash) return false;
	if (method === "GET") return url.pathname === "/backend-api/wham/usage" || url.pathname === "/backend-api/wham/rate-limit-reset-credits";
	return method === "POST" && url.pathname === "/backend-api/wham/rate-limit-reset-credits/consume";
}
/** 桌面 transport 初始化后安装，保留 Electron Request 的跨 realm 兼容。 */
export function installModelBoundary(): void {
	const original = globalThis.fetch;
	globalThis.fetch = async (input, options) => {
		const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		const method = options?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
		if (allowedAuthRequest(url, method.toUpperCase()) || allowedUsageRequest(url, method.toUpperCase())) return original(input, { ...options, redirect: "error" });
		if (!allowedModelURL(url)) { record("network_denied", { target: fingerprint(url) }); throw new Error("pimoon 此构建仅连接 Codex 订阅端点。"); }
		let bytes: Uint8Array | undefined;
		if (typeof options?.body === "string") bytes = new TextEncoder().encode(options.body);
		else if (options?.body instanceof Uint8Array) bytes = options.body;
		else if (typeof input === "object" && "clone" in input && typeof input.clone === "function") bytes = new Uint8Array(await input.clone().arrayBuffer());
		const headers = new Headers(options?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
		const encoding = headers.get("content-encoding");
		const wireBytes = bytes;
		let body: string | undefined;
		try {
			if (bytes && bytes.length > 16 * 1024 * 1024) throw new Error("模型请求超过本地检查上限。");
			if (bytes && encoding === "zstd") bytes = zstdDecompressSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
			else if (encoding && encoding !== "identity") throw new Error("不支持的模型请求编码。");
			body = bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : undefined;
		} catch (error) {
			record("transport_denied", { reason: "body_inspection_error", error: fingerprint(String(error)) });
			throw error;
		}
		if (body === undefined) { record("transport_denied", { reason: "body_unavailable", input_type: typeof input, body_type: typeof options?.body, option_keys: Object.keys(options ?? {}) }); throw new Error("无法校验模型请求正文；已阻止发送。"); }
		const payload = fingerprint(body), binding = requestBindings.get(payload.sha256);
		let parsed: unknown;
		try { parsed = JSON.parse(body); }
		catch (error) {
			// JSON.parse 的错误可能包含正文片段，只保留数字位置与字节指纹。
			const position = error instanceof SyntaxError ? /\bposition (\d+)\b/u.exec(error.message)?.[1] : undefined;
			const byteFingerprint = (value: Uint8Array | undefined) => value
				? { bytes: value.byteLength, sha256: createHash("sha256").update(value).digest("hex") } : undefined;
			record("transport_denied", { ...binding?.labels, reason: "invalid_json", payload,
				encoding: encoding ?? "identity", wire: byteFingerprint(wireBytes), decoded: byteFingerprint(bytes),
				json_error_position: position === undefined ? null : Number(position) });
			throw new Error("模型请求不是有效 JSON。");
		}
		requestBindings.delete(payload.sha256);
		if (!binding?.allowed) { record("transport_denied", { ...binding?.labels, reason: "unbound_session", payload }); throw new Error("模型请求未绑定到允许的 Codex 会话；已阻止发送，不会自动重试。"); }
		if (typeof parsed !== "object" || parsed === null || !("model" in parsed) || typeof parsed.model !== "string" || !parsed.model || parsed.model !== binding?.model) {
			record("transport_denied", { ...binding?.labels, reason: "model_mismatch", payload });
			throw new Error("请求模型与当前会话选择不一致；已阻止自动切换模型。");
		}
		const start = performance.now(); record("transport_start", { ...binding.labels, payload, body_inspected: true });
		try {
			const result = await original(input, { ...options, redirect: "error" });
			record("transport_headers", { ...binding.labels, status: result.status, elapsed_ms: performance.now() - start }); return result;
		} catch (error) { record("transport_error", { ...binding.labels, error: fingerprint(String(error)), elapsed_ms: performance.now() - start }); throw error; }
	};
}
