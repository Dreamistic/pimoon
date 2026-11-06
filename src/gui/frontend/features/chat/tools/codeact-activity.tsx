import { ChevronRight, CodeXml } from "lucide-react";
import { outputPreview } from "../../../../shared/messages/output.ts";
import type { GuiNestedCall, ToolState } from "../../../../shared/messages/types.ts";
import { ActivityError, ActivityState, errorSummary, toolDisplay } from "./tool-display.tsx";
import { useDisclosureMemory } from "@/ui/disclosure-memory.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/ui/collapsible.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { CodeBlock } from "@/ui/content/code-block.tsx";
import { clean, record } from "@/ui/content/format.ts";
import { ParameterValue } from "./tool-parameters.tsx";
import { RawToolContent } from "./tool-results.tsx";
import { ToolBody } from "./tool-body.tsx";
import { ToolSummary } from "./tool-summary.tsx";
import { toolTarget } from "./tool-target.ts";
import { useToolOutput } from "./use-tool-output.ts";
import type { ToolActivity } from "./activity.ts";
import { codeActOutcome, codeActOutputSummary, codeActStateLabel } from "./codeact-summary.ts";

import { SchedulingBadge, SchedulingPanel, schedulingView } from "./codeact-scheduling.tsx";

export function CodeActActivity({ tool }: { tool: ToolActivity }) {
	const [expanded, setExpanded] = useDisclosureMemory(`tool:${tool.id}`, null);
	const active = tool.state === "running" || tool.state === "preparing" || tool.state === "pending";
	const open = expanded ?? (active || tool.state === "failed");
	const calls = tool.nestedCalls?.calls ?? [];
	const failures = calls.filter((call) => call.status === "error").length;
	const first = calls[0];
	const sameTool = first && calls.every(call => call.name === first.name);
	const display = sameTool ? toolDisplay(first.name) : undefined;
	const Icon = display?.icon ?? CodeXml;
	const args = record(tool.args) ? tool.args : {};
	const desc = typeof args.desc === "string" ? clean(args.desc) : "";
	const label = desc || (display ? `${display.label}${calls.length > 1 ? ` · ${calls.length} 次` : ""}` : "代码执行");
	const target = !desc && calls.length === 1 && first ? toolTarget(first.name, first.arguments) : "";
	const failedCall = calls.find(call => call.status === "error");
	const outcome = codeActOutcome(tool.output);
	const scheduling = schedulingView(tool.output);
	const waiting = tool.state === "pending" && args.confirmationPending === true;
	const error = tool.state === "failed" ? codeActOutputSummary(tool.output, true) || (failedCall && errorSummary(failedCall)) || errorSummary(tool) : "";
	const summary = !active && tool.state === "completed" ? codeActOutputSummary(tool.output) : "";
	const operations = new Map<string, number>();
	for (const call of calls) operations.set(call.name, (operations.get(call.name) ?? 0) + 1);
	const facts = [...operations].map(([name, count]) => `${toolDisplay(name).label} ${count} 次`).join(" · ");
	return <section className="tool-activity codeact-activity" data-state={tool.state} data-tool={tool.name} data-tool-call-id={tool.id}>
		<Collapsible open={open} onOpenChange={setExpanded}>
			<CollapsibleTrigger className="activity-summary">
				<Icon className="activity-icon" aria-hidden="true" /><span className="activity-label codeact-title">{label}</span>
				{target && <code className="activity-target">{target}</code>}
				<span className="activity-tail">
					<ActivityState state={tool.state} label={codeActStateLabel(tool.state, outcome, waiting, failures > 0)} durationMs={tool.durationMs}
						facts={<>{calls.length > 0 ? `${calls.length} 次函数调用` : ""}{failures > 0 && <span className="nested-failures"> · {failures} 次失败</span>}</>} />
					<ChevronRight className={`activity-chevron${open ? " expanded" : ""}`} aria-hidden="true" />
				</span>
			</CollapsibleTrigger>
			{(facts || summary) && <p className="codeact-overview">{[facts, summary].filter(Boolean).join(" · ")}</p>}
			<div className="codeact-scheduling-summary"><SchedulingBadge output={tool.output} /></div>
			<ActivityError>{error}</ActivityError>
			<CollapsibleContent lazy>
				<div className="activity-body codeact-body">
					{scheduling && <SchedulingPanel value={scheduling} />}
					<div className="codeact-calls">
						{calls.map((call) => <NestedCallRow key={call.id} call={call} active={active} stopped={tool.state === "stopped"} />)}
					</div>
					{!active && tool.nestedCalls?.complete === false && <p className="tool-note">调用记录不完整，部分参数、调用或完成状态未保留。</p>}
					{typeof args.confirm === "string" && <p className="tool-note">确认原因：{clean(args.confirm)}</p>}
					{typeof args.code === "string" && (tool.state === "preparing"
						? <CodeBlock label="正在生成 · Python" language="python" text={args.code} />
						: <Disclosure className="tool-parameters" summary="源码 · Python" lazy>
							<CodeBlock label="Python" language="python" text={args.code} />
						</Disclosure>)}
					{!active && tool.output && <Disclosure className="tool-parameters codeact-output" summary="返回给模型的输出" lazy>
						<CodeActOutput tool={tool} />
					</Disclosure>}
				</div>
			</CollapsibleContent>
		</Collapsible>
	</section>;
}

function NestedCallRow({ call, active, stopped }: { call: GuiNestedCall; active: boolean; stopped: boolean }) {
	const [expanded, setExpanded] = useDisclosureMemory(`nested:${call.id}`, null);
	const state: ToolState = call.status === "ok" ? "completed" : call.status === "error" ? "failed"
		: active ? "running" : stopped ? "stopped" : "unavailable";
	const tool: ToolActivity = { id: call.id, name: call.name, args: call.arguments, state, output: call.output, ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }) };
	const open = expanded ?? state === "failed";
	const error = call.status === "error" ? errorSummary(call) : "";
	return <Collapsible className="tool-activity nested-tool-call" data-nested-tool-call-id={call.id} data-state={state}
		open={open} onOpenChange={setExpanded}>
		<ToolSummary tool={tool} open={open} {...(state === "unavailable" ? { stateLabel: "未完成" } : {})} />
		<ActivityError>{error}</ActivityError>
		<CollapsibleContent lazy><div className="nested-call-details">
			{call.output ? <ToolBody tool={tool} /> : <div className="activity-body">
				{call.arguments !== undefined ? <Disclosure className="tool-parameters" summary="参数" lazy>
					<ParameterValue value={call.arguments} />
				</Disclosure> : <p className="tool-note">参数未保留{call.argumentsBytes !== undefined && `（${call.argumentsBytes} 字节）`}</p>}
				{state === "completed" && (call.name === "write" || call.name === "edit")
					&& <p className="tool-note">历史记录未保存变更结果。</p>}
			</div>}
		</div></CollapsibleContent>
	</Collapsible>;
}

function CodeActOutput({ tool }: { tool: ToolActivity }) {
	const id = tool.output?.kind === "reference" ? tool.output.id : undefined;
	const loaded = useToolOutput(id);
	if (id && !loaded.value) return <p className="tool-note" role={loaded.error ? "alert" : "status"}>{loaded.error || "正在读取工具结果…"}</p>;
	const output = loaded.value ?? outputPreview(tool.output);
	return output ? <RawToolContent value={output.content} /> : null;
}
