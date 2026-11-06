// @vitest-environment node
/*
 * lib/review-comment.js, a PreToolUse dispatcher core (#4492), denies a
 * `gh issue comment` posting a whole-spec review whose TICKETED line names no
 * exception, through the dispatcher's real seam.
 *
 * WHAT BREAKING IT COSTS: a miss lets a first pass ticket fix-here work and
 * retag its spec unseen, as #2570's did; a wrong deny blocks every review
 * comment a /triage session posts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore, toolCall } from "./guard-core-testkit";

let dir: string;

const check = (command: string) =>
	runCore("guard-review-comment", toolCall("Bash", { command }), {
		root: dir,
	});

const denyOf = (run: ReturnType<typeof check>) =>
	run.output?.permissionDecisionReason ?? "";

const review = (finding: string, through = true) =>
	`## Whole-spec review\n\n4. **Duplicated Code, ${finding}** Spelt out at 8 sites.\n5. **§N7, FIXED \`a3ffe7ad6\`.** Moved.\n${through ? "\n**Reviewed through:** 39ebdf38e279f005d505ab6780242507818865d9\n" : ""}`;

const bodyFile = (text: string) => {
	const file = path.join(dir, "body.md");
	fs.writeFileSync(file, text);
	return file;
};

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "review-comment-")),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a review comment ticketing a finding with no exception", () => {
	it("is denied from a body file, quoting the line and the three tags", () => {
		const reason = denyOf(
			check(
				`gh issue comment 2570 --body-file ${bodyFile(review("TICKETED #4491."))}`,
			),
		);
		expect(reason).toContain(
			"This posts a whole-spec review that tickets a finding naming no exception",
		);
		expect(reason).toContain(
			"4. **Duplicated Code, TICKETED #4491.** Spelt out at 8 sites.",
		);
		for (const tag of [
			"`claimed by <session name>`",
			"`needs its own design: <reason>`",
			"`exposed, not caused`",
		])
			expect(reason).toContain(tag);
	});

	it.each([
		"TICKETED on #4491.",
		"TICKETED in owner/repo#4491.",
		"**TICKETED** #4491.",
		"TICKETED (#4491).",
		"TICKETED — #4491.",
		"TICKETED → #4491.",
		"TICKETED https://github.com/o/r/issues/4491.",
		"was TICKETED #4491 this pass.",
	])("is denied where the line reads %s (#4492)", (finding) => {
		expect(
			denyOf(
				check(`gh issue comment 2570 --body-file ${bodyFile(review(finding))}`),
			),
		).toContain("naming no exception");
	});

	it("is denied from an inline --body", () => {
		const body =
			"4. **Duplicated Code, TICKETED #4491.**\n\n**Reviewed through:** 39ebdf38e279f005d505ab6780242507818865d9";
		expect(denyOf(check(`gh issue comment 2570 --body "${body}"`))).toContain(
			"4. **Duplicated Code, TICKETED #4491.**",
		);
	});
});

describe("calls it lets through", () => {
	it.each([
		"TICKETED #4491, claimed by brisk-otter.",
		"TICKETED #4491, needs its own design: the seat model is changing.",
		"TICKETED #4491, exposed, not caused.",
	])("passes a review whose TICKETED line reads %s", (finding) => {
		expect(
			check(`gh issue comment 2570 --body-file ${bodyFile(review(finding))}`)
				.output,
		).toBeNull();
	});

	it.each([
		[
			"an untagged TICKETED line in a comment with no Reviewed through line",
			review("TICKETED #4491.", false),
		],
		[
			"a Review findings record",
			"**Review findings:** base abc1234, reviewed def5678, landed 0123abc\n- TICKETED #4491 the filter\n",
		],
		...[
			"Nothing on this pass is TICKETED; every finding was FIXED.",
			"Each finding is FIXED, TICKETED or DECLINED.",
			"**Outstanding:** none — nothing TICKETED",
			"- F2 was previously TICKETED #4100 and is now FIXED abc1234.",
		].map((line) => [
			`prose that tickets nothing (#4492): ${line}`,
			`${line}\n\n**Reviewed through:** 39ebdf38e279f005d505ab6780242507818865d9\n`,
		]),
		[
			"a TICKETED line inside a fence",
			"```\n4. TICKETED #4491.\n```\n\n**Reviewed through:** 39ebdf38e279f005d505ab6780242507818865d9\n",
		],
	])("passes %s", (_, body) => {
		expect(
			check(`gh issue comment 2570 --body-file ${bodyFile(body)}`).output,
		).toBeNull();
	});

	it("passes any gh call but a comment", () => {
		expect(check("gh issue view 2570").output).toBeNull();
	});

	it("passes a missing body file unjudged and logs that it could not read it", () => {
		const run = check(
			`gh issue comment 2570 --body-file ${path.join(dir, "gone.md")}`,
		);
		expect(run.output).toBeNull();
		expect(run.logs.join("\n")).toContain(
			"review comment's TICKETED lines unchecked",
		);
	});
});
