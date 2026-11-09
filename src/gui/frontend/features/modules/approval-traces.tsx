import { useCallback, useEffect, useState } from "react";
import type { ApprovalTraceDetail, ApprovalTraceSummary } from "../../../../harness/approval/trace-store.ts";
import type { Query, GlobalQuery } from "../../../shared/protocol/queries.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { CodeBlock } from "@/ui/content/code-block.tsx";
import { SettingsSection } from "@/forms/settings-controls.tsx";

const phases: Record<string, string> = { begin: "开始", request: "实际输入", transport: "模型请求", response: "原始回复", parsed: "解析结果", present: "展示卡片", interaction: "人工交互", resolved: "最终决定", dispatch: "派发操作", execution: "执行结果", failure: "失败", omitted: "记录省略", annotation: "用户标注" };

export function ApprovalTraces({ query, send, disabled }: { query: Query<GlobalQuery>; send: Send; disabled: boolean }) {
	const [rows, setRows] = useState<ApprovalTraceSummary[]>([]), [detail, setDetail] = useState<ApprovalTraceDetail>();
	const [error, setError] = useState(""), [busy, setBusy] = useState(false), [confirmClear, setConfirmClear] = useState(false);
	const reload = useCallback(async () => {
		try { setRows(await query({ query: "approvalTraces" })); setError(""); }
		catch { setError("审批诊断记录读取失败。"); }
	}, [query]);
	useEffect(() => { let active = true; void query({ query: "approvalTraces" }).then(value => { if (active) setRows(value); }, () => { if (active) setError("审批诊断记录读取失败。"); }); return () => { active = false; }; }, [query]);
	const open = async (id: string) => { setBusy(true); try { setDetail(await query({ query: "approvalTrace", id })); setError(""); } catch { setError("该记录不可用或已被清理。"); } finally { setBusy(false); } };
	const clear = async () => { setBusy(true); try { if (await send({ action: "clearApprovalTraces" })) { setDetail(undefined); setConfirmClear(false); await reload(); } } finally { setBusy(false); } };
	const annotate = async (label: "false_block" | "false_allow" | "unclear" | "unreviewed") => {
		if (!detail) return; setBusy(true);
		try { if (await send({ action: "annotateApprovalTrace", id: detail.id, label })) setDetail(await query({ query: "approvalTrace", id: detail.id })); }
		catch { setError("标注未保存，请重新读取记录后检查。"); } finally { setBusy(false); }
	};
	const locked = disabled || busy;
	return <SettingsSection title="审批 AI 诊断" actions={<Button variant="ghost" size="sm" disabled={locked} onClick={() => void reload()}>刷新记录</Button>}>
		<p className="settings-empty">仅存本机脱敏诊断，不自动上传，也不作为授权。原始文本仍可能包含未识别的隐私；导出前请检查。</p>
		{error && <p role="alert">{error}</p>}
		{rows.length === 0 ? <p className="settings-empty">暂无详细审批记录；普通免审只写轻量元数据。</p> : <div className="approval-trace-list">{rows.map(row => <Button variant="ghost" key={row.id} disabled={locked} onClick={() => void open(row.id)}>
			<span>{row.at ? new Date(row.at).toLocaleString() : row.id}</span><small>{row.phases.map(phase => phases[phase] ?? phase).join(" / ")} · {Math.ceil(row.bytes / 1024)} KiB</small>
		</Button>)}</div>}
		{detail && <>
			<p><code>{detail.id}</code></p>
			<div className="approval-trace-actions">{([["false_block", "标记误拦截"], ["false_allow", "标记误放行"], ["unclear", "标记不清楚"], ["unreviewed", "撤销标记"]] as const).map(([label, title]) => <Button key={label} variant="outline" size="sm" disabled={locked} onClick={() => void annotate(label)}>{title}</Button>)}</div>
			<p className="tool-note">标记是用户反馈，不是自动训练标签，也不会修改审批规则。</p>
			{detail.events.map((event, index) => <Disclosure key={index} summary={`${phases[event.phase] ?? event.phase} · ${new Date(event.at).toLocaleTimeString()}${event.redactions ? ` · 脱敏 ${event.redactions}` : ""}${event.truncated ? " · 有省略" : ""}`} lazy><CodeBlock label="本机诊断" language="json" text={JSON.stringify(event.data, null, 2)} /></Disclosure>)}
			<Disclosure summary="脱敏导出预览" lazy><p className="tool-note">只导出当前记录，不包含认证对象；仍需自行核查私人内容。</p><CodeBlock label="审批诊断 JSON" language="json" text={JSON.stringify(detail, null, 2)} />
				<Button variant="outline" size="sm" disabled={locked} onClick={() => {
					const url = URL.createObjectURL(new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" }));
					const link = document.createElement("a"); link.href = url; link.download = `approval-${detail.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
				}}>导出当前脱敏记录</Button></Disclosure>
		</>}
		<div>{confirmClear ? <><span>清除所有详细诊断？不会撤销授权或删除会话。</span><Button variant="outline" size="sm" disabled={locked} onClick={() => void clear()}>确认清除</Button><Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>取消</Button></> : <Button variant="outline" size="sm" disabled={locked || rows.length === 0} onClick={() => setConfirmClear(true)}>清除详细诊断</Button>}</div>
	</SettingsSection>;
}
