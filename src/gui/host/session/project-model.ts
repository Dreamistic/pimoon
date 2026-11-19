import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

type Preference = { enabled: boolean; model?: { provider: string; id: string } };
const cache = new Map<string, Preference>();
function file(cwd: string) {
	const root = path.resolve(cwd);
	const key = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
	return path.join(getAgentDir(), "project-models", `${key}.json`);
}
export function projectModel(cwd: string): Preference {
	const key = file(cwd);
	const cached = cache.get(key);
	if (cached) return cached;
	let pref: Preference = { enabled: true };
	try {
		const data = JSON.parse(readFileSync(key, "utf8"));
		pref = { enabled: data.enabled !== false, model: typeof data.model?.provider === "string" && typeof data.model?.id === "string" ? data.model : undefined };
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	cache.set(key, pref);
	return pref;
}
export function saveProjectModel(cwd: string, change: Partial<Preference>) {
	const key = file(cwd);
	const next = { ...projectModel(cwd), ...change };
	mkdirSync(path.dirname(key), { recursive: true });
	const tmp = `${key}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(next));
	renameSync(tmp, key);
	cache.set(key, next);
}
