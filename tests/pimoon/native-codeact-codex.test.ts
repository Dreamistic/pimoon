import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { stream as codexStream } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
import { fixture, marker } from "./native-fixture.ts";

afterEach(() => vi.unstubAllEnvs());
const model: Model<"openai-codex-responses"> = {
    id: "fixture", name: "Fixture", api: "openai-codex-responses", provider: "openai-codex",
    baseUrl: "https://codex.invalid", reasoning: false, input: ["text"],
    contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const fakePayload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64");

it.each(["completed", "incomplete", "failed", "disconnected", "multiple"] as const)("Codex SSE %s：完整参数不代替成功终态，只执行一个合法调用", async terminal => {
    const value = await fixture([]);
    const payloads: unknown[] = [];
    let requests = 0;
    const event = (payload: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
    const fetchFixture: typeof fetch = async () => {
        const round = ++requests;
        const packets: Uint8Array[] = [];
        const send = (payload: unknown) => packets.push(event(payload));
        send({ type: "response.created", response: { id: `response-${round}` } });
        if (round === 1) {
            for (let index = 0; index < (terminal === "multiple" ? 2 : 1); index++) {
                const item = { type: "function_call", id: `item-${index}`, call_id: `call-${index}`, name: "execute" };
                const args = JSON.stringify({ code: marker, desc: "隔离测试" });
                send({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } });
                for (const delta of [args.slice(0, 17), args.slice(17)])
                    send({ type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta });
                send({ type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: args });
                send({ type: "response.output_item.done", output_index: index, item: { ...item, arguments: args } });
            }
        } else {
            send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "answer", role: "assistant", content: [] } });
            send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "done" });
            send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "answer", role: "assistant", content: [{ type: "output_text", text: "done" }] } });
        }
        if (!(round === 1 && terminal === "disconnected")) {
            const status = round === 1 && ["incomplete", "failed"].includes(terminal) ? terminal : "completed";
            send({ type: `response.${status}`, response: { id: `response-${round}`, status, output: [],
                ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
                ...(status === "failed" ? { error: { code: "server_error", message: "synthetic failure" } } : {}),
                usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 } } });
        }
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            for (const packet of packets) controller.enqueue(packet);
            controller.close();
        } }), { headers: { "content-type": "text/event-stream" } });
    };
    value.runtime.session.agent.streamFunction = (_model, context, options) => codexStream(model, context, {
        ...options, transport: "sse", apiKey: `synthetic.${fakePayload}.synthetic`, fetch: fetchFixture, maxRetries: 0,
        onPayload(payload) { payloads.push(payload); },
    });
    try {
        await value.runtime.session.prompt("Fixture.");
        if (terminal === "completed") {
            expect(await fs.readFile(path.join(value.cwd, "marker.txt"), "utf8")).toBe("once");
            expect(value.results()).toHaveLength(1);
            expect(value.results()[0]?.isError).toBe(false);
            expect(payloads).toHaveLength(2);
            expect(JSON.stringify(payloads[1])).toContain("function_call_output");
        } else {
            await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
            expect(value.results().every(result => result.isError)).toBe(true);
        }
        const messages = value.runtime.session.messages.filter(message => message.role === "assistant");
        if (terminal === "completed") expect(messages[0]).toMatchObject({ stopReason: "toolUse", usage: { totalTokens: 14 } });
        if (terminal === "disconnected" || terminal === "failed") expect(messages[0]?.stopReason).toBe("error");
        expect(requests).toBeLessThanOrEqual(2);
    } finally { await value.close(); }
});
