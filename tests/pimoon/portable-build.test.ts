import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it.each(["same", "inside", "parent"])("便携封装拒绝与 Electron 来源重叠的输出：%s", async relation => {
	const base = path.resolve(".tmp/tests/pimoon-portable-build");
	await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const source = path.join(folder, "electron");
	await fs.mkdir(source);
	await fs.writeFile(path.join(source, "sentinel.txt"), "do not modify");
	const output = relation === "same" ? source : relation === "inside" ? path.join(source, "output") : folder;
	await expect(execute(process.execPath, ["scripts/build-pimoon-portable.mjs", "--output", output], {
		env: { ...process.env, PIMOON_ELECTRON_DIST: source },
		windowsHide: true,
	})).rejects.toMatchObject({ stderr: expect.stringContaining("封装输出不能与 Electron 来源目录重叠") });
	expect(await fs.readdir(folder)).toEqual(["electron"]);
	expect(await fs.readdir(source)).toEqual(["sentinel.txt"]);
	expect(await fs.readFile(path.join(source, "sentinel.txt"), "utf8")).toBe("do not modify");
});
