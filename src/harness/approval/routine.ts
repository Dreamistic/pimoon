import type { ApprovalRequest } from "./types.ts";
import { routineFile } from "./routine-files.ts";
import { routineGit } from "./routine-git.ts";
import { routineWorkflow } from "./routine-workflows.ts";

/** 只返回免审类别；无法归类仍走原 AI 流程，不增加一套静态拒绝策略。 */
export async function routineOperation(request: ApprovalRequest, workspace: string, created?: ReadonlySet<string>): Promise<string | undefined> {
	return await routineFile(request, workspace, created)
		?? (await routineGit(request, workspace) ? "git_inspection" : undefined)
		?? await routineWorkflow(request, workspace);
}
