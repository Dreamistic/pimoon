import { Type } from "typebox";
import { routineProcessArgv } from "../approval/routine-process-grant.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../../pimoon/codeact/process.ts";
import { DEFAULT_PROCESS_TIMEOUT_SECONDS, MAX_PROCESS_TIMEOUT_SECONDS } from "../../pimoon/codeact/process-budget.ts";

const parameters = Type.Object({
	argv: Type.Array(Type.String(), { minItems: 1, maxItems: 1024 }),
	cwd: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	inherit_env: Type.Optional(Type.Boolean()),
	timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_PROCESS_TIMEOUT_SECONDS })),
	check: Type.Optional(Type.Boolean()),
	encoding: Type.Optional(Type.String({ minLength: 1 })),
	fallback_encoding: Type.Optional(Type.String({ minLength: 1 })),
	discard_stdout: Type.Optional(Type.Boolean()),
	discard_stderr: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export default function codeactFunctions(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "process_run", label: "进程", defaultActive: true,
		description: `Run foreground argv without an implicit shell. cwd defaults to workspace; env overrides inherited variables. npm/gradlew Windows launchers map to Node/Java. timeout seconds (default ${DEFAULT_PROCESS_TIMEOUT_SECONDS}, max ${MAX_PROCESS_TIMEOUT_SECONDS}), capped by remaining CodeAct time with cleanup reserved. check defaults true: failure raises; false returns exit_code/status/stdout/stderr/truncated/duration_ms. Routine fast paths: direct installed Node tsc --noEmit, isolated Vitest run, default Vite build; custom scripts still get AI review.`,
		parameters,
		outputSchema: Type.Object({ exit_code: Type.Union([Type.Integer(), Type.Null()]), status: Type.Union([Type.Literal("exited"), Type.Literal("cancelled"), Type.Literal("timeout"), Type.Literal("spawn_error")]), stdout: Type.String(), stderr: Type.String(), truncated: Type.Boolean(), duration_ms: Type.Number(), decode_error: Type.Optional(Type.String()), stdout_base64: Type.Optional(Type.String()), stderr_base64: Type.Optional(Type.String()) }),
		async execute(_id, input, signal, _update, ctx) {
			const result = await runProcess({ ...input, argv: routineProcessArgv(input, input.argv) }, ctx.cwd, signal);
			const failed = result.status !== "exited" || result.exit_code !== 0 || result.decode_error !== undefined;
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result,
				...(failed && input.check !== false ? { isError: true } : { structuredContent: { ...result } }),
			};
		},
	});
}
