import { validateApprovalAnswers, type ApprovalAnswers } from "../../../harness/approval/widgets.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { GuiDialog, GuiNotice } from "../../shared/protocol/state.ts";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import { approvalScopes, DENY, type ApprovalInteractionPort, type ApprovalReply } from "../../../harness/approval/runtime/interaction.ts";
import { approvalSummary, approvalText, buildApprovalContent } from "../../../harness/approval/presentation.ts";
import { plainTheme } from "./theme.ts";
import type { CodeActConfirmation, CodeActConfirmationDecision } from "../../../pimoon/codeact/confirmation.ts";

interface DialogResponse { value: string | undefined; feedback?: string | undefined; answers?: ApprovalAnswers | undefined }

/** 对话框属于会话，不随浏览器连接销毁。响应只能消费一次。 */
export class GuiDialogs {
	private pending = new Map<string, { dialog: GuiDialog; finish: (value: string | undefined, feedback?: string, answers?: ApprovalAnswers) => void }>();
	readonly notices: GuiNotice[] = [];
	readonly status: Record<string, string> = {};
	constructor(private readonly emit: (event: GuiEvent) => void, private readonly tail: () => number,
		private readonly editor: { get(): string; set(value: string): void }) {}

	list(): GuiDialog[] {
		return [...this.pending.values()].map(({ dialog }) => dialog);
	}

	async approve(...[request, decision, options, opts]: Parameters<ApprovalInteractionPort["approve"]>): Promise<ApprovalReply | undefined> {
		const scopes = approvalScopes(request, decision, options).map(scope => opts?.block ? { ...scope, label: "本次 CodeAct", detail: "仅批准展示的这段 CodeAct 余下确定操作；不重跑已完成步骤，不生成会话许可。" } : scope);
		const card = opts?.card;
		const recommended = card?.decision === "deny" || card?.recommendation === DENY
			? null : scopes.find(scope => scope.choice === card?.recommendation)?.scope ?? "once";
		const response = await this.request({ kind: "approval", title: card?.title ?? "操作审批", message: "", options: [...scopes.map(scope => scope.choice), DENY, ...(opts?.discuss ? ["Discuss"] : [])], initial: "",
			approval: { tool: request.tool, cwd: approvalText(request.cwd), reason: approvalText(card?.explanation ?? decision.reason),
				summary: approvalSummary(request), content: buildApprovalContent(request, decision), scopes, recommended,
				...(card ? { card } : {}), ...(opts?.block ? { block: opts.block } : {}), ...(opts?.reviewId ? { reviewId: opts.reviewId } : {}), ...(opts?.discuss ? { discuss: true } : {}) } }, opts);
		if (opts?.discuss && response.value === "Discuss") return { choice: "Discuss", feedback: response.feedback ?? "", ...(response.answers ? { answers: response.answers } : {}) };
		const choice = options.find(choice => choice === response.value);
		return choice ? { choice, ...(response.feedback ? { feedback: response.feedback } : {}), ...(response.answers ? { answers: response.answers } : {}) } : undefined;
	}

	async confirmCodeAct(request: CodeActConfirmation, signal?: AbortSignal): Promise<CodeActConfirmationDecision> {
		const response = await this.request({ kind: "codeact", title: request.desc ?? "代码执行", message: request.reason,
			options: [], initial: "", codeact: { ...request } }, signal ? { signal } : undefined);
		if (signal?.aborted || response.value === undefined) return { kind: "cancelled" };
		return response.value === "yes" ? { kind: "approved" } : { kind: "rejected", feedback: response.feedback };
	}

	ask(
		kind: GuiDialog["kind"],
		title: string,
		message = "",
		options: string[] = [],
		initial = "",
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.request({ kind, title, message, options, initial }, opts).then(response => response.value);
	}

	private request(dialog: Omit<GuiDialog, "id" | "deadline">, opts?: ExtensionUIDialogOptions): Promise<DialogResponse> {
		if (opts?.signal?.aborted) return Promise.resolve({ value: undefined });
		const id = randomUUID();
		return new Promise((resolve) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const abort = () => finish(undefined);
			const finish = (value: string | undefined, feedback?: string, answers?: ApprovalAnswers) => {
				if (!this.pending.has(id)) return;
				clearTimeout(timeout);
				opts?.signal?.removeEventListener("abort", abort);
				this.pending.delete(id);
				this.emit({ type: "dialogs", value: this.list() });
				resolve({ value, feedback, answers });
			};
			this.pending.set(id, {
				dialog: { ...dialog, id, deadline: opts?.timeout ? Date.now() + opts.timeout : null },
				finish,
			});
			opts?.signal?.addEventListener("abort", abort, { once: true });
			if (opts?.timeout) timeout = setTimeout(abort, opts.timeout);
			this.emit({ type: "dialogs", value: this.list() });
		});
	}

	respond(id: string, value: string | null, feedback?: string, answers?: ApprovalAnswers): void {
		const pending = this.pending.get(id);
		if (!pending) throw new Error("对话框已结束，请刷新当前状态。");
		if (value !== null && (pending.dialog.kind === "select" || pending.dialog.kind === "approval") && !pending.dialog.options.includes(value))
			throw new Error("无效选项。");
		if (value !== null && pending.dialog.kind === "confirm" && value !== "yes") throw new Error("无效确认。");
		if (pending.dialog.kind === "codeact" && value !== null && value !== "yes" && value !== "no") throw new Error("无效执行确认。");
		if (feedback !== undefined && (!(pending.dialog.kind === "approval" && value !== null || pending.dialog.kind === "codeact" && value === "no") || feedback.length > 2000)) throw new Error("无效拒绝意见。");
		if (pending.dialog.approval) validateApprovalAnswers(pending.dialog.approval.card?.widgets ?? [], answers ?? {}, value === "Allow once");
		else if (answers && Object.keys(answers).length) throw new Error("此对话不接受表单。");
		if (value === "Discuss" && !feedback?.trim() && !Object.keys(answers ?? {}).length) throw new Error("请先填写要交流的内容。");
		pending.finish(value ?? undefined, feedback?.trim(), answers);
	}

	cancel(): void {
		for (const pending of [...this.pending.values()]) pending.finish(undefined);
	}

	notify(text: string, type: GuiNotice["type"] = "info"): void {
		this.notices.push({ id: randomUUID(), type, text, anchor: this.tail() });
		if (this.notices.length > 100) this.notices.shift();
		this.emit({ type: "notices", value: [...this.notices] });
	}

	clearNotices(ids: string[]): void {
		const kept = this.notices.filter((notice) => !ids.includes(notice.id));
		if (kept.length === this.notices.length) return;
		this.notices.splice(0, this.notices.length, ...kept);
		this.emit({ type: "notices", value: [...this.notices] });
	}

	context(): ExtensionUIContext {
		const unsupported = (): never => {
			throw new Error("此扩展使用了 GUI 不支持的终端组件。");
		};
		return {
			select: (title, options, opts) => this.ask("select", title, "", options, "", opts),
			confirm: async (title, message, opts) => (await this.ask("confirm", title, message, [], "", opts)) === "yes",
			input: (title, placeholder, opts) => this.ask("input", title, placeholder ?? "", [], "", opts),
			editor: (title, prefill) => this.ask("editor", title, "", [], prefill ?? ""),
			notify: (message, type) => this.notify(message, type),
			setStatus: (key, text) => {
				if (text === undefined) delete this.status[key];
				else this.status[key] = text;
			},
			setTitle: (title) => {
				this.status["title"] = title;
			},
			setWorkingMessage: (message) => {
				if (message === undefined) delete this.status["working"];
				else this.status["working"] = message;
			},
			setWorkingVisible: (visible) => {
				this.status["workingVisible"] = String(visible);
			},
			setWorkingIndicator: unsupported,
			setHiddenThinkingLabel: (label) => {
				this.status["thinkingLabel"] = label ?? "思考";
			},
			setWidget: (key, content) => {
				if (Array.isArray(content)) this.status[key] = content.join("\n");
				else if (content === undefined) delete this.status[key];
				else unsupported();
			},
			setEditorText: (text) => {
				this.editor.set(text);
			},
			pasteToEditor: (text) => {
				const value = this.editor.get() + text;
				this.editor.set(value);
			},
			getEditorText: () => this.editor.get(),
			onTerminalInput: unsupported,
			setFooter: unsupported,
			setHeader: unsupported,
			custom: unsupported,
			addAutocompleteProvider: unsupported,
			setEditorComponent: unsupported,
			getEditorComponent: () => undefined,
			theme: plainTheme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "GUI 不使用终端主题。" }),
			getToolsExpanded: () => this.status["toolsExpanded"] === "true",
			setToolsExpanded: (expanded) => {
				this.status["toolsExpanded"] = String(expanded);
			},
		};
	}
}
