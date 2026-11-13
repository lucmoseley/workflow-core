// @vitest-environment node
/*
 * The pre-commit roadmap-validity gate (mantahostels#698), a pre-commit
 * dispatcher row (#5172).
 *
 * The row runs `check-roadmap-valid.js` only when the commit stages
 * `docs/reference-roadmap.html`, after the roadmap-pair row, so the cheaper
 * and more common half-staged-pair failure reports first. What the dispatcher
 * does with its exit is scripts/precommit-dispatch.test.ts's.
 *
 * The hook is the PRIMARY gate, and not the only one (mantahostels#974): the
 * scheduled `Document guards` job runs the same checker in `--tree` mode, which
 * judges the roadmap as it stands rather than a commit against its parent.
 *
 * What stays UNVERIFIED: that the scheduled job actually FIRES. Testing that
 * means running a workflow (`scripts/precommit-ci-gates.test.ts` carves out the
 * same ground).
 *
 * It is a hard gate: loosen a case and a structurally invalid roadmap — the
 * sole authority on card status — lands, unseen until the scheduled job next
 * runs.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch, existsUnder, readStaged } from "./lib/precommit-dispatch.js";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";

const CHECKER = "scripts/check-roadmap-valid.js";
const PAIR = "scripts/check-roadmap-pair.js";
const ROADMAP = "docs/reference-roadmap.html";

const temps = registerTempCleanup();

const row = GATES.find((g) => g.script === CHECKER);
if (!row || !("pattern" in row.arm))
	throw new Error(`no pattern row for ${CHECKER} in lib/precommit-gates.js`);
const ROW = row;
const PATTERN = row.arm.pattern;

/**
 * How the row's arm differs from the path `check-roadmap-valid.js` itself
 * judges, or `null` where they agree. The two are separate spellings of one
 * path: renaming the roadmap in the checker alone would leave a gate that
 * silently never fires.
 */
function parityGap(pattern: RegExp): string | null {
	const checker = fs.readFileSync(path.join(ROOT, CHECKER), "utf8");
	const decl = /const HTML = "([^"]+)"/.exec(checker);
	if (!decl) return `HTML no longer parses out of ${CHECKER}`;
	const judged = decl[1];
	const look = `vendor/${judged}`;
	return pattern.test(judged) && !pattern.test(look)
		? null
		: `the row matches ${pattern}, the checker judges '${judged}'`;
}

/** Whether the dispatcher runs the row on what is staged in `root`. */
async function arms(root: string): Promise<boolean> {
	let ran = false;
	await dispatch({
		rows: [ROW],
		gates: "all",
		ports: {
			staged: () => readStaged(root),
			computed: () => [],
			exists: existsUnder(root),
			load: () => () => {
				ran = true;
				return { exit: 0, stdout: "", stderr: "" };
			},
			write: () => undefined,
			interrupted: async () => null,
		},
	});
	return ran;
}

const repo = (staged: Record<string, string>, committed = {}) =>
	stagedRepo("roadmap-valid-gate-", temps, committed, staged);

describe("the pre-commit roadmap-validity row", () => {
	it("is a gating checker row the batch set skips", () => {
		expect(ROW).toMatchObject({
			policy: "gate",
			kind: "checker",
			lander: "none",
		});
	});

	it("runs after the roadmap-pair row", () => {
		const at = (script: string) => GATES.findIndex((g) => g.script === script);
		expect(at(PAIR)).toBeGreaterThan(-1);
		expect(at(CHECKER)).toBeGreaterThan(at(PAIR));
	});

	it("arms on exactly the path the checker judges", () => {
		expect(parityGap(PATTERN)).toBeNull();
	});

	it("reports a gap when the arm and the checker disagree", () => {
		expect(parityGap(/^docs\/roadmap\.html$/)).toMatch(/the row matches/);
		expect(parityGap(/docs\/reference-roadmap\.html$/)).toMatch(
			/the row matches/,
		);
	});

	it("arms on a commit staging the roadmap", async () => {
		expect(await arms(repo({ [ROADMAP]: "<html></html>\n" }).root)).toBe(true);
	});

	it("does not arm on a commit that leaves the roadmap alone", async () => {
		expect(await arms(repo({ "docs/other.md": "x\n" }).root)).toBe(false);
	});

	it("does not arm on a path that only resembles the roadmap", async () => {
		const { root } = repo({
			"vendor/docs/reference-roadmap.html": "x\n",
			"docs/reference-roadmap.html.bak": "x\n",
		});
		expect(await arms(root)).toBe(false);
	});

	it("arms on a deletion of the roadmap", async () => {
		const { root, git } = repo({}, { [ROADMAP]: "<html></html>\n" });
		git("rm", "-q", "--", ROADMAP);
		expect(await arms(root)).toBe(true);
	});
});
