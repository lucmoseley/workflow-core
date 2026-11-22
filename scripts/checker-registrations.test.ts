// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spellSiblingTestsIfUntested } from "./lib/registrations.js";

const SCRIPTS = __dirname;
const ROOT = path.join(SCRIPTS, "..");

const CALLED_ELSEWHERE: Record<string, string> = {};

function stripWholeLineComments(text: string): string {
	return text
		.split("\n")
		.filter((line) => {
			const t = line.trim();
			return !(
				t.startsWith("#") ||
				t.startsWith("//") ||
				t.startsWith("*") ||
				t.startsWith("/*")
			);
		})
		.join("\n");
}

const CHECKER_FILES = fs
	.readdirSync(SCRIPTS)
	.filter((f) => /^check-.+\.js$/.test(f))
	.sort();

const CALLER_SOURCES: Record<string, string> = {};

for (const hook of [
	".husky/pre-commit",
	".husky/prepare-commit-msg",
	".husky/commit-msg",
	".husky/pre-merge-commit",
	".husky/post-commit",
	".husky/pre-push",
]) {
	const hookPath = path.join(ROOT, hook);
	CALLER_SOURCES[hook] = fs.existsSync(hookPath)
		? fs.readFileSync(hookPath, "utf8")
		: "";
}

const workflowDir = path.join(ROOT, ".github", "workflows");
for (const file of fs.readdirSync(workflowDir)) {
	if (!/\.ya?ml$/.test(file)) continue;
	CALLER_SOURCES[`.github/workflows/${file}`] = fs.readFileSync(
		path.join(workflowDir, file),
		"utf8",
	);
}

CALLER_SOURCES["self-plugin/hooks/hooks.json"] = fs.readFileSync(
	path.join(ROOT, "self-plugin", "hooks", "hooks.json"),
	"utf8",
);

for (const file of fs.readdirSync(SCRIPTS)) {
	if (!/\.(js|sh)$/.test(file)) continue;
	CALLER_SOURCES[`scripts/${file}`] = fs.readFileSync(
		path.join(SCRIPTS, file),
		"utf8",
	);
}
const LIB = path.join(SCRIPTS, "lib");
for (const file of fs.readdirSync(LIB)) {
	if (!/\.(js|sh)$/.test(file)) continue;
	CALLER_SOURCES[`scripts/lib/${file}`] = fs.readFileSync(
		path.join(LIB, file),
		"utf8",
	);
}

function callersOf(checker: string): string[] {
	const self = path.join("scripts", checker);
	return Object.entries(CALLER_SOURCES)
		.filter(([label]) => label !== self)
		.filter(([, text]) => stripWholeLineComments(text).includes(checker))
		.map(([label]) => label);
}

describe("checker registrations", () => {
	it("scripts/check-*.js actually exist to enumerate", () => {
		expect(CHECKER_FILES.length).toBeGreaterThan(0);
	});

	it("every CALLED_ELSEWHERE entry is commented, not just keyed", () => {
		const uncommented = Object.entries(CALLED_ELSEWHERE)
			.filter(([, reason]) => reason.trim() === "")
			.map(([file]) => file);

		expect(uncommented).toEqual([]);
	});

	it("every CALLED_ELSEWHERE entry names a checker that still exists", () => {
		const gone = Object.keys(CALLED_ELSEWHERE).filter(
			(file) => !CHECKER_FILES.includes(file),
		);

		expect(gone).toEqual([]);
	});

	it("every scripts/check-*.js is run by a hook, a workflow or another script", () => {
		const unwired = CHECKER_FILES.filter(
			(file) => callersOf(file).length === 0 && !(file in CALLED_ELSEWHERE),
		);

		expect(unwired).toEqual([]);
	});

	it("every scripts/check-*.js has a sibling test", () => {
		const untested = CHECKER_FILES.filter(
			(file) =>
				spellSiblingTestsIfUntested(file, (p) =>
					fs.existsSync(path.join(ROOT, p)),
				) !== null,
		);

		expect(untested).toEqual([]);
	});

	it("every checker with a fault-diff profile takes --against", () => {
		const shellDirectionGated: Record<string, string> = {
			"doc-map": "gated by scripts/lib/doc-map-gate.js (#1793, #5155)",
		};
		const heresyScan = stripWholeLineComments(
			fs.readFileSync(path.join(SCRIPTS, "lib/heresy-scan.js"), "utf8"),
		);
		const heresyScanTakesAgainst =
			heresyScan.includes("profile: checkName") &&
			heresyScan.includes("[--against <rev>]");
		const hasAgainstFlag = (file: string, profile: string) => {
			const source = stripWholeLineComments(
				fs.readFileSync(path.join(SCRIPTS, file), "utf8"),
			);
			if (source.includes("heresySpec("))
				return heresyScanTakesAgainst && source.includes(`name: "${profile}"`);
			return (
				source.includes(`profile: "${profile}"`) &&
				source.includes("[--against <rev>]")
			);
		};
		const { PROFILES } = require("./lib/fault-profiles.js") as {
			PROFILES: Record<string, unknown>;
		};

		const missing = Object.keys(PROFILES)
			.filter((profile) => !(profile in shellDirectionGated))
			.filter(
				(profile) =>
					!CHECKER_FILES.some(
						(file) =>
							file === `check-${profile}.js` && hasAgainstFlag(file, profile),
					),
			);

		expect(missing).toEqual([]);
	});

	it("every check:* npm script naming a scripts/ file names one that exists", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };

		const missing = Object.entries(pkg.scripts)
			.filter(([name]) => name === "check" || name.startsWith("check:"))
			.flatMap(([name, command]) =>
				[...command.matchAll(/scripts\/[\w./-]+\.js/g)]
					.map((m) => m[0])
					.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
					.map((rel) => `${name} -> ${rel}`),
			);

		expect(missing).toEqual([]);
	});
});
