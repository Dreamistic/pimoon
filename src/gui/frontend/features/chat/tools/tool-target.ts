import { clean, record } from "@/ui/content/format.ts";

export function toolTarget(name: string, args: unknown): string {
	if (!record(args)) return "";
	if (name === "subagent" && Array.isArray(args.tasks)) return args.tasks.filter(record)
		.flatMap((task) => typeof task.agent === "string" ? [task.agent] : []).join(" + ");
	if (name === "process_run" && Array.isArray(args.argv)) return clean(args.argv.filter(arg => typeof arg === "string").join(" "));
	const target = name === "grep" || name === "find" || name === "websearch"
		? args.query : name === "webfetch" || name === "http" ? args.url : args.path ?? args.name;
	return typeof target === "string" ? clean(target) : "";
}
