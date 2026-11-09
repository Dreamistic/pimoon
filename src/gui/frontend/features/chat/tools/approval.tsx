import type { ApprovalAnswers } from "../../../../../harness/approval/widgets.ts";
import { ApprovalWidgets } from "./approval-widgets.tsx";
import { useEffect, useId, useRef, useState } from "react";
import { ShieldQuestion } from "lucide-react";
import type { GuiDialog } from "../../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { CodeBlock } from "@/ui/content/code-block.tsx";
import { clean } from "@/ui/content/format.ts";
import "./approval.css";

/** 代码意图确认与具体权限审批共用非模态入口；重连只恢复展示，不重新执行。 */
export function ApprovalBar({ dialog, send, disabled }: { dialog: GuiDialog; send: Send; disabled: boolean }) {
	const titleId = useId(), scopeId = useId();
	const submitting = useRef(false);
	const [busy, setBusy] = useState(false);
	const [explaining, setExplaining] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [answers, setAnswers] = useState<ApprovalAnswers>({});
	const [scope, setScope] = useState(dialog.approval ? dialog.approval.recommended : "once");
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (dialog.deadline === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [dialog.deadline]);
	const permission = dialog.approval, codeact = dialog.codeact;
	if (!permission && !codeact) return null;
	const selected = permission?.scopes.find(option => option.scope === scope);
	const card = permission?.card;
	const widgets = card?.widgets ?? [];
	const hasQuestion = widgets.some(widget => widget.kind === "question");
	const acknowledged = widgets.every(widget => widget.kind !== "checklist" || widget.items.every(item => !item.required || answers[item.id] === true));
	const recommendsDeny = card?.decision === "deny" || card?.recommendation === "Deny";
	const label = (choice: string, fallback: string) => card?.actions.find(action => action.choice === choice)?.label ?? fallback;
	const expired = dialog.deadline !== null && now >= dialog.deadline;
	const locked = disabled || busy || expired;
	const approveLabel = !permission ? "确认执行" : !selected ? "选择范围后仍要执行" : label(selected?.choice ?? "", "授权本次");
	const respond = async (approved: boolean, discuss = false) => {
		if (submitting.current || locked || approved && permission && (!selected || hasQuestion || !acknowledged)) return;
		submitting.current = true; setBusy(true);
		try {
			const accepted = await send({ action: "dialog", id: dialog.id, value: discuss ? "Discuss" : permission ? approved ? selected?.choice ?? "Deny" : "Deny" : approved ? "yes" : "no",
				...((permission || !approved) && feedback.trim() ? { feedback: feedback.trim() } : {}),
				...(permission && Object.keys(answers).length ? { answers } : {}) });
			if (accepted) return;
		} catch { /* 连接边界负责显示错误，未知结果不自动重试。 */ }
		submitting.current = false; setBusy(false);
	};
	return <section className="approval-bar" aria-labelledby={titleId} data-execution-id={codeact?.id}>
		<div className="approval-bar-heading"><ShieldQuestion aria-hidden="true" /><strong id={titleId}>{clean(dialog.title)}</strong><span role="status">等待确认 · {permission?.block ? "代码块在此暂停" : permission ? "此操作尚未执行" : "尚未执行"}</span></div>
		<p className="approval-bar-reason">{clean(permission?.reason ?? codeact?.reason ?? "")}</p>
		{permission ? <>
			<p className="tool-note"><code>{permission.tool}</code> · 工作区：<code>{clean(permission.cwd)}</code></p>
			{permission.block && <Disclosure summary={`本次 CodeAct · ${permission.block.plannedCalls} 个确定调用`} lazy>
				<p className="tool-note">审批覆盖此段余下确定操作；此前已完成的不回滚、不重跑。动态新目标超出计划时停止。已派发 {permission.block.dispatchedCalls ?? 0} 个调用。</p>
				{permission.block.unresolvedLines.length > 0 && <p className="tool-note">有动态调用未解析，不能把未知目标当作已授权。</p>}
				<CodeBlock label="宿主绑定的 CodeAct 源码" language="python" text={permission.block.code} />
			</Disclosure>}
			{widgets.length > 0 && <><p className="tool-note">以下为 AI 整理；真实操作以宿主展示为准。</p><ApprovalWidgets widgets={widgets} answers={answers} disabled={locked} change={(id, value) => setAnswers(previous => ({ ...previous, [id]: value }))} /></>}
			<p className="approval-bar-target"><code>{clean(permission.summary)}</code></p>
			<Disclosure summary="查看实际操作与拦截原因" lazy>
				<CodeBlock label="运行时核验的操作" text={permission.content.map(line => line.text).join("\n")} />
			</Disclosure>
			<fieldset className="approval-bar-scopes" disabled={locked}>
				<legend>授权范围</legend>
				{permission.scopes.map(option => <label key={option.scope}>
					<input type="radio" name={scopeId} checked={option.scope === scope} onChange={() => setScope(option.scope)} />
					<span>{card ? `${label(option.choice, option.label)} · ` : ""}{option.label}{card?.recommendation === option.choice && <small> · AI 建议</small>}</span>
				</label>)}
			</fieldset>
			<p className="approval-bar-range">{clean(selected?.detail ?? (recommendsDeny ? "AI建议拒绝；如要覆盖此建议，请先明确选择授权范围。" : "请选择授权范围"))}</p>
			<p className="tool-note">不重跑整段代码；文件版本检查和取消保护仍生效。</p>
		</> : codeact && <>
			<Disclosure summary="查看待执行代码与工作区" lazy>
				<p className="tool-note">工作区：<code>{codeact.cwd}</code></p>
				<CodeBlock label="待执行 · Python" language="python" text={codeact.code} />
			</Disclosure>
			<p className="tool-note">仅确认本次代码意图；不授予内部操作权限。</p>
		</>}
		{dialog.deadline !== null && <p className="tool-note">{expired ? "审批已超时" : `剩余 ${Math.max(0, Math.ceil((dialog.deadline - now) / 1000))} 秒`}</p>}
		{(explaining || permission?.discuss) && <Textarea aria-label={permission ? "审批意见" : "拒绝原因或替代方案"} autoFocus={explaining} maxLength={2000} rows={2} value={feedback}
			disabled={locked} onChange={event => setFeedback(event.target.value)} placeholder={card?.feedbackPlaceholder ?? "说明原因或希望采用的做法（可选）"} />}
		<div className="approval-bar-actions">
			<Button variant={recommendsDeny ? "default" : "outline"} size="sm" disabled={locked} onClick={() => void respond(false)}>{explaining && !permission ? "提交拒绝" : card ? `拒绝 · ${label("Deny", "不执行")}${recommendsDeny ? " · AI推荐" : ""}` : "拒绝"}</Button>
			{!permission?.discuss && <Button variant="ghost" size="sm" disabled={locked} onClick={() => setExplaining(value => !value)}>{explaining ? "收起说明" : permission ? "补充意见" : "拒绝并说明"}</Button>}
			{permission?.discuss && <Button variant="outline" size="sm" disabled={locked || !feedback.trim() && !Object.keys(answers).length} onClick={() => void respond(false, true)}>{hasQuestion ? "提交答案，不执行" : "先聊一下，不执行"}</Button>}
			<Button variant={recommendsDeny ? "outline" : "default"} size="sm" disabled={locked || Boolean(permission && (!selected || hasQuestion || !acknowledged))} onClick={() => void respond(true)}>{busy ? "正在提交…" : approveLabel}</Button>
		</div>
	</section>;
}
