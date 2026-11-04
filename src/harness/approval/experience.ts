import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isNotFound } from "../config-loader.ts";
import { approvalFingerprint } from "./runtime/pending.ts";
import type { ApprovalReceipt } from "./runtime/interaction.ts";
import type { ApprovalRequest } from "./types.ts";

const MAX_ENTRIES = 128, MAX_AGE = 90 * 24 * 60 * 60_000;
const queues = new Map<string, Promise<unknown>>();

export interface ApprovalExperience {
	requestHash: string;
	tool: string;
	decision: "approved" | "rejected" | "cancelled";
	scope?: string;
	feedback?: string;
	summary?: string;
	count?: number;
	actor?: "user" | "advisor";
	sameFamily?: boolean;
}
interface StoredExperience {
	workspace: string;
	family: string;
	requestHash: string;
	tool: string;
	decision: "approved" | "rejected";
	scope?: string;
	count: number;
	at: number;
}

/** 仅记录散列、实际决定与次数；不保存命令、路径、环境值、正文或自由输入。 */
export class ApprovalExperiences {
	readonly file: string;
	constructor(rulesFile: string) { this.file = path.resolve(`${rulesFile}.experiences.json`); }

	async relevant(request: ApprovalRequest): Promise<ApprovalExperience[]> {
		await queues.get(this.file)?.catch(() => {});
		const workspace = approvalFingerprint(request.cwd), family = requestFamily(request), hash = approvalFingerprint(request);
		return (await this.load()).filter(entry => entry.workspace === workspace && entry.tool === request.tool)
			.sort((a, b) => Number(b.requestHash === hash) - Number(a.requestHash === hash)
				|| Number(b.family === family) - Number(a.family === family) || b.at - a.at)
			.slice(0, 12).map(entry => ({ requestHash: entry.requestHash, tool: entry.tool,
				decision: entry.decision, ...(entry.scope ? { scope: entry.scope } : {}),
				count: entry.count, sameFamily: entry.family === family }));
	}

	async remember(request: ApprovalRequest, receipt: ApprovalReceipt): Promise<void> {
		if (receipt.decision === "cancelled" || receipt.actor === "advisor") return;
		const operation = (queues.get(this.file) ?? Promise.resolve()).catch(() => {}).then(async () => {
			const entries = await this.load();
			const workspace = approvalFingerprint(request.cwd), requestHash = approvalFingerprint(request);
			const existing = entries.find(entry => entry.workspace === workspace && entry.requestHash === requestHash
				&& entry.decision === receipt.decision && entry.scope === receipt.scope);
			const next: StoredExperience = { workspace, requestHash, family: requestFamily(request), tool: request.tool,
				decision: receipt.decision === "approved" ? "approved" : "rejected",
				...(receipt.scope ? { scope: receipt.scope } : {}), count: Math.min((existing?.count ?? 0) + 1, 1_000_000), at: Date.now() };
			const retained = [next, ...entries.filter(entry => entry !== existing)].slice(0, MAX_ENTRIES);
			await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
			const temporary = `${this.file}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify({ entries: retained }) + "\n", { mode: 0o600, flag: "wx" });
				await rename(temporary, this.file);
			} finally { await rm(temporary, { force: true }); }
		});
		queues.set(this.file, operation);
		try { await operation; }
		finally { if (queues.get(this.file) === operation) queues.delete(this.file); }
	}

	private async load(): Promise<StoredExperience[]> {
		let text: string;
		try { text = await readFile(this.file, "utf8"); }
		catch (error) { if (isNotFound(error)) return []; throw error; }
		if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Approval experience exceeds size limit.");
		const value: unknown = JSON.parse(text);
		if (!record(value) || !Array.isArray(value.entries) || !value.entries.every(validEntry)) throw new Error("Invalid approval experience.");
		return value.entries.filter(entry => entry.at >= Date.now() - MAX_AGE && entry.at <= Date.now()).slice(0, MAX_ENTRIES);
	}
}

function requestFamily(request: ApprovalRequest): string {
	// 家族只用于推荐检索，绝不能复用为授权匹配。
	return approvalFingerprint(request.tool === "process_run" ? [request.tool, request.detail.argv.slice(0, 2)]
		: request.tool === "write" || request.tool === "edit" ? [request.tool, path.extname(request.detail.path)]
		: request.tool === "bash" ? [request.tool] : [request.tool, request.detail.origin]);
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validEntry(value: unknown): value is StoredExperience {
	if (!record(value)) return false;
	return ["workspace", "family", "requestHash"].every(key => typeof value[key] === "string" && /^[a-f0-9]{64}$/.test(value[key]))
		&& typeof value.tool === "string" && ["process_run", "bash", "write", "edit", "http", "webfetch"].includes(value.tool)
		&& (value.decision === "approved" || value.decision === "rejected")
		&& (value.scope === undefined || ["once", "session", "persistent"].includes(String(value.scope)))
		&& typeof value.count === "number" && Number.isInteger(value.count) && value.count > 0 && value.count <= 1_000_000
		&& typeof value.at === "number" && Number.isFinite(value.at);
}
