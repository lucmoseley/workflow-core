// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	finished,
	freshSandbox,
	live,
	markers as markersMod,
} from "./arbiter-testkit";
import { committedRepoTemplate, defineTemplate } from "./git-fixture";
import { readParkedBy, writeParkedBy } from "./parked.js";
import { REFILL_STATE_FILE } from "./refill-dir.js";
import { record } from "./refill-loop-fixture";

const AGED_MS = 25 * 60 * 60 * 1000;

const sb = freshSandbox();

describe("marker sweep — the backstop's per-session files in the repo root", () => {
	const prefixes = [
		".concision-base-",
		".concision-nagged-",
		".concision-pass-",
		".codereview-nagged-",
		".codereview-pass-",
		".parked-blocked-",
	];

	const passPrefixes = [".concision-pass-", ".codereview-pass-"];

	const markersDir = () => path.join(sb.repo, ".claude", "tmp", "markers");

	const markers = (sessionId: string, old = false) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		const when = new Date(Date.now() - AGED_MS);
		for (const p of prefixes) {
			const full = path.join(markersDir(), p + sessionId);
			fs.writeFileSync(full, "");
			if (old) fs.utimesSync(full, when, when);
		}
	};

	const surviving = (sessionId: string) =>
		prefixes.filter((p) =>
			fs.existsSync(path.join(markersDir(), p + sessionId)),
		);

	it("spares a live session's markers however old they are", () => {
		markers("alice", true);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(surviving("alice")).toEqual(prefixes);
	});

	it("sweeps a finished session's aged markers", () => {
		markers("bob", true);
		finished(sb, "bob");

		markersMod.pruneMarkers();

		expect(surviving("bob")).toEqual([]);
	});

	it("keeps a finished session's aged park marker, whose park may still wait on the founder (#3589)", () => {
		markers("bob", true);
		const before = new Set(fs.readdirSync(markersDir()));
		writeParkedBy("bob", [12]);
		const when = new Date(Date.now() - AGED_MS);
		for (const f of fs.readdirSync(markersDir()))
			if (!before.has(f)) fs.utimesSync(path.join(markersDir(), f), when, when);
		finished(sb, "bob");

		markersMod.pruneMarkers();

		expect(readParkedBy("bob")).toEqual([12]);
		expect(surviving("bob")).toEqual(passPrefixes);
	});

	describe("a session the refill loop still expects to resume (#4110)", () => {
		const writeState = (launches: Record<string, unknown>[]) => {
			vi.stubEnv("WFC_REFILL_DIR", sb.home);
			fs.writeFileSync(
				path.join(sb.home, REFILL_STATE_FILE),
				JSON.stringify({ launches: launches.map((l) => record(l)) }),
			);
		};
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("keeps only the pass markers of a held launch's aged session", () => {
			markers("held", true);
			finished(sb, "held");
			writeState([{ finishedAt: null, jobId: "held", sessionId: "held" }]);

			markersMod.pruneMarkers();

			expect(surviving("held")).toEqual(passPrefixes);
		});

		it.each(["limitHeld", "stepResume"])(
			"keeps the pass markers of a session only %s names",
			(field) => {
				markers("nested", true);
				finished(sb, "nested");
				writeState([
					{ finishedAt: null, jobId: "j", [field]: { sessionId: "nested" } },
				]);

				markersMod.pruneMarkers();

				expect(surviving("nested")).toEqual(passPrefixes);
			},
		);

		it("keeps the pass markers of a finished session's standing park", () => {
			markers("parked", true);
			writeParkedBy("parked", [12]);
			finished(sb, "parked");
			writeState([]);

			markersMod.pruneMarkers();

			expect(surviving("parked")).toEqual(passPrefixes);
		});

		it("sweeps the pass markers of a finished launch's session", () => {
			markers("done", true);
			finished(sb, "done");
			writeState([{ finishedAt: 1, jobId: "done", sessionId: "done" }]);

			markersMod.pruneMarkers();

			expect(surviving("done")).toEqual([]);
		});

		it("sweeps the pass markers of a session whose park has emptied", () => {
			markers("unparked", true);
			writeParkedBy("unparked", []);
			finished(sb, "unparked");
			writeState([]);

			markersMod.pruneMarkers();

			expect(surviving("unparked")).toEqual([]);
		});

		it("sweeps the pass markers of a session no launch or park names", () => {
			markers("stranger", true);
			finished(sb, "stranger");
			writeState([{ finishedAt: null, jobId: "held", sessionId: "held" }]);

			markersMod.pruneMarkers();

			expect(surviving("stranger")).toEqual([]);
		});

		it("keeps a young marker of a session no launch or park names", () => {
			markers("young");
			finished(sb, "young");
			writeState([]);

			markersMod.pruneMarkers();

			expect(surviving("young")).toEqual(prefixes);
		});

		it.each([
			["is torn", "{torn"],
			["holds no list of launches", '{"launches":"x"}'],
		])("keeps only the pass markers where the loop's state %s", (_, text) => {
			markers("unknown", true);
			finished(sb, "unknown");
			vi.stubEnv("WFC_REFILL_DIR", sb.home);
			fs.writeFileSync(path.join(sb.home, REFILL_STATE_FILE), text);

			markersMod.pruneMarkers();

			expect(surviving("unknown")).toEqual(passPrefixes);
		});

		it("keeps only the pass markers where a park marker will not read", () => {
			markers("unknown", true);
			finished(sb, "unknown");
			writeState([]);
			fs.mkdirSync(path.join(markersDir(), ".parked-torn"));

			markersMod.pruneMarkers();

			expect(surviving("unknown")).toEqual(passPrefixes);
		});

		it("reads a state with no launches as none", () => {
			markers("stranger", true);
			finished(sb, "stranger");
			vi.stubEnv("WFC_REFILL_DIR", sb.home);
			fs.writeFileSync(path.join(sb.home, REFILL_STATE_FILE), "{}");

			markersMod.pruneMarkers();

			expect(surviving("stranger")).toEqual([]);
		});
	});

	it("sweeps the markers of a session that was never registered", () => {
		markers("ghost", true);

		markersMod.pruneMarkers();

		expect(surviving("ghost")).toEqual([]);
	});

	it("leaves a finished session's fresh markers alone", () => {
		markers("bob");
		finished(sb, "bob");

		markersMod.pruneMarkers();

		expect(surviving("bob")).toEqual(prefixes);
	});

	it("spares the close-check log however old it is (#1101)", () => {
		const log = path.join(markersDir(), ".close-check-log.jsonl");
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(log, "{}\n");
		const when = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
		fs.utimesSync(log, when, when);

		markersMod.pruneMarkers();

		expect(fs.existsSync(log)).toBe(true);
	});

	it("touches nothing in the repo root that is not a marker", () => {
		fs.writeFileSync(path.join(sb.repo, "package.json"), "{}");
		fs.writeFileSync(path.join(sb.repo, ".gitignore"), "");
		const when = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
		for (const f of ["package.json", ".gitignore"])
			fs.utimesSync(path.join(sb.repo, f), when, when);

		markersMod.pruneMarkers();

		expect(fs.existsSync(path.join(sb.repo, "package.json"))).toBe(true);
		expect(fs.existsSync(path.join(sb.repo, ".gitignore"))).toBe(true);
	});

	it("sweeps a live session's aged markers when there is no registry at all", () => {
		markers("alice", true);
		live(sb, "alice");
		fs.rmSync(path.join(sb.home, "sessions"), { recursive: true, force: true });

		markersMod.pruneMarkers();

		expect(surviving("alice")).toEqual([]);
	});
});

describe("rule-latch sweep — the .rule-injected- family (mantahostels#1804)", () => {
	const hour = 60 * 60 * 1000;
	const markersDir = () => path.join(sb.repo, ".claude", "tmp", "markers");
	const latchPrefix = ".rule-injected-";

	const latch = (id: string, agent: string, sessionId: string, ms: number) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		const full = path.join(
			markersDir(),
			`${latchPrefix}${id}-${agent}-${sessionId}`,
		);
		const when = new Date(Date.now() - ms);
		fs.writeFileSync(full, "");
		fs.utimesSync(full, when, when);
		return full;
	};

	it("keeps the breadcrumb directory out of git", () => {
		const hookRecord = require("./hook-record.js");
		const repo = path.join(__dirname, "..", "..");
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "breadcrumb-dir-"));
		const rel = path.relative(scratch, hookRecord.recordsDir(scratch));
		fs.rmSync(scratch, { recursive: true, force: true });
		const probe = path.join(repo, rel, "probe");
		const res = spawnSync("git", ["check-ignore", "-q", "--no-index", probe], {
			cwd: repo,
		});
		expect(res.status).toBe(0);
	});

	it("spells the prefix guard-entry.js writes", () => {
		const { writeLatches } = require("./guard-entry.js");
		writeLatches(
			{ root: sb.repo, payload: { session_id: "s" }, log: () => undefined },
			[{ name: "one", text: "" }],
		);
		expect(fs.readdirSync(markersDir())).toContain(`${latchPrefix}one-main-s`);
	});

	it("sweeps a finished session's aged latch", () => {
		const f = latch("one", "main", "ghost", 25 * hour);

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	it("leaves a finished session's fresh latch alone", () => {
		const f = latch("one", "main", "ghost", 1 * hour);

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});

	it("spares a live session's latch however old, past the agent segment", () => {
		const f = latch("one", "main", "alice", 30 * 24 * hour);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});

	it("spares a subagent's latch under the live parent it is keyed to", () => {
		const f = latch("one", "aac7cb4a45383cc850", "alice", 30 * 24 * hour);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});

	it("sweeps a subagent's aged latch once its parent has finished", () => {
		const f = latch("one", "aac7cb4a45383cc850", "ghost", 25 * hour);
		finished(sb, "ghost");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	it("does not spare a latch whose id merely ends with a live id", () => {
		const f = latch("one", "main", "xalice", 25 * hour);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	it("sweeps the sanitised marker guard-entry.js writes for an unusable session id", () => {
		const f = latch("one", "main", "___escape", 25 * hour);
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	it("deletes no latch when the registry itself cannot be read", () => {
		const f = latch("one", "main", "ghost", 25 * hour);
		fs.chmodSync(path.join(sb.home, "sessions"), 0o000);
		try {
			markersMod.pruneMarkers();
		} finally {
			fs.chmodSync(path.join(sb.home, "sessions"), 0o755);
		}

		expect(fs.existsSync(f)).toBe(true);
	});

	it("leaves a near-miss sharing the prefix's opening alone", () => {
		const f = path.join(sb.repo, ".rule-injection-notes");
		const when = new Date(Date.now() - 400 * 24 * hour);
		fs.writeFileSync(f, "");
		fs.utimesSync(f, when, when);

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});
});

describe("self-plugin marker sweep — a linked worktree's markers (#4531)", () => {
	const wt = () => path.join(sb.repo, ".claude", "worktrees", "s1");
	const wtMarkers = () => path.join(wt(), ".claude", "tmp", "markers");

	const git = (cwd: string, ...args: string[]) => {
		const res = spawnSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@t", ...args],
			{ cwd, encoding: "utf8" },
		);
		expect(res.status, res.stderr).toBe(0);
	};

	const worktreeRepo = defineTemplate((dir) => {
		fs.mkdirSync(path.join(dir, "docs"));
		committedRepoTemplate(dir);
		git(
			dir,
			"worktree",
			"add",
			"-q",
			"--detach",
			path.join(dir, ".claude", "worktrees", "s1"),
		);
	});

	const aged = (name: string) => {
		fs.mkdirSync(wtMarkers(), { recursive: true });
		const full = path.join(wtMarkers(), name);
		fs.writeFileSync(full, "");
		const when = new Date(Date.now() - AGED_MS);
		fs.utimesSync(full, when, when);
		return full;
	};

	const withWorktree = () => {
		worktreeRepo.instantiate(sb.repo);
	};

	it("sweeps a finished session's aged marker in a worktree", () => {
		withWorktree();
		const f = aged(".self-plugin-loaded-bob");
		finished(sb, "bob");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(false);
	});

	it("keeps a live session's aged marker in a worktree", () => {
		withWorktree();
		const f = aged(".self-plugin-loaded-alice");
		live(sb, "alice");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});

	it("leaves a worktree's other aged markers alone", () => {
		withWorktree();
		const f = aged(".concision-base-bob");
		finished(sb, "bob");

		markersMod.pruneMarkers();

		expect(fs.existsSync(f)).toBe(true);
	});

	it("creates no markers directory in a worktree that has none", () => {
		withWorktree();

		markersMod.pruneMarkers();

		expect(fs.existsSync(wtMarkers())).toBe(false);
	});
});
