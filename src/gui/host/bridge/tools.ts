import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuiDialogs } from "../session/dialogs.ts";
import { deliverySchema, type BridgeDelivery } from "./schema.ts";

export interface DelegateTools {
	deliver(value: BridgeDelivery): Promise<void>;
}

/** 仅由宿主为已登记任务装配；澄清答案不会创建审批许可。 */
export function registerDelegateTools(pi: ExtensionAPI, dialogs: GuiDialogs, delegate: DelegateTools): void {
	pi.registerTool({
		name: "ask", label: "任务澄清", defaultActive: true,
		description: "Ask for task clarification; waits for an answer.",
		parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 64000 }),
			options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 100, uniqueItems: true })) }, { additionalProperties: false }),
		async execute(_id, input, signal) {
			const answer = await dialogs.ask(input.options ? "select" : "input", input.question, "", input.options ?? [], "", signal ? { signal } : undefined);
			const result = { answered: answer !== undefined, answer: answer ?? null };
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	pi.registerTool({
		name: "deliver", label: "提交交付", defaultActive: true,
		description: "Submit the completed task report for review; report only verified facts.",
		parameters: deliverySchema,
		async execute(_id, input, signal) {
			signal?.throwIfAborted();
			await delegate.deliver(input);
			return { content: [{ type: "text", text: "Delivery recorded; awaiting review." }], details: {} };
		},
	});
	// 委派协议工具不受普通会话默认工具集合影响，重开和旧快照恢复后仍可交付。
	const activate = () => pi.setActiveTools([...new Set([...pi.getActiveTools(), "ask", "deliver"])]);
	pi.on("session_start", activate);
	pi.on("session_tree", activate);
	pi.on("before_agent_start", event => {
		activate();
		event.systemPromptOptions.sections ??= {};
		event.systemPromptOptions.sections.delegate = "Delegated task: clarify ambiguity with ask; answers are not operation authorization. Finish with deliver.";
	});
}
