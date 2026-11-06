/** 显式列出独立构建阶段；失败也收齐在途任务，再让调用方清理目录。 */
export async function runBuildTasks(tasks, { serial = false, report = console.log } = {}) {
  async function run({ name, run }) {
    const start = performance.now();
    let ok = false;
    try { const value = await run(); ok = true; return value; }
    finally { report('BUILD_STAGE ' + JSON.stringify({ name, ok, elapsedMs: Math.round(performance.now() - start) })); }
  }
  if (serial) {
    const results = [];
    for (const task of tasks) results.push(await run(task));
    return results;
  }
  const rows = await Promise.allSettled(tasks.map(run));
  const failures = rows.filter(row => row.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(row => row.reason), '构建阶段失败；已等待所有在途阶段结束。');
  return rows.map(row => row.value);
}
