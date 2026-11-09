import { approvalText } from "./presentation.ts";

export type ApprovalWidget =
	| { kind: "facts"; title: string; items: { label: string; value: string }[] }
	| { kind: "checklist"; title: string; items: { id: string; label: string; required: boolean }[] }
	| { kind: "question"; id: string; title: string; options: string[] }
	| { kind: "comparison"; title: string; items: { label: string; value: string }[] };
export type ApprovalAnswers = Record<string, string | boolean>;

export function parseApprovalWidgets(value: unknown): ApprovalWidget[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 6) throw new Error("Invalid approval widgets.");
	const ids = new Set<string>();
	const id = (value: unknown) => {
		if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/u.test(value) || ids.has(value)) throw new Error("Invalid approval field ID.");
		ids.add(value); return value;
	};
	return value.map((widget: unknown): ApprovalWidget => {
		if (!record(widget)) throw new Error("Invalid approval widget.");
		const title = text(widget.title, 160);
		if (widget.kind === "question") {
			if (!Array.isArray(widget.options) || widget.options.length < 2 || widget.options.length > 6) throw new Error("Invalid approval options.");
			const options = widget.options.map(option => text(option, 160));
			if (new Set(options).size !== options.length) throw new Error("Duplicate approval options.");
			return { kind: "question", id: id(widget.id), title, options };
		}
		if (!Array.isArray(widget.items) || widget.items.length === 0 || widget.items.length > 12) throw new Error("Invalid approval items.");
		if (widget.kind === "checklist") return { kind: "checklist", title, items: widget.items.map((item: unknown) => {
			if (!record(item) || typeof item.required !== "boolean") throw new Error("Invalid checklist item.");
			return { id: id(item.id), label: text(item.label, 240), required: item.required };
		}) };
		if (widget.kind !== "facts" && widget.kind !== "comparison") throw new Error("Unknown approval widget.");
		return { kind: widget.kind, title, items: widget.items.map((item: unknown) => {
			if (!record(item)) throw new Error("Invalid fact.");
			return { label: text(item.label, 160), value: text(item.value, 1200) };
		}) };
	});
}

/** 组件不能创造权限；问题只收集澄清，勾选确认由宿主复核而非只靠前端。 */
export function validateApprovalAnswers(widgets: readonly ApprovalWidget[], answers: ApprovalAnswers, approve: boolean): void {
	const fields = new Map<string, { options?: string[]; required?: boolean }>();
	for (const widget of widgets) {
		if (widget.kind === "question") fields.set(widget.id, { options: widget.options });
		if (widget.kind === "checklist") for (const item of widget.items) fields.set(item.id, { required: item.required });
	}
	for (const [id, answer] of Object.entries(answers)) {
		const field = fields.get(id);
		if (!field || (field.options ? typeof answer !== "string" || !field.options.includes(answer) : typeof answer !== "boolean")) throw new Error("无效审批表单值。");
	}
	if (approve) {
		if (widgets.some(widget => widget.kind === "question")) throw new Error("请先提交澄清答案；回答不代表批准。");
		for (const [id, field] of fields) if (field.required && answers[id] !== true) throw new Error("请先完成必要的风险确认。");
	}
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid widget text."); return approvalText(value).trim(); }
