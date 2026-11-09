import { useId } from "react";
import type { ApprovalAnswers, ApprovalWidget } from "../../../../../harness/approval/widgets.ts";
import { clean } from "@/ui/content/format.ts";

/** 只渲染固定组件；模型文本始终作为 React 文本，不解释 HTML 或执行代码。 */
export function ApprovalWidgets({ widgets, answers, change, disabled }: {
	widgets: readonly ApprovalWidget[]; answers: ApprovalAnswers; change: (id: string, value: string | boolean) => void; disabled: boolean;
}) {
	const group = useId();
	return <div className="approval-widgets">{widgets.map((widget, index) => <fieldset key={index} className={`approval-widget approval-widget-${widget.kind}`} disabled={disabled}>
		<legend>{clean(widget.title)}</legend>
		{widget.kind === "facts" || widget.kind === "comparison" ? <dl>{widget.items.map((item, i) => <div key={i}><dt>{clean(item.label)}</dt><dd>{clean(item.value)}</dd></div>)}</dl>
			: widget.kind === "checklist" ? widget.items.map(item => <label key={item.id}><input type="checkbox" checked={answers[item.id] === true} onChange={event => change(item.id, event.target.checked)} /><span>{clean(item.label)}{item.required && <small> · 必选确认</small>}</span></label>)
			: widget.options.map(option => <label key={option}><input type="radio" name={`${group}-${widget.id}`} checked={answers[widget.id] === option} onChange={() => change(widget.id, option)} /><span>{clean(option)}</span></label>)}
		{widget.kind === "question" && <p className="tool-note">提交答案只用于澄清，不执行原操作或替代方案。</p>}
	</fieldset>)}</div>;
}
