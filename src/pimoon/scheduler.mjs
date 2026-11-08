// 显式任务组共用一个入口；读取不限流，进程最多两个（包括审批等待）。
import { isProcessResult } from './codeact/process.ts';
const READ_ONLY = new Set(['read', 'find', 'grep', 'ls', 'websearch', 'webfetch', 'http']);
export const PROCESS_CONCURRENCY = 2;

export function processFailure(value, check) {
  if (!isProcessResult(value)) return {error: 'Invalid process result; do not replay completed operations', error_code: 'PROCESS_RESULT_INVALID'};
  if (value.status !== 'exited') return {error: 'Process ' + value.status + ': ' + value.stderr.slice(0, 600), error_code: 'PROCESS_' + value.status.toUpperCase()};
  if (check && value.exit_code !== 0) return {error: 'Process exited ' + value.exit_code + ': ' + value.stderr.slice(0, 600), error_code: 'PROCESS_EXIT'};
}

export async function scheduleJobs(jobs, invoke, cancelled = () => false, observe = () => {}, errors = 'raise') {
  if (!Array.isArray(jobs) || jobs.length > 256 || !['raise','collect'].includes(errors) || jobs.some(job =>
    !job || !(READ_ONLY.has(job.name) || job.name === 'process_run' && typeof job.check === 'boolean' && job.args?.check === false)
    || !job.args || typeof job.args !== 'object' || Array.isArray(job.args)
    || job.name === 'http' && (!['text', 'probe'].includes(job.args.mode === undefined ? 'text' : job.args.mode) || Object.hasOwn(job.args, 'path'))))
    throw Error('Invalid parallel schedule');
  const rows = Array(jobs.length);
  let failed = false, cursor = 0;
  const canStart = () => (!failed || errors === 'collect') && !cancelled();
  const processes = jobs.flatMap((job, index) => job.name === 'process_run' ? [index] : []);
  async function run(index) {
    const job = jobs[index], started = performance.now();
    observe('start', index);
    try {
      const value = await invoke(job.name, job.args, index);
      const failure = job.name === 'process_run' ? processFailure(value, job.check) : undefined;
      rows[index] = failure ? {ok: false, ...failure, ...(isProcessResult(value) ? {value} : {})} : {ok: true, value};
      failed ||= Boolean(failure);
    } catch (error) {
      rows[index] = {ok: false, error: error.message, ...(typeof error.code === 'string' ? {error_code: error.code} : {})};
      failed = true;
    } finally {
      rows[index].elapsed_ms = performance.now() - started;
      observe('end', index, rows[index]);
    }
  }
  const pending = [];
  for (let i = 0; i < jobs.length && canStart(); i++) if (jobs[i].name !== 'process_run') pending.push(run(i));
  for (let i = 0; i < Math.min(PROCESS_CONCURRENCY, processes.length); i++) pending.push((async () => {
    while (cursor < processes.length && canStart()) await run(processes[cursor++]);
  })());
  // 已启动项必须收尾；失败不撤销副作用，不重放，也不提前归还进程槽。
  await Promise.all(pending);
  return Array.from(rows, row => row ?? {ok: false, skipped: true, error: 'Not started after failure or cancellation'});
}
