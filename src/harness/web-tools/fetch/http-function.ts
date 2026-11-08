import path from "node:path";
import type { WebCapabilityOptions } from "../core/runtime-types.ts";
import type { WebFetchExecutionContext } from "../core/types.ts";
import { validateRequestUrl } from "../network/network-policy.ts";
import { fetchHttpUrl } from "../network/http-client.ts";
import { checkWritablePath } from "../../../pimoon/paths.ts";
import { protectedCredentialPaths } from "../../../pimoon/profile.ts";
import { downloadFile } from "./download.ts";

export interface HttpInput {
	url: string;
	mode?: "text" | "probe" | "download";
	path?: string;
	timeout?: number;
}
export interface HttpResult {
	status: number;
	url: string;
	content_type: string | null;
	bytes: number;
	headers_ms: number;
	total_ms: number;
	speed_bytes_per_second: number;
	body?: string;
	path?: string;
}

/** 复用网络策略、逐跳重定向、代理和大小限制；不读取浏览器或用户 Cookie。 */
export async function executeHttp(input: HttpInput, context: WebFetchExecutionContext, workspace: string, options: WebCapabilityOptions): Promise<HttpResult> {
	const started = performance.now();
	const mode = input.mode ?? "text";
	if ((mode === "download") !== (input.path !== undefined)) throw new Error("download 模式必须且仅能提供 path。");
	if (input.path !== undefined) await checkWritablePath(workspace, input.path, protectedCredentialPaths);
	const loaded = await options.loadConfig();
	const requested = validateRequestUrl(input.url, context.privateNetworkGrant?.origin, loaded.network.restrict_private_addresses);
	if ("status" in requested) throw new Error(requested.error.message);
	const config = { ...loaded, webfetch: { ...loaded.webfetch,
		timeout_seconds: input.timeout ?? loaded.webfetch.timeout_seconds, cookies: { ...loaded.webfetch.cookies, enabled: false } } };
	const dispatcher = await options.getDispatcher(config.network);
	const privateNetworkDispatcher = context.privateNetworkGrant === undefined ? undefined : await options.getDispatcher(config.network, context.privateNetworkGrant);
	let headersMs = 0;
	const limitKey = mode === "text" ? "limits" : "download";
	const maxBytes = config.webfetch[limitKey].response_bytes;
	const fetch = async (onChunk?: (chunk: Uint8Array) => Promise<void>) => {
		const result = await fetchHttpUrl(requested, {
			config, dispatcher, ...(privateNetworkDispatcher ? { privateNetworkDispatcher } : {}), context,
			fetchImpl: async (url, init) => { const response = await options.fetchImpl(url, init); headersMs = Math.round((performance.now() - started) * 100) / 100; return response; },
			cookieStore: { getCookieAccess: async () => ({}), storeFromResponse: async () => undefined },
			approvedAuthOrigins: new Set(), startedAt: options.now(), now: options.now,
		}, { maxBytes, accept: "*/*", ...(onChunk ? { onChunk } : {}) });
		if (result.status === "failed") {
			const { code, message } = result.details.error;
			throw new Error(`${code}: ${message}${code === "RESPONSE_TOO_LARGE" ? ` limit_config=webfetch.${limitKey}.response_bytes; max_bytes=${maxBytes}.` : ""}`);
		}
		return result;
	};
	const destination = input.path === undefined ? undefined : path.resolve(workspace, input.path);
	const result = mode === "download" && destination !== undefined
		? await downloadFile(workspace, destination, context.signal, fetch)
		: await fetch(mode === "probe" ? async () => {} : undefined);
	const totalMs = Math.round((performance.now() - started) * 100) / 100;
	const output: HttpResult = { status: result.httpStatus, url: result.finalUrl, content_type: result.headers.get("content-type"),
		bytes: result.downloadedBytes, headers_ms: headersMs, total_ms: totalMs,
		speed_bytes_per_second: totalMs > 0 ? Math.round(result.downloadedBytes * 1000 / totalMs) : 0 };
	if (mode === "text") {
		const contentType = result.headers.get("content-type") ?? "";
		if (!/(?:^text\/|json|xml|javascript|svg)/iu.test(contentType)) throw new Error("二进制响应请使用 download；查看图片使用 webfetch(mode='image')。");
		output.body = new TextDecoder("utf-8", { fatal: true }).decode(result.body);
	}
	if (destination !== undefined) output.path = destination;
	return output;
}
