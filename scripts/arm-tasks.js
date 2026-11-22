#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { ghJson } = require("./lib/gh.js");
const { execGit, spawnGitSync } = require("./lib/git.js");
const { readProcStartOf } = require("./lib/arbiter-proc.js");
const { caught } = require("./lib/caught.js");
const { readText } = require("./lib/file-read.js");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { writeFd } = require("./lib/write-fd.js");
const { escapeRe } = require("./lib/regex-group.js");
const {
	SELF_PLUGIN_MARKETPLACE,
	buildSelfMarketplaceEntry,
} = require("./lib/core-hooks.js");
const { buildInfixTestName } = require("./lib/test-kind.js");

const TASKS_DIR = path.join(__dirname, "arm-tasks");
const SANDBOX_CLI = path.join(__dirname, "build-arm-sandbox.js");
// guess, #2044
const DEFAULT_HOLD_SECONDS = 600;
const HIDDEN_TEST_TIMEOUT_MS = 600_000;

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `Usage: node ${scriptPath("arm-tasks.js")} (build <id> --at <rev> --to <dir> [--issues <dir>] [--node-modules <dir>] [--config-dir <dir>] [--known-good] [--hold <s>] | accept <id> --sandbox <dir> [--json] | verify [<id>...] --at <rev> --node-modules <dir> [--scratch <dir>] | freeze [<id>...] --issues <dir> | coverage)`,
	commands: {
		build: {
			min: 1,
			usage: `Usage: node ${scriptPath("arm-tasks.js")} build <id> --at <rev> --to <dir> [--issues <dir>] [--node-modules <dir>] [--config-dir <dir>] [--known-good] [--hold <s>]`,
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
			usage: `Usage: node ${scriptPath("arm-tasks.js")} accept <id> --sandbox <dir> [--json]`,
			flags: { "--sandbox": "value", "--json": "boolean" },
		},
		verify: {
			max: Number.POSITIVE_INFINITY,
			usage: `Usage: node ${scriptPath("arm-tasks.js")} verify [<id>...] --at <rev> --node-modules <dir> [--scratch <dir>]`,
			flags: {
				"--at": "value",
				"--node-modules": "value",
				"--scratch": "value",
			},
		},
		freeze: {
			max: Number.POSITIVE_INFINITY,
			usage: `Usage: node ${scriptPath("arm-tasks.js")} freeze [<id>...] --issues <dir>`,
			flags: { "--issues": "value" },
		},
		coverage: { usage: `Usage: node ${scriptPath("arm-tasks.js")} coverage` },
	},
};

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {number} issue
 * @property {string[]} revert
 * @property {string} [fix]
 * @property {HiddenTest[]} hiddenTests
 * @property {{ file: string, pattern: string, why?: string }[]} docChecks
 * @property {{ path: string, name: string } | null} neighbour
 * @property {string | null} instruction
 * @property {{ kind: string, text: string } | null} pressure
 * @property {string[]} families
 */

/**
 * @typedef {object} HiddenTest
 * @property {string} file
 * @property {string[]} names
 * @property {string} [patch]
 */

const tasksFile = () =>
	process.env.WFC_ARM_TASKS || path.join(TASKS_DIR, "tasks.json");

/** @returns {Task[]} */
function loadTasks() {
	return JSON.parse(fs.readFileSync(tasksFile(), "utf8")).tasks;
}

/**
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
		});
	if (claim(sessionId).status !== 0)
		throw new Error("the neighbour's claim failed");
	const probe = claim("arm-probe");
	if (probe.status !== 1 && !probe.stderr.includes(sessionId))
		throw new Error("the neighbour's claim does not reach another session");
	const expiresAt = new Date(Date.now() + holdSeconds * 1000).toISOString();
	return { sessionId, pid, path: task.neighbour.path, holdSeconds, expiresAt };
}

/** @param {string} name */
const fixPatch = (name) => path.join(path.dirname(tasksFile()), name);

/**
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

/** @typedef {{ check: string, kind: "setup" | "work" | "info", ok: boolean, detail: string }} CheckResult */

/** @param {CheckResult} r */
const formatResult = (r) =>
	`${r.ok ? "✓" : "✗"} ${r.check}${r.detail ? ` — ${r.detail}` : ""}`;

/**
 * @param {string} text
 * @param {string} file
 * @param {string} patch
 * @param {string} scratch
 */
function patched(text, file, patch, scratch) {
	const target = path.join(scratch, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${text}\n`);
	const r = spawnGitSync(["apply", path.resolve(patch)], {
		cwd: scratch,
		encoding: "utf8",
		env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(scratch) },
	});
	return r.status === 0 ? fs.readFileSync(target, "utf8") : null;
}

/**
 * @typedef {{ fullName: string, status: "passed" | "failed" | "skipped" | "pending" | "todo" | "disabled" }} CaseResult
 * @typedef {{ numPassedTests: number, numFailedTests: number, testResults: { assertionResults: CaseResult[] }[] }} VitestReport
 */

/**
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
		const copy = buildInfixTestName(file, "accept");
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
					names.map(escapeRe).join("|"),
					"--reporter=json",
					`--outputFile=${report}`,
				],
				{ cwd: repo, encoding: "utf8", timeout: HIDDEN_TEST_TIMEOUT_MS },
			);
			if (!fs.existsSync(report)) return failed(`exit ${r.status}`);
			/** @type {VitestReport} */
			const json = JSON.parse(fs.readFileSync(report, "utf8"));
			const cases = json.testResults.flatMap((f) => f.assertionResults);
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
 * @param {string} root
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
		const got = readText(p);
		const ok = got.state === "read" && new RegExp(pattern).test(got.data);
		let detail = "";
		if (got.state === "absent") detail = "file absent";
		else if (got.state === "unreadable")
			detail = `file unreadable: ${got.message}`;
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
		if (caught(e).code !== "ESRCH") throw e;
	}
}

/**
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
 * @returns {boolean}
 */
function verifyOne(task, knownGood, { scratch, at, nodeModules }) {
	const kind = knownGood ? "good" : "bad";
	const to = path.join(scratch, `${task.id}-${kind}`);
	const config = `${to}-config`;
	fs.mkdirSync(path.join(config, "plugins"), { recursive: true });
	fs.writeFileSync(
		path.join(config, "plugins", "known_marketplaces.json"),
		JSON.stringify({
			[SELF_PLUGIN_MARKETPLACE]: buildSelfMarketplaceEntry(config),
		}),
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

const FROZEN_FIELDS =
	"number,title,body,labels,state,comments,assignees,createdAt";

/**
 * @param {number} n
 * @param {string} before
 */
function readFrozenIssue(n, before) {
	/** @type {FrozenIssue} */
	const issue = ghJson(["issue", "view", String(n), "--json", FROZEN_FIELDS]);
	const cutoff = Date.parse(before);
	return {
		...issue,
		state: "OPEN",
		assignees: [],
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

const UNIVERSAL_FAMILIES = ["commit-push", "suite-launch"];

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
