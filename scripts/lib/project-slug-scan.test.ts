// @vitest-environment node
/*
 * The source half of `project-slug.test.ts`'s guarantee: no file under
 * scripts/ spells the project slug a way other than the one function. It sits
 * apart so that file's unit cases do not read the scripts tree (#1900).
 *
 * Settled at mantahostels#2008, mantahostels#2020 and mantahostels#2052. A loosened case lets a
 * restated or hard-coded slug back in, and the site that holds it looks in a
 * directory the harness never wrote.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* `reap-finished-sessions.js` `transcriptPath` and the two `measure-*` scripts'
 * DEFAULT_DIR are CLI internals with no export, and mantahostels#1994 is open against
 * exporting a thing for its test alone. So they are scanned in source instead.
 *
 * IT IS A REGRESSION FENCE AGAINST THE EXACT BAD SPELLINGS SHIPPED BEFORE, and
 * nothing more. It matches literal substrings, so `replaceAll("/", "-")`,
 * `split("/").join("-")`, a class spelled `[^\w]`, a bash restatement spelled
 * some way other than parameter expansion (`sed`, `tr`), and any of the known
 * ones that Biome or shfmt happens to wrap across lines all pass it green
 * with the site wrong. A NEW hard-coded slug is caught in `.sh` and `.py`
 * only where it sits mid-path, a `/` on both sides (mantahostels#2634) — a bare
 * variable, `Path.home() / "…"`, or `os.path.join(...)` passes it unseen,
 * and nothing catches one outside `.sh`/`.py` at all. pyBareLiteralExempt's
 * 17 sites were fixed by mantahostels#2148 and the list is left empty, not removed, so
 * an eighteenth mid-path site is still caught.
 */
describe("no file under scripts/ regresses to a known-bad spelling", () => {
	// Every full character-class spelling this repo has ever used for the slug,
	// plus the slashes-only one that was mantahostels#1963's and mantahostels#1982's bug.
	const restatements = [
		'.replace(/[^a-zA-Z0-9]/g, "-")',
		'.replace(/[^A-Za-z0-9]/g, "-")',
		'.replace(/\\//g, "-")',
	];
	// The bash parameter-expansion spelling of the same class, needled without
	// the variable name so any caller's own name still matches, in both case
	// orderings restatements above covers on the JS side (mantahostels#2020).
	// `scripts/lib/guard-log.sh` restates the first deliberately, on its
	// fail-open path, where forking to `node -e` (`snapshot-memory.sh`'s
	// route) is the failure mode this file exists to survive.
	const shRestatements = ["//[^a-zA-Z0-9]/-}", "//[^A-Za-z0-9]/-}"];
	// Quoted, so that prose naming the directory — `scripts/lib/turn-collapse.js`'s
	// docstring on the `.claude2` symlink — is not read as a path being built.
	const literal = '"-home-lucmo-mantahostels"';
	// Bare, for `.sh`: the shipped mantahostels#2008 bug was the slug interpolated mid-path
	// (`$HOME/.claude/projects/-home-lucmo-mantahostels/memory`), never wrapped
	// on its own in quotes, so the quoted literal above cannot see it.
	const bareLiteral = "-home-lucmo-mantahostels";
	// project_slug.py's own regex, needled without the parameter name so a
	// rename or reflow of that line doesn't red this — the `.py` scan's
	// positive control, the same role restatements[0] plays below, minus the
	// restatement fence restatementExempt gives that one (no `.py` site is
	// known to restate this class) (mantahostels#2246).
	const pyRestatement = 're.sub(r"[^a-zA-Z0-9]", "-", ';

	// proving-run.ts restates the same regex class directly — that same
	// exemption, extended to the one other deliberate site.
	const restatementExempt = new Set(["project-slug.js", "proving-run.ts"]);

	// Every measure script derives the slug via scripts/lib/project_slug.py
	// instead of hard-coding it (mantahostels#2148). The list stays, empty, so a
	// site regressing to the literal is still caught by the case below.
	const pyBareLiteralExempt: string[] = [];

	/* TRACKED files only, via git: this suite runs in a shared working tree where
	 * a neighbour's half-written scratch `.js` would otherwise fail it (mantahostels#291).
	 *
	 * `.sh` joins `.js` here (mantahostels#2020): a shell script cannot `require()`
	 * project-slug.js, so the default shape there is to shell out to it via
	 * `node -e` rather than restate the rule (mantahostels#2008, scripts/snapshot-memory.sh)
	 * — `guard-log.sh` is the one exception, see shRestatements above.
	 *
	 * `.ts`, `.husky/*` and `.py` join in mantahostels#2052: `proving-run.ts` restates the
	 * regex class directly (excluded below, same as `project-slug.js`);
	 * `.husky/*` hooks are tracked shell scripts the `.sh` glob never reaches,
	 * having no extension; and `scripts/**\/*.py` hard-codes the bare literal
	 * outright (pyBareLiteralExempt above). `*.test.ts` is excluded from
	 * the `.ts` glob: this very file, and two neighbours, hold every needle
	 * below as a quoted test fixture, not a restatement. */
	const readSources = () =>
		execFileSync(
			"git",
			[
				"ls-files",
				"-z",
				"--",
				"scripts/*.js",
				"scripts/*.sh",
				"scripts/*.ts",
				":!scripts/*.test.ts",
				".husky/*",
				"scripts/*.py",
			],
			{
				cwd: path.join(__dirname, "..", ".."),
				encoding: "utf8",
			},
		)
			.split("\0")
			.filter(Boolean)
			.map((f) => path.join(__dirname, "..", "..", f));

	const holding = (needle: string) =>
		readSources().filter((f) => fs.readFileSync(f, "utf8").includes(needle));

	// bareLiteral has no quote wrapper to read as "this is prose, not a path
	// being built" — literal's own carve-out (see its comment above). So this
	// scan asks the narrower question the mantahostels#2008 bug actually shaped: the slug
	// INTERPOLATED MID-PATH, a `/` on BOTH sides (`…/projects/-home-lucmo-mantahostels/memory`).
	// One side alone is not enough: the repo's prose habit for naming the slug
	// (`` `projects/-home-lucmo-mantahostels` ``) puts a `/` immediately before
	// it too, with nothing after but a backtick — an either-side test misreads
	// that mention as the bug it describes.
	const isPathSegment = (text: string, needle: string) => {
		let i = text.indexOf(needle);
		while (i !== -1) {
			if (text[i - 1] === "/" && text[i + needle.length] === "/") return true;
			i = text.indexOf(needle, i + 1);
		}
		return false;
	};
	const holdingAsPath = (needle: string) =>
		readSources().filter((f) =>
			isPathSegment(fs.readFileSync(f, "utf8"), needle),
		);

	/* THE POSITIVE LIMB. Without it every case below passes on an empty scan. */
	it("scans a corpus that is actually there", () => {
		// Above the `.js`+`.sh`-only count: a regression of a wide glob (`.py`)
		// back out fails on count alone; a narrow one (`.ts`, `.husky`) relies
		// on the named assertions below instead.
		expect(readSources().length).toBeGreaterThan(250);
		expect(readSources()).toContain(path.join(__dirname, "project-slug.js"));
		expect(readSources()).toContain(
			path.join(__dirname, "..", "snapshot-memory.sh"),
		);
		expect(readSources()).toContain(
			path.join(__dirname, "..", "proving-run.ts"),
		);
		expect(readSources()).toContain(
			path.join(__dirname, "..", "..", ".husky", "pre-commit"),
		);
		expect(readSources()).toContain(
			path.join(__dirname, "..", "measure-burn", "scan_burn.py"),
		);
	});

	it("the needle can actually see the bug it is scanning for", () => {
		// The line mantahostels#2008 fixed, verbatim (git show 08e55a68^:scripts/snapshot-memory.sh)
		// — not read from git history, which a shallow CI checkout does not carry.
		const shippedBug =
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash syntax, not a JS template
			'src="${1:-$HOME/.claude/projects/-home-lucmo-mantahostels/memory}"';
		expect(shippedBug).toContain(bareLiteral);
		expect(shippedBug).not.toContain(literal);
		expect(isPathSegment(shippedBug, bareLiteral)).toBe(true);
		expect(
			isPathSegment(
				"holds `projects/-home-lucmo-mantahostels` as a symlink",
				bareLiteral,
			),
		).toBe(false);
	});

	it("no shell script hard-codes the founder's own slug", () => {
		// Neither shell site that touches the slug (snapshot-memory.sh via
		// node -e, guard-log.sh via its own restatement) holds the literal
		// itself — bare or quoted. `.husky/*` hooks join `.sh` here (mantahostels#2052):
		// they are the exact shape mantahostels#2008 shipped, a shell script interpolating
		// the slug mid-path, so this must not stay blind to one wearing no
		// extension. `holdingAsPath`, not `holding`: a doc comment naming the
		// slug in prose is not the bug this guards (mantahostels#2634).
		expect(
			holdingAsPath(bareLiteral).filter(
				(f) => f.endsWith(".sh") || f.includes(`${path.sep}.husky${path.sep}`),
			),
		).toEqual([]);
	});

	it("no python script hard-codes the founder's own slug, beyond the tracked exemptions", () => {
		// mantahostels#2148 fixed the 17 sites this once exempted, so this now guards
		// against any site at all, including a new eighteenth. `holdingAsPath`,
		// not `holding` — see the shell case above (mantahostels#2634).
		const exempt = new Set(pyBareLiteralExempt);
		expect(
			holdingAsPath(bareLiteral).filter(
				(f) => f.endsWith(".py") && !exempt.has(f),
			),
		).toEqual([]);
	});

	it("the tracked python exemptions are still tracked, and still hold the literal", () => {
		// Guards the exemption list itself against going stale if a future
		// entry is added without being dropped once its site is fixed.
		const tracked = new Set(readSources());
		expect(
			pyBareLiteralExempt.filter(
				(f) =>
					!tracked.has(f) || !fs.readFileSync(f, "utf8").includes(bareLiteral),
			),
		).toEqual([]);
	});

	it("reports a file that does hold the needle", () => {
		// project-slug.js is the one site allowed the class, so it doubles as the
		// scan's own positive control.
		expect(holding(restatements[0])).toEqual([
			path.join(__dirname, "project-slug.js"),
			path.join(__dirname, "..", "proving-run.ts"),
		]);
		expect(holding(shRestatements[0])).toEqual([
			path.join(__dirname, "guard-log.sh"),
		]);
		expect(holding(pyRestatement)).toEqual([
			path.join(__dirname, "project_slug.py"),
		]);
	});

	it.each(restatements)("no site restates %s", (needle) => {
		expect(
			holding(needle).filter((f) => !restatementExempt.has(path.basename(f))),
		).toEqual([]);
	});

	it.each(shRestatements)("no other shell site restates %s", (needle) => {
		expect(
			holding(needle).filter((f) => path.basename(f) !== "guard-log.sh"),
		).toEqual([]);
	});

	it("no site hard-codes the founder's own slug", () => {
		expect(holding(literal)).toEqual([]);
	});
});
