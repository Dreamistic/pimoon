import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { pimoonCodexProvider } from "../../src/pimoon/codex-models.ts";
import { importSession } from "../../src/gui/host/session/files.ts";

it("Codex 6.2 保留订阅认证、旧模型与用户覆盖，重载不丢失", async () => {
	const root = path.resolve(".tmp/tests/codex-models");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(path.join(root, "case-"));
	const modelsPath = path.join(dir, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { "openai-codex": {
		modelOverrides: { "gpt-6.2-astra": { name: "用户命名" } },
		models: [{ id: "custom-codex", contextWindow: 64000 }],
	} } }));
	const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath,
		modelsStorePath: path.join(dir, "catalog.json"), allowModelNetwork: false });
	runtime.registerNativeProvider(pimoonCodexProvider());
	await runtime.refresh({ allowNetwork: false });
	expect(runtime.getProvider("openai-codex")?.auth.oauth?.isSubscription).toBe(true);
	expect(runtime.getProvider("openai-codex")?.auth.apiKey).toBeUndefined();
	expect(runtime.getModel("openai-codex", "gpt-6-astra")).toBeDefined();
	expect(runtime.getModel("openai-codex", "custom-codex")?.contextWindow).toBe(64000);
	expect(runtime.getModel("openai-codex", "gpt-6.2-astra")).toMatchObject({ name: "用户命名", contextWindow: 272000,
		api: "openai-codex-responses", thinkingLevelMap: { off: null, minimal: "low", max: "max" } });
	expect(runtime.getModel("openai-codex", "gpt-6.2-sol")?.contextWindow).toBe(500000);
});

it("导入旧目录不存在的会话时使用当前目录并生成独立标识", async () => {
	const root = path.resolve(".tmp/tests/import-session");
	await mkdir(root, { recursive: true });
	const cwd = await mkdtemp(path.join(root, "case-"));
	const content = JSON.stringify({ type: "session", version: 3, id: "source-session", timestamp: new Date().toISOString(), cwd: path.join(cwd, "missing") });
	const manager = await importSession(content, cwd);
	expect(manager.getCwd()).toBe(cwd);
	expect(manager.getSessionId()).not.toBe("source-session");
	const file = manager.getSessionFile();
	if (!file) throw new Error("缺少导入文件");
	expect(JSON.parse((await readFile(file, "utf8")).split("\n")[0] ?? "").cwd).toBe(cwd);
});
