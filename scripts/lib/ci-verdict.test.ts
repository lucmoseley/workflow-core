// @vitest-environment node
/*
 * lib/ci-verdict.js's newestVerdictRuns on canned `gh run list` output — the
 * set the delivery script's CI re-check keys on.
 *
 * Loosen it and a run that never judged `main`'s tree — a named rerun of a
 * queue tree stamped with `main`'s sha, or a queue alarm — re-checks `main` as
 * red (#4676).
 */
import { expect, it } from "vitest";
import { newestVerdictRuns } from "./ci-verdict.js";

const run = (workflowName: string, headSha: string, conclusion: string) => ({
	workflowName,
	headSha,
	conclusion,
});

it.each(["Named rerun", "Landing quiet 14h", "Queue ref waiting 2h"])(
	"skips a newer red %s and keys on the CI run behind it",
	(name) => {
		const ci = run("CI", "aaa", "success");
		expect(newestVerdictRuns([run(name, "bbb", "failure"), ci])).toEqual([ci]);
	},
);
