// @vitest-environment node
/*
 * self-plugin-canary.sh refuses every tool call in a session the self-plugin
 * did not load, and write-self-plugin-marker.sh, the self-plugin's SessionStart
 * hook, writes the marker that lets a loaded session through (#2438, spec
 * #2295 seam 2).
 *
 * Break the canary and a session missing the self-plugin works the repo with
 * no guards and nothing said, or a guarded one is refused at every call.
 *
 * The setup-line cases build real git checkouts and a worktree, since the
 * canary resolves the main checkout from git's own common dir (#2461).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweptMarkers } from "./lib/arbiter-testkit";
import { initGitRepo } from "./lib/git-fixture";

const { projectSlug } = require("./lib/project-slug") as {
	projectSlug: (root: string) => string;
};

const CANARY = path.resolve(__dirname, "self-plugin-canary.sh");
const WRITER = path.resolve(__dirname, "write-self-plugin-marker.sh");
const ROOT = path.resolve(__dirname, "..");
const SID = "aaaaaaaa-1111-2222-3333-444444444444";

let dir: string;
let repo: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "self-plugin-canary-"));
	repo = fs.realpathSync(dir);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(script: string, input: string, env: NodeJS.ProcessEnv = {}) {
	return spawnSync(script, [], {
		cwd: repo,
		encoding: "utf8",
		input,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: repo,
			// Unset, a fail-open record would append to the founder's own log.
			CLAUDE_CONFIG_DIR: path.join(repo, "config"),
			...env,
		},
	});
}

function startSession(source: string, session = SID) {
	const r = run(
		WRITER,
		JSON.stringify({
			session_id: session,
			hook_event_name: "SessionStart",
			source,
		}),
	);
	expect(r.status).toBe(0);
	expect(r.stdout + r.stderr).toBe("");
}

function call(payload: object | string, env: NodeJS.ProcessEnv = {}) {
	return run(
		CANARY,
		typeof payload === "string" ? payload : JSON.stringify(payload),
		env,
	);
}

const bash = (session: string, extra: object = {}) => ({
	session_id: session,
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: "ls" },
	...extra,
});

const PLACEHOLDER = "<absolute path to the main checkout>";

/** The setup line's arguments, as bash would parse the pasted `!` line. */
function pastedArgs(stderr: string) {
	const line = stderr.split("\n").find((l) => l.startsWith("! "));
	expect(line).toBeDefined();
	const r = spawnSync(
		"bash",
		["-c", `set -- ${line?.slice(2)}; printf '%s\\0' "$@"`],
		{ encoding: "utf8" },
	);
	expect(r.status).toBe(0);
	return r.stdout.split("\0").slice(0, -1);
}

function expectRefused(r: ReturnType<typeof call>, main = PLACEHOLDER) {
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("the wfc-self self-plugin did not load");
	expect(pastedArgs(r.stderr)).toEqual([
		"claude",
		"plugin",
		"marketplace",
		"add",
		`${main}/self-plugin`,
		"--scope",
		"user",
	]);
	expect(r.stderr).toContain("Then restart the session");
	expect(r.stderr).toContain("A cloud session cannot load the self-plugin");
}

describe("a session the self-plugin loaded", () => {
	it.each(["startup", "resume", "clear", "compact"])(
		"is allowed once the writer has run on a %s start",
		(source) => {
			startSession(source);
			const r = call(bash(SID));
			expect(r.status).toBe(0);
			expect(r.stdout + r.stderr).toBe("");
		},
	);

	it("covers a subagent's call under its parent's session id", () => {
		startSession("startup");
		expect(call(bash(SID, { agent_id: "a1b2c3" })).status).toBe(0);
	});

	it("reads the marker from CLAUDE_PROJECT_DIR, not the cwd", () => {
		startSession("startup");
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "canary-cwd-"));
		try {
			const r = spawnSync(CANARY, [], {
				cwd: elsewhere,
				encoding: "utf8",
				input: JSON.stringify(bash(SID)),
				env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
			});
			expect(r.status).toBe(0);
		} finally {
			fs.rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

describe("a session the self-plugin did not load", () => {
	it("is refused with no marker, naming the setup line and the restart", () => {
		const r = call(bash(SID));
		expectRefused(r);
		expect(r.stderr).not.toContain("could not check this session");
	});

	it("is refused where only another session has a marker", () => {
		startSession("startup", "bbbbbbbb-5555-6666-7777-888888888888");
		expectRefused(call(bash(SID)));
	});

	it("is refused in a cloud session too: no CLAUDE_CODE_REMOTE exemption", () => {
		expectRefused(call(bash(SID), { CLAUDE_CODE_REMOTE: "true" }));
	});
});

describe("the setup line", () => {
	function checkout(name: string) {
		const at = path.join(repo, name);
		const hooks = path.join(repo, "no-hooks");
		fs.mkdirSync(hooks, { recursive: true });
		initGitRepo(at, hooks);
		return at;
	}

	it("names the checkout the session runs in, quoted", () => {
		const main = checkout("main");
		const r = call(bash(SID), { CLAUDE_PROJECT_DIR: main });
		expectRefused(r, main);
		expect(r.stderr).toContain(
			`\n! claude plugin marketplace add '${main}/self-plugin' --scope user\n`,
		);
	});

	it("names the main checkout from a worktree session (#2461)", () => {
		const main = checkout("main");
		const worktree = path.join(repo, "main", ".claude", "worktrees", "wt");
		spawnSync("git", ["-C", main, "worktree", "add", "-q", worktree], {
			encoding: "utf8",
		});
		expect(fs.existsSync(path.join(worktree, ".git"))).toBe(true);
		expectRefused(call(bash(SID), { CLAUDE_PROJECT_DIR: worktree }), main);
	});

	it("pastes a path with a space and a quote as one argument", () => {
		const main = checkout("the founder's checkout");
		expectRefused(call(bash(SID), { CLAUDE_PROJECT_DIR: main }), main);
	});

	it("carries the placeholder where the common dir is not named .git", () => {
		const sep = path.join(repo, "sep");
		const r = spawnSync(
			"git",
			["init", "-q", "--separate-git-dir", path.join(repo, "sep.git"), sep],
			{ encoding: "utf8" },
		);
		expect(r.status).toBe(0);
		expectRefused(call(bash(SID), { CLAUDE_PROJECT_DIR: sep }));
	});

	it("carries the placeholder where the root is no git checkout", () => {
		const r = call(bash(SID));
		expectRefused(r);
		expect(r.stderr).toContain(`'${PLACEHOLDER}/self-plugin'`);
	});
});

describe("failing closed", () => {
	it("refuses an empty session id, even beside a marker", () => {
		startSession("startup");
		const r = call(bash(""));
		expectRefused(r);
		expect(r.stderr).toContain(
			"could not check this session (the hook input carried no session id)",
		);
	});

	it("refuses input that is not JSON", () => {
		startSession("startup");
		const r = call("{not json");
		expectRefused(r);
		expect(r.stderr).toContain("(the hook input did not parse as JSON)");
	});

	it("refuses an empty input", () => {
		expectRefused(call(""));
	});
});

describe("the marker", () => {
	it("is written under .claude/tmp/markers, keyed on the sanitised id", () => {
		startSession("startup", "odd/id");
		expect(
			fs.existsSync(
				path.join(
					repo,
					".claude",
					"tmp",
					"markers",
					".self-plugin-loaded-odd_id",
				),
			),
		).toBe(true);
		expect(call(bash("odd/id")).status).toBe(0);
	});

	function expectUnwrittenLogged() {
		startSession("startup");
		const log = path.join(
			repo,
			"config",
			"projects",
			projectSlug(repo),
			"guard-errors.log",
		);
		expect(fs.readFileSync(log, "utf8")).toContain(
			"no self-plugin marker written",
		);
	}

	it("records a marker it cannot write in the guard error log, printing nothing (#2626)", () => {
		fs.mkdirSync(path.join(repo, ".claude", "tmp"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".claude", "tmp", "markers"), "");
		expectUnwrittenLogged();
	});

	/* chmod binds nobody as root, so this says nothing there. */
	it.skipIf(process.getuid?.() === 0)(
		"does the same where the markers directory is read-only (#2626)",
		() => {
			const markers = path.join(repo, ".claude", "tmp", "markers");
			fs.mkdirSync(markers, { recursive: true });
			fs.chmodSync(markers, 0o555);
			try {
				expectUnwrittenLogged();
			} finally {
				fs.chmodSync(markers, 0o755);
			}
		},
	);

	it("is a marker family the markers sweep knows, so it does not pile up", () => {
		const markers = [
			`.self-plugin-loaded-${SID}`,
			".self-plugin-loaded-running",
		];
		expect(sweptMarkers(markers)).toEqual([markers[0]]);
	});
});

describe("the writer's registration", () => {
	const commandsOf = (file: string) =>
		JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")));

	it("is in the self-plugin's hooks file and not in the adopters' render", () => {
		expect(commandsOf("self-plugin/hooks/hooks.json")).toContain(
			"/scripts/write-self-plugin-marker.sh",
		);
		expect(commandsOf("hooks/hooks.json")).not.toContain(
			"write-self-plugin-marker.sh",
		);
	});
});
