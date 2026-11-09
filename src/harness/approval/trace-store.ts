import { appendFile, mkdir, readdir, readFile, lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { pimoonHome } from "../../pimoon/profile.ts";
import { MutationQueue } from "../filesystem/platform/node/mutation-queue.ts";

export interface ApprovalTraceConfig { enabled: boolean; retention_days: number; max_mb: number }
export interface ApprovalTraceEvent { at: string; phase: string; data: unknown; redactions: number; truncated: boolean }
export interface ApprovalTraceSummary { id: string; at: string; phases: string[]; bytes: number }
export interface ApprovalTraceDetail { id: string; events: ApprovalTraceEvent[] }
const root = () => path.join(pimoonHome, "diagnostics", "approval");
const queue = new MutationQueue();
const valid = (id: string) => /^[0-9]{8}-[a-f0-9-]{36}$/u.test(id);
const LIMIT = 512 * 1024;

export function sanitizeApprovalTrace(value: unknown): { value: unknown; redactions: number; truncated: boolean } {
	let redactions = 0, remaining = 60000, truncated = false;
	const hide = () => { redactions++; return "[redacted]"; };
	const visit = (item: unknown, key = "", depth = 0): unknown => {
		if (/^(?:authorization|cookie|set-cookie|api[_-]?key|password|secret|token|access|refresh|env)$/iu.test(key)) return hide();
		if (depth > 16 || remaining <= 0) { truncated = true; return "[omitted]"; }
		if (typeof item === "string") {
			let text = item.replace(/Bearer\s+[a-z0-9._~+/-]+/giu, () => `Bearer ${hide()}`)
				.replace(/\bsk-[a-z0-9_-]{12,}/giu, hide)
				.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, (_match, scheme: string) => `${scheme}${hide()}@`)
				.replace(/((?:["']?(?:api[_-]?key|password|secret|token|access_token|refresh_token)["']?)\s*[:=]\s*)["'][^"'\r\n]*["']/giu, (_match, prefix: string) => `${prefix}"${hide()}"`)
				.replace(/([?&](?:api[_-]?key|token|access_token|secret|password)=)[^&\s"']+/giu, (_match, prefix: string) => prefix + hide());
			const cap = Math.min(64000, remaining);
			if (text.length > cap) { text = text.slice(0, cap) + "[omitted]"; truncated = true; }
			remaining -= text.length; return text;
		}
		if (Array.isArray(item)) { if (item.length > 256) truncated = true; return item.slice(0, 256).map(value => visit(value, "", depth + 1)); }
		if (typeof item === "object" && item !== null) return Object.fromEntries(Object.entries(item).slice(0, 128).map(([key, value]) => [key, visit(value, key, depth + 1)]));
		return item;
	};
	const result = visit(value);
	return { value: result, redactions, truncated };
}

/** 独立于执行结果的串行、有界本机诊断；绝不写入认证头、隐藏思考或供应商凭据对象。 */
export async function appendApprovalTrace(id: string, phase: string, data: unknown, config: ApprovalTraceConfig): Promise<void> {
	if (!config.enabled || !valid(id)) return;
	const safe = sanitizeApprovalTrace(data);
	const at = new Date().toISOString();
	await queue.run(root(), undefined, async () => {
		const parent = path.dirname(root());
		await mkdir(parent, { recursive: true, mode: 0o700 });
		if ((await lstat(parent)).isSymbolicLink()) throw new Error("审批诊断父目录不能是链接。");
		await mkdir(root(), { recursive: true, mode: 0o700 });
		await regularDirectory();
		const files = await inventory();
		const before = Date.now() - config.retention_days * 86400000;
		const event: ApprovalTraceEvent = { at, phase, data: safe.value, redactions: safe.redactions, truncated: safe.truncated };
		const line = JSON.stringify(event) + "\n", bytes = Buffer.byteLength(line);
		let total = files.reduce((sum, file) => sum + file.bytes, 0);
		for (const file of files) {
			if (file.id === id) continue;
			if (file.time < before || total + bytes > config.max_mb * 1024 * 1024) { await unlink(path.join(root(), file.id + ".jsonl")); total -= file.bytes; }
		}
		const current = files.find(file => file.id === id);
		if ((current?.bytes ?? 0) + bytes > LIMIT - 2048 || total + bytes > config.max_mb * 1024 * 1024) {
			const target = path.join(root(), id + ".jsonl");
			const marker = JSON.stringify({ at: new Date().toISOString(), phase: "omitted", data: { phase, reason: "capacity_limit" }, redactions: 0, truncated: true }) + "\n";
			if ((current?.bytes ?? 0) + Buffer.byteLength(marker) <= LIMIT && total + Buffer.byteLength(marker) <= config.max_mb * 1024 * 1024) {
				if (current) await regularFile(target);
				await appendFile(target, marker, { mode: 0o600 });
			}
			return;
		}
		const target = path.join(root(), id + ".jsonl");
		if (current) await regularFile(target);
		await appendFile(target, line, { mode: 0o600 });
	});
}
export async function listApprovalTraces(): Promise<ApprovalTraceSummary[]> {
	return queue.run(root(), undefined, async () => {
		const files = (await inventory()).reverse().slice(0, 100);
		const rows: ApprovalTraceSummary[] = [];
		for (const file of files) {
			const detail = await detailFile(file.id);
			rows.push({ id: file.id, at: detail.events[0]?.at ?? "", phases: [...new Set(detail.events.map(event => event.phase))], bytes: file.bytes });
		}
		return rows;
	});
}
export async function readApprovalTrace(id: string): Promise<ApprovalTraceDetail> {
	if (!valid(id)) throw new Error("无效审批记录 ID。");
	return queue.run(root(), undefined, () => detailFile(id));
}
export async function removeApprovalTraces(): Promise<void> {
	await queue.run(root(), undefined, async () => { for (const file of await inventory()) await unlink(path.join(root(), file.id + ".jsonl")); });
}
async function detailFile(id: string): Promise<ApprovalTraceDetail> {
	const target = path.join(root(), id + ".jsonl"); await regularFile(target);
	const text = await readFile(target, "utf8");
	const events: ApprovalTraceEvent[] = [];
	for (const line of text.split("\n").filter(Boolean)) {
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && "phase" in value && typeof value.phase === "string" && "at" in value && typeof value.at === "string" && "data" in value)
				events.push({ at: value.at, phase: value.phase, data: value.data, redactions: "redactions" in value && typeof value.redactions === "number" ? value.redactions : 0, truncated: "truncated" in value && value.truncated === true });
		} catch { /* 崩溃造成的尾行不伪造成完整记录。 */ }
	}
	return { id, events };
}
async function inventory(): Promise<{ id: string; bytes: number; time: number }[]> {
	try { await regularDirectory(); } catch (error) { if (missing(error)) return []; throw error; }
	const rows: { id: string; bytes: number; time: number }[] = [];
	for (const entry of await readdir(root())) {
		if (!entry.endsWith(".jsonl") || !valid(entry.slice(0, -6))) continue;
		const info = await regularFile(path.join(root(), entry)); rows.push({ id: entry.slice(0, -6), bytes: info.size, time: info.mtimeMs });
	}
	return rows.sort((a, b) => a.time - b.time);
}
async function regularDirectory(): Promise<void> {
	const home = await realpath(pimoonHome), target = await realpath(root());
	const relative = path.relative(home, target);
	const info = await lstat(root());
	if (info.isSymbolicLink() || !info.isDirectory() || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("审批诊断目录不能链接到配置目录之外。");
}
async function regularFile(target: string) { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > LIMIT) throw new Error("审批记录不是受限普通文件。"); return info; }
function missing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
