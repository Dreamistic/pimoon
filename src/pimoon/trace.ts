import { randomUUID } from "node:crypto";

/** 纯内存关联上下文；不初始化配置或写盘。 */
export const applicationRunId = process.env.PIMOON_RUN_ID ?? `${Date.now()}-${randomUUID()}`;
export interface ExecutionTrace {
	application_run_id?: string;
	session_id?: string;
	agent_run_id?: string;
	model_request_id?: string;
}
const sessions = new Map<string, ExecutionTrace>();
export function sessionTrace(sessionId: string): ExecutionTrace {
	return { application_run_id: applicationRunId, session_id: sessionId, ...sessions.get(sessionId) };
}
export function bindSessionTrace(sessionId: string, trace: ExecutionTrace): void {
	sessions.set(sessionId, trace);
}
export function clearSessionTrace(sessionId: string): void {
	sessions.delete(sessionId);
}
