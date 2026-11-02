// @vitest-environment node
/*
 * The repo hold's CLI (#3857), run as sessions and the founder run it. The real tick's side of a hold is
 * refill-loop-run.test.ts's.
 *
 * WHAT BREAKING IT COSTS: a hold listed from one worktree and not another gets
 * the founder a second copy of the same question; a lift that fails leaves a
 * hold nothing else may end.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { parseHoldId } from "./lib/repo-hold-fixture";
import { raiseHold } from "./lib/repo-holds.js";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process.js";

const CLI = path.join(__dirname, "repo-hold.js");

const COMMIT = [
	"-c",
	"user.name=t",
	"-c",
	"user.email=t@t",
	"commit",
	"-q",
	"--allow-empty",
	"-m",
	"first",
];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "ignore" });

const initCheckout = (root: string) => {
	fs.mkdirSync(root);
	git(root, "init", "-q");
	git(root, ...COMMIT);
};

/* The store sits outside it, so no case's write reaches the template. */
const template = defineTemplate((root) => {
	const main = path.join(root, "checkout");
	initCheckout(main);
	initCheckout(path.join(root, "other"));
	git(main, "worktree", "add", "-q", "--detach", path.join(root, "worktree"));
	git(main, "worktree", "add", "-q", "--detach", path.join(root, "second"));
});

let dir: string;
let home: string;
let checkout: string;
let worktree: string;
let second: string;
let other: string;

const hold = (cwd: string, args: string[], over: NodeJS.ProcessEnv = {}) =>
	runInProcess(CLI, args, {
		cwd,
		env: {
			...process.env,
			HOME: home,
			WFC_REFILL_DIR: dir,
			CLAUDE_PROJECT_DIR: cwd,
			CLAUDE_JOB_DIR: "",
			CLAUDE_CODE_SESSION_ID: "",
			...over,
		},
	});

const raise = (cwd: string, act: string, over: NodeJS.ProcessEnv = {}) =>
	hold(
		cwd,
		["raise", "--act", act, "--issue", "12", "--clear-command", "false"],
		over,
	);

const readLogLines = () =>
	fs
		.readFileSync(path.join(dir, ".refill-loop.log"), "utf8")
		.split("\n")
		.filter(Boolean);

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-hold-")));
	home = path.join(dir, "home");
	fs.mkdirSync(home);
	const trees = path.join(dir, "trees");
	template.instantiate(trees);
	checkout = path.join(trees, "checkout");
	worktree = path.join(trees, "worktree");
	second = path.join(trees, "second");
	other = path.join(trees, "other");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("repo-hold.js (#3857)", () => {
	it("lists a hold raised from a worktree from the main checkout and another worktree, not from a different checkout", () => {
		expect(raise(worktree, "repair main").status).toBe(0);

		for (const cwd of [checkout, second]) {
			const listed = hold(cwd, ["list"]);
			expect(listed.status).toBe(0);
			expect(listed.stdout).toContain("repair main");
		}
		const elsewhere = hold(other, ["list"]);
		expect(elsewhere.status).toBe(0);
		expect(elsewhere.stdout).toContain("none open");
	});

	it("lists a hold's issue, age, sessions and that it stops no launches", () => {
		const raised = hold(
			checkout,
			["raise", "--act", "repair main", "--issue", "12", "--clear-issue", "12"],
			{ CLAUDE_JOB_DIR: "/seat/jobs/abc123" },
		);
		expect(raised.status).toBe(0);

		const { status, stdout: listed } = hold(checkout, ["list"]);
		expect(status).toBe(0);
		expect(listed).toContain("1 open");
		expect(listed).toContain(
			"repair main — issue #12, age 0m, sessions: abc123, stops launches: no",
		);
	});

	it("ends a hold by hand whatever its clear check reads, with a log line for raise and lift", () => {
		const id = parseHoldId(raise(worktree, "repair main").stdout);

		const lifted = hold(checkout, ["lift", id]);

		expect(lifted.status).toBe(0);
		expect(hold(checkout, ["list"]).stdout).toContain("none open");
		const lines = readLogLines();
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(`repo hold raised: ${id}`);
		expect(lines[0]).toContain("clears on command: false");
		expect(lines[1]).toContain(`repo hold lifted by hand: ${id}`);
		expect(lines[1]).toContain("repair main");
	});

	it("refuses a lift of no open hold, with no log line", () => {
		const lifted = hold(checkout, ["lift", "abc"]);

		expect(lifted.status).toBe(1);
		expect(lifted.stderr).toContain("no open repo hold abc");
		expect(lifted.stderr).toContain("`list` names them");
		expect(fs.existsSync(path.join(dir, ".refill-loop.log"))).toBe(false);
	});

	it("will not read a lift's id as a path out of the store", () => {
		const id = parseHoldId(raise(checkout, "repair main").stdout);
		const lifted = hold(worktree, ["lift", `../${path.basename(dir)}/${id}`]);

		expect(lifted.status).toBe(1);
		expect(lifted.stderr).toContain("no open repo hold");
		expect(hold(checkout, ["list"]).stdout).toContain("repair main");
	});

	it.each([
		[["raise", "--issue", "12", "--clear-issue", "12"], "--act is required"],
		[
			["raise", "--act", "x", "--issue", "no", "--clear-issue", "12"],
			"--issue takes one issue number",
		],
		[
			["raise", "--act", "x", "--issue", "12"],
			"one of --clear-command and --clear-issue",
		],
		[
			[
				"raise",
				"--act",
				"x",
				"--issue",
				"12",
				"--clear-issue",
				"12",
				"--clear-command",
				"true",
			],
			"one of --clear-command and --clear-issue",
		],
		[
			["raise", "--act", "x", "--issue", "12", "--clear-command", " "],
			"--clear-command takes a command",
		],
		[
			["raise", "--act", "x", "--issue", "12", "--clear-issue", "no"],
			"--clear-issue takes one issue number",
		],
	])("refuses raise %j, raising nothing", (args, why) => {
		const refused = hold(checkout, args);

		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain(why);
		expect(hold(checkout, ["list"]).stdout).toContain("none open");
	});

	it.each([
		["a background job", { CLAUDE_JOB_DIR: "/seat/jobs/abc123" }],
		["any other session", { CLAUDE_CODE_SESSION_ID: "abc123" }],
	])("refuses a clear command from %s, naming the issue route", (_, env) => {
		const refused = raise(checkout, "repair main", env);

		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain(
			"--clear-command is refused from a session",
		);
		expect(refused.stderr).toContain("--clear-issue 12");
		expect(hold(checkout, ["list"]).stdout).toContain("none open");
	});

	describe("attach (#3858)", () => {
		const Job = { CLAUDE_JOB_DIR: "/seat/jobs/abc123" };
		const Other = { CLAUDE_JOB_DIR: "/seat/jobs/def456" };
		const raiseFor = (env: NodeJS.ProcessEnv) =>
			parseHoldId(
				hold(
					checkout,
					[
						"raise",
						"--act",
						"repair main",
						"--issue",
						"12",
						"--clear-issue",
						"12",
					],
					env,
				).stdout,
			);

		it("adds the session from any worktree, logs the count and prints the ending that names the hold's issue", () => {
			const id = raiseFor({ CLAUDE_JOB_DIR: "/seat/jobs/raiser" });

			const attached = hold(worktree, ["attach", id], Job);

			expect(attached.status).toBe(0);
			expect(attached.stdout).toContain(
				`needs input: attached to hold ${id} — waits on you: #12, #<yours>`,
			);
			expect(hold(checkout, ["list"]).stdout).toContain(
				"sessions: raiser, abc123",
			);
			const line = readLogLines().at(-1);
			expect(line).toContain(`repo hold attached: ${id}`);
			expect(line).toContain("session abc123; 2 attached");
		});

		it("counts a session once however often it attaches, with one log line", () => {
			const id = raiseFor({});

			hold(checkout, ["attach", id], Job);
			expect(hold(checkout, ["attach", id], Job).status).toBe(0);

			expect(hold(checkout, ["list"]).stdout).toContain("sessions: abc123,");
			expect(
				readLogLines().filter((l) => l.includes("repo hold attached")),
			).toHaveLength(1);
		});

		it("keeps both of two attaches", () => {
			const id = raiseFor({});

			hold(checkout, ["attach", id], Job);
			hold(worktree, ["attach", id], Other);

			expect(hold(checkout, ["list"]).stdout).toMatch(
				/sessions: (abc123, def456|def456, abc123)/,
			);
		});

		it("does not bring back a hold that was lifted, and leaves no late attach behind", () => {
			const id = raiseFor({});
			hold(checkout, ["attach", id], Job);
			hold(checkout, ["lift", id]);

			const late = hold(checkout, ["attach", id], Other);

			expect(late.status).toBe(1);
			expect(late.stderr).toContain(`no open repo hold ${id}`);
			expect(late.stderr).toContain("`list` names them");
			expect(hold(checkout, ["list"]).stdout).toContain("none open");
			const stores = fs.readdirSync(path.join(dir, "repo-holds"));
			for (const store of stores) {
				const inStore = path.join(dir, "repo-holds", store);
				expect(fs.readdirSync(inStore)).toEqual(["lifted"]);
				const lifts = fs.readdirSync(path.join(inStore, "lifted"));
				expect(lifts).toHaveLength(1);
				const [lift] = lifts;
				expect(
					fs.readdirSync(path.join(inStore, "lifted", lift ?? "")).sort(),
				).toEqual([`${id}.attached.abc123`, `${id}.json`].sort());
			}
		});

		it("refuses a session outside a background job, attaching nothing", () => {
			const id = raiseFor({});

			const refused = hold(checkout, ["attach", id], {
				CLAUDE_CODE_SESSION_ID: "abc123",
			});

			expect(refused.status).toBe(2);
			expect(refused.stderr).toContain("parks a background job");
			expect(refused.stderr).toContain("ask the founder here");
			expect(hold(checkout, ["list"]).stdout).toContain("sessions: none");
		});

		it("refuses a hold with no issue yet, attaching nothing and saying when to retry", () => {
			vi.stubEnv("WFC_REFILL_DIR", dir);
			const { id } = raiseHold(checkout, {
				kind: "probe",
				act: "fetch failed",
				issue: null,
				clearCheck: { probe: true },
				session: null,
				now: Date.now(),
			});

			const refused = hold(checkout, ["attach", id], Job);

			expect(refused.status).toBe(1);
			expect(refused.stderr).toContain("has no issue yet");
			expect(refused.stderr).toContain("Run this again");
			expect(hold(checkout, ["list"]).stdout).toContain("sessions: none");
		});

		it("will not read an attach's id as a path out of the store", () => {
			const attached = hold(checkout, ["attach", "../x"], Job);

			expect(attached.status).toBe(1);
			expect(attached.stderr).toContain("no open repo hold");
		});
	});

	it("keeps two checkouts whose paths flatten to one name apart", () => {
		const trees = path.dirname(checkout);
		const dashed = path.join(trees, "a-b");
		const underscored = path.join(trees, "a_b");
		initCheckout(dashed);
		initCheckout(underscored);

		raise(dashed, "repair main");

		expect(hold(underscored, ["list"]).stdout).toContain("none open");
	});

	it("refill-loop.js status lists each open hold, and whether it stops launches", async () => {
		hold(
			worktree,
			["raise", "--act", "repair main", "--issue", "12", "--clear-issue", "12"],
			{ CLAUDE_JOB_DIR: "/seat/jobs/abc123" },
		);
		vi.stubEnv("WFC_REFILL_DIR", dir);
		raiseHold(checkout, {
			kind: "probe",
			act: "fetch failed",
			issue: 13,
			clearCheck: { command: "true" },
			session: null,
			now: Date.now() - 90 * 60_000,
		});
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: Date.now(),
				stopRequested: false,
				seats: [],
				scope: { mode: "normal", repos: [checkout], exclude: [], goals: {} },
			}),
		);

		const { status, stdout } = await runInProcessAsync(
			path.join(__dirname, "refill-loop.js"),
			["status"],
			{
				cwd: other,
				env: {
					...process.env,
					HOME: home,
					WFC_REFILL_DIR: dir,
					CLAUDE_PROJECT_DIR: other,
				},
			},
		);

		expect(status).toBe(0);
		expect(stdout).toContain("holds:     2 open");
		expect(stdout).toContain(
			"checkout: fetch failed — issue #13, age 1h 30m, sessions: none, stops launches: yes",
		);
		expect(stdout).toContain(
			"checkout: repair main — issue #12, age 0m, sessions: abc123, stops launches: no",
		);
	});

	it("says so, and exits 1, where the store will not read", () => {
		fs.writeFileSync(path.join(dir, "repo-holds"), "a file, not a directory\n");

		const listed = hold(checkout, ["list"]);

		expect(listed.status).toBe(1);
		const store = path.join(dir, "repo-holds");
		expect(listed.stdout).toContain(`unread: ${store}`);
		expect(listed.stdout).toContain("lift its id or remove the file");
	});
});
