import { expect, it } from "vitest";
import { inspectBlockPlan } from "../../../src/harness/approval/block-plan.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";
const temp = useTempDir("block-plan-");
it("只解析常量、循环和 parallel，不执行源码或恢复持久变量", async () => {
	const source = `prefix="fixture"\nfor name in ["a","b"]:\n subprocess.run(["node", "-e", f"print('{name}')"],check=True)\nparallel([(read,{"path":"a.txt"}),(read,{"path":"b.txt"})])\nsubprocess.run(previous_args)`;
	const plan = await inspectBlockPlan(source, temp.path, new AbortController().signal);
	expect(plan.calls).toHaveLength(4);
	expect(plan.calls.filter(call => call.tool === "process_run").map(call => call.input.argv)).toEqual([["node", "-e", "print('a')"], ["node", "-e", "print('b')"]]);
	expect(plan.unresolvedLines.length).toBeGreaterThan(0);
});
it("包含导入和表达式副作用也只解析；无效代码不生成许可", async () => {
	const plan = await inspectBlockPlan('open("should-not-exist","w").write("bad")\nsubprocess.run(["git","status"])', temp.path, new AbortController().signal);
	expect(plan.calls).toHaveLength(1);
	const { access } = await import("node:fs/promises"); const path = await import("node:path");
	await expect(access(path.join(temp.path, "should-not-exist"))).rejects.toThrow();
	expect((await inspectBlockPlan("this is invalid (", temp.path, new AbortController().signal)).complete).toBe(false);
});
it("取消不留下悬挂解析进程", async () => {
	const controller = new AbortController(); controller.abort();
	expect((await inspectBlockPlan('read(path="a")', temp.path, controller.signal)).calls).toEqual([]);
});
