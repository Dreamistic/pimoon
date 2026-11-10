import { afterEach, expect, it } from "vitest";
import { GuiHost } from "../../../src/gui/host/host.ts";
import type { GuiAction } from "../../../src/gui/shared/protocol/actions.ts";
import type { GuiQuery } from "../../../src/gui/shared/protocol/queries.ts";

const hosts: GuiHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
function fixture() {
	const host = new GuiHost(); hosts.push(host);
	return host.createClient(undefined, "delegate");
}
const blocked: GuiAction[] = [
	{ action: "login", provider: "fixture", type: "api_key" }, { action: "logout", provider: "fixture" },
	{ action: "saveConfig", file: "settings.json", original: "", content: "{}" },
	{ action: "saveMcpConfig", original: "", content: "{}" }, { action: "saveGuiConfig", original: "", content: "{}" },
	{ action: "saveModuleConfig", id: "approvalGate", original: "", content: "{}" },
	{ action: "saveModelServices", original: "", content: "{}" },
	{ action: "deleteSession", path: "fixture.jsonl" }, { action: "removeWorkspace", path: "fixture" },
	{ action: "removeStorage", ids: ["fixture"] }, { action: "import", content: "{}" },
	{ action: "new" }, { action: "reload" }, { action: "persistTools" }, { action: "persistModels" },
	{ action: "persistDefaultModel" }, { action: "observe", visible: true }, { action: "clearApprovalTraces" },
];
it.each(blocked)("delegate 拒绝 $action，且不需要加载会话", async action => {
	await expect(fixture().dispatch(action)).rejects.toThrow("委派客户端不允许此操作");
});
const queries: GuiQuery[] = [
	{ query: "config", file: "settings.json" }, { query: "guiConfig" }, { query: "mcpConfig" },
	{ query: "moduleConfig", id: "approvalGate" }, { query: "modelServices" },
	{ query: "modelServiceCatalog", provider: "fixture" }, { query: "searchApiKeyAvailable", config: "{}" },
	{ query: "storage" }, { query: "approvalTraces" }, { query: "directories", path: "." },
];
it.each(queries)("delegate 拒绝 GUI 查询 $query", async query => {
	await expect(fixture().query(query)).rejects.toThrow("委派客户端不允许 GUI 查询");
});
it.each(["/login", " /logout fixture", "/import fixture", "/mcp login fixture", "!echo unsafe", "!!echo unsafe", "\n /settings"])("delegate 不能通过 prompt 命令旁路：%s", async text => {
	await expect(fixture().dispatch({ action: "prompt", text, images: [], behavior: "followUp" })).rejects.toThrow("委派消息不能执行");
});
it("身份来自构造入口且不能改写，也不接受动作中的自报身份", async () => {
	const client = fixture();
	expect(client.actor).toBe("delegate");
	expect(Reflect.set(client, "actor", "owner")).toBe(false);
	expect(client.actor).toBe("delegate");
	await expect(client.dispatch({ action: "abort", actor: "owner" })).rejects.toThrow("无效 GUI 操作参数");
	expect(client.host.createClient().actor).toBe("owner");
});
it.each(["prompt", "abort", "dialog"] as const)("白名单 %s 仍要求有效目标会话", async action => {
	const client = fixture();
	const value: GuiAction = action === "prompt" ? { action, text: "检查项目", images: [], behavior: "followUp" }
		: action === "dialog" ? { action, id: "missing", value: "yes" } : { action };
	await expect(client.dispatch(value, "missing")).rejects.toThrow("请先选择有效会话");
});
it("owner 配置读写和 observe 保持可用", async () => {
	const client = fixture().host.createClient();
	const config = await client.query({ query: "guiConfig" });
	await expect(client.dispatch({ action: "saveGuiConfig", original: config.content, content: JSON.stringify(config.defaults) })).resolves.toBeUndefined();
	await expect(client.dispatch({ action: "observe", visible: false })).resolves.toBeUndefined();
});
