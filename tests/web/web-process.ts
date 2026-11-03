import { spawn } from "node:child_process";
import path from "node:path";
import { expect } from "@playwright/test";

export function startWebProcess(cwd: string, env: Record<string, string>, binary = process.env.PIMOON_GUI_TEST_BINARY
	?? path.resolve("dist/web", process.platform === "win32" ? "pimoon-web.exe" : "pimoon-web")) {
	const child = spawn(binary, ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	return {
		get output() { return output; },
		async ready(): Promise<string> {
			let url = "";
			await expect.poll(() => { url = output.match(/pimoon-web: (http:\/\/[^\s]+)/)?.[1] ?? ""; return url; }, { message: "pimoon-web 启动" }).toBeTruthy();
			return url;
		},
		async close(): Promise<void> {
			if (child.exitCode !== null || child.signalCode !== null) return;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
				child.once("exit", () => { clearTimeout(timer); resolve(); });
				child.kill("SIGTERM");
			});
		},
	};
}
