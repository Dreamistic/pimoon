/** 预热命名空间；同名工具通过 functions 访问，不覆盖模块。 */
export const pythonPreloads = ["os", "sys", "json", "re", "pathlib", "Path", "csv", "io", "math", "statistics", "datetime", "time", "collections", "itertools", "functools", "subprocess"] as const;
export const isPreloadedName = (name: string): boolean => pythonPreloads.some(value => value === name);
