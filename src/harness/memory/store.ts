import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "../config-loader.ts";
import { MutationQueue } from "../filesystem/platform/node/mutation-queue.ts";
import { MAX_MEMORY_BYTES, memoryIndexLine, parseMemory, type MemoryEntry } from "./format.ts";

const exec = promisify(execFile);
const queue = new MutationQueue();
export interface MemoryScope { kind: "user" | "project"; directory: string }
export interface MemoryIssue { file: string; reason: string }
export interface MemorySnapshot {
	scopes: MemoryScope[];
	entries: Array<MemoryEntry & { scope: MemoryScope; path: string }>;
	issues: MemoryIssue[];
	version: string;
}
interface CachedEntry { stamp: string; entry?: MemoryEntry; issue?: string }

export class MemoryStore {
	private cache = new Map<string, CachedEntry>();
	private binding: { cwd: string; scopes: MemoryScope[] } | undefined;
	constructor(readonly root: string) {}

	async scopes(cwd: string, signal?: AbortSignal): Promise<MemoryScope[]> {
		signal?.throwIfAborted();
		if (this.binding?.cwd === cwd) return this.binding.scopes;
		await directory(this.root);
		const canonical = await projectRoot(cwd, signal);
		const registry = path.join(this.root, "projects.json");
		const id = await queue.run(registry, signal, async () => {
			let projects: Record<string, string> = {};
			try {
				await regularFile(registry);
				const value: unknown = JSON.parse(await readFile(registry, "utf8"));
				if (!isRegistry(value)) throw new Error("Memory project registry is invalid.");
				projects = value.projects;
			} catch (error) { if (!isNotFound(error)) throw error; }
			const existing = projects[canonical];
			if (existing) return existing;
			const id = randomUUID();
			projects[canonical] = id;
			await atomicText(registry, JSON.stringify({ version: 1, projects }, null, 2) + "\n", signal);
			return id;
		});
		const user = path.join(this.root, "user"), projects = path.join(this.root, "projects");
		await directory(user); await directory(projects);
		const project = path.join(projects, id);
		await directory(project);
		for (const parent of [user, project]) await directory(path.join(parent, "entries"));
		const scopes: MemoryScope[] = [{ kind: "user", directory: user }, { kind: "project", directory: project }];
		this.binding = { cwd, scopes };
		return scopes;
	}

	async snapshot(cwd: string, signal?: AbortSignal): Promise<MemorySnapshot> {
		signal?.throwIfAborted();
		await directory(this.root);
		const scopes = await this.scopes(cwd, signal);
		await directory(path.join(this.root, "projects"));
		const entries: MemorySnapshot["entries"] = [], issues: MemoryIssue[] = [];
		const present = new Set<string>();
		for (const scope of scopes) {
			await queue.run(scope.directory, signal, async () => {
				await directory(scope.directory);
				const folder = path.join(scope.directory, "entries");
				await directory(folder);
				for (const item of await readdir(folder, { withFileTypes: true })) {
					signal?.throwIfAborted();
					if (!item.name.endsWith(".md")) continue;
					const file = path.join(folder, item.name); present.add(file);
					const loaded = await this.load(file, item.name, signal);
					if (loaded.entry) entries.push({ ...loaded.entry, path: file, scope });
					if (loaded.issue) issues.push({ file, reason: loaded.issue });
				}
				const active = entries.filter(entry => entry.scope === scope && !entry.archived).sort(compareEntries);
				const index = "# Memory\n\n" + active.map(memoryIndexLine).join("\n") + "\n";
				try { await atomicText(path.join(scope.directory, "MEMORY.md"), index, signal); }
				catch { signal?.throwIfAborted(); issues.push({ file: path.join(scope.directory, "MEMORY.md"), reason: "index_pending; source entries are saved" }); }
			});
		}
		for (const file of this.cache.keys()) if (!present.has(file)) this.cache.delete(file);
		entries.sort(compareEntries);
		return { scopes, entries, issues, version: hash(JSON.stringify([entries, issues])) };
	}

	private async load(file: string, name: string, signal?: AbortSignal): Promise<CachedEntry> {
		try {
			const before = await regularFile(file);
			const stamp = `${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
			const cached = this.cache.get(file);
			if (cached?.stamp === stamp) return cached;
			if (before.size > MAX_MEMORY_BYTES) throw new Error("Memory exceeds 32 KiB.");
			const text = await readFile(file, { encoding: "utf8", signal });
			const after = await regularFile(file);
			if (`${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) throw new Error("Memory changed while reading; retry after the writer finishes.");
			let parsed: ReturnType<typeof parseMemory>;
			try { parsed = parseMemory(text); }
			catch (error) {
				const message = error instanceof Error && error.message.startsWith("Memory ") ? error.message : "Memory frontmatter is invalid.";
				const failed = { stamp, issue: message }; this.cache.set(file, failed); return failed;
			}
			const loaded = { stamp, entry: { ...parsed, file: name, version: `sha256:${hash(text)}` } };
			this.cache.set(file, loaded); return loaded;
		} catch (error) {
			signal?.throwIfAborted();
			this.cache.delete(file);
			return { stamp: "", issue: error instanceof Error ? error.message.slice(0, 240) : "Memory unavailable." };
		}
	}
}

export async function atomicText(file: string, content: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	try { const stat = await regularFile(file); if (stat.size === Buffer.byteLength(content) && await readFile(file, "utf8") === content) return; }
	catch (error) { if (!isNotFound(error)) throw error; }
	const temp = `${file}.${randomUUID()}.tmp`;
	try { await writeFile(temp, content, { flag: "wx", mode: 0o600, signal }); signal?.throwIfAborted(); await rename(temp, file); }
	finally { await rm(temp, { force: true }); }
}

async function directory(folder: string): Promise<void> {
	await mkdir(folder, { recursive: true });
	const stat = await lstat(folder);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Memory directories must be real directories, not links.");
}
export async function regularFile(file: string) {
	const stat = await lstat(file);
	if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error("Memory entries and indexes must be regular files, not links.");
	return stat;
}
async function projectRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	let root = await realpath(cwd);
	try {
		const { stdout } = await exec("git", ["--no-optional-locks", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024, signal,
		});
		root = await realpath(stdout.trim());
	} catch { signal?.throwIfAborted(); /* 非 Git 工作区使用真实工作区路径。 */ }
	return process.platform === "win32" ? root.toLowerCase() : root;
}
function isRegistry(value: unknown): value is { version: 1; projects: Record<string, string> } {
	if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 || !("projects" in value)) return false;
	const projects = value.projects;
	return typeof projects === "object" && projects !== null && !Array.isArray(projects)
		&& Object.values(projects).every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id));
}
function compareEntries(a: MemoryEntry, b: MemoryEntry): number { return a.type.localeCompare(b.type) || a.file.localeCompare(b.file); }
export function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
