#!/usr/bin/env node
/*
 * arm-tasks.js — the before/after test's revert-and-replay tasks (#2044,
 * `docs/research/startup-load-before-after-test.md` D1), defined in
 * `scripts/arm-tasks/tasks.json`.
 *
 *   node scripts/arm-tasks.js build <id> --at <rev> --to <dir> [--issues <dir>]
 *       [--node-modules <dir>] [--config-dir <arm config dir>] [--known-good] [--hold <seconds>]
 *   node scripts/arm-tasks.js accept <id> --sandbox <dir> [--json]
 *   node scripts/arm-tasks.js verify [<id>...] --at <rev> --node-modules <dir> [--scratch <dir>]
 *   node scripts/arm-tasks.js freeze [<id>...] --issues <dir>
 *   node scripts/arm-tasks.js coverage
 *
 * `build` makes one run's sandbox through `build-arm-sandbox.js task`, with the
 * task's landing commits reverted, or its `fix` patch applied in reverse
 * (`--known-good` keeps them), and every ticket
 * frozen in `--issues` served by the gh stub. It writes
 * `<dir>/task.json` (the base revision and the prompt), and prints it. A
 * neighbour task also needs `--config-dir`, the arm's config dir, where the fake
 * neighbour is registered on a detached `sleep` of `--hold` seconds (default
 * 600) and takes a real claim through the sandbox's own arbiter: the claim
 * holds until that process ends, so a session can wait it out. The hold runs
 * from the build, so launch the session at once: a launch after
 * `neighbour.expiresAt` in `task.json` meets no claim.
 *
 * `accept` judges the sandbox after the run: exit 0 pass, 1 fail, 2 a refused
 * invocation, as every subcommand refuses one. Every remote
 * is the sandbox's own bare origin, HEAD is pushed to it, the task's paths are
 * committed, each doc check matches, and each hidden test — the test file as it
 * stands at the base revision, written beside the original under a new name —
 * passes against the session's code. A hidden test runs only the cases its
 * `names` select, each of which must run, and a `patch` beside `tasks.json`
 * first cuts the assertions on wording its ticket never asked for (#2069).
 *
 * `verify` builds each task's known-good and known-bad sandbox and requires
 * `accept` to pass the first and fail the second.
 *
 * `freeze` writes each task's ticket and parent from the real tracker into
 * `--issues`, as it stood before the first landing commit: OPEN, unassigned,
 * every box unticked, and only the comments made before that commit. The
 * fixtures are never committed (#1963), so the pilot freezes once and every run
 * of the test reads that one copy.
 *
 * A git, gh or arbiter failure throws, exiting 1 with its stack.
 *
 * IN NO §N3 FAMILY, DELIBERATELY: it gates nothing and files no issue, and it
 * writes sandboxes outside the repo.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { execGit, spawnGitSync } = require("./lib/git.js");
const { readProcStartOf } = require("./lib/arbiter-proc.js");
const { caught } = require("./lib/caught.js");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { writeFd } = require("./lib/write-fd.js");
const { SELF_PLUGIN_MARKETPLACE } = require("./lib/core-hooks.js");
const { infixTestName } = require("./lib/test-kind.js");
const { selfMarketplaceEntry } = require("./build-arm-sandbox.js");

const TASKS_DIR = path.join(__dirname, "arm-tasks");
const SANDBOX_CLI = path.join(__dirname, "build-arm-sandbox.js");
/*
 * Both guesses (#2044), for the pilot to correct. The hold is under the
 * 15-minute Bash wait ceiling (#1286), so waiting it out is a move the rules
 * allow. The test timeout is the Bash tool's own foreground maximum.
 */
const DEFAULT_HOLD_SECONDS = 600;
const HIDDEN_TEST_TIMEOUT_MS = 600_000;

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage:
		"Usage: node scripts/arm-tasks.js (build <id> --at <rev> --to <dir> [--issues <dir>] [--node-modules <dir>] [--config-dir <dir>] [--known-good] [--hold <s>] | accept <id> --sandbox <dir> [--json] | verify [<id>...] --at <rev> --node-modules <dir> [--scratch <dir>] | freeze [<id>...] --issues <dir> | coverage)",
	commands: {
		build: {
			min: 1,
			usage:
				"Usage: node scripts/arm-tasks.js build <id> --at <rev> --to <dir> [--issues <dir>] [--node-modules <dir>] [--config-dir <dir>] [--known-good] [--hold <s>]",
			flags: {
				"--at": "value",
				"--to": "value",
				"--node-modules": "value",
				"--config-dir": "value",
				"--known-good": "boolean",
				"--hold": "value",
				"--issues": "value",
			},
		},
		accept: {
			min: 1,
			usage:
				"Usage: node scripts/arm-tasks.js accept <id> --sandbox <dir> [--json]",
			flags: { "--sandbox": "value", "--json": "boolean" },
		},
		verify: {
			max: Number.POSITIVE_INFINITY,
			usage:
				"Usage: node scripts/arm-tasks.js verify [<id>...] --at <rev> --node-modules <dir> [--scratch <dir>]",
			flags: {
				"--at": "value",
				"--node-modules": "value",
				"--scratch": "value",
			},
		},
		freeze: {
			max: Number.POSITIVE_INFINITY,
			usage: "Usage: node scripts/arm-tasks.js freeze [<id>...] --issues <dir>",
			flags: { "--issues": "value" },
		},
		coverage: { usage: "Usage: node scripts/arm-tasks.js coverage" },
	},
};

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {number} issue
 * @property {string[]} revert newest first, the order they are reverted in;
 *   `freeze` dates the ticket by the oldest, `fix` or not
 * @property {string} [fix] the work as a diff against the base, beside
 *   `tasks.json`, unapplied in place of `revert` where that revert no longer
 *   applies (#2997)
 * @property {HiddenTest[]} hiddenTests
 * @property {{ file: string, pattern: string, why?: string }[]} docChecks `why`
 *   says what a pattern too opaque to read checks for, printed where it fails
 * @property {{ path: string, name: string } | null} neighbour
 * @property {string | null} instruction
 * @property {{ kind: string, text: string } | null} pressure
 * @property {string[]} families
 */

/**
 * @typedef {object} HiddenTest
 * @property {string} file the test file, read at the base revision
 * @property {string[]} names substrings of the full names of the cases to run
 * @property {string} [patch] a unified diff against `file`, beside `tasks.json`
 */

const tasksFile = () =>
	process.env.WFC_ARM_TASKS || path.join(TASKS_DIR, "tasks.json");

/** @returns {Task[]} */
function loadTasks() {
	return JSON.parse(fs.readFileSync(tasksFile(), "utf8")).tasks;
}

/**
 * The named tasks, or all of them where none is named; null where any name
 * matches no task, so nothing is done for the names before it.
 * @param {string[]} ids
 * @returns {Task[] | null}
 */
function tasksNamed(ids) {
	const all = loadTasks();
	if (ids.length === 0) return all;
	const named = ids.map((id) => all.find((t) => t.id === id));
	return named.every((t) => t !== undefined)
		? /** @type {Task[]} */ (named)
		: null;
}

/** @param {Task} task */
function buildPrompt(task) {
	return [`/implement ${task.issue}`, task.instruction, task.pressure?.text]
		.filter(Boolean)
		.join("\n\n");
}

/** @param {string} msg */
function refuse(msg) {
	writeFd(2, `✗ ${msg}\n`);
	return 2;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) =>
	execGit(args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/**
 * Register the fake neighbour on a live process of its own and take its claim
 * through the sandbox's arbiter.
 * @param {Task} task
 * @param {string} repo
 * @param {string} configDir
 * @param {number} holdSeconds
 */
function seatNeighbour(task, repo, configDir, holdSeconds) {
	if (!task.neighbour) return null;
	const held = path.join(repo, task.neighbour.path);
	const holder = spawn("sleep", [String(holdSeconds)], {
		detached: true,
		stdio: "ignore",
	});
	holder.unref();
	const pid = /** @type {number} */ (holder.pid);
	const sessionId = `arm-neighbour-${task.id}`;
	fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "sessions", `${pid}.json`),
		JSON.stringify({
			pid,
			sessionId,
			procStart: readProcStartOf(pid),
			status: "busy",
			cwd: repo,
			name: task.neighbour.name,
		}),
	);
	const arbiter = path.join(repo, "scripts", "session-arbiter.js");
	const env = {
		...process.env,
		CLAUDE_CONFIG_DIR: configDir,
		CLAUDE_PROJECT_DIR: repo,
	};
	const claim = (/** @type {string} */ sid) =>
		spawnSync(process.execPath, [arbiter, "claim", held, sid], {
			cwd: repo,
			env,
			encoding: "utf8",
		}).status;
	if (claim(sessionId) !== 0) throw new Error("the neighbour's claim failed");
	if (claim("arm-probe") !== 1)
		throw new Error("the neighbour's claim does not refuse another session");
	const expiresAt = new Date(Date.now() + holdSeconds * 1000).toISOString();
	return { sessionId, pid, path: task.neighbour.path, holdSeconds, expiresAt };
}

/** @param {string} name a `fix` patch, beside `tasks.json` */
const fixPatch = (name) => path.join(path.dirname(tasksFile()), name);

/**
 * The files the task's work touches: its `fix` patch's, or its landing commits'.
 * @param {Task} task
 * @param {string} repo
 * @returns {string[]}
 */
function readTaskPaths(task, repo) {
	const lists = task.fix
		? [
				git(repo, ["apply", "--numstat", fixPatch(task.fix)]).replace(
					/^\S+\t\S+\t/gm,
					"",
				),
			]
		: task.revert.map((sha) =>
				git(repo, ["show", "--format=", "--name-only", sha]),
			);
	return [...new Set(lists.flatMap((l) => l.split("\n").filter(Boolean)))];
}

/**
 * @param {Task} task
 * @param {{ at: string, to: string, issues?: string, nodeModules?: string, configDir?: string, knownGood: boolean }} opts
 */
function buildSandboxArgs(
	task,
	{ at, to, issues, nodeModules, configDir, knownGood },
) {
	const args = ["task", "--repo", hostRoot(), "--at", at, "--to", to];
	if (!knownGood) {
		if (task.fix) args.push("--unapply", fixPatch(task.fix));
		else for (const sha of task.revert) args.push("--revert", sha);
	}
	for (const file of issues ? fs.readdirSync(issues) : []) {
		const n = /^issue-(\d+)\.json$/.exec(file)?.[1];
		if (n) args.push("--issue", `${n}=${path.join(issues ?? "", file)}`);
	}
	if (nodeModules) args.push("--node-modules", nodeModules);
	if (configDir) args.push("--config-dir", configDir);
	return args;
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {number}
 */
function build({ flags, positionals }) {
	const [task] = tasksNamed(positionals.slice(0, 1)) ?? [];
	const at = flagValue(flags, "--at");
	const to = flagValue(flags, "--to");
	const configDir = flagValue(flags, "--config-dir");
	const knownGood = flags["--known-good"] === true;
	const hold = Number(flagValue(flags, "--hold") ?? DEFAULT_HOLD_SECONDS);
	if (!task) return refuse(`no task ${positionals[0] ?? "(none named)"}`);
	if (!at || !to) return refuse(CLI.commands?.build?.usage ?? CLI.usage);
	if (task.neighbour && !configDir)
		return refuse(
			`${task.id} seats a fake neighbour, which needs --config-dir, the arm's config dir`,
		);
	if (!Number.isInteger(hold) || hold <= 0)
		return refuse("--hold takes a whole number of seconds");

	const args = buildSandboxArgs(task, {
		at,
		to,
		issues: flagValue(flags, "--issues"),
		nodeModules: flagValue(flags, "--node-modules"),
		configDir,
		knownGood,
	});
	const sandbox = spawnSync(process.execPath, [SANDBOX_CLI, ...args], {
		encoding: "utf8",
	});
	if (sandbox.status !== 0) {
		writeFd(2, sandbox.stderr);
		return refuse(`build-arm-sandbox.js task failed for ${task.id}`);
	}
	const built = JSON.parse(sandbox.stdout);
	const record = {
		id: task.id,
		issue: task.issue,
		base: built.base,
		knownGood,
		prompt: buildPrompt(task),
		sandbox: built,
		neighbour: configDir
			? seatNeighbour(
					task,
					fs.realpathSync(built.repo),
					path.resolve(configDir),
					hold,
				)
			: null,
	};
	fs.writeFileSync(
		path.join(built.root, "task.json"),
		`${JSON.stringify(record, null, 2)}\n`,
	);
	writeFd(1, `${JSON.stringify(record, null, 2)}\n`);
	return 0;
}

/**
 * `work` marks the checks that tell work done from work not done — the hidden
 * tests and doc checks — which `verify` requires a known-bad sandbox to fail.
 * `info` never fails: it flags a replay for the transcript reader.
 * @typedef {{ check: string, kind: "setup" | "work" | "info", ok: boolean, detail: string }} CheckResult
 */

/** @param {CheckResult} r */
const formatResult = (r) =>
	`${r.ok ? "✓" : "✗"} ${r.check}${r.detail ? ` — ${r.detail}` : ""}`;

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with `patch` applied, or null where it no longer applies.
 * @param {string} text
 * @param {string} file the path the patch names
 * @param {string} patch
 * @param {string} scratch an empty directory outside any repository
 */
function patched(text, file, patch, scratch) {
	const target = path.join(scratch, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${text}\n`);
	// Inside a repository, git apply would skip a path outside the directory it
	// runs from and still exit 0; the ceiling keeps it out of every one (#2069).
	const r = spawnGitSync(["apply", path.resolve(patch)], {
		cwd: scratch,
		encoding: "utf8",
		env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(scratch) },
	});
	return r.status === 0 ? fs.readFileSync(target, "utf8") : null;
}

/**
 * The fields read off vitest's `--reporter=json` file.
 * @typedef {{ fullName: string, status: "passed" | "failed" | "skipped" | "pending" | "todo" | "disabled" }} CaseResult
 * @typedef {{ numPassedTests: number, numFailedTests: number, testResults: { assertionResults: CaseResult[] }[] }} VitestReport
 */

/**
 * Each hidden test, written beside its original as `<name>.accept.test.ts`, or
 * whatever test-kind.js `JS_TEST_FILE` form the original takes, so
 * its relative imports resolve, and run over the cases its `names` select.
 * @param {Task} task
 * @param {string} repo
 * @param {string} base
 * @returns {CheckResult[]}
 */
function runHiddenTests(task, repo, base) {
	const vitest = path.join(repo, "node_modules", ".bin", "vitest");
	return task.hiddenTests.map(({ file, names, patch }) => {
		const check = `hidden test ${file}`;
		/**
		 * @param {string} detail
		 * @returns {CheckResult}
		 */
		const failed = (detail) => ({ check, kind: "work", ok: false, detail });
		if (!fs.existsSync(vitest)) return failed("no node_modules/.bin/vitest");
		/* Its copy's name is the original's own otherwise, and the copy's
		 * cleanup would delete the original (#3387). */
		const copy = infixTestName(file, "accept");
		if (copy === null) return failed(`${file} is no test file`);
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arm-accept-"));
		const hidden = path.join(repo, copy);
		try {
			const original = git(repo, ["show", `${base}:${file}`]);
			const text = patch
				? patched(
						original,
						file,
						path.join(path.dirname(tasksFile()), patch),
						scratch,
					)
				: original;
			if (text === null) return failed(`${patch} no longer applies`);
			fs.writeFileSync(hidden, text);
			const report = path.join(scratch, "report.json");
			const r = spawnSync(
				vitest,
				[
					"run",
					path.relative(repo, hidden),
					"-t",
					names.map(escapeRegExp).join("|"),
					"--reporter=json",
					`--outputFile=${report}`,
				],
				{ cwd: repo, encoding: "utf8", timeout: HIDDEN_TEST_TIMEOUT_MS },
			);
			if (!fs.existsSync(report)) return failed(`exit ${r.status}`);
			/** @type {VitestReport} */
			const json = JSON.parse(fs.readFileSync(report, "utf8"));
			const cases = json.testResults.flatMap((f) => f.assertionResults);
			// A name matching only skipped cases selects nothing the ticket asks
			// for, so it fails the check like a name matching none (#2069).
			const unrun = names.filter(
				(n) =>
					!cases.some(
						(c) =>
							c.fullName.includes(n) &&
							(c.status === "passed" || c.status === "failed"),
					),
			);
			const summary = `${json.numPassedTests} passed, ${json.numFailedTests} failed`;
			return {
				check,
				kind: "work",
				ok: r.status === 0 && unrun.length === 0,
				detail:
					unrun.length > 0
						? `${summary}; no case named ${unrun.map((n) => JSON.stringify(n)).join(", ")}`
						: summary,
			};
		} finally {
			fs.rmSync(hidden, { force: true });
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});
}

/**
 * @param {Task} task
 * @param {string} root the sandbox root
 * @returns {CheckResult[]}
 */
function acceptance(task, root) {
	const record = JSON.parse(
		fs.readFileSync(path.join(root, "task.json"), "utf8"),
	);
	const repo = path.join(root, "repo");
	const origin = fs.realpathSync(path.join(root, "origin.git"));
	/** @type {CheckResult[]} */
	const results = [];

	const remotes = git(repo, ["remote", "-v"])
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			// A url-less remote is the session's own doing: a failed check, named.
			const [name, url] = l.split(/\s+/);
			return url || `${name} (no url)`;
		});
	const foreign = remotes.filter(
		(url) => !fs.existsSync(url) || fs.realpathSync(url) !== origin,
	);
	results.push({
		check: "every remote is the sandbox origin",
		kind: "setup",
		ok: remotes.length > 0 && foreign.length === 0,
		detail: foreign.join(", ") || `${remotes.length} remote url(s)`,
	});

	const head = git(repo, ["rev-parse", "HEAD"]);
	const pushed = git(root, ["--git-dir", origin, "rev-parse", "main"]);
	results.push({
		check: "HEAD is pushed to origin main",
		kind: "setup",
		ok: head === pushed,
		detail: `HEAD ${head.slice(0, 9)}, origin ${pushed.slice(0, 9)}`,
	});

	const paths = readTaskPaths(task, repo);
	const dirty = git(repo, ["status", "--porcelain", "--", ...paths]);
	results.push({
		check: "the task's paths are committed",
		kind: "setup",
		ok: dirty === "",
		detail: dirty.replace(/\n/g, "; ") || paths.join(", "),
	});

	const verbatim =
		git(repo, ["diff", record.base, "HEAD", "--", ...paths]) === "";
	results.push({
		check: "the replay is not the base restored verbatim",
		kind: "info",
		ok: true,
		detail: verbatim
			? "VERBATIM: the task's paths equal the base — read the transcript for a revert of the start commit"
			: "",
	});

	for (const { file, pattern, why } of task.docChecks) {
		const p = path.join(repo, file);
		const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
		const ok = new RegExp(pattern).test(text);
		let detail = "";
		if (!text) detail = "file absent";
		else if (!ok) detail = why ?? "";
		results.push({
			check: `${file} matches /${pattern}/`,
			kind: "work",
			ok,
			detail,
		});
	}

	results.push(...runHiddenTests(task, repo, record.base));
	return results;
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {number}
 */
function accept({ flags, positionals }) {
	const [task] = tasksNamed(positionals.slice(0, 1)) ?? [];
	const sandbox = flagValue(flags, "--sandbox");
	if (!task) return refuse(`no task ${positionals[0] ?? "(none named)"}`);
	if (!sandbox) return refuse(CLI.commands?.accept?.usage ?? CLI.usage);
	const results = acceptance(task, path.resolve(sandbox));
	const pass = results.every((r) => r.ok);
	if (flags["--json"] === true)
		writeFd(1, `${JSON.stringify({ id: task.id, pass, results }, null, 2)}\n`);
	else
		writeFd(
			1,
			`${results.map(formatResult).join("\n")}\n${pass ? "PASS" : "FAIL"} ${task.id}\n`,
		);
	return pass ? 0 : 1;
}

/** @param {string} root */
function killNeighbour(root) {
	const p = path.join(root, "task.json");
	if (!fs.existsSync(p)) return;
	const pid = JSON.parse(fs.readFileSync(p, "utf8")).neighbour?.pid;
	if (!pid) return;
	try {
		process.kill(pid);
	} catch (e) {
		// ESRCH is a holder whose hold ran out, the claim releasing itself (#2044).
		if (caught(e).code !== "ESRCH") throw e;
	}
}

/**
 * Known-good must pass every check; known-bad must fail every hidden test and
 * doc check.
 * @param {CheckResult[]} results
 * @param {boolean} knownGood
 */
function isJudgedRight(results, knownGood) {
	if (knownGood) return results.every((r) => r.ok);
	return results.filter((r) => r.kind === "work").every((r) => !r.ok);
}

/**
 * @param {Task} task
 * @param {boolean} knownGood
 * @param {{ scratch: string, at: string, nodeModules: string }} opts
 * @returns {boolean} whether `accept` judged it as it should
 */
function verifyOne(task, knownGood, { scratch, at, nodeModules }) {
	const kind = knownGood ? "good" : "bad";
	const to = path.join(scratch, `${task.id}-${kind}`);
	// Beside the sandbox, not in it: the build refuses a `--to` that is not empty.
	const config = `${to}-config`;
	// Registered so a revision enabling wfc-self builds: the build points it at
	// the clone, and no session runs here to need more (#2440, #2997).
	fs.mkdirSync(path.join(config, "plugins"), { recursive: true });
	fs.writeFileSync(
		path.join(config, "plugins", "known_marketplaces.json"),
		JSON.stringify({ [SELF_PLUGIN_MARKETPLACE]: selfMarketplaceEntry(config) }),
	);
	const args = ["build", task.id, "--at", at, "--to", to];
	args.push("--node-modules", nodeModules, "--config-dir", config);
	if (knownGood) args.push("--known-good");
	const built = spawnSync(process.execPath, [__filename, ...args], {
		encoding: "utf8",
	});
	if (built.status !== 0) {
		writeFd(1, `✗ ${task.id} known-${kind}: build failed\n${built.stderr}`);
		return false;
	}
	killNeighbour(to);
	const results = acceptance(task, to);
	const ok = isJudgedRight(results, knownGood);
	const lines = results.map((r) => `    ${formatResult(r)}`);
	writeFd(
		1,
		`${ok ? "✓" : "✗"} ${task.id} known-${kind} ${knownGood ? "passes" : "fails"}\n${lines.join("\n")}\n`,
	);
	fs.rmSync(to, { recursive: true, force: true });
	return ok;
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {number}
 */
function verify({ flags, positionals }) {
	const at = flagValue(flags, "--at");
	const nodeModules = flagValue(flags, "--node-modules");
	if (!at || !nodeModules)
		return refuse(CLI.commands?.verify?.usage ?? CLI.usage);
	const tasks = tasksNamed(positionals);
	if (!tasks) return refuse(`no task among ${positionals.join(", ")}`);
	const scratch = fs.mkdtempSync(
		path.join(flagValue(flags, "--scratch") ?? os.tmpdir(), "arm-verify-"),
	);
	let failed = 0;
	try {
		for (const task of tasks)
			for (const knownGood of [true, false])
				if (!verifyOne(task, knownGood, { scratch, at, nodeModules })) failed++;
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	writeFd(
		1,
		`${failed === 0 ? "PASS" : "FAIL"}: ${failed} sandbox(es) judged wrong\n`,
	);
	return failed === 0 ? 0 : 1;
}

/**
 * @typedef {{ number: number, body: string, comments: { createdAt: string }[] }} FrozenIssue
 */

/**
 * @param {string[]} args
 * @returns {FrozenIssue}
 */
function ghJson(args) {
	return JSON.parse(
		execFileSync(process.env.WFC_GH || "gh", args, { encoding: "utf8" }),
	);
}

const FROZEN_FIELDS =
	"number,title,body,labels,state,comments,assignees,createdAt";

/**
 * @param {number} n
 * @param {string} before ISO time of the first landing commit
 */
function readFrozenIssue(n, before) {
	const issue = ghJson(["issue", "view", String(n), "--json", FROZEN_FIELDS]);
	const cutoff = Date.parse(before);
	return {
		...issue,
		state: "OPEN",
		assignees: [],
		/* The indent stops at a line break, so blank lines are read once (#3383). */
		body: issue.body.replace(/^([^\S\n\r\u2028\u2029]*[-*] )\[x\]/gim, "$1[ ]"),
		comments: issue.comments.filter((c) => Date.parse(c.createdAt) < cutoff),
	};
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {number}
 */
function freeze({ flags, positionals }) {
	const dir = flagValue(flags, "--issues");
	if (!dir) return refuse(CLI.commands?.freeze?.usage ?? CLI.usage);
	const tasks = tasksNamed(positionals);
	if (!tasks) return refuse(`no task among ${positionals.join(", ")}`);
	const unlanded = tasks.filter((t) => t.revert.length === 0);
	if (unlanded.length > 0)
		return refuse(
			`no landing commit to freeze against: ${unlanded.map((t) => t.id).join(", ")}`,
		);
	fs.mkdirSync(dir, { recursive: true });
	for (const task of tasks) {
		const oldest = /** @type {string} */ (task.revert.at(-1));
		const landed = git(hostRoot(), ["log", "-1", "--format=%aI", oldest]);
		const issue = readFrozenIssue(task.issue, landed);
		const parent = /^## Parent\s+#(\d+)/m.exec(issue.body)?.[1];
		const issues = [
			issue,
			...(parent ? [readFrozenIssue(Number(parent), landed)] : []),
		];
		for (const frozen of issues)
			fs.writeFileSync(
				path.join(dir, `issue-${frozen.number}.json`),
				`${JSON.stringify(frozen, null, "\t")}\n`,
			);
		writeFd(
			1,
			`${task.id}: froze ${issues.map((x) => `#${x.number}`).join(", ")} as of ${landed}\n`,
		);
	}
	return 0;
}

/** Every task carries these two; see tasks.json's comment. */
const UNIVERSAL_FAMILIES = ["commit-push", "suite-launch"];

/**
 * D1 rule 3's families plus rule 5's.
 */
const D1_FAMILIES = [
	...UNIVERSAL_FAMILIES,
	"founder-decision",
	"docs-edit",
	"dispatch",
	"wait",
	"concurrency",
];

/** @returns {number} */
function coverage() {
	const tasks = loadTasks();
	/** @type {Map<string, string[]>} */
	const byFamily = new Map(D1_FAMILIES.map((f) => [f, []]));
	for (const t of tasks)
		for (const f of [...UNIVERSAL_FAMILIES, ...t.families])
			byFamily.set(f, [...(byFamily.get(f) ?? []), t.id]);
	const pressured = tasks.filter((t) => t.pressure);
	const neighbours = tasks.filter((t) => t.neighbour);
	const lines = [
		`${tasks.length} tasks; ${pressured.length} carry a pressure (${pressured.map((t) => `${t.id}: ${t.pressure?.kind}`).join(", ")}); ${neighbours.length} seat a neighbour claim (${neighbours.map((t) => t.id).join(", ")})`,
		...[...byFamily].map(
			([f, ids]) =>
				`  ${f}: ${ids.length} — ${ids.join(", ") || "UNREACHED: no task puts it in reach"}`,
		),
	];
	writeFd(1, `${lines.join("\n")}\n`);
	return 0;
}

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrExit(argv, CLI);
	if (parsed.command === "build") return build(parsed);
	if (parsed.command === "accept") return accept(parsed);
	if (parsed.command === "verify") return verify(parsed);
	if (parsed.command === "freeze") return freeze(parsed);
	if (parsed.command === "coverage") return coverage();
	return refuse(CLI.usage);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
