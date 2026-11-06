import { expect, it } from "vitest";
import { nativeInstructions } from "../../src/pimoon/codeact/native-instructions.ts";

it("允许根据结果继续执行，同时保留每次等待结果的边界", () => {
 expect(nativeInstructions).not.toContain("once per turn");
 expect(nativeInstructions).toContain("continue executing until the task is complete or a user decision is required");
 expect(nativeInstructions).toContain("Wait for the tool result before continuing");
});
