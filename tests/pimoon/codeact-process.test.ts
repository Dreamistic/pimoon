import fs from "node:fs/promises";
import path from "node:path";
import which from "which";
import { expect, it } from "vitest";
import { runProcess } from "../../src/pimoon/codeact/process.ts";

async function folder() {
	const base = path.resolve(".tmp/tests/codeact-process"); await fs.mkdir(base, { recursive: true });
	return fs.mkdtemp(path.join(base, "case-"));
}

it("参数保留 Unicode、空格和 Shell 元字符；cwd/env 不改变父环境", async () => {
	const cwd = await folder(), payload = "中文 spaces & | > $(not-a-command)";
	const result = await runProcess({ argv: [process.execPath, "-e", "console.log(JSON.stringify({arg:process.argv[1],cwd:process.cwd(),value:process.env.CODEACT_VALUE}))", payload], env: { CODEACT_VALUE: payload } }, cwd);
	expect(result).toMatchObject({ exit_code: 0, status: "exited", truncated: false });
	expect(JSON.parse(result.stdout)).toEqual({ arg: payload, cwd, value: payload });
	expect(process.env.CODEACT_VALUE).toBeUndefined();
});
it("非零退出与输出截断是结构化事实，不吞错误", async () => {
	const cwd = await folder();
	const result = await runProcess({ argv: [process.execPath, "-e", "process.stdout.write('a'.repeat(200000));process.stderr.write('failed');process.exitCode=7"] }, cwd);
	expect(result).toMatchObject({ exit_code: 7, status: "exited", stderr: "failed", truncated: true });
	expect(result.stdout.length).toBe(65_536);
});
it("拒绝 Shell/curl 包装以及未知 Windows 批处理入口", async () => {
	const cwd = await folder();
	for (const program of ["powershell.exe", "bash", "cmd.exe", "curl.exe"]) await expect(runProcess({ argv: [program, "anything"] }, cwd)).rejects.toThrow("Shell/curl");
	if (process.platform === "win32") await expect(runProcess({ argv: ["unknown.cmd"] }, cwd)).rejects.toThrow("批处理");
});
it("超时和主动取消回收活动进程树", async () => {
	const cwd = await folder();
	for (const cancel of [false, true]) {
		const pidFile = path.join(cwd, `child-${cancel}.txt`);
		const controller = new AbortController();
		const code = `const{spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`;
		const promise = runProcess({ argv: [process.execPath, "-e", code], timeout: cancel ? 30 : 1 }, cwd, controller.signal);
		await expect.poll(async () => fs.readFile(pidFile, "utf8").catch(() => ""), { timeout: 3000 }).not.toBe("");
		const pid = Number(await fs.readFile(pidFile, "utf8"));
		if (cancel) controller.abort();
		expect((await promise).status).toBe(cancel ? "cancelled" : "timeout");
		await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 3000 }).toBe(false);
	}
});
it.skipIf(process.platform !== "win32")("npm.cmd 自动转换为 Node CLI，前项失败时 Python 可停止后项", async () => {
	const cwd = await folder();
	await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "codeact-process-fixture", private: true, scripts: { "build:android": "node build.mjs" } }));
	await fs.writeFile(path.join(cwd, "build.mjs"), "if(process.env.BUILD_FAIL==='1')process.exit(7);console.log(process.env.JAVA_HOME+'|'+process.env.ANDROID_HOME)");
	const env = { JAVA_HOME: "fixture-java", ANDROID_HOME: "fixture-sdk", npm_config_cache: path.join(cwd, "cache"), npm_config_update_notifier: "false" };
	const good = await runProcess({ argv: ["npm.cmd", "run", "build:android"], env }, cwd);
	expect(good).toMatchObject({ exit_code: 0, status: "exited" }); expect(good.stdout).toContain("fixture-java|fixture-sdk");
	const bad = await runProcess({ argv: ["npm", "run", "build:android"], env: { ...env, BUILD_FAIL: "1" } }, cwd);
	expect(bad.exit_code).toBe(7);
});
const javac = await which("javac", { nothrow: true });
it.skipIf(process.platform !== "win32" || !javac)("gradlew.bat 转换为 JVM Wrapper 主类，保留参数、环境与工作目录", async () => {
	if (!javac) throw new Error("javac unavailable");
	const cwd = await folder(), wrapper = path.join(cwd, "gradle/wrapper"), classes = path.join(cwd, "classes");
	await fs.mkdir(wrapper, { recursive: true }); await fs.mkdir(classes);
	await fs.writeFile(path.join(cwd, "gradlew.bat"), "@echo must-not-run\r\nexit /b 9");
	const source = path.join(cwd, "GradleWrapperMain.java");
	await fs.writeFile(source, 'package org.gradle.wrapper; public class GradleWrapperMain { public static void main(String[] args){System.out.println(String.join("|",args));System.out.println(System.getenv("ANDROID_HOME"));}}');
	const javaHome = path.dirname(path.dirname(javac));
	expect((await runProcess({ argv: [javac, "-d", classes, source] }, cwd)).exit_code).toBe(0);
	expect((await runProcess({ argv: [path.join(javaHome, "bin/jar.exe"), "cf", path.join(wrapper, "gradle-wrapper.jar"), "-C", classes, "."] }, cwd)).exit_code).toBe(0);
	const result = await runProcess({ argv: [".\\gradlew.bat", ":app:assembleDebug", "--console=plain", "--no-daemon"], env: { JAVA_HOME: javaHome, ANDROID_HOME: "isolated-sdk" } }, cwd);
	expect(result).toMatchObject({ exit_code: 0, status: "exited" });
	expect(result.stdout).toContain(":app:assembleDebug|--console=plain|--no-daemon"); expect(result.stdout).toContain("isolated-sdk");
});

it("同一次进程捕获分别解码 UTF-8 与 GBK，不改写退出码", async () => {
	const cwd = await folder();
	const result = await runProcess({ argv: [process.execPath, "-e", 'process.stdout.write("中文😀");process.stderr.write(Buffer.from([0xd6,0xd0,0xce,0xc4]));process.exitCode=7'], fallback_encoding: "cp936" }, cwd);
	expect(result).toMatchObject({ stdout: "中文😀", stderr: "中文", exit_code: 7, status: "exited" });
	expect(result.decode_error).toBeUndefined();
});
it("解码失败保留原始字节和退出事实，副作用只执行一次", async () => {
	const cwd = await folder();
	const code = 'require("node:fs").appendFileSync("count","x");process.stdout.write(Buffer.from([0x81]));process.stderr.write("diagnostic");process.exitCode=3';
	const result = await runProcess({ argv: [process.execPath, "-e", code], encoding: "utf-8" }, cwd);
	expect(result).toMatchObject({ stdout: "", stderr: "diagnostic", exit_code: 3, status: "exited", stdout_base64: "gQ==", stderr_base64: Buffer.from("diagnostic").toString("base64") });
	expect(result.decode_error).toContain("stdout:");
	expect(await fs.readFile(path.join(cwd, "count"), "utf8")).toBe("x");
});
it("未知显式编码在进程启动前拒绝", async () => {
	const cwd = await folder();
	await expect(runProcess({ argv: [process.execPath, "-e", 'require("node:fs").writeFileSync("unexpected","x")'], encoding: "not-a-codec" }, cwd)).rejects.toThrow("Unsupported process encoding");
	await expect(fs.access(path.join(cwd, "unexpected"))).rejects.toThrow();
});
it("截断不制造乱码，另一完整流的非法尾字节仍报解码失败", async () => {
	const cwd = await folder();
	const result = await runProcess({ argv: [process.execPath, "-e", 'process.stdout.write("中".repeat(30000));process.stderr.write(Buffer.from([0x81]))'], encoding: "utf-8" }, cwd);
	expect(result.truncated).toBe(true);
	expect(result.stdout).toBe("中".repeat(21845));
	expect(result.decode_error).toContain("stderr:");
	expect(result.decode_error).not.toContain("stdout:");
});
it("丢弃的流不参与解码，不误报二进制输出", async () => {
	const cwd = await folder();
	const result = await runProcess({ argv: [process.execPath, "-e", 'process.stdout.write(Buffer.from([0x81]));console.error("ok")'], discard_stdout: true }, cwd);
	expect(result.stdout).toBe("");
	expect(result.stderr.trim()).toBe("ok");
	expect(result.decode_error).toBeUndefined();
});
