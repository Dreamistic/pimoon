// 调度只读工具；不接纳进程或写入，也不替代宿主权限校验。
const READ_ONLY = new Set(['read', 'find', 'grep', 'ls', 'native_read']);
export async function scheduleReads(jobs, invoke, cancelled = () => false, observe = () => {}, errors = 'raise') {
  if (!Array.isArray(jobs) || jobs.length > 256 || !['raise','collect'].includes(errors) || jobs.some(job =>
    !job || !READ_ONLY.has(job.name) || !job.args || typeof job.args !== 'object' || Array.isArray(job.args) ||
    job.name === 'native_read' && (typeof job.args.path !== 'string' || Object.keys(job.args).length !== 1)))
    throw Error('Invalid read schedule');
  const rows = Array(jobs.length); let cursor = 0, failed = false;
  await Promise.all(Array.from({length: jobs.length}, async () => {
    while (cursor < jobs.length && (!failed || errors === 'collect') && !cancelled()) {
      const index = cursor++, job = jobs[index];
      const started = performance.now(); observe('start', index);
      try { rows[index] = {ok: true, value: await invoke(job.name, job.args, index)}; }
      catch (error) { rows[index] = {ok: false, error: error.message, ...(typeof error.code === 'string' ? {error_code: error.code} : {})}; failed = true; }
      finally { rows[index].elapsed_ms = performance.now() - started; observe('end', index, rows[index]); }
    }
  }));
  return Array.from(rows, row => row ?? {ok: false, skipped: true, error: 'Not started after failure or cancellation'});
}
