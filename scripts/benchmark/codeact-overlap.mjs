// 实验专用：闭合提交与正常终态是两个独立状态，不接入生产会话。
export async function collectOverlap({ source, parser, mode, execute, signal }) {
    const started = performance.now();
    let code = "", closedMs, execution, executionStartedMs, executionFinishedMs, index;
    const run = () => {
        if (execution || signal?.aborted) return;
        executionStartedMs = performance.now() - started;
        // 立即安装拒绝处理，后台收尾不能制造未处理的 Promise。
        execution = Promise.resolve().then(() => execute(code, signal)).then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error: String(error) }),
        ).finally(() => { executionFinishedMs = performance.now() - started; });
    };
    const accept = chunks => {
        for (const chunk of chunks) {
            if (chunk.type === "code") code += chunk.text;
            if (chunk.type === "close" && closedMs === undefined) {
                closedMs = performance.now() - started;
                if (mode === "overlap") run();
            }
        }
    };
    let final, failure;
    try {
        for await (const event of source) {
            if (event.type !== "text_delta") continue;
            if (index !== event.contentIndex) {
                accept(parser.textBoundary());
                index = event.contentIndex;
            }
            accept(parser.feed(event.delta));
        }
        final = await source.result();
        if (final.stopReason === "stop") {
            accept(parser.finish());
            if (closedMs !== undefined && mode === "serial") run();
        }
    } catch (error) { failure = String(error); }
    const streamFinishedMs = performance.now() - started;
    const executed = execution ? await execution : undefined;
    return { code, closedMs, streamFinishedMs, executionStartedMs, executionFinishedMs,
        elapsedMs: performance.now() - started, executed, final, failure };
}
