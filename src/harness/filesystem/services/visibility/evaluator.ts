import type { VisibilityPolicy } from "../../contracts/visibility.ts";
import { CompiledPathRuleMatcher } from "../../kernel/access-policy.ts";
import {
	pathDepth,
	SOURCE_PRIORITY,
	type CompiledVisibilityRuleSet,
	type MatchedIgnoreRule,
	type VisibilityDecision,
	type VisibilityEvaluateInput,
	type VisibilitySourceMatch,
	type VisibilitySourceType,
} from "./model.ts";

interface CompiledVisibilitySource {
	readonly sourceType: VisibilitySourceType;
	readonly ruleSets: readonly CompiledVisibilityRuleSet[];
}

/** 只评估已加载的可见性规则，不发现或读取规则文件。 */
export class VisibilityEvaluator {
	private readonly ruleSets: CompiledVisibilityRuleSet[] = [];
	private sources: readonly CompiledVisibilitySource[] = [];
	private negatedRuleSets: readonly CompiledVisibilityRuleSet[] = [];
	private readonly trackedLookup: ReadonlySet<string>;
	private readonly trackedDirectories = new Set<string>();
	private readonly trackedBypassEnabled: boolean;
	private readonly configuredRules: CompiledPathRuleMatcher;

	constructor(
		ruleSets: readonly CompiledVisibilityRuleSet[],
		trackedPaths: ReadonlySet<string>,
		policy: VisibilityPolicy,
		private readonly caseInsensitive: boolean,
	) {
		this.addRules(ruleSets);
		this.trackedLookup = caseInsensitive
			? new Set(Array.from(trackedPaths, (trackedPath) => trackedPath.toLowerCase()))
			: trackedPaths;
		this.trackedBypassEnabled = policy.ignore.gitignore.trackedFilesBypass;
		if (this.trackedBypassEnabled) for (const tracked of this.trackedLookup) {
			for (let end = tracked.lastIndexOf("/"); end > 0; end = tracked.lastIndexOf("/", end - 1)) {
				const directory = tracked.slice(0, end);
				if (this.trackedDirectories.has(directory)) break;
				this.trackedDirectories.add(directory);
			}
		}
		this.configuredRules = new CompiledPathRuleMatcher(policy.ignoredPaths);
	}

	addRules(rules: readonly CompiledVisibilityRuleSet[]): void {
		this.ruleSets.push(...rules);
		this.ruleSets.sort((left, right) => left.priority - right.priority
			|| pathDepth(left.baseDirectory) - pathDepth(right.baseDirectory)
			|| (left.sourcePath ?? "").localeCompare(right.sourcePath ?? ""));
		this.sources = groupRuleSetsBySource(this.ruleSets);
		this.negatedRuleSets = this.ruleSets.filter((ruleSet) => ruleSet.hasNegatedRule);
	}

	evaluate(input: VisibilityEvaluateInput): VisibilityDecision {
		const workspacePath = input.workspacePath;
		const normalized = normalizeIgnorePath(workspacePath ?? input.displayPath);
		const tracked = workspacePath !== undefined && this.trackedBypassEnabled && this.isTracked(normalized);
		let winner: VisibilitySourceMatch | undefined;
		if (workspacePath !== undefined) {
			for (const source of this.sources) {
				const sourceMatch = this.matchSource(source, normalized, input.kind);
				if (sourceMatch === undefined || this.isBypassedTrackedIgnore(source.sourceType, sourceMatch, tracked)) continue;
				winner = sourceMatch;
			}
		}
		const configuredRule = this.matchConfiguredRule(input);
		if (configuredRule !== undefined) winner = { state: "ignore", rule: configuredRule };
		const ignored = winner?.state === "ignore";
		const prune = ignored && input.intent === "search" && input.kind === "directory" && winner !== undefined
			&& (configuredRule !== undefined || !this.mayIncludeDescendant(normalized, winner.rule.sourceType));
		return {
			ignored,
			prune,
			...(winner === undefined ? {} : { matchedRule: winner.rule }),
		};
	}

	private matchSource(
		source: CompiledVisibilitySource,
		pathname: string,
		kind: VisibilityEvaluateInput["kind"],
	): VisibilitySourceMatch | undefined {
		let winner: VisibilitySourceMatch | undefined;
		for (const ruleSet of source.ruleSets) {
			if (!pathIsInsideBase(pathname, ruleSet.baseDirectory)) continue;
			const relative = toBaseRelative(pathname, ruleSet.baseDirectory);
			if (relative === "" || relative === ".") continue;
			const testPath = kind === "directory" ? `${relative}/` : relative;
			const ruleSetMatch = ruleSet.matcher.test(testPath);
			if (!ruleSetMatch.ignored && !ruleSetMatch.unignored) continue;
			const parentExcluded = winner?.state === "ignore" && ruleMatchesDirectoryAncestor(winner.rule, relative, kind);
			if (ruleSetMatch.unignored && parentExcluded) continue;
			// 整组 matcher 负责父目录排除与重新包含；逐条匹配只用于定位最终规则。
			for (const compiledRule of ruleSet.rules) {
				if (compiledRule.rule.negated !== ruleSetMatch.unignored || !compiledRule.matcher.ignores(testPath)) continue;
				winner = { state: ruleSetMatch.ignored ? "ignore" : "include", rule: compiledRule.rule };
			}
		}
		return winner;
	}

	private isBypassedTrackedIgnore(sourceType: VisibilitySourceType, match: VisibilitySourceMatch, tracked: boolean): boolean {
		return sourceType === "gitignore" && tracked && match.state === "ignore";
	}

	private mayIncludeDescendant(pathname: string, ignoredBy: VisibilitySourceType): boolean {
		if (ignoredBy === "gitignore" && this.trackedDirectories.has(this.caseInsensitive ? pathname.toLowerCase() : pathname)) return true;
		// 同来源的反向规则不能救回已排除父目录的后代；仅保留更高优先级来源的例外。
		return this.negatedRuleSets.some(ruleSet => SOURCE_PRIORITY[ruleSet.sourceType] > SOURCE_PRIORITY[ignoredBy]
			&& (pathIsInsideBase(pathname, ruleSet.baseDirectory) || pathIsInsideBase(ruleSet.baseDirectory, pathname))
			&& ruleSet.rules.some(compiled => compiled.rule.negated
				&& mayMatchDescendant(compiled.rule.pattern, ruleSet.baseDirectory, pathname, this.caseInsensitive)));
	}

	private isTracked(pathname: string): boolean {
		return this.trackedLookup.has(this.caseInsensitive ? pathname.toLowerCase() : pathname);
	}

	private matchConfiguredRule(input: VisibilityEvaluateInput): MatchedIgnoreRule | undefined {
		const pattern = this.configuredRules.match(input);
		if (pattern === undefined) return undefined;
		return {
			sourceType: "config",
			sourcePath: "file-tools.jsonc",
			pattern,
			negated: false,
		};
	}
}

/** 只用确定的目录前缀排除无关例外；通配符或转义边界之后保守保留。 */
function mayMatchDescendant(pattern: string, base: string, directory: string, caseInsensitive: boolean): boolean {
	const raw = pattern.slice(1).replace(/\/$/u, "");
	if (!raw.includes("/")) return true;
	const segments = raw.replace(/^\//u, "").split("/");
	const prefix: string[] = [];
	for (const segment of segments) {
		if (/[?*[\]\\]/u.test(segment)) break;
		prefix.push(segment);
	}
	if (prefix.length === 0) return true;
	let target = [base === "." ? "" : base, ...prefix].filter(Boolean).join("/");
	if (caseInsensitive) { target = target.toLowerCase(); directory = directory.toLowerCase(); }
	return pathIsInsideBase(target, directory) || pathIsInsideBase(directory, target);
}

function groupRuleSetsBySource(ruleSets: readonly CompiledVisibilityRuleSet[]): CompiledVisibilitySource[] {
	const grouped = new Map<VisibilitySourceType, CompiledVisibilityRuleSet[]>();
	for (const ruleSet of ruleSets) {
		const existing = grouped.get(ruleSet.sourceType);
		if (existing === undefined) grouped.set(ruleSet.sourceType, [ruleSet]);
		else existing.push(ruleSet);
	}
	return Array.from(grouped, ([sourceType, sourceRuleSets]) => ({ sourceType, ruleSets: sourceRuleSets }));
}

function pathIsInsideBase(pathname: string, baseDirectory: string): boolean {
	return baseDirectory === "." || pathname === baseDirectory || pathname.startsWith(`${baseDirectory}/`);
}

function toBaseRelative(pathname: string, baseDirectory: string): string {
	return baseDirectory === "." ? pathname : pathname.slice(baseDirectory.length + 1);
}

function normalizeIgnorePath(pathname: string): string {
	return pathname.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "") || ".";
}

function ruleMatchesDirectoryAncestor(
	rule: MatchedIgnoreRule,
	relative: string,
	kind: VisibilityEvaluateInput["kind"],
): boolean {
	if (!rule.pattern.trimEnd().endsWith("/")) return false;
	if (kind !== "directory") return true;
	return relative.includes("/");
}
