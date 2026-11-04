import { WorkerTaskPool } from "../../worker-runtime/worker-task-pool.ts";
import { createTypeScriptWorker } from "../../worker-runtime/typescript-worker.ts";

export interface LineMatch { readonly start: number; readonly end: number }
export interface RegexRequest { readonly source: string; readonly lines: readonly string[] }

/** 纯文本及其非空分支留在当前线程；其他正则在可终止的 worker 中执行。 */
export class GrepLineMatcher {
	private readonly pool: WorkerTaskPool<RegexRequest, Array<LineMatch | undefined>> | undefined;

	constructor(private readonly regex: RegExp, literal: boolean) {
		if (!literal && !isLiteralAlternation(regex.source)) {
			this.pool = new WorkerTaskPool({
				workerLimit: 2,
				workerName: "grep regex",
				createWorker: () => createTypeScriptWorker(new URL("./regex-worker.ts", import.meta.url)),
			});
		}
	}

	async match(lines: readonly string[], signal?: AbortSignal): Promise<Array<LineMatch | undefined>> {
		if (this.pool !== undefined) return this.pool.run({ source: this.regex.source, lines }, signal);
		return lines.map((line) => {
			const match = this.regex.exec(line);
			return match === null ? undefined : { start: match.index, end: match.index + match[0].length };
		});
	}

	dispose(): void { this.pool?.dispose(); }
}

function isLiteralAlternation(source: string): boolean {
	// 不接受量词、分组、断言或转义，保留 ECMAScript 的分支优先与 Unicode 语义。
	return source.split("|").every(part => part.length > 0 && !/[.*+?^${}()[\]\\]/u.test(part));
}
