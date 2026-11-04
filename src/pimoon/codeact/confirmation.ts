export interface CodeActConfirmation {
	desc?: string | undefined;
	id: string;
	cwd: string;
	code: string;
	reason: string;
}

export type CodeActConfirmationDecision =
	| { kind: "approved" }
	| { kind: "rejected"; feedback?: string | undefined }
	| { kind: "cancelled" };

export type ConfirmCodeAct = (request: CodeActConfirmation, signal?: AbortSignal) => Promise<CodeActConfirmationDecision>;
