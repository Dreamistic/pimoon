import { expect, it, vi } from "vitest";
import type { WebHttpResponse } from "../../../src/harness/web-tools/network/types.ts";
import { readLimitedResponseBody } from "../../../src/harness/web-tools/network/response-body.ts";

it("消费者逐块完成后再读取，统计完整字节但不保留正文", async () => {
 let produced = 0, consumed = 0;
 const response = streamResponse(new ReadableStream<Uint8Array>({
  pull(controller) {
   expect(produced).toBe(consumed);
   if (produced === 100) { controller.close();return; }
   produced++;controller.enqueue(new Uint8Array(65536));
  },
 }, { highWaterMark: 0 }));
 const result = await readLimitedResponseBody(response, { maxBytes: 8 * 1024 * 1024,
  async onChunk() { await Promise.resolve();consumed++; },
 });
 expect(consumed).toBe(100);expect(result).toEqual({ status: "success", bytes: new Uint8Array(), receivedBytes: 6553600 });
});

it("消费者写入失败保留原错误，并取消响应流", async () => {
 const cancel = vi.fn();
 const response = streamResponse(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4)); }, cancel }, { highWaterMark: 0 }));
 await expect(readLimitedResponseBody(response, { maxBytes: 16, async onChunk() { throw new Error("disk full"); } })).rejects.toThrow("disk full");
 expect(cancel).toHaveBeenCalledTimes(1);
});

function streamResponse(stream: ReadableStream<Uint8Array>): WebHttpResponse {
 return { status: 200, statusText: "OK", headers: new Headers(),
  body: { getReader() {
   const reader = stream.getReader();
   return { async read() { const row = await reader.read();return row.done ? { done: true } : { done: false, value: row.value }; }, cancel: () => reader.cancel() };
  }, cancel: () => stream.cancel() },
 };
}
