// @vitest-environment node
/*
 * lib/scratch-overwrite.js, a PreToolUse dispatcher core (#2789), refuses the
 * first `Write` that replaces a `.claude/tmp/` file the writing session never
 * wrote, and lets the same call re-sent through (#1167, refuse-once since
 * #1728). The "A again" case is what the per-session record buys — remove the
 * record check and it refuses.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * production record (lib/scratch-overwrite-host.js) in a temp repo. Each case
 * then performs the write itself as the harness would, unless the core
 * refused it, so the next call sees the file.
 *
 * Break it and one session overwrites a neighbour's `.claude/tmp/` scratch
 * unrefused, with no claim or version to recover it from.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweptMarkers } from "./arbiter-testkit";
import { runCore, toolCall } from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-5555-6666-7777-888888888888";

let dir: string;
let repo: string;
let logs: string[];

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "scratch-overwrite-")),
	);
	repo = path.join(dir, "repo");
	fs.mkdirSync(path.join(repo, ".claude", "tmp"), { recursive: true });
	logs = [];
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/* Runs the core on one `Write`, then does the write itself as the harness
 * would unless the core refused it. Returns the refusal's reason, or null.
 * `payload`, given, replaces the default `Write` payload whole. */
function write(session: string, target: string, payload?: object) {
	const r = runCore(
		"guard-scratch-overwrite",
		(payload as Record<string, unknown> | undefined) ??
			toolCall(
				"Write",
				{ file_path: target, content: session },
				{ session_id: session, cwd: repo },
			),
		{ root: repo },
	);
	logs.push(...r.logs);
	if (r.output) {
		expect(r.output.permissionDecision).toBe("deny");
		return r.output.permissionDecisionReason as string;
	}
	const abs = path.resolve(repo, target);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, session);
	return null;
}

describe("a record that cannot be read", () => {
	it("lets the write through unchecked, recorded (mantahostels#103 §6)", () => {
		fs.writeFileSync(scratch("held.md"), "x");
		fs.mkdirSync(
			path.join(repo, ".claude", "tmp", "markers", `.scratch-written-${B}`),
			{ recursive: true },
		);
		expect(write(B, scratch("held.md"))).toBeNull();
		expect(logs.join("\n")).toMatch(
			/scratch record .* unreadable — a scratch write allowed unchecked/,
		);
	});
});

const scratch = (name: string) => path.join(repo, ".claude", "tmp", name);

describe("the first Write over an existing scratch file this session never wrote", () => {
	it("is refused, naming the session-suffixed alternative (#1728: a warn rode the write and lost the neighbour's bytes)", () => {
		expect(write(A, scratch("c1882.md"))).toBeNull();
		const refusal = write(B, scratch("c1882.md"));
		expect(refusal).toContain(scratch("c1882.md"));
		expect(refusal).toContain(scratch("c1882-bbbbbbbb.md"));
	});

	it("lets the same call re-sent through, then never refuses that path again this session", () => {
		write(A, scratch("i1806.json"));
		expect(write(B, scratch("i1806.json"))).not.toBeNull();
		expect(write(B, scratch("i1806.json"))).toBeNull();
		expect(write(B, scratch("i1806.json"))).toBeNull();
	});

	it("is refused on a file no session recorded — one made through Bash — naming the session-suffixed alternative", () => {
		fs.writeFileSync(scratch("claim1806.txt"), "x");
		expect(write(A, scratch("claim1806.txt"))).toContain(
			"claim1806-aaaaaaaa.txt",
		);
		expect(write(A, scratch("claim1806.txt"))).toBeNull();
	});

	it("suffixes the end of a name with no extension", () => {
		fs.writeFileSync(scratch("notes"), "x");
		expect(write(A, scratch("notes"))).toContain("notes-aaaaaaaa` instead");
	});

	it("reads a relative path against the payload's cwd", () => {
		write(A, scratch("rel.md"));
		const refusal = write(B, ".claude/tmp/rel.md", {
			session_id: B,
			cwd: repo,
			tool_name: "Write",
			tool_input: { file_path: ".claude/tmp/rel.md", content: "x" },
		});
		expect(refusal).toContain("rel-bbbbbbbb.md");
	});

	it("on a name carrying the session's id anywhere but its suffix", () => {
		fs.writeFileSync(scratch("x-bbbbbbbb-old.md"), "x");
		expect(write(B, scratch("x-bbbbbbbb-old.md"))).toContain(
			"x-bbbbbbbb-old-bbbbbbbb.md",
		);
	});
});

describe("never refused", () => {
	it("on the session's own second write", () => {
		expect(write(A, scratch("c1882.md"))).toBeNull();
		expect(write(A, scratch("c1882.md"))).toBeNull();
	});

	it("on a new scratch path", () => {
		expect(write(B, scratch("fresh.md"))).toBeNull();
	});

	it("on a subdirectory's new path, and on its rewrite", () => {
		expect(write(A, scratch("agents/x.md"))).toBeNull();
		expect(write(A, scratch("agents/x.md"))).toBeNull();
	});

	it("on a name already carrying this session's suffix", () => {
		fs.writeFileSync(scratch("c1882-bbbbbbbb.md"), "x");
		expect(write(B, scratch("c1882-bbbbbbbb.md"))).toBeNull();
	});

	it("outside .claude/tmp/, an existing file included", () => {
		fs.writeFileSync(path.join(repo, "a.md"), "x");
		expect(write(B, path.join(repo, "a.md"))).toBeNull();
		expect(
			fs.existsSync(
				path.join(repo, ".claude", "tmp", "markers", `.scratch-written-${B}`),
			),
		).toBe(false);
	});

	it("with no session id, failing open and recorded", () => {
		fs.writeFileSync(scratch("anon.md"), "x");
		const refusal = write("", scratch("anon.md"), {
			tool_name: "Write",
			tool_input: { file_path: scratch("anon.md"), content: "x" },
		});
		expect(refusal).toBeNull();
		expect(logs.join("\n")).toContain("no session id");
	});
});

describe("the record", () => {
	it("is a marker family the markers sweep knows, so it does not pile up", () => {
		const records = [`.scratch-written-${A}`, ".scratch-written-running"];
		expect(sweptMarkers(records)).toEqual([records[0]]);
	});
});

describe("the cases a mutant must not survive (#2789)", () => {
	it("leaves alone a directory whose name merely ends in .claude", () => {
		const other = path.join(repo, "x.claude", "tmp", "a.md");
		fs.mkdirSync(path.dirname(other), { recursive: true });
		fs.writeFileSync(other, "x");
		expect(write(A, other)).toBeNull();
	});

	it("refuses for a session id that is no safe filename, keeping its record", () => {
		fs.writeFileSync(scratch("odd.md"), "x");
		expect(write("a/b", scratch("odd.md"))).toContain("odd-a_b.md");
		expect(write("a/b", scratch("odd.md"))).toBeNull();
	});

	it.skipIf(process.getuid?.() === 0)(
		"lets the write through unrecorded, recorded, where the record cannot be written",
		() => {
			fs.writeFileSync(scratch("ro.md"), "x");
			const markers = path.join(repo, ".claude", "tmp", "markers");
			fs.mkdirSync(markers, { recursive: true });
			fs.chmodSync(markers, 0o500);
			try {
				expect(write(A, scratch("ro.md"))).toBeNull();
			} finally {
				fs.chmodSync(markers, 0o700);
			}
			expect(logs.join("\n")).toMatch(
				/scratch record .* unwritable — a scratch write allowed unrecorded/,
			);
		},
	);

	it("lets the write through unrecorded, recorded, where the record has no home", () => {
		/* markersDir throws only on an unresolvable root, which no sandbox
		 * reaches, so the port is faked. */
		const core = require("./scratch-overwrite.js") as {
			decide: (s: string, ctx: Record<string, unknown>) => unknown;
		};
		const seen: string[] = [];
		expect(
			core.decide(
				scratch("x.md"),
				kitContextFake({
					session: A,
					fallbackCwd: repo,
					scratchRecord: () => null,
					log: (w: string) => seen.push(w),
				}),
			),
		).toBeNull();
		expect(seen).toEqual([
			"repo root unresolved — a scratch write allowed unrecorded",
		]);
	});
});
