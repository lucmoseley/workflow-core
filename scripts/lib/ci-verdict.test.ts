// @vitest-environment node
/*
 * lib/ci-verdict.js's newestVerdictRuns on canned `gh run list` output — the
 * set the delivery script's CI re-check keys on.
 *
 * Loosen it and a run that never judged `main`'s tree — a named rerun of a
 * queue tree stamped with `main`'s sha, or a queue alarm — re-checks `main` as
 * red (#4676).
 */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { NOT_A_TREE_VERDICT, newestVerdictRuns } from "./ci-verdict.js";

const ROOT = path.join(__dirname, "..", "..");

const run = (workflowName: string, headSha: string, conclusion: string) => ({
	workflowName,
	headSha,
	conclusion,
});

it.each(["Named rerun", "Landing quiet 14h", "Queue ref waiting 2h"])(
	"skips a newer red %s and keys on the CI run behind it (#4676)",
	(name) => {
		const ci = run("CI", "aaa", "success");
		expect(newestVerdictRuns([run(name, "bbb", "failure"), ci])).toEqual([ci]);
	},
);

it("keys on a newer red run of a workflow that judges the tree", () => {
	const red = run("CI", "bbb", "failure");
	expect(newestVerdictRuns([red, run("CI", "aaa", "success")])).toEqual([red]);
});

it.each([
	".github/workflows/named-rerun.yml",
	".github/workflows/landing-quiet.yml",
	".github/workflows/main-lag.yml",
])("denylists %s by the name GitHub reports for it", (file) => {
	const name = fs
		.readFileSync(path.join(ROOT, file), "utf8")
		.match(/^name: (.+)$/m)?.[1];
	expect(NOT_A_TREE_VERDICT.has(name ?? "")).toBe(true);
});
