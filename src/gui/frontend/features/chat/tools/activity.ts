import { isPythonExecution } from "../../../../shared/messages/execution.ts";
import type { GuiNestedCalls, GuiToolOutput, ToolState } from "../../../../shared/messages/types.ts";

export interface ToolActivity {
	id: string;
	name: string;
	args: unknown;
	state: ToolState;
	output: GuiToolOutput | undefined;
	nestedCalls?: GuiNestedCalls;
	durationMs?: number;
}

/** Python 执行与内部函数分开计数，避免父子调用重复统计。 */
export function activityCounts(tools: ToolActivity[]): string[] {
	const executions = tools.filter(tool => isPythonExecution(tool.name));
	const direct = tools.length - executions.length;
	const functions = executions.reduce((count, tool) => count + (tool.nestedCalls?.calls.length ?? 0), 0);
	return [executions.length ? `${executions.length} 次执行` : "", functions ? `${functions} 次函数调用` : "", direct ? `${direct} 次工具调用` : ""].filter(Boolean);
}

export function sameToolActivity(before: ToolActivity, after: ToolActivity): boolean {
	return before.id === after.id && before.name === after.name && before.state === after.state
		&& before.args === after.args && before.output === after.output && before.nestedCalls === after.nestedCalls && before.durationMs === after.durationMs;
}
