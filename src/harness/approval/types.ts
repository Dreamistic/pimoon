export interface ApprovalUnit {
	action: "execute" | "write_file" | "edit_file" | "fetch_url";
	target: { kind: "command" | "path" | "url"; value: string };
}

export interface ApprovalEditReplacement {
	old: string;
	new: string;
	replace_all?: boolean;
}

export type ApprovalRequest = {
	cwd: string;
	units: ApprovalUnit[];
} & (
	| { tool: "bash"; detail: { command: string } }
	| { tool: "process_run"; detail: { argv: string[]; env: Record<string, string>; inherit_env?: false } }
	| { tool: "write"; detail: { path: string; content: string } }
	| { tool: "edit"; detail: { path: string; edits: ApprovalEditReplacement[] } }
	| { tool: "webfetch"; detail: WebApprovalDetail }
	| { tool: "http"; detail: WebApprovalDetail }
	| { tool: "other"; detail: { name: string; input: Record<string, unknown> } }
);

interface WebApprovalDetail {
	url: string;
	origin: string;
	addresses?: import("../web-tools/network/network-policy.ts").ResolvedAddresses;
	path?: string;
}

export type BashApprovalRequest = Extract<ApprovalRequest, { tool: "bash" }>;

interface ApprovalAskItem {
	unit: ApprovalUnit;
	reason: string;
}

export type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; items: ApprovalAskItem[] }
	| { kind: "deny"; reason: string; rule_name?: string };

export interface ApprovalGateConfig {
	enabled: boolean;
	routine?: boolean;
	model: string;
	timeout_ms: number;
}
