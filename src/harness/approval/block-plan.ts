import { realpath } from "node:fs/promises";
import which from "which";
import { within } from "./routine-paths.ts";
import { spawn } from "node:child_process";
import path from "node:path";
import { installationRoot } from "../runtime/paths.ts";

export interface PlannedCall { tool: string; input: Record<string, unknown>; line: number }
export interface BlockPlan { calls: PlannedCall[]; unresolvedLines: number[]; complete: boolean }
const unavailable = (): BlockPlan => ({ calls: [], unresolvedLines: [0], complete: false });

/** 只解析 AST；不导入用户项目、不继承 Python 环境、不执行待审代码。 */
export async function inspectBlockPlan(code: string, cwd: string, signal: AbortSignal): Promise<BlockPlan> {
	if (signal.aborted) return unavailable();
	let executable: string;
	try { executable = await realpath(await which("python")); if (within(await realpath(cwd), executable)) return unavailable(); } catch { return unavailable(); }
	const resource = process.env.PIMOON_RESOURCE_DIR;
	const script = resource ? path.join(resource, "pimoon", "approval_plan.py") : path.join(installationRoot(), "src/pimoon/approval_plan.py");
	return new Promise(resolve => {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/iu.test(key)));
		const child = spawn(executable, ["-I", "-B", script], { cwd: path.dirname(script), env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
		const chunks: Buffer[] = []; let bytes = 0, settled = false;
		const finish = (plan: BlockPlan) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(plan); };
		const abort = () => { child.kill(); finish(unavailable()); };
		const timer = setTimeout(abort, 3000);
		signal.addEventListener("abort", abort, { once: true });
		child.on("error", () => finish(unavailable())); child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) abort(); else chunks.push(chunk); });
		child.on("close", status => {
			try {
				const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (status !== 0 || !isPlan(value)) return finish(unavailable());
				finish(value);
			} catch { finish(unavailable()); }
		});
		child.stdin.end(code);
		if (signal.aborted) abort();
	});
}
function isPlan(value: unknown): value is BlockPlan {
	return typeof value === "object" && value !== null && "calls" in value && Array.isArray(value.calls) && value.calls.length <= 128
		&& value.calls.every((call: unknown) => typeof call === "object" && call !== null && "tool" in call && typeof call.tool === "string"
			&& "input" in call && typeof call.input === "object" && call.input !== null && !Array.isArray(call.input) && "line" in call && typeof call.line === "number")
		&& "unresolvedLines" in value && Array.isArray(value.unresolvedLines) && value.unresolvedLines.every(line => typeof line === "number")
		&& "complete" in value && typeof value.complete === "boolean";
}
