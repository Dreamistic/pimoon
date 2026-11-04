import { expect, it, vi } from "vitest";
import { approvalPresence, updateApprovalPresence } from "../../../src/harness/approval/presence.ts";
it("空闲阈值与过期样本不伪造离开状态", () => {
	vi.useFakeTimers();
	try {
		updateApprovalPresence(179); expect(approvalPresence().state).toBe("active");
		updateApprovalPresence(180); expect(approvalPresence().state).toBe("away");
		vi.advanceTimersByTime(30001); expect(approvalPresence().state).toBe("unknown");
		updateApprovalPresence(-1); expect(approvalPresence().state).toBe("unknown");
	} finally { updateApprovalPresence(0); vi.useRealTimers(); }
});
