import { expect, it } from "vitest";
import { nativeInstructions, orchestrationInstructions } from "../../src/pimoon/codeact/native-instructions.ts";

it("允许根据结果继续执行，同时保留每次等待结果的边界", () => {
 expect(nativeInstructions).not.toContain("once per turn");
 expect(nativeInstructions).toContain("continue executing until the task is complete or a user decision is required");
 expect(nativeInstructions).toContain("Wait for the tool result before continuing");
});

it("原生入口与 Python 网页并发边界明确，不引导外层工具包装", () => {
 expect(nativeInstructions).toContain("Call execute directly, one per response");
 expect(nativeInstructions).toContain("put parallel() inside Python code, not native tool wrappers");
 expect(orchestrationInstructions).toContain("read/find/grep/ls/websearch/webfetch/http and subprocess.run");
 expect(orchestrationInstructions).toContain("http supports text/probe without path, not download");
});
