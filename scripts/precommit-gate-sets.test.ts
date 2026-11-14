// @vitest-environment node
/*
 * Pins the queue lander's two pre-commit gate sets (#4545): `--gates=merge`
 * runs only the merge set, `--gates=batch` every gate bar one the lander's
 * Actions run repeats or a lander merge renders, and no argument every gate.
 * The parse, the dispatcher line, the merge set's exit and two later gates —
 * swallowed-errors, which Actions repeats, and upstream-record, which it does
 * not — are cut from the real hook and run over stub scripts; the dispatcher's own lander sets are
 * scripts/precommit-dispatch.test.ts's. A last case maps every gate the batch
 * set skips to the step of a workflow a lander push runs that repeats it, and
 * every gate both sets skip to a generator each lander merge runs, read off
 * the real files.
 *
 * Loosen it and a lander batch can reach main with a check no hook and no
 * Actions job ran on it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cutGateFragment,
	registerTempCleanup,
	stagedRepo,
} from "./lib/precommit-gate-harness";
import { cutHookBlock, LIB } from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";
import { REGENERATED_FILES } from "./lib/regenerated-files.js";

const temps = registerTempCleanup();

const DISPATCH = "scripts/precommit-dispatch.js";
const CHECKERS = [
	DISPATCH,
	"scripts/check-vendored-skills.js --covered <dir>",
	"scripts/check-swallowed-errors.js",
];

const SCRIPT = [
	LIB,
	cutHookBlock("wfc_gates=all", "esac"),
	cutHookBlock(`node "\${WFC_PLUGIN_ROOT:-.}"/${DISPATCH}`, ""),
	cutHookBlock('if [ "$wfc_gates" = merge ]; then', "fi"),
	cutGateFragment("scripts/check-vendored-skills.js"),
	cutGateFragment("scripts/check-swallowed-errors.js"),
].join("\n\n");

/** The scripts the hook ran on `args`, each with its arguments, in order,
 * and its exit code. */
function run(...args: string[]): { code: number; ran: string[] } {
	const stub = (name: string) =>
		`require("node:fs").appendFileSync("ran.log", [${JSON.stringify(name)}, ...process.argv.slice(2).map((a) => (require("node:path").isAbsolute(a) ? "<dir>" : a))].join(" ") + "\\n");\n`;
	const { root } = stagedRepo(
		"gate-sets-",
		temps,
		Object.fromEntries(
			CHECKERS.map((c) => c.split(" ")[0] ?? c).map((c) => [c, stub(c)]),
		),
		{
			"skills-lock.json": "{}\n",
			"scripts/a.py": "x\n",
		},
	);
	const r = spawnSync("sh", ["-ec", SCRIPT, "pre-commit", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log = path.join(root, "ran.log");
	return {
		code: r.status ?? 1,
		ran: fs.existsSync(log)
			? fs.readFileSync(log, "utf8").trim().split("\n")
			: [],
	};
}

describe("the pre-commit gate sets", () => {
	it("runs every gate with no argument, as git calls it", () => {
		expect(run()).toEqual({ code: 0, ran: CHECKERS });
	});

	it("runs only the dispatcher's merge set on a lander merge (#4573)", () => {
		expect(run("--gates=merge")).toEqual({
			code: 0,
			ran: [`${DISPATCH} --gates=merge`],
		});
	});

	it("runs a gate Actions does not repeat on the batch, and skips one it does", () => {
		expect(run("--gates=batch")).toEqual({
			code: 0,
			ran: [
				`${DISPATCH} --gates=batch`,
				"scripts/check-vendored-skills.js --covered <dir>",
			],
		});
	});

	it("runs every gate on an argument it does not know", () => {
		expect(run("--gates=all")).toEqual({
			code: 0,
			ran: [`${DISPATCH} --gates=all`, ...CHECKERS.slice(1)],
		});
	});
});

/* Each gate the batch set skips, by the checker its block runs first, and
 * the text naming the step that repeats it in a workflow a lander push runs;
 * null where the merge set runs it on every member instead. */
const REPEATED_BY: Record<string, string | null> = {
	"scripts/check-guard-registry.js": null,
	"scripts/biome-staged.js": "biome ci .",
	"scripts/check-roadmap-valid.js": "check-roadmap-valid.js",
	"scripts/check-digest-version.js": "check-digest-version.js",
	"scripts/gen-roadmap-digest.js": "gen-roadmap-digest.js",
	"scripts/check-guard-test-isolation.js": "check-guard-test-isolation.js",
	"scripts/check-git-fixture-identity.js": "check-git-fixture-identity.js",
	"scripts/check-test-env-writes.js": "check-test-env-writes.js",
	"scripts/check-website-copy.js": "npm run check:copy",
	"scripts/check-skill-frontmatter.js": "check-skill-frontmatter.js",
	"scripts/check-workflow-permissions.js": "check-workflow-permissions.js",
	tsc: "npm run typecheck",
	eslint: "npm run check:eslint",
	shellcheck: "npm run check:sh",
	actionlint: "npm run check:actions",
	ruff: "npm run check:py",
	"scripts/check-swallowed-errors.js": "check-swallowed-errors.js",
	"scripts/lib/formatters.js": "npm run check:sh:format",
	"scripts/lib/test-gate.js": "npm run test --",
};

it("skips on the batch only gates a workflow on a lander push repeats, or the merge set runs, and on both sets only a manifest each lander merge renders (#4545, #4573)", () => {
	const hook = fs.readFileSync(".husky/pre-commit", "utf8");
	const workflows = [
		fs.readFileSync(".github/workflows/ci.yml", "utf8"),
		fs.readFileSync(".github/workflows/roadmap-digest.yml", "utf8"),
	].join("\n");
	const skipped = (guard: string) =>
		hook
			.split(new RegExp(`^(?=if ! ${guard} )`, "m"))
			.slice(1)
			.map((block) => {
				const body = block.slice(0, block.search(/^fi$/m));
				/* A gate whose command the host declares looks it up first. */
				const named = [
					...body.matchAll(
						/scripts\/[a-z0-9/_.-]+\.(?:js|py|sh)|\b(?:tsc|eslint|shellcheck|actionlint|ruff)\b/g,
					),
				].map((m) => m[0]);
				const Lookup = "scripts/lib/workflow-core-config.js";
				return named.find((n) => n !== Lookup) ?? named[0] ?? body;
			});
	const rendered = [...REGENERATED_FILES.values()].map((r) => r.generator);
	/* A dispatcher row the batch set skips: its lander is `merge` or `none`,
	 * a rendered manifest's generator aside. */
	const rows = GATES.filter(
		(g) =>
			(g.lander === "merge" || g.lander === "none") &&
			!rendered.includes(g.script),
	).map((g) => g.script);
	expect([...skipped("lander_batch"), ...rows].sort()).toEqual(
		Object.keys(REPEATED_BY).sort(),
	);
	for (const [gate, step] of Object.entries(REPEATED_BY))
		if (step !== null) expect(workflows, gate).toContain(step);
	/* Neither set runs a rendered manifest's generator. */
	const neither = GATES.filter((g) => rendered.includes(g.script));
	expect(neither.length).toBeGreaterThan(0);
	for (const g of neither) expect(g.lander, g.id).toBe("none");
});
