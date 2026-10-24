// @vitest-environment node
/*
 * report-once.js (#861) — a transcript-reading Stop guard names each tool call
 * in one line and tells a session about it once, for ever, marking it told only
 * where the block actually went out.
 *
 * In-process, with the `seen` marker under a temp root, so no case writes this
 * checkout's markers.
 *
 * `guard-lost-deny.js` and `guard-automode-refusal.js` run on it as Stop hooks
 * in `.claude/settings.json`; loosen a case and a session is blocked on the
 * same call every turn, or never told of one it was never shown.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { markersDir } = require("./marker-root.js");
const { describeCall, reportOnce } = require("./report-once");

describe("describeCall", () => {
	it("quotes a command input on one line", () => {
		expect(
			describeCall({ name: "Bash", input: { command: "git  status\n-s" } }),
		).toBe("Bash: git status -s");
	});

	it("falls back to the input's JSON, and to ? for a missing name", () => {
		expect(describeCall({ input: { file_path: "a" } })).toBe(
			'?: {"file_path":"a"}',
		);
	});

	it("cuts a long input at 160 characters", () => {
		const out = describeCall({
			name: "Bash",
			input: { command: "x".repeat(165) },
		});
		expect(out).toBe(`Bash: ${"x".repeat(160)}…`);
	});

	it("names a call the transcript no longer carries", () => {
		expect(describeCall(undefined)).toBe(
			"a tool call this transcript no longer carries",
		);
	});
});

describe("reportOnce", () => {
	let root: string;
	let blocked: string[][];
	const items = [{ id: "a" }, { id: "b" }];
	const seenFile = () => path.join(markersDir(root), ".t-seen-s1");
	const run = (wentOut: boolean) =>
		reportOnce({
			root,
			sessionId: "s1",
			seenPrefix: ".t-seen-",
			items,
			idOf: (i: { id: string }) => i.id,
			block: (fresh: { id: string }[]) => {
				blocked.push(fresh.map((i) => i.id));
				return wentOut;
			},
		});

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "report-once-"));
		blocked = [];
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("blocks over the untold items only, and marks them told", () => {
		fs.writeFileSync(seenFile(), "a\n");
		expect(run(true)).toBe(true);
		expect(blocked).toEqual([["b"]]);
		expect(fs.readFileSync(seenFile(), "utf8")).toBe("a\nb\n");
	});

	it("marks nothing told where the block did not go out", () => {
		expect(run(false)).toBe(false);
		expect(blocked).toEqual([["a", "b"]]);
		expect(fs.existsSync(seenFile())).toBe(false);
	});

	it("does not block where every item was told", () => {
		fs.writeFileSync(seenFile(), "a\nb\n");
		expect(run(true)).toBe(false);
		expect(blocked).toEqual([]);
	});
});
