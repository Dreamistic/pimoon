import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// 同一任务不指定原生调用或 Python 编排，由实际模型选择执行方式。
export const scenarios = {
	"locate-edit": {
		prompt: "使用当前环境提供的文件工具/函数完成任务。定位 src 中计算运费的实现，把免运费门槛从 100 改为 150；不要修改其他行为或文件。修改后重新读取确认，并简短报告文件路径与新门槛。",
		async setup(cwd) {
			await fs.mkdir(path.join(cwd, "src"));
			for (let i = 0; i < 24; i++) await fs.writeFile(path.join(cwd, "src", `helper-${i}.ts`), `export const helper${i} = ${i};\n`);
			await fs.writeFile(path.join(cwd, "src/shipping.ts"), 'export function shippingFee(total: number): number {\n  return total >= 100 ? 0 : 12;\n}\n');
		},
		async verify(cwd) {
			assert.equal(await fs.readFile(path.join(cwd, "src/shipping.ts"), "utf8"), 'export function shippingFee(total: number): number {\n  return total >= 150 ? 0 : 12;\n}\n');
			for (let i = 0; i < 24; i++) assert.equal(await fs.readFile(path.join(cwd, "src", `helper-${i}.ts`), "utf8"), `export const helper${i} = ${i};\n`);
		},
	},
	"aggregate": {
		prompt: "使用当前环境提供的文件工具/函数，读取 invoices 下全部 JSON，忽略 status 为 void 的发票。将有效发票的 count、amount 总和 total 和按客户汇总的 byCustomer 写入 summary.json。还有 invoices/missing.json 可能不存在；检查它，但缺失不应阻止汇总。不要修改发票。简短报告结果。",
		async setup(cwd) {
			await fs.mkdir(path.join(cwd, "invoices"));
			for (let i = 0; i < 12; i++) await fs.writeFile(path.join(cwd, "invoices", `${i}.json`), JSON.stringify({ customer: i % 2 ? "B" : "A", amount: (i + 1) * 7, status: i % 4 === 0 ? "void" : "paid" }));
		},
		async verify(cwd) {
			const expected = { count: 0, total: 0, byCustomer: {} };
			for (let i = 0; i < 12; i++) {
				const row = { customer: i % 2 ? "B" : "A", amount: (i + 1) * 7, status: i % 4 === 0 ? "void" : "paid" };
				assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd, "invoices", `${i}.json`), "utf8")), row);
				if (row.status === "void") continue;
				expected.count++; expected.total += row.amount;
				expected.byCustomer[row.customer] = (expected.byCustomer[row.customer] ?? 0) + row.amount;
			}
			assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd, "summary.json"), "utf8")), expected);
			await assert.rejects(fs.access(path.join(cwd, "invoices/missing.json")));
		},
	},
	"conditional-edit": {
		prompt: "使用当前环境提供的文件工具/函数，检查 configs 下所有 JSON：仅当 enabled 为 true 且 retries 小于 3 时把 retries 改为 3，其他配置内容不变。不要重写整个文件，使用精确编辑。完成后重新读取全部文件验证，将实际修改过的相对路径按字典序写成 changed.json 数组。简短报告修改数量。",
		async setup(cwd) {
			await fs.mkdir(path.join(cwd, "configs"));
			for (let i = 0; i < 8; i++) await fs.writeFile(path.join(cwd, "configs", `${i}.json`), JSON.stringify({ enabled: i % 2 === 0, retries: i % 4, label: `job-${i}` }, null, 2) + "\n");
		},
		async verify(cwd) {
			const changed = [];
			for (let i = 0; i < 8; i++) {
				const row = { enabled: i % 2 === 0, retries: i % 4, label: `job-${i}` };
				if (row.enabled && row.retries < 3) { row.retries = 3; changed.push(`configs/${i}.json`); }
				assert.equal(await fs.readFile(path.join(cwd, "configs", `${i}.json`), "utf8"), JSON.stringify(row, null, 2) + "\n");
			}
			assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd, "changed.json"), "utf8")), changed.sort());
		},
	},
};
