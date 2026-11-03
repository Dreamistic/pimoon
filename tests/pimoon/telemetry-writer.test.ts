import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelemetryWriter } from "../../src/pimoon/telemetry-writer.ts";
import { deferred } from "../helpers/async.ts";

async function outputFile(): Promise<string> {
	const base = path.resolve(".tmp/tests/pimoon-telemetry");
	await fs.mkdir(base, { recursive: true });
	return path.join(await fs.mkdtemp(path.join(base, "case-")), "events.jsonl");
}
afterEach(() => vi.restoreAllMocks());

it("后台写入不阻塞生产者；并发排空与写入期间新增记录仍有序提交", async () => {
	const output = await outputFile(), failed = vi.fn();
	const writer = new TelemetryWriter(output, failed);
	const entered = deferred<void>(), release = deferred<void>();
	const append = fs.appendFile.bind(fs);
	let active = 0, peak = 0;
	vi.spyOn(fs, "appendFile").mockImplementation(async (file, data, options) => {
		active++; peak = Math.max(peak, active);
		try { entered.resolve(); await release.promise; await append(file, data, options); }
		finally { active--; }
	});
	writer.append('{"seq":1}\n');
	writer.append('{"seq":2}\n');
	await entered.promise;
	writer.append('{"seq":3}\n');
	const first = writer.flush(), second = writer.flush();
	let drained = false;
	void first.then(() => { drained = true; });
	try {
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(drained).toBe(false);
		expect(writer.stats.pendingBytes).toBeGreaterThan(0);
	} finally { release.resolve(); await Promise.all([first, second]); }
	expect((await fs.readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
	expect(peak).toBe(1);
	expect(writer.stats).toMatchObject({ complete: true, pendingBytes: 0, writes: 2 });
	expect(failed).not.toHaveBeenCalled();
	await writer.close();
	expect(JSON.parse(await fs.readFile(`${output}.status.json`, "utf8"))).toMatchObject({ complete: true, closed: true, writtenRecords: 3 });
});

it.each(["totalBytes", "pendingBytes"] as const)("达到 %s 上限时保留已接收记录，停止接收并只提示一次", async field => {
	const output = await outputFile(), failed = vi.fn();
	const writer = new TelemetryWriter(output, failed, { totalBytes: 100, pendingBytes: 100, [field]: 5 });
	writer.append("123\n");
	writer.append("45\n");
	writer.append("ignored\n");
	await writer.flush();
	expect(await fs.readFile(output, "utf8")).toBe("123\n");
	expect(writer.stats).toMatchObject({ complete: false, pendingBytes: 0, writtenBytes: 4 });
	expect(failed).toHaveBeenCalledTimes(1);
	await writer.close();
	expect(JSON.parse(await fs.readFile(`${output}.status.json`, "utf8"))).toMatchObject({
		complete: false, closed: true, failure: field === "totalBytes" ? "total_limit" : "queue_limit",
		acceptedRecords: 1, writtenRecords: 1, droppedRecords: 2,
	});
});

it("写盘失败可见且排空不挂起，也不产生未处理拒绝", async () => {
	const output = await outputFile(), failed = vi.fn();
	await fs.mkdir(output);
	const writer = new TelemetryWriter(output, failed);
	writer.append("first\n");
	await writer.flush();
	writer.append("ignored\n");
	await writer.flush();
	expect(writer.stats).toMatchObject({ complete: false, pendingBytes: 0, writtenBytes: 0 });
	expect(failed).toHaveBeenCalledTimes(1);
	await writer.close();
	expect(JSON.parse(await fs.readFile(`${output}.status.json`, "utf8"))).toMatchObject({ failure: "write_error", acceptedRecords: 1, writtenRecords: 0 });
});

it("检查点写入失败也明确停用，不让遥测异常逃逸", async () => {
	const output = await outputFile(), failed = vi.fn();
	const writer = new TelemetryWriter(output, failed);
	writer.append("event\n");
	await fs.mkdir(`${output}.status.json`);
	await writer.close();
	expect(writer.stats).toMatchObject({ complete: false, failure: "checkpoint_error", writtenRecords: 1, closed: true });
	expect(failed).toHaveBeenCalledTimes(1);
});
