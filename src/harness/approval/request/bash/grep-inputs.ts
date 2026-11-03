const VALUE_OPTIONS = new Set(["--after-context", "--before-context", "--context", "--binary-files", "--devices", "--directories", "--label", "--max-count", "--include", "--exclude", "--exclude-dir", "--group-separator"]);
const SHORT_VALUE_OPTIONS = new Set(["A", "B", "C", "D", "d", "m", "e", "f"]);
const FLAG_OPTIONS = new Set(["--basic-regexp", "--extended-regexp", "--fixed-strings", "--perl-regexp", "--ignore-case", "--no-ignore-case", "--word-regexp", "--line-regexp", "--no-messages", "--invert-match", "--version", "--help", "--byte-offset", "--line-number", "--with-filename", "--no-filename", "--only-matching", "--quiet", "--silent", "--text", "--binary", "--initial-tab", "--unix-byte-offsets", "--null", "--null-data", "--count", "--files-with-matches", "--files-without-match", "--line-buffered", "--recursive", "--dereference-recursive", "--no-group-separator"]);

/** 区分 grep 的匹配表达式、选项值和实际读取的文件。动态参数保留原命令供保守匹配。 */
export function grepFileInputs(args: readonly (string | undefined)[]): string[] | undefined {
	const files: string[] = [], positional: string[] = [];
	let hasPattern = false, optionsEnded = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === undefined) return undefined;
		if (argument === "--" && !optionsEnded) { optionsEnded = true; continue; }
		if (optionsEnded || !argument.startsWith("-") || argument === "-") { positional.push(argument); continue; }
		if (argument.startsWith("--")) {
			const separator = argument.indexOf("=");
			const option = separator < 0 ? argument : argument.slice(0, separator);
			if (option === "--regexp" || option === "--file" || option === "--exclude-from" || VALUE_OPTIONS.has(option)) {
				const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
				if (value === undefined) return undefined;
				if (option === "--regexp" || option === "--file") hasPattern = true;
				if (option === "--file" || option === "--exclude-from") files.push(value);
			} else if (option !== "--color" && option !== "--colour" && !FLAG_OPTIONS.has(option)) return undefined;
			continue;
		}
		for (let offset = 1; offset < argument.length; offset++) {
			const option = argument.charAt(offset);
			if (!SHORT_VALUE_OPTIONS.has(option)) {
				if (!"EFGPivwxVhHonsbqazZcLlRrIUuy0123456789".includes(option)) return undefined;
				continue;
			}
			const value = offset + 1 < argument.length ? argument.slice(offset + 1) : args[++index];
			if (value === undefined) return undefined;
			if (option === "e" || option === "f") hasPattern = true;
			if (option === "f") files.push(value);
			break;
		}
	}
	return [...files, ...positional.slice(hasPattern ? 0 : 1)];
}
