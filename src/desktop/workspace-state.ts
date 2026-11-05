import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 仅记录桌面端选择，不让 Web 客户端覆盖下次启动目录。 */
export class DesktopWorkspaceState {
	private current: string | undefined;
	constructor(private readonly file: string) {}

	restore(fallback: string): string {
		try {
			const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (typeof value === "string" && path.isAbsolute(value) && statSync(value).isDirectory()) {
				this.current = value;
				return value;
			}
		} catch { /* 记录损坏、目录删除或不可访问时使用默认工作区。 */ }
		return fallback;
	}

	select(cwd: string): void {
		if (cwd === this.current) return;
		const temporary = `${this.file}.tmp`;
		try {
			mkdirSync(path.dirname(this.file), { recursive: true });
			writeFileSync(temporary, JSON.stringify(cwd), { mode: 0o600 });
			renameSync(temporary, this.file);
			this.current = cwd;
		} catch (error) {
			console.error("无法保存上次工作区:", error);
		} finally {
			try { rmSync(temporary, { force: true }); }
			catch { /* 保存失败不阻塞桌面导航。 */ }
		}
	}
}
