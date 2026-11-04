import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const inside = (root: string, file: string): boolean => {
	const relative = path.relative(root, file);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** 控制面不能由普通文件写入自行扩权；显式用户设置和审批存储走宿主入口。 */
export function protectedControlPaths(): string[] {
	const home = process.env.PIMOON_HOME ?? path.join(process.env.APPDATA ?? os.homedir(), "pimoon");
	return [path.join(home, "agent", "settings.json"), path.join(home, "agent", "configs"), path.join(home, "agent", "state"),
		...[process.env.PI_APPROVAL_GATE_CONFIG, process.env.PI_FILE_TOOLS_CONFIG].filter((item): item is string => Boolean(item))];
}

export function systemWriteRoots(): string[] {
	return process.platform === "win32"
		? [...new Set([process.env.SystemRoot ?? "C:\\Windows", process.env.ProgramFiles ?? "C:\\Program Files", process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"]) ]
		: ["/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/var"];
}

function localPath(cwd: string, target: string): string {
	const absolute = path.resolve(cwd, target);
	if (/^(?:\\\\|\/\/)/.test(target) || /^(?:\\\\|\/\/)/.test(absolute))
		throw new Error("网络和设备路径需要独立审批，不能作为普通本地文件访问。");
	return absolute;
}

/** 读取不受工作区范围限制，同时检查原始路径和链接目标。 */
export async function checkReadablePath(cwd: string, target: string, protectedPaths: readonly string[]): Promise<string> {
	const absolute = localPath(cwd, target);
	const canonical = await fs.realpath(absolute);
	await checkProtected([absolute, canonical], protectedPaths);
	return canonical;
}

/** 普通写入可跨工作区；检查未创建目标的真实父目录，不放开凭据和控制面。 */
export async function checkWritablePath(cwd: string, target: string, protectedPaths: readonly string[]): Promise<void> {
	const absolute = localPath(cwd, target);
	let ancestor = absolute;
	for (;;) {
		try {
			const canonical = path.join(await fs.realpath(ancestor), path.relative(ancestor, absolute));
			localPath(cwd, canonical);
			await checkProtected([absolute, canonical], [...protectedPaths, ...protectedControlPaths(), ...systemWriteRoots()]);
			return;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			const parent = path.dirname(ancestor);
			if (parent === ancestor) throw error;
			ancestor = parent;
		}
	}
}

async function checkProtected(candidates: readonly string[], protectedPaths: readonly string[]): Promise<void> {
	for (const target of protectedPaths) {
		let canonical: string;
		try { canonical = await fs.realpath(target); }
		catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			canonical = path.resolve(target);
		}
		if (candidates.some(file => inside(path.resolve(target), file) || inside(canonical, file)))
			throw new Error("受保护的凭据、系统或安全配置路径；普通文件操作不可访问，不能通过更换接口绕过。");
	}
}
