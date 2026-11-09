import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildApprovalRequest } from "../../../src/harness/approval/pi/request.ts";
import * as configModule from "../../../src/harness/web-tools/config.ts";
import { defaultWebToolsConfig } from "../web-tools/config-fixture.ts";

const resolver: { lookup(hostname: string, options: { all: true }): Promise<LookupAddress[]> } = dns;
afterEach(() => vi.restoreAllMocks());

it("可信站点仍经过 AI 审批，地址检查与下载目标独立保留", async () => {
	const config = defaultWebToolsConfig();
	config.network.restrict_private_addresses = true;
	config.network.trusted_https_origins = ["https://github.com"];
	vi.spyOn(configModule, "loadWebToolsConfig").mockImplementation(async () => structuredClone(config));
	const lookup = vi.spyOn(resolver, "lookup").mockResolvedValue([{ address: "172.19.0.9", family: 4 }]);
	const cwd = path.resolve(".tmp/tests/trusted-sites-approval");
	const input = { url: "https://github.com/repo" };
	await expect(buildApprovalRequest({ type: "tool_call", toolName: "webfetch", toolCallId: "read", input }, cwd)).resolves.toMatchObject({ tool: "webfetch", detail: { origin: "https://github.com" } });
	const download = await buildApprovalRequest({ type: "tool_call", toolName: "http", toolCallId: "download", input: { ...input, mode: "download", path: "repo.zip" } }, cwd);
	expect(download?.units.map(unit => unit.action)).toEqual(["fetch_url", "write_file"]);
	config.network.trusted_https_origins = [];
	expect((await buildApprovalRequest({ type: "tool_call", toolName: "http", toolCallId: "revoked", input }, cwd))?.units.map(unit => unit.action)).toEqual(["fetch_url"]);
	config.network.trusted_https_origins = ["https://github.com"];
	lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
	expect((await buildApprovalRequest({ type: "tool_call", toolName: "webfetch", toolCallId: "loopback", input }, cwd))?.units.map(unit => unit.action)).toEqual(["fetch_url"]);
});
