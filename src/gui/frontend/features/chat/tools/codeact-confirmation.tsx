import { useId, useRef, useState } from "react";
import { ShieldQuestion } from "lucide-react";
import type { GuiDialog } from "../../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { CodeBlock } from "@/ui/content/code-block.tsx";
import { clean } from "@/ui/content/format.ts";
import "./codeact-confirmation.css";

/** 沿用会话对话框协议；重连只恢复展示，不重新提交执行。 */
export function CodeActConfirmationBar({ dialog, send, disabled }: { dialog: GuiDialog; send: Send; disabled: boolean }) {
	const titleId = useId();
	const submitting = useRef(false);
	const [busy, setBusy] = useState(false);
	const [explaining, setExplaining] = useState(false);
	const [feedback, setFeedback] = useState("");
	const request = dialog.codeact;
	if (!request) return null;
	const respond = async (approved: boolean) => {
		if (submitting.current || disabled) return;
		submitting.current = true; setBusy(true);
		try {
			const accepted = await send({ action: "dialog", id: dialog.id, value: approved ? "yes" : "no",
				...(!approved && feedback.trim() ? { feedback: feedback.trim() } : {}) });
			if (accepted) return;
		} catch { /* 连接边界负责显示错误，未知结果不自动重试。 */ }
		submitting.current = false; setBusy(false);
	};
	return <section className="codeact-confirmation" aria-labelledby={titleId} data-execution-id={request.id}>
		<div className="codeact-confirmation-heading"><ShieldQuestion aria-hidden="true" /><strong id={titleId}>{clean(dialog.title)}</strong><span role="status">等待确认 · 尚未执行</span></div>
		<p className="codeact-confirmation-reason">{clean(request.reason)}</p>
		<Disclosure summary="查看待执行代码与工作区" lazy>
			<p className="tool-note">工作区：<code>{request.cwd}</code></p>
			<CodeBlock label="待执行 · Python" language="python" text={request.code} />
		</Disclosure>
		<p className="tool-note">仅确认本次代码；内部操作仍需通过权限检查和审批。</p>
		{explaining && <Textarea aria-label="拒绝原因或替代方案" autoFocus maxLength={2000} rows={2} value={feedback}
			disabled={disabled || busy} onChange={event => setFeedback(event.target.value)} placeholder="说明原因或希望采用的做法（可选）" />}
		<div className="codeact-confirmation-actions">
			<Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => void respond(false)}>{explaining ? "提交拒绝" : "拒绝"}</Button>
			<Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => setExplaining(value => !value)}>{explaining ? "收起说明" : "拒绝并说明"}</Button>
			<Button size="sm" disabled={disabled || busy} onClick={() => void respond(true)}>{busy ? "正在提交…" : "确认执行"}</Button>
		</div>
	</section>;
}
