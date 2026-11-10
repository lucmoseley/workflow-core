// @vitest-environment node
/*
 * Holds the refill loop's typed resume, pty_type.py driving `claude attach`
 * (#2354 F6), to one case list, run against the installed harness's recorded
 * exits (scripts/fixtures/claude-attach.json, re-recorded by
 * `node scripts/record-claude-responses.js`) and against
 * lib/claude-attach-fake.ts, which the refill-loop-run suites' `claude` stub
 * runs. No case runs the real `claude`: each needs a live job, which a launch
 * spends a turn to make. It holds the exit off a terminal and pty_type.py's
 * exit after drawing on one, each through the verdict the loop judges its
 * typed resume by. Whether the harness takes the line is unheld: pty_type.py
 * exits 0 once the line is written, taken or not. Breaking it costs the
 * loop's typed resume: a fake whose exit the loop judges otherwise than the
 * harness's passes a refill-loop-run test the loop fails.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childFailure, childVerdict } from "./child-failure.js";
import { buildTypedAttach } from "./claude-attach.js";
import {
	type AttachKind,
	buildAttachBranch,
	recorded,
} from "./claude-attach-fake";
import { writeClaudeStub } from "./claude-stub";
import { API_PROMPT, scriptPrompt } from "./loop-prompts.js";

const TYPED = scriptPrompt("ok");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-attach-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const fakeClaude = () =>
	writeClaudeStub(path.join(dir, "claude"), [
		buildAttachBranch(path.join(dir, "log")),
	]);

const attach: Record<AttachKind, (bin: string) => string | null> = {
	offTerminal: (bin) =>
		childFailure(
			childVerdict(spawnSync(bin, ["attach", "job7"], { encoding: "utf8" })),
		),
	onTerminal: (bin) => {
		vi.stubEnv("WFC_CLAUDE_BIN", bin);
		const [file, args, opts] = buildTypedAttach("job7", TYPED);
		return childFailure(
			childVerdict(spawnSync(file, args, { ...opts, encoding: "utf8" })),
		);
	},
};

const cases: { kind: AttachKind; failure: string | null }[] = [
	{ kind: "offTerminal", failure: null },
	{ kind: "onTerminal", failure: null },
];

describe.each(cases)("attach $kind", ({ kind, failure }) => {
	it(`${failure ?? "succeeds"} in ${recorded.harness}'s recording`, () => {
		expect(childFailure(childVerdict(recorded.responses[kind]))).toBe(failure);
	});

	it(`${failure ?? "succeeds"} from the fake`, () => {
		expect(attach[kind](fakeClaude())).toBe(failure);
	});
});

it("logs the line typed at the fake on a terminal, and none off one", () => {
	const bin = fakeClaude();
	attach.offTerminal(bin);
	attach.onTerminal(bin);
	expect(fs.readFileSync(path.join(dir, "log"), "utf8")).toBe(
		`attach job7\ntyped ${TYPED}\n`,
	);
});

describe("the typed attach's prompt (#4844)", () => {
	it("is refused where it opens with no prefix, as the founder's typing would read", () => {
		expect(() =>
			buildTypedAttach("job7", "Reply with the single word ok. Use no tools."),
		).toThrow(/must open with the loop's or a script's prefix/);
	});

	it("is typed where it is one of the loop's own", () => {
		expect(buildTypedAttach("job7", API_PROMPT)[1]).toContain(API_PROMPT);
	});
});
