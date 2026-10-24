// @vitest-environment node
/*
 * Pins that a compaction clears this session's and its subagents' rule
 * latches, and nothing else, wherever gp_rule wrote them, exiting 0 on any
 * payload.
 *
 * scripts/clear-rule-latch.sh — the PreCompact hook that drops this session's
 * gp_rule latches (mantahostels#1804, spec mantahostels#1762).
 *
 * Each case spawns the real hook with a JSON payload on stdin, as the harness
 * does, against a temp repo on `CLAUDE_PROJECT_DIR` and a temp config dir, so
 * neither this repo's live latches nor gl_log's record land among the files
 * counted.
 *
 * It is the `PreCompact` hook in `self-plugin/hooks/hooks.json`: loosen a case
 * and a latch outlives the context it latched, so a session never gets a
 * relocated rule again, or a neighbour's latches are cleared under it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = path.resolve(__dirname, "clear-rule-latch.sh");

/** Prints the path gp_rule latches rule `one` at for session `sid-1`. */
const MARKER_OF_ONE = `source "${path.resolve(__dirname, "lib/guard-parse.sh")}" && gp_adopt_payload '{"session_id":"sid-1"}' && gp_latch_path one`;

describe("clear-rule-latch.sh", () => {
	let base: string;
	let root: string;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "clear-latch-"));
		root = path.join(base, "repo");
		fs.mkdirSync(root);
	});
	afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

	// Under .claude/tmp/markers/ rather than the repo root directly since F8
	// (mantahostels#3515, #2).
	const markersDir = () => path.join(root, ".claude", "tmp", "markers");

	const latch = (name: string) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(path.join(markersDir(), name), "");
		return name;
	};

	const env = (projectDir: string) => ({
		...process.env,
		CLAUDE_PROJECT_DIR: projectDir,
		// Outside the repo root: gl_log's fail-open record would otherwise
		// land among the very files these cases count.
		CLAUDE_CONFIG_DIR: path.join(base, "config"),
	});

	const run = (payload: string, projectDir = root) =>
		spawnSync(HOOK, [], {
			input: payload,
			encoding: "utf8",
			env: env(projectDir),
		});

	const left = () =>
		fs.existsSync(markersDir()) ? fs.readdirSync(markersDir()).sort() : [];

	it("clears this session's latches", () => {
		latch(".rule-injected-one-main-sid-1");
		latch(".rule-injected-two-main-sid-1");
		const r = run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
		expect(r.status).toBe(0);
		expect(left()).toEqual([]);
	});

	it("clears a subagent's latches with its parent's", () => {
		// A subagent's markers are keyed -a<agent_id>-<sid>, so the same glob
		// reaches them.
		latch(".rule-injected-one-aac7cb4a4-sid-1");
		run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
		expect(left()).toEqual([]);
	});

	it("leaves another session's latches alone", () => {
		latch(".rule-injected-one-main-sid-2");
		run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
		expect(left()).toEqual([".rule-injected-one-main-sid-2"]);
	});

	it("touches nothing outside the family", () => {
		latch(".concision-nagged-sid-1");
		// Not through `latch()`: this stands for an unrelated file sharing the
		// markers directory, not one of the family under test.
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(path.join(markersDir(), "README.md"), "");
		run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
		expect(left()).toEqual([".concision-nagged-sid-1", "README.md"]);
	});

	it("clears on an automatic compaction as well as a manual one", () => {
		latch(".rule-injected-one-main-sid-1");
		run(
			'{"hook_event_name":"PreCompact","session_id":"sid-1","trigger":"auto"}',
		);
		expect(left()).toEqual([]);
	});

	it("exits 0 and clears nothing on a payload with no session_id", () => {
		latch(".rule-injected-one-main-sid-1");
		const r = run('{"hook_event_name":"PreCompact"}');
		expect(r.status).toBe(0);
		expect(left()).toEqual([".rule-injected-one-main-sid-1"]);
	});

	it("exits 0 on a payload that does not parse", () => {
		latch(".rule-injected-one-main-sid-1");
		const r = run("not json");
		expect(r.status).toBe(0);
		expect(left()).toEqual([".rule-injected-one-main-sid-1"]);
	});

	it("exits 0 on an empty payload", () => {
		expect(run("").status).toBe(0);
	});

	it("sanitises the session id before it reaches the glob", () => {
		latch(".rule-injected-one-main-___escape");
		run('{"hook_event_name":"PreCompact","session_id":"../escape"}');
		expect(left()).toEqual([]);
	});

	/*
	 * The pairing this hook is one half of (mantahostels#1905). gp_rule writes the latch and
	 * this hook globs for it, so the two derive the repo root from one gr_root
	 * and cannot drift; before the fold they were separate expressions, and a
	 * CLAUDE_PROJECT_DIR a human spelled with a trailing / is exactly the input
	 * that made them disagree. Every case drives the REAL gp_latch_path rather
	 * than a hand-written filename.
	 *
	 * WHAT EACH SIDE IS DEFENDED AGAINST DIFFERS, and the asymmetry is the
	 * glob's. A marker respelled on the WRITING side moves the file and fails
	 * every case here. On the SWEEPING side a root left unnormalised still
	 * matches, `<root>//.rule-injected-*` and `<root>/.rule-injected-*` globbing
	 * the same entries — so only a respelling that names a DIFFERENT DIRECTORY
	 * is observable, which is what the third case supplies.
	 */
	describe("agrees with gp_rule's marker on where the latch is", () => {
		const marker = (projectDir: string) =>
			spawnSync("bash", ["-c", MARKER_OF_ONE], {
				encoding: "utf8",
				env: env(projectDir),
			}).stdout;

		it("clears a latch written under a plainly spelled root", () => {
			fs.writeFileSync(marker(root), "");
			expect(left()).toEqual([".rule-injected-one-main-sid-1"]);
			run('{"hook_event_name":"PreCompact","session_id":"sid-1"}');
			expect(left()).toEqual([]);
		});

		it("clears one written under a root spelled with a trailing slash", () => {
			const slashed = `${root}/`;
			// The path the marker names must land IN the root, not beside it: a
			// root normalised on one side only puts the latch where the other
			// side never looks.
			expect(marker(slashed)).toBe(
				path.join(
					root,
					".claude",
					"tmp",
					"markers",
					".rule-injected-one-main-sid-1",
				),
			);
			fs.writeFileSync(marker(slashed), "");
			run('{"hook_event_name":"PreCompact","session_id":"sid-1"}', slashed);
			expect(left()).toEqual([]);
		});

		/*
		 * The case that makes the SWEEP side observable: with CLAUDE_PROJECT_DIR
		 * unset, gr_root's git limb answers the repo toplevel, while the short
		 * `${CLAUDE_PROJECT_DIR:-$PWD}` spelling this fold removed answers the
		 * cwd. Run from a subdirectory those are two different directories, so a
		 * sweeper reverted to the short form globs the subdirectory and leaves the
		 * latch standing.
		 */
		it("clears one written from a subdirectory, with no root in the environment", () => {
			execFileSync("git", ["init", "-q", root]);
			const sub = path.join(root, "deep");
			fs.mkdirSync(sub);
			const unset: NodeJS.ProcessEnv = {
				...process.env,
				CLAUDE_CONFIG_DIR: path.join(base, "c"),
			};
			delete unset.CLAUDE_PROJECT_DIR;

			const at = spawnSync("bash", ["-c", MARKER_OF_ONE], {
				encoding: "utf8",
				cwd: sub,
				env: unset,
			}).stdout;
			expect(at).toBe(
				path.join(
					root,
					".claude",
					"tmp",
					"markers",
					".rule-injected-one-main-sid-1",
				),
			);
			fs.writeFileSync(at, "");

			const r = spawnSync(HOOK, [], {
				input: '{"hook_event_name":"PreCompact","session_id":"sid-1"}',
				encoding: "utf8",
				cwd: sub,
				env: unset,
			});
			expect(r.status).toBe(0);
			expect(fs.existsSync(at)).toBe(false);
		});
	});
});
