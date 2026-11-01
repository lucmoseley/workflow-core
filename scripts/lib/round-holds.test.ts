// @vitest-environment node
/*
 * lib/round-holds.js, a PreToolUse dispatcher core (#3858), refuses once a
 * background job's round before it reaches the founder, printing the open repo
 * holds.
 *
 * WHAT BREAKING IT COSTS: a miss lets many sessions ask one question; a
 * refusal with no way past wedges every round a job asks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCore, toolCall } from "./guard-core-testkit";
import { raiseHold, readCheckout } from "./repo-holds.js";

const ROUND = "❓ **Q1** Who repairs main?\n\n(A) You.\n";
const JOB = { CLAUDE_JOB_DIR: "/seat/jobs/abc123" };

let dir: string;

const check = (command: string, env: Record<string, string> = JOB) =>
	runCore("guard-round-holds", toolCall("Bash", { command }), {
		root: dir,
		env,
	});

const denyOf = (run: ReturnType<typeof check>) =>
	run.output?.permissionDecisionReason ?? "";

const writeBodyFile = (text: string) => {
	const file = path.join(dir, "body.md");
	fs.writeFileSync(file, text);
	return file;
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "round-holds-")));
	fs.mkdirSync(path.join(dir, ".claude", "tmp", "markers"), {
		recursive: true,
	});
	vi.stubEnv("WFC_REFILL_DIR", path.join(dir, "store"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a background job posting a round", () => {
	it("is refused before the post, seeing the open hold's act and id and the commands", () => {
		const hold = raiseHold(readCheckout(dir), {
			kind: "park",
			act: "repair main",
			issue: 12,
			clearCheck: { issueClosed: 12 },
			session: "other",
			now: Date.now(),
		});

		const reason = denyOf(
			check(`gh issue comment 31 --body-file ${writeBodyFile(ROUND)}`),
		);

		expect(reason).toContain("repair main");
		expect(reason).toContain(hold.id);
		expect(reason).toContain("repo-hold.js attach <id>");
		expect(reason).toContain("--issue 31 --clear-issue 31");
	});

	it("is told none is open where none is, and how to raise one", () => {
		const reason = denyOf(check(`gh issue comment 31 --body "${ROUND}"`));

		expect(reason).toContain("none open");
		expect(reason).toContain("repo-hold.js raise");
	});

	it("passes the same call re-sent, and is refused again on a different round", () => {
		const file = writeBodyFile(ROUND);
		const command = `gh issue comment 31 --body-file ${file}`;

		expect(denyOf(check(command))).not.toBe("");
		expect(check(command).output).toBeNull();

		writeBodyFile("❓ **Q1** Which key?\n");
		expect(denyOf(check(command))).not.toBe("");
	});

	it("judges every round one command posts", () => {
		const second = path.join(dir, "second.md");
		fs.writeFileSync(second, ROUND);
		const command = `gh issue comment 31 --body-file ${writeBodyFile(ROUND)}; gh issue comment 32 --body-file ${second}`;

		expect(denyOf(check(command))).not.toBe("");
		expect(check(command).output).toBeNull();

		fs.writeFileSync(second, "❓ **Q1** Which key?\n");
		expect(denyOf(check(command))).not.toBe("");
	});
});

describe("calls that are no round to judge", () => {
	it.each([
		["a comment with no round", "gh issue comment 31 --body 'Done.'"],
		["a round quoted mid-line", "gh issue comment 31 --body 'see ❓ **Q1**'"],
		["any other gh call", "gh issue view 31"],
		[
			"an edit of the last comment",
			`gh issue comment 31 --edit-last --body "${ROUND}"`,
		],
	])("leaves alone %s", (_, command) => {
		expect(check(command).output).toBeNull();
	});

	it("leaves alone a round from an interactive session, whose founder is in the terminal", () => {
		expect(
			check(`gh issue comment 31 --body "${ROUND}"`, {}).output,
		).toBeNull();
	});
});

describe("where it cannot judge, it passes on the record", () => {
	it.each([
		["a hidden body", 'gh issue comment 31 --body "$(cat f)"', "body hidden"],
		[
			"a missing body file",
			"gh issue comment 31 --body-file /no/such/file",
			"round unseen",
		],
	])("logs %s", (_, command, logged) => {
		const run = check(command);

		expect(run.output).toBeNull();
		expect(run.logs.join("\n")).toContain(logged);
	});

	it("logs a round no latch can key", () => {
		const run = runCore(
			"guard-round-holds",
			toolCall(
				"Bash",
				{ command: `gh issue comment 31 --body "${ROUND}"` },
				{ session_id: undefined },
			),
			{ root: dir, env: JOB },
		);

		expect(run.output).toBeNull();
		expect(run.logs.join("\n")).toContain("latch path unresolved");
	});

	it("logs a round whose latch directory will not take a write", () => {
		const markers = path.join(dir, ".claude", "tmp", "markers");
		fs.chmodSync(markers, 0o500);
		try {
			const run = check(`gh issue comment 31 --body "${ROUND}"`);

			expect(run.output).toBeNull();
			expect(run.logs.join("\n")).toContain("latch directory unwritable");
		} finally {
			fs.chmodSync(markers, 0o700);
		}
	});
});
