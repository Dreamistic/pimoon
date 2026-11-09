import { listApprovalTraces, readApprovalTrace } from "../../src/harness/approval/trace-store.ts";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import functions from "../../src/harness/extensions/codeact-functions.ts";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import approvalGate from "../../src/harness/extensions/approval-gate.ts";
import { GuiDialogs } from "../../src/gui/host/session/dialogs.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());
async function fixture(reply: (step: number, request: unknown) => string | ModelResponse, verdict: "ask" | "allow" | "deny" | "invalid" = "ask", routine = false) {
	const base = path.resolve(".tmp/tests/approval-integration"); await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(root));
	const config = path.join(root, "approval.jsonc");
	await fs.writeFile(config, JSON.stringify({ model: "fixture/test", routine }));
	vi.stubEnv("PIMOON_APPROVAL_AI_CONFIG", config);
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
	let step = 0;
	let reviews = 0;
	const server = await startModelServer(request => {
		if (JSON.stringify(request.messages[0]).includes("independent security monitor")) {
			reviews++;
			const message = request.messages.at(-1)?.content;
			const text = typeof message === "string" ? message : Array.isArray(message) ? message.map(part => part.text ?? "").join("") : "{}";
			const payload = JSON.parse(text) as { action: { tool: string }; codeact?: { code: { text: string } } };
			const decision = payload.action.tool === "process_run" || payload.codeact?.code.text.includes("subprocess.run") ? verdict : "allow";
			if (decision === "invalid") return { text: "invalid-json-fixture" };
			return { text: JSON.stringify({ decision, title: "本次写入测试标记", explanation: "确认仅在隔离工作区写标记。", recommendation: decision === "allow" ? "Allow once" : "Deny",
				recommendationReason: "仅本次验证", feedbackPlaceholder: "补充要求", actions: [{ choice: "Allow once", label: "本次写入" }, { choice: "Deny", label: "不写入" }] }) };
		}
		const value = reply(step++, request); return typeof value === "string" ? { text: value } : value;
	});
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	try {
		const manager = SessionManager.inMemory(cwd);
		manager.appendCustomEntry("codeact_functions", ["process_run", "read", "write", "grep", "find", "ls"]);
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [codeact.extension, { name: "functions", factory: functions }, { name: "files", factory: fileTools },
					{ name: "approval-gate", factory: pi => approvalGate(pi, { mode: "gui", show: (_ui, ...args) => dialogs.approve(...args) }) }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager });
			codeact.bind(result.session); return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: manager });
		await runtime.session.bindExtensions({ mode: "print", uiContext: dialogs.context(), onError: ({ error }) => { throw new Error(error); } });
		return { cwd, root, runtime, server, dialogs, get reviews() { return reviews; }, async close() { await runtime.session.abort(); await runtime.session.waitForIdle(); dialogs.cancel(); await runtime.dispose(); await server.close(); } };
	} catch (error) { await server.close(); throw error; }
}
const execution = (code: string): ModelResponse => ({ tool: "execute", args: { code, desc: "审批验证" } });
const append = `subprocess.run(${JSON.stringify([process.execPath, "-e", 'require("node:fs").appendFileSync("effect.txt","once")'])},check=True)`;

it("真实 CodeAct 经 AI 判断：原调用等待，批准后继续且不重放此前副作用", async () => {
	const f = await fixture(step => step === 0 ? execution(`write(path="earlier.txt",content="keep")\n${append}\nwrite(path="later.txt",content="continued")`) : "done", "ask", true);
	try {
		const running = f.runtime.session.prompt("Run the isolated approval fixture.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10000 });
		const dialog = f.dialogs.list()[0]; if (!dialog?.approval) throw new Error("missing approval");
		expect(await fs.readFile(path.join(f.cwd, "earlier.txt"), "utf8")).toBe("keep");
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		f.dialogs.respond(dialog.id, "Allow once", "仅本次");
		// 后续写入也需审批；分类器只按本次 action 判断，不按历史中的 process_run 判断。
		await running;
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
		expect(await fs.readFile(path.join(f.cwd, "later.txt"), "utf8")).toBe("continued");
		expect(f.reviews).toBe(1); expect(f.dialogs.list()).toEqual([]);
		expect(f.runtime.session.getCallableToolNames()).not.toContain("approval");
	} finally { await f.close(); }
}, 30000);

it("同一 CodeAct 两次进程共用一次整段审查", async () => {
	const f = await fixture(step => step === 0 ? execution(`${append}\n${append}`) : "done", "allow");
	try {
		await f.runtime.session.prompt("Run two isolated operations.");
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("onceonce");
		const executed = f.runtime.session.messages.find(message => message.role === "toolResult" && message.toolName === "execute");
		expect((JSON.stringify(executed).match(/确认仅在隔离工作区写标记/gu) ?? [])).toHaveLength(1);
		expect(f.reviews).toBe(1); expect(f.dialogs.list()).toEqual([]);
	} finally { await f.close(); }
}, 30000);

it.each(["user", "ai"] as const)("%s 拒绝后不启动进程，拒绝原因进入主模型", async actor => {
	const f = await fixture(step => step === 0 ? execution(append) : "done", actor === "ai" ? "deny" : "ask");
	try {
		const running = f.runtime.session.prompt("Exercise isolated rejection.");
		if (actor === "user") {
			await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10000 });
			const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing dialog");
			f.dialogs.respond(id, "Deny", "先提供方案");
		}
		await running; await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		expect(JSON.stringify(f.server.requests.at(-1))).toContain(actor === "user" ? "先提供方案" : "AI denied");
		expect(f.dialogs.list()).toEqual([]);
	} finally { await f.close(); }
}, 30000);

it("停止等待立即撤销选择框，迟到批准不能执行", async () => {
	const f = await fixture(step => step === 0 ? execution(append) : "done");
	try {
		const running = f.runtime.session.prompt("Wait for human choice.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10000 });
		const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing dialog");
		await f.runtime.session.abort(); await running;
		expect(f.dialogs.list()).toEqual([]); expect(() => f.dialogs.respond(id, "Allow once")).toThrow();
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
	} finally { await f.close(); }
}, 30000);


it("真实 SDK 常规读写不请求审批模型，未知进程仍停在人类选择框", async () => {
	const f = await fixture(step => step === 0 ? execution(`write(path="ordinary.txt",content="keep")\nread(path="ordinary.txt")\n${append}`) : "done", "ask", true);
	try {
		const running = f.runtime.session.prompt("Write and inspect ordinary project file; ask about unknown process.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10000 });
		expect(f.reviews).toBe(1);
		expect(await fs.readFile(path.join(f.cwd, "ordinary.txt"), "utf8")).toBe("keep");
		const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing human choice");
		f.dialogs.respond(id, "Deny"); await running;
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
	} finally { await f.close(); }
}, 30000);


it("真实 SDK Git 查询免审且不执行外部 diff；后续编辑本轮新文件仍免审", async () => {
	const argv = JSON.stringify(["git", "diff"]);
	const f = await fixture(step => step === 0 ? execution(`subprocess.run(${argv},check=True,capture_output=True,text=True)\nwrite(path="new.ts",content="before")\nread(path="new.ts")\nwrite(path="new.ts",content="after")`) : "done", "deny", true);
	try {
		execFileSync("git", ["init", f.cwd], { windowsHide: true, stdio: "pipe" });
		await fs.writeFile(path.join(f.cwd, "tracked.txt"), "before");
		execFileSync("git", ["-C", f.cwd, "add", "tracked.txt"], { windowsHide: true, stdio: "pipe" });
		await fs.writeFile(path.join(f.cwd, "tracked.txt"), "after");
		execFileSync("git", ["-C", f.cwd, "config", "diff.external", "!echo injected > bad-marker"], { windowsHide: true, stdio: "pipe" });
		await f.runtime.session.prompt("Inspect the ordinary diff and edit new file.");
		expect(f.reviews).toBe(0);
		expect(await fs.readFile(path.join(f.cwd, "new.ts"), "utf8")).toBe("after");
		await expect(fs.access(path.join(f.cwd, "bad-marker"))).rejects.toThrow();
		const result = f.runtime.session.messages.find(message => message.role === "toolResult" && message.toolName === "execute");
		expect(result).toMatchObject({ isError: false });
	} finally { await f.close(); }
}, 30000);


it("真实 SDK 类型检查免审且不会写入 tsconfig 指定的缓存", async () => {
	const argv = JSON.stringify([process.execPath, "node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false"]);
	const f = await fixture(step => step === 0 ? execution(`subprocess.run(${argv},capture_output=True,text=True,check=True)`) : "done", "deny", true);
	try {
		await fs.symlink(path.resolve("node_modules"), path.join(f.cwd, "node_modules"), "junction");
		await fs.writeFile(path.join(f.cwd, "sample.ts"), "export const value: number = 42;");
		await fs.writeFile(path.join(f.cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { incremental: true, tsBuildInfoFile: "unwanted-cache", skipLibCheck: true, types: [] }, files: ["sample.ts"] }));
		await f.runtime.session.prompt("Only check TypeScript; do not write build output.");
		expect(f.reviews).toBe(0);
		const result = f.runtime.session.messages.find(message => message.role === "toolResult" && message.toolName === "execute");
		expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
		await expect(fs.access(path.join(f.cwd, "unwanted-cache"))).rejects.toThrow();
	} finally { await f.close(); }
}, 30000);


it("真实 SDK 根目录免审搜索过滤敏感子项，不依赖主模型避免选择它们", async () => {
	const f = await fixture(step => step === 0 ? execution(`r=grep(query="routine-needle",path=["."])\nassert "PRIVATE_SENTINEL" not in str(r) and "DOTENV_SENTINEL" not in str(r)\nprint(r)`) : "done", "deny", true);
	try {
		await fs.mkdir(path.join(f.cwd, ".private"));
		await fs.writeFile(path.join(f.cwd, ".private", "data.txt"), "routine-needle PRIVATE_SENTINEL");
		await fs.writeFile(path.join(f.cwd, ".env.staging"), "routine-needle DOTENV_SENTINEL");
		await fs.writeFile(path.join(f.cwd, "ordinary.txt"), "routine-needle ordinary");
		await f.runtime.session.prompt("Search ordinary project content.");
		expect(f.reviews).toBe(0);
		const result = f.runtime.session.messages.find(message => message.role === "toolResult" && message.toolName === "execute");
		expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).toContain("ordinary");
		expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
		expect(JSON.stringify(result)).not.toContain("DOTENV_SENTINEL");
	} finally { await f.close(); }
}, 30000);


it.each(["test", "build"] as const)("真实 SDK 隔离 %s 使用已安装 CLI 直接执行而不请求 AI", async workflow => {
	let code = "";
	const f = await fixture(step => step === 0 ? execution(code) : "done", "deny", true);
	try {
		await fs.symlink(path.resolve("node_modules"), path.join(f.cwd, "node_modules"), "junction");
		if (workflow === "test") {
			await fs.writeFile(path.join(f.cwd, "sample.test.ts"), 'import { it, expect } from "vitest"; it("fixture", () => expect(42).toBe(42));');
			await fs.writeFile(path.join(f.cwd, "vitest.config.mjs"), 'export default { test: { include: ["sample.test.ts"] } };');
		} else await fs.writeFile(path.join(f.cwd, "index.html"), '<!doctype html><title>isolated fixture</title><p>build fixture</p>');
		const env = Object.fromEntries(["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"].map(key => [key, path.join(f.cwd, ".tmp", "tests", key)]));
		for (const target of Object.values(env)) await fs.mkdir(target, { recursive: true });
		const argv = workflow === "test" ? ["node", "node_modules/vitest/vitest.mjs", "run", "sample.test.ts"] : ["node", "node_modules/vite/bin/vite.js", "build"];
		code = `subprocess.run(${JSON.stringify(argv)},env=${JSON.stringify(env)},capture_output=True,text=True,check=True)`;
		await f.runtime.session.prompt("Run the isolated local validation workflow.");
		expect(f.reviews).toBe(0);
		const result = f.runtime.session.messages.find(message => message.role === "toolResult" && message.toolName === "execute");
		expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
		if (workflow === "build") expect(await fs.readFile(path.join(f.cwd, "dist/index.html"), "utf8")).toContain("build fixture");
	} finally { await f.close(); }
}, 45000);


it("同段不同进程与 parallel 只审一次，下一段重新审查", async () => {
	const jobs = ["one", "two", "three"].map(name => ({ args: [process.execPath, "-e", `require('node:fs').writeFileSync('${name}.txt','once')`], check: true }));
	const first = `parallel([(subprocess.run,kw) for kw in json.loads(${JSON.stringify(JSON.stringify(jobs))})])`;
	const f = await fixture(step => step === 0 ? execution(first) : step === 1 ? execution(append) : "done", "allow", true);
	try {
		await f.runtime.session.prompt("Run independent fixture processes in one block, then another block.");
		expect(f.reviews).toBe(2);
		for (const name of ["one", "two", "three"]) expect(await fs.readFile(path.join(f.cwd, name + ".txt"), "utf8")).toBe("once");
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
	} finally { await f.close(); }
}, 30000);

it("拒绝整段后即使 Python 捕获工具异常也不能继续本地副作用", async () => {
	const code = `try:\n ${append}\nexcept BaseException:\n pass\nPath("after-denial.txt").write_text("bad")`;
	const f = await fixture(step => step === 0 ? execution(code) : "done", "deny", true);
	try {
		await f.runtime.session.prompt("Reject this isolated block.");
		expect(f.reviews).toBe(1);
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		await expect(fs.access(path.join(f.cwd, "after-denial.txt"))).rejects.toThrow();
	} finally { await f.close(); }
}, 30000);

it("审批后读到的新动态进程不继承批次许可，不二次询问而停止", async () => {
	const dynamic = [process.execPath, "-e", "require('node:fs').writeFileSync('dynamic.txt','bad')"];
	const code = `${append}\nargs=json.loads(read(path="next.json",mode="raw"))\ntry:\n subprocess.run(args,check=True)\nexcept BaseException:\n pass\nPath("after-scope.txt").write_text("bad")`;
	const f = await fixture(step => step === 0 ? execution(code) : "done", "allow", true);
	try {
		await fs.writeFile(path.join(f.cwd, "next.json"), JSON.stringify(dynamic));
		await f.runtime.session.prompt("Run a known action, then inspect dynamic arguments.");
		expect(f.reviews).toBe(1);
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
		await expect(fs.access(path.join(f.cwd, "dynamic.txt"))).rejects.toThrow();
		await expect(fs.access(path.join(f.cwd, "after-scope.txt"))).rejects.toThrow();
		expect(JSON.stringify(f.runtime.session.messages)).toContain("not covered");
	} finally { await f.close(); }
}, 30000);

it("一次人工选择覆盖整段余下已展示进程，不重跑前序写入", async () => {
	const second = `subprocess.run(${JSON.stringify([process.execPath, "-e", "require('node:fs').writeFileSync('second.txt','ok')"])},check=True)`;
	const f = await fixture(step => step === 0 ? execution(`write(path="earlier.txt",content="keep")\n${append}\n${second}`) : "done", "ask", true);
	try {
		const running = f.runtime.session.prompt("Ask once for the complete remaining block.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10000 });
		const dialog = f.dialogs.list()[0]; if (!dialog?.approval?.block) throw new Error("missing batch context");
		expect(dialog.approval.block.code).toContain("second.txt");
		expect(dialog.approval.scopes[0]?.label).toBe("本次 CodeAct");
		expect(await fs.readFile(path.join(f.cwd, "earlier.txt"), "utf8")).toBe("keep");
		f.dialogs.respond(dialog.id, "Allow once"); await running;
		expect(f.reviews).toBe(1);
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
		expect(await fs.readFile(path.join(f.cwd, "second.txt"), "utf8")).toBe("ok");
	} finally { await f.close(); }
}, 30000);


it.each(["allow", "invalid"] as const)("真实审批 %s 保存实际输入输出和解析/执行终态", async verdict => {
	const f = await fixture(step => step === 0 ? execution(append) : "done", verdict, true);
	try {
		await f.runtime.session.prompt("Record the isolated approval model boundary.");
		const details = await Promise.all((await listApprovalTraces()).map(row => readApprovalTrace(row.id)));
		const trace = details.find(detail => detail.events.some(event => event.phase === "begin" && typeof event.data === "object" && event.data !== null && "sessionId" in event.data && event.data.sessionId === f.runtime.session.sessionId));
		if (!trace) throw new Error("missing approval trace");
		expect(trace.events.map(event => event.phase)).toContain("request");
		expect(trace.events.map(event => event.phase)).toContain("response");
		if (verdict === "allow") {
			expect(trace.events.map(event => event.phase)).toEqual(expect.arrayContaining(["parsed", "resolved", "dispatch", "execution"]));
			expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
		} else {
			expect(JSON.stringify(trace.events)).toContain("invalid-json-fixture");
			expect(trace.events.map(event => event.phase)).toContain("failure");
			await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		}
	} finally { await f.close(); }
}, 30000);


it("不能完整提交的超长风险代码块停止而不以截断源码批准", async () => {
	const code = "#" + "x".repeat(97000) + "\n" + append;
	const f = await fixture(step => step === 0 ? execution(code) : "done", "allow", true);
	try {
		await f.runtime.session.prompt("Do not approve an incomplete code review.");
		expect(f.reviews).toBe(0);
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		expect(JSON.stringify(f.runtime.session.messages)).toContain("complete-review limit");
	} finally { await f.close(); }
}, 30000);
