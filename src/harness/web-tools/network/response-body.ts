import type { WebHttpHeaders, WebHttpResponse } from "./types.ts";

/** 共享受限正文读取结果；失败码保持通用，由调用工具映射到自身错误结构。 */
export type ResponseBodyReadResult =
	| {
			status: "success";
			bytes: Uint8Array;
			receivedBytes: number;
	  }
	| {
			status: "failed";
			code: "RESPONSE_TOO_LARGE" | "ABORTED" | "CONNECTION_FAILED";
			message: string;
	  };

/** 读取有上限的响应正文；调用方负责把通用错误映射到具体工具的 details。 */
export async function readLimitedResponseBody(
	response: WebHttpResponse,
	options: {
		maxBytes: number;
		onProgress?: (receivedBytes: number) => void;
		signal?: AbortSignal;
		onChunk?: (chunk: Uint8Array) => Promise<void>;
	},
): Promise<ResponseBodyReadResult> {
	const expected = responseContentLength(response.headers);
	if (options.signal?.aborted) { cancelBody(response.body); return abortedResult(options.signal.reason); }
	if (expected !== undefined && expected > options.maxBytes) {
		cancelBody(response.body);
		return {
			status: "failed",
			code: "RESPONSE_TOO_LARGE",
			message: `response exceeded ${options.maxBytes} bytes.`,
		};
	}
	if (response.body === null) return { status: "success", bytes: new Uint8Array(), receivedBytes: 0 };

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let completed = false;
	try {
		while (true) {
			let next: { done: boolean; value?: Uint8Array };
			try { next = await readWithSignal(reader, options.signal); }
			catch (error) {
				if (options.signal?.aborted) return abortedResult(error);
				return { status: "failed", code: "CONNECTION_FAILED", message: errorMessage(error) };
			}
			if (next.done) { completed = true; break; }
			const value = next.value;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > options.maxBytes) return {
				status: "failed", code: "RESPONSE_TOO_LARGE", message: `response exceeded ${options.maxBytes} bytes.`,
			};
			// 消费者逐块等待，写盘自然形成背压；文件错误不伪装成网络错误。
			if (options.onChunk) await options.onChunk(value);
			else chunks.push(value);
			options.onProgress?.(total);
		}
	} finally {
		if (!completed) cancelBody(reader);
	}

	if (options.signal?.aborted) return abortedResult(options.signal.reason);
	const bytes = new Uint8Array(options.onChunk ? 0 : total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { status: "success", bytes, receivedBytes: total };
}

export function cancelBody(resource: { cancel(): Promise<void> } | null): void {
	if (resource === null) return;
	try {
		void resource.cancel().catch(() => undefined);
	} catch {
		// 清理失败不能覆盖原读取结果。
	}
}

async function readWithSignal(
	reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> },
	signal: AbortSignal | undefined,
): Promise<{ done: boolean; value?: Uint8Array }> {
	if (signal === undefined) return reader.read();
	if (signal.aborted) {
		cancelBody(reader);
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			cancelBody(reader);
			reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		void reader.read().then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function abortedResult(error: unknown): ResponseBodyReadResult {
	return { status: "failed", code: "ABORTED", message: errorMessage(error) };
}

export function responseContentLength(headers: WebHttpHeaders): number | undefined {
	const value = headers.get("content-length");
	if (value === null) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
