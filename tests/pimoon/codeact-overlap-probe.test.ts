import { expect, it } from "vitest";
import { CodeActParser } from "../../src/pimoon/codeact/parser.ts";
// @ts-expect-error 实验脚本是无声明的独立 MJS，不进入生产模块。
import { collectOverlap } from "../../scripts/benchmark/codeact-overlap.mjs";

function fixture(reason = "stop", suffix = "", onClose = () => {}) {
    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", contentIndex: 0, delta: "<execute>\n42\n</exec" };
            yield { type: "text_delta", contentIndex: 0, delta: "ute>" };
            onClose();
            yield { type: "text_delta", contentIndex: 0, delta: suffix };
        },
        async result() { return { stopReason: reason, usage: { totalTokens: 14 } }; },
    };
}

it("跨片闭合只提交一次，后缀第二块不执行，完整 usage 保留", async () => {
    const codes: string[] = [];
    const result = await collectOverlap({ source: fixture("stop", "\n<execute>\n99\n</execute>"),
        parser: new CodeActParser(), mode: "overlap", execute: async (code: string) => { codes.push(code); } });
    expect(codes).toEqual(["42\n"]);
    expect(result.final.usage.totalTokens).toBe(14);
});

it.each(["error", "length", "aborted"])("暴露语义代价：晚到的 %s 无法撤销闭合提交，串行不执行", async reason => {
    for (const mode of ["serial", "overlap"]) {
        let calls = 0;
        const result = await collectOverlap({ source: fixture(reason), parser: new CodeActParser(), mode,
            execute: async () => { calls++; } });
        expect(calls).toBe(mode === "overlap" ? 1 : 0);
        expect(result.final.stopReason).toBe(reason);
    }
});

it("取消后不提交，已开始执行收到同一取消信号；失败不重试", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await collectOverlap({ source: fixture(), parser: new CodeActParser(), mode: "overlap",
        signal: controller.signal, execute: async () => { calls++; } });
    expect(calls).toBe(0);
    const active = new AbortController();
    const result = await collectOverlap({ source: fixture("stop", "", () => active.abort()),
        parser: new CodeActParser(), mode: "overlap", signal: active.signal,
        execute: async (_code: string, signal: AbortSignal) => {
            calls++;
            await Promise.resolve();
            if (signal.aborted) throw new Error("cancelled");
        } });
    expect(calls).toBe(1);
    expect(result.executed.ok).toBe(false);
});

it("执行失败被回收，不打断 usage 接收，也不重试", async () => {
    let calls = 0;
    const result = await collectOverlap({ source: fixture(), parser: new CodeActParser(), mode: "overlap",
        execute: async () => { calls++; throw new Error("fixture"); } });
    expect(calls).toBe(1);
    expect(result.executed.ok).toBe(false);
    expect(result.final.usage.totalTokens).toBe(14);
});

it("未闭合代码不执行", async () => {
    let calls = 0;
    const source = { async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", contentIndex: 0, delta: "<execute>\n42" };
    }, async result() { return { stopReason: "stop" }; } };
    const result = await collectOverlap({ source, parser: new CodeActParser(), mode: "overlap",
        execute: async () => { calls++; } });
    expect(calls).toBe(0);
    expect(result.failure).toContain("未闭合");
});
