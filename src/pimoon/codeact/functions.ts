const shellFunctions = new Set(["bash", "powershell"]);

/** Shell 包装不进入 CodeAct 函数集合。 */
export const isCodeActFunction = (name: string): boolean => !shellFunctions.has(name);
