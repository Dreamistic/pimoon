import { EventEmitter } from "node:events";

if (process.argv[2] === "--pimoon-discord-daemon") {
	process.argv.splice(2, 1);
	await import("../discord-presence/coordinator-daemon.ts");
} else {
	await import("./environment.ts");
	EventEmitter.defaultMaxListeners = 20;
	process.emitWarning = () => {};
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		process.exitCode = await (await import("./codeact-headless.ts")).runCodeActHeadless(process.argv.slice(2));
	} else {
	const { main, parseArgs } = await import("@earendil-works/pi-coding-agent");
	const args = process.argv.slice(2);
	const parsed = parseArgs(args);
	const extensionFactories = parsed.noExtensions ? [] : (await import("../extensions.ts")).createHarnessExtensions({ startup: parsed });
	await main(args, { extensionFactories });
	}
}
