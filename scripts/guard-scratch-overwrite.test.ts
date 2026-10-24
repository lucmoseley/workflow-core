// @vitest-environment node
/*
 * guard-scratch-overwrite.sh refuses the first `Write` that replaces a
 * `.claude/tmp/` file the writing session never wrote, and lets the same call
 * re-sent through (#1167, refuse-once since #1728). The "A again" case is what
 * the per-session record buys — remove the record check and it refuses.
 *
 * Each case spawns the guard against a temp repo, then performs the write
 * itself as the harness would, unless the guard refused it, so the next call
 * sees the file.
 *
 * It runs on every `Write` as a `PreToolUse` hook
 * (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`): break it and one
 * session overwrites a neighbour's `.claude/tmp/` scratch unrefused, with no
 * claim or version to recover it from.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweptMarkers } from "./lib/arbiter-testkit";

const { projectSlug } = require("./lib/project-slug") as {
	projectSlug: (root: string) => string;
};

const GUARD = path.resolve(__dirname, "guard-scratch-overwrite.sh");
const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-5555-6666-7777-888888888888";

let dir: string;
let repo: string;
let config: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-overwrite-"));
	repo = path.join(dir, "repo");
	config = path.join(dir, "config");
	fs.mkdirSync(path.join(repo, ".claude", "tmp"), { recursive: true });
	fs.mkdirSync(config, { recursive: true });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/* Runs the guard on one `Write`, then does the write itself as the harness
 * would unless the guard refused it. Returns the refusal's reason, or null.
 * `payload`, given, replaces the default `Write` payload whole. */
function write(session: string, target: string, payload?: object) {
	const r = spawnSync(GUARD, [], {
		cwd: repo,
		encoding: "utf8",
		input: JSON.stringify(
			payload ?? {
				session_id: session,
				cwd: repo,
				tool_name: "Write",
				tool_input: { file_path: target, content: session },
			},
		),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: repo,
			// Unset, the guard's fail-open records would append to the founder's own log.
			CLAUDE_CONFIG_DIR: config,
		},
	});
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	if (r.stdout.trim()) {
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBe("deny");
		return out.permissionDecisionReason as string;
	}
	const abs = path.resolve(repo, target);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, session);
	return null;
}

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
		expect(write(A, scratch("notes"))).toContain("notes-aaaaaaaa");
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
		const log = path.join(
			config,
			"projects",
			projectSlug(repo),
			"guard-errors.log",
		);
		expect(fs.readFileSync(log, "utf8")).toContain("no session id");
	});
});

describe("the record", () => {
	it("is a marker family the markers sweep knows, so it does not pile up", () => {
		const records = [`.scratch-written-${A}`, ".scratch-written-running"];
		expect(sweptMarkers(records)).toEqual([records[0]]);
	});
});
