// @vitest-environment node
/*
 * Every scripts/check-*.js is run by something that is not a human typing it,
 * and has a sibling test; every `check:*` npm script names a file that exists.
 *
 * The sibling of hook-registrations.test.ts, which does this for the guard set
 * (mantahostels#1266). Ruled at mantahostels#1541: a checker losing its caller would have been silent,
 * exactly the class mantahostels#112 and mantahostels#117 paid for on the guard side.
 *
 * WHY AN npm NAME IS NOT A CALLER. `package.json` makes a checker invocable; it
 * does not make it run. A checker whose only route in is `npm run check:x` fires
 * when someone remembers it, which is the state this test exists to detect. So
 * the caller surfaces below are the four that run without being asked — the
 * husky hooks, the workflows, self-plugin/hooks/hooks.json, and another script
 * — and a deliberate hand-only checker goes in CALLED_ELSEWHERE with its reason.
 *
 * WHY COMMENT LINES ARE STRIPPED. This repo's hooks and workflows name their
 * local backstops in prose constantly — `.husky/pre-commit` mentions `check:sh`,
 * roadmap-digest.yml's steps name their `npm run` equivalents — so a bare
 * substring search over these files passes on the mention rather than the call.
 * The strip is deliberately crude: it drops whole-line comments only, so an
 * invocation trailing a comment on the same line still counts.
 *
 * Loosen a case and a checker renamed out of its hook or workflow goes on
 * reporting nothing, with no red anywhere — the suite in `.github/workflows/ci.yml`
 * is the only place that would say so.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPTS = __dirname;
const ROOT = path.join(SCRIPTS, "..");

/**
 * Checkers with no automatic caller, on purpose. Commented per entry, as
 * hook-registrations.test.ts requires of its own allowlist: an uncommented key
 * is a checker someone silently gave up on.
 */
const CALLED_ELSEWHERE: Record<string, string> = {};

/** Whole-line comments only — see the header. */
function stripComments(text: string): string {
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

/**
 * The four surfaces that run a checker without being asked. Keyed by the label
 * a failure prints, so the reader is told where a caller was expected.
 */
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

/* Another script counts. A *.test.ts does NOT — a checker whose only caller is
 * its own test is precisely the unwired case. One loop per directory, so each
 * listing selects this file when a script in it changes (base §X10). */
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

/** Every caller surface but the checker itself, comments stripped. */
function callersOf(checker: string): string[] {
	const self = path.join("scripts", checker);
	return Object.entries(CALLER_SOURCES)
		.filter(([label]) => label !== self)
		.filter(([, text]) => stripComments(text).includes(checker))
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

	it("every scripts/check-*.js has a sibling scripts/check-<name>.test.ts", () => {
		const untested = CHECKER_FILES.filter(
			(file) =>
				!fs.existsSync(path.join(SCRIPTS, file.replace(/\.js$/, ".test.ts"))),
		);

		expect(untested).toEqual([]);
	});

	/*
	 * The one convention for judging the commit rather than the working tree
	 * (mantahostels#1801, mantahostels#1833). A checker carrying a lib/fault-profiles.js profile is one
	 * whose faults get attributed to a commit, and `--against <rev>` in
	 * scripts/lib/check.js is where that is done.
	 */
	it("every checker with a fault-diff profile takes --against", () => {
		const shellDirectionGated: Record<string, string> = {
			// Spelled out in .husky/pre-commit for its --map-dirty flag, temp index
			// and untracked-entry replay (mantahostels#1793).
			"doc-map": "gated in .husky/pre-commit via gate_direction (#1793, #1801)",
		};
		/* Comments stripped, per this file's header: a checker MENTIONING
		 * either token in prose has not declared anything. */
		const hasAgainstFlag = (file: string, profile: string) => {
			const source = stripComments(
				fs.readFileSync(path.join(SCRIPTS, file), "utf8"),
			);
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

	/* The inverse direction: package.json is where a checker is renamed out from
	 * under its npm name, and `npm run check:x` then dies on a missing file with
	 * nothing having reported it. */
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
