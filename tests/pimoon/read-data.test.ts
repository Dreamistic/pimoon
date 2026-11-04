import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import { isCodeActResultMessage } from "../../src/pimoon/codeact/types.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());

it("JSON 误读保留失败且说明展示文本契约，原文读取在单个执行块内完成发票汇总", async () => {
	const base = path.resolve(".tmp/tests/pimoon-read-data");
	await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(path.join(cwd, "invoices"), { recursive: true });
	await fs.mkdir(agentDir);
	const originals: string[] = [];
	const expected = { count: 0, total: 0, byCustomer: { A: 0, B: 0 } };
	for (let index = 0; index < 12; index++) {
		const customer = index % 2 ? "B" : "A";
		const row = { customer, amount: (index + 1) * 7, status: index % 4 === 0 ? "void" : "paid", note: "原文😀</read><read literal>" };
		const text = JSON.stringify(row, null, 2).replaceAll("\n", "\r\n") + "\r\n";
		originals.push(text);
		await fs.writeFile(path.join(cwd, "invoices", `${index}.json`), text);
		if (row.status !== "void") { expected.count++; expected.total += row.amount; expected.byCustomer[customer] += row.amount; }
	}
	await fs.writeFile(path.join(cwd, "invalid.json"), "not JSON");
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const replies: ModelResponse[] = [];
	const server = await startModelServer(() => replies.shift() ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [codeact.extension, { name: "file-tools", factory: fileTools }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["read", "write"] });
			codeact.bind(result.session);
			return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
			replies.push({ text: '<execute>\nimport json\njson.loads(read(path="invoices/0.json"))\n</execute>' }, { text: "done" });
			await runtime.session.prompt("Reproduce the read-as-JSON mistake; do not retry.");
			const failed = runtime.session.messages.filter(isCodeActResultMessage).at(-1);
			expect(failed?.details).toMatchObject({ isError: true, metrics: { outcome: "python_error", error_type: "JSONDecodeError", internal_tool_calls: 1 } });
			expect(JSON.stringify(failed?.content)).toContain("rendered read view, not raw JSON");
			expect(server.requests).toHaveLength(2);
			expect(JSON.stringify(server.requests[0])).toContain("Rendered <read> view");
			expect(JSON.stringify(server.requests[0])).toContain("native_read(path)");

			const good = `import json
rows=[json.loads(native_read(f"invoices/{i}.json")) for i in range(12)]
assert rows[0]["note"] == "原文😀</read><read literal>"
try:
 native_read("invoices/missing.json")
except RuntimeError:
 missing=True
else:
 raise AssertionError("missing fixture unexpectedly exists")
summary={"count":0,"total":0,"byCustomer":{}}
for row in rows:
 if row["status"] == "void":
  continue
 summary["count"]+=1
 summary["total"]+=row["amount"]
 summary["byCustomer"][row["customer"]]=summary["byCustomer"].get(row["customer"],0)+row["amount"]
written=write(path="summary.json",content=json.dumps(summary,ensure_ascii=False))
{"count":summary["count"],"total":summary["total"],"missing":missing}`;
			replies.push({ text: `<execute>\n${good}\n</execute>` }, { text: "done" });
			await runtime.session.prompt("Aggregate raw invoice JSON and preserve all inputs in one execution block.");
			const success = runtime.session.messages.filter(isCodeActResultMessage).at(-1);
			expect(success?.details).toMatchObject({ isError: false, metrics: { outcome: "tool_partial_failure", tool_failure_count: 1, internal_tool_calls: 1, internal_tool_failures: 0 } });
			expect(server.requests).toHaveLength(4);
			expect(JSON.parse(await fs.readFile(path.join(cwd, "summary.json"), "utf8"))).toEqual(expected);
			for (const [index, original] of originals.entries()) expect(await fs.readFile(path.join(cwd, "invoices", `${index}.json`), "utf8")).toBe(original);

			replies.push({ text: '<execute>\njson.loads(native_read("invalid.json"))\n</execute>' }, { text: "done" });
			await runtime.session.prompt("Keep genuine malformed raw JSON errors unchanged.");
			const invalid = runtime.session.messages.filter(isCodeActResultMessage).at(-1);
			expect(invalid?.details).toMatchObject({ isError: true, metrics: { error_type: "JSONDecodeError" } });
			expect(JSON.stringify(invalid?.content)).not.toContain("rendered read view");
			expect(server.requests).toHaveLength(6);
		} finally { await runtime.dispose(); }
	} finally { await server.close(); }
});
