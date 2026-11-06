const shellFunctions = new Set(["bash", "powershell", "execute", "parallel", "ParallelError", "ToolError"]);

/** Shell 包装、execute 与 Python 编排保留名称不进入内部工具集合。 */
export const isCodeActFunction = (name: string): boolean => !shellFunctions.has(name);
