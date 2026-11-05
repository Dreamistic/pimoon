const shellFunctions = new Set(["bash", "powershell", "execute"]);

/** Shell 包装与 execute 入口不进入 Python 内部函数集合。 */
export const isCodeActFunction = (name: string): boolean => !shellFunctions.has(name);
