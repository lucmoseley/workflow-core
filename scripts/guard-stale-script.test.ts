// @vitest-environment node
/*
 * The parse half of mantahostels#1035: given one opaque shell string, which scripts is this
 * command about to RUN?
 *
 * "Run" is the whole question. A command that merely mentions a script — a
 * grep, a cat, an echo, a heredoc — must produce nothing, or the warning fires
 * on reading the very file it is telling you not to trust.
 *
 * What these cases pin is the argument list the guard hands its judge, and that
 * no path through the guard ever denies. So each case spawns a COPY of the
 * guard beside a stub judge that records its argv, the plugin-install shape
 * (#1), rather than asserting the real judge's verdict.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): a missed run route lets a session run a neighbour's
 * half-saved script unwarned; a mention parsed as a run warns on every read.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyLibs, sourcedLibs } from "./guard-parse-fixture";

const GUARD = path.resolve(__dirname, "guard-stale-script.sh");
const { errorLog } = createRequire(__filename)("./lib/arbiter-store.js");

let dir: string;
let repo: string;
let config: string;
let argvLog: string;
/*
 * THE CORE, STOOD UP AWAY FROM THE HOST (#1) — what a plugin install looks
 * like. `warn-stale-script.js` ships BESIDE the guard and is named from the
 * guard's own directory, never from the host root, so the stub judge is stood
 * beside a COPY of the guard here rather than inside the fake host. The
 * scripts the commands under test NAME still live in the host's `scripts/`,
 * which is the whole point: the two trees are different.
 */
let coreDir: string;
let guard: string;

const STUB_WARNING = "STUB-WARNING";

/** A copy of the guard with the real shell libraries beside it, in `coreDir`. */
function standCore() {
	copyLibs(path.join(coreDir, "lib"), sourcedLibs(GUARD));
	guard = path.join(coreDir, "guard-stale-script.sh");
	fs.copyFileSync(GUARD, guard);
	fs.chmodSync(guard, 0o755);
}

/** A stand-in judge that records its arguments and prints a warning. */
function stubJudge(prints = true) {
	fs.writeFileSync(
		path.join(coreDir, "warn-stale-script.js"),
		`require("node:fs").writeFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join("\\n"));\n` +
			(prints ? `console.log(${JSON.stringify(STUB_WARNING)});\n` : ""),
	);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-script-"));
	repo = path.join(dir, "repo");
	config = path.join(dir, "config");
	argvLog = path.join(dir, "argv");
	coreDir = path.join(dir, "core");
	fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
	fs.mkdirSync(config, { recursive: true });
	for (const f of ["pick-next.js", "thing.sh"])
		fs.writeFileSync(path.join(repo, "scripts", f), "#\n");
	standCore();
	stubJudge();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Runs the guard on `command`, as Claude Code would. */
function run(command: string) {
	const r = spawnSync(guard, [], {
		cwd: repo,
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "mine",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: repo,
			// Unset, the guard's fail-open records would append to the founder's own
			// log and manufacture the faults check-guard-errors.js exists to report.
			CLAUDE_CONFIG_DIR: config,
		},
	});
	expect(r.status).toBe(0);
	return r;
}

/** The candidates the guard handed the judge, session id dropped. */
function candidates(command: string) {
	run(command);
	if (!fs.existsSync(argvLog)) return null; // the judge was never called
	const argv = fs.readFileSync(argvLog, "utf8").split("\n");
	expect(argv[0]).toBe("mine");
	return argv.slice(1);
}

describe("the scripts a command runs", () => {
	it("reads one run under an interpreter", () => {
		expect(candidates("node scripts/pick-next.js --json")).toEqual([
			path.join(repo, "scripts/pick-next.js"),
		]);
	});

	it("reads one run as the command itself", () => {
		expect(candidates("./scripts/thing.sh")).toEqual([
			path.join(repo, "scripts/thing.sh"),
		]);
	});

	it("reads every script a compound command runs", () => {
		expect(
			candidates("bash scripts/thing.sh && node scripts/pick-next.js"),
		).toEqual([
			path.join(repo, "scripts/thing.sh"),
			path.join(repo, "scripts/pick-next.js"),
		]);
	});

	it("passes an `npm run` by script name, for package.json to expand", () => {
		expect(candidates("npm run check:ci")).toEqual(["npm-script:check:ci"]);
	});

	it("reads the script run, never the script paths passed to it", () => {
		// `node scripts/session-arbiter.js claim scripts/foo.js` is the contention
		// poll CLAUDE.md prescribes; warning about its argument would fire the guard
		// on the very command sent to ask whether that file is free.
		expect(
			candidates("node scripts/pick-next.js claim scripts/thing.sh"),
		).toEqual([path.join(repo, "scripts/pick-next.js")]);
	});

	it("takes an absolute path as given", () => {
		expect(candidates(`node ${repo}/scripts/pick-next.js`)).toEqual([
			path.join(repo, "scripts/pick-next.js"),
		]);
	});
});

describe("what must not be read as a run", () => {
	it.each([
		["a script read rather than run", "cat scripts/pick-next.js"],
		["a script searched", "grep -n hang scripts/pick-next.js"],
		["a path inside a quoted span", 'echo "node scripts/pick-next.js"'],
		["a path that does not exist", "node scripts/not-here.js"],
		["an ordinary command", "ls -la && free -m"],
		["an npm command that runs no script", "npm ci"],
	])("%s", (_what, command) => {
		expect(candidates(command)).toBeNull();
	});
});

describe("the verdict", () => {
	it("emits the judge's words as context, and never a decision", () => {
		const out = run("node scripts/pick-next.js").stdout;
		const parsed = JSON.parse(out);
		expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(parsed.hookSpecificOutput.additionalContext).toContain(STUB_WARNING);
		expect(out).not.toContain("permissionDecision");
	});

	it("says nothing at all when the judge does", () => {
		stubJudge(false);
		expect(run("node scripts/pick-next.js").stdout).toBe("");
	});
});

describe("failing open", () => {
	/*
	 * errorLog() derives its path from the environment, so the sandbox's is put
	 * back afterwards — the suite's afterEach deletes these directories, and a
	 * leaked value would point a later suite's log at a path that is gone.
	 */
	const logLines = () => {
		const saved = { ...process.env };
		process.env.CLAUDE_CONFIG_DIR = config;
		process.env.CLAUDE_PROJECT_DIR = repo;
		try {
			const at = errorLog();
			return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
		} finally {
			process.env = saved;
		}
	};

	it("records the judge being unrunnable, rather than passing silently", () => {
		fs.rmSync(path.join(coreDir, "warn-stale-script.js"));
		expect(run("node scripts/pick-next.js").stdout).toBe("");
		expect(logLines()).toContain("guard-stale-script.sh");
		expect(logLines()).toContain("allowed unchecked");
	});

	it("records a judge that exits non-zero", () => {
		fs.writeFileSync(
			path.join(coreDir, "warn-stale-script.js"),
			"process.exit(3);\n",
		);
		expect(run("node scripts/pick-next.js").stdout).toBe("");
		expect(logLines()).toContain("guard-stale-script.sh");
	});

	it("allows unchecked, and records, when the payload names no session", () => {
		// Without a session id, this session's own claims are indistinguishable
		// from a neighbour's, so every warning would be about the reader's own
		// work in progress.
		const r = spawnSync(guard, [], {
			cwd: repo,
			encoding: "utf8",
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "node scripts/pick-next.js" },
			}),
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: repo,
				CLAUDE_CONFIG_DIR: config,
			},
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(fs.existsSync(argvLog)).toBe(false); // the judge was never asked
		expect(logLines()).toContain("no session_id");
	});

	it("stays silent, and records nothing, on a command it judges cleanly", () => {
		run("ls -la");
		expect(logLines()).toBe("");
	});
});
