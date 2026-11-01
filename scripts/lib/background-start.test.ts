// @vitest-environment node
/*
 * Pins what lib/background-start.js counts as a background start (#3707),
 * the predicate that holds a founder's once-a-day notice back for his own
 * session start.
 *
 * In process, each case handing the predicate its own environment object,
 * so the case does not depend on whether the suite itself runs in a
 * background job.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeJobRecord } from "./background-start-testkit";

const require_ = createRequire(__filename);
const { isBackgroundStart, isFounderNoticeHeld } = require_(
	"./background-start.js",
) as {
	isBackgroundStart: (env: NodeJS.ProcessEnv) => boolean;
	isFounderNoticeHeld: (
		checker: string,
		source: string | undefined,
		env: NodeJS.ProcessEnv,
	) => boolean;
};

describe("isBackgroundStart", () => {
	it.each([
		[
			"a `claude --bg` job",
			{ CLAUDE_JOB_DIR: "/j", CLAUDE_CODE_ENTRYPOINT: "cli" },
		],
		["a print-mode run", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }],
	])("counts %s as a background start", (_, env) => {
		expect(isBackgroundStart(env)).toBe(true);
	});

	it.each([
		["an interactive terminal session", { CLAUDE_CODE_ENTRYPOINT: "cli" }],
		["an empty job dir", { CLAUDE_JOB_DIR: "" }],
		["no harness variables", {}],
	])("counts %s as interactive", (_, env) => {
		expect(isBackgroundStart(env)).toBe(false);
	});
});

describe("isFounderNoticeHeld (#3725)", () => {
	const job = { CLAUDE_JOB_DIR: "/j", CLAUDE_CODE_ENTRYPOINT: "cli" };
	const terminal = { CLAUDE_CODE_ENTRYPOINT: "cli" };

	it.each(["idle-efforts", "refill-loop-stop"])(
		"holds the founder notice %s at a background start alone",
		(checker) => {
			expect(isFounderNoticeHeld(checker, "startup", job)).toBe(true);
			expect(isFounderNoticeHeld(checker, "startup", terminal)).toBe(false);
		},
	);

	it("holds no other report at a background start", () => {
		expect(isFounderNoticeHeld("ci-status", "startup", job)).toBe(false);
	});
});

describe("whose job a start is (#3772)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "background-start-"));
	afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
	const jobEnv = (template: string, entrypoint = "cli") => ({
		CLAUDE_JOB_DIR: writeJobRecord(path.join(root, template), template),
		CLAUDE_CODE_ENTRYPOINT: entrypoint,
	});

	it("shows a founder notice at a job launched from the agents view", () => {
		expect(
			isFounderNoticeHeld("idle-efforts", "startup", jobEnv("claude")),
		).toBe(false);
	});

	it("holds it at a dispatcher's or the loop's plain `claude --bg` job", () => {
		expect(isFounderNoticeHeld("idle-efforts", "startup", jobEnv("bg"))).toBe(
			true,
		);
	});

	it("holds it at a print-mode run inside his job", () => {
		expect(
			isFounderNoticeHeld(
				"idle-efforts",
				"startup",
				jobEnv("claude", "sdk-cli"),
			),
		).toBe(true);
	});

	it("holds it at a wake of his job, which keeps its template", () => {
		expect(
			isFounderNoticeHeld("idle-efforts", "resume", jobEnv("claude")),
		).toBe(true);
	});

	it("shows it at a resume in a terminal", () => {
		expect(
			isFounderNoticeHeld("idle-efforts", "resume", {
				CLAUDE_CODE_ENTRYPOINT: "cli",
			}),
		).toBe(false);
	});

	it("holds it at a compaction anywhere, and no other report", () => {
		const terminal = { CLAUDE_CODE_ENTRYPOINT: "cli" };
		expect(isFounderNoticeHeld("idle-efforts", "compact", terminal)).toBe(true);
		expect(isFounderNoticeHeld("ci-status", "compact", terminal)).toBe(false);
	});

	it("holds it where the job's record carries no template", () => {
		const bare = path.join(root, "bare");
		fs.mkdirSync(bare);
		fs.writeFileSync(path.join(bare, "state.json"), "{}");
		expect(
			isFounderNoticeHeld("idle-efforts", "startup", {
				CLAUDE_JOB_DIR: bare,
				CLAUDE_CODE_ENTRYPOINT: "cli",
			}),
		).toBe(true);
	});

	it("holds it where the job's record will not read", () => {
		const damaged = path.join(root, "damaged");
		fs.mkdirSync(damaged);
		fs.writeFileSync(path.join(damaged, "state.json"), "{");
		expect(
			isFounderNoticeHeld("idle-efforts", "startup", {
				CLAUDE_JOB_DIR: damaged,
				CLAUDE_CODE_ENTRYPOINT: "cli",
			}),
		).toBe(true);
	});
});
