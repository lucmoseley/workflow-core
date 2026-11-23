// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthStatusBranch } from "./auth-status-fake";
import { launchAuthRefusal } from "./launch-auth.js";
import { buildKeyHelper } from "./overflow-key.js";
import { runInProcess } from "./run-in-process.js";

let dir = "";
let bin = "";
let home = "";
let secrets = "";
const CLI = path.join(__dirname, "launch-auth.js");

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-auth-"));
	bin = path.join(dir, "claude");
	fs.writeFileSync(bin, `#!/bin/bash\n${buildAuthStatusBranch()}\nexit 9\n`, {
		mode: 0o755,
	});
	home = path.join(dir, "home");
	secrets = path.join(dir, "secrets.env");
	vi.stubEnv("WFC_SECRETS_FILE", secrets);
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	vi.stubEnv("HOME", home);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const refusal = (extra: Record<string, string> = {}, cwd = dir) =>
	launchAuthRefusal({
		bin,
		env: { PATH: process.env.PATH, HOME: home, ...extra },
		cwd,
		bg: false,
	});

describe("a plan seat", () => {
	it("admits the seat's own login", () => {
		expect(refusal()).toBeNull();
	});

	it("admits CLAUDE_CODE_OAUTH_TOKEN, the subscription's token", () => {
		expect(refusal({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBeNull();
	});

	it.each([
		[{ ANTHROPIC_API_KEY: "k" }, "ANTHROPIC_API_KEY is set"],
		[{ ANTHROPIC_AUTH_TOKEN: "t" }, "ANTHROPIC_AUTH_TOKEN is set"],
		[
			{ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_AUTH_TOKEN: "t" },
			"ANTHROPIC_AUTH_TOKEN is set",
		],
		[
			{ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" },
			"ANTHROPIC_API_KEY is set",
		],
		[{ ANTHROPIC_BASE_URL: "http://x" }, "ANTHROPIC_BASE_URL is set"],
		[{ CLAUDE_CODE_USE_BEDROCK: "1" }, "CLAUDE_CODE_USE_BEDROCK is set"],
		[{ CLAUDE_CODE_USE_VERTEX: "1" }, "CLAUDE_CODE_USE_VERTEX is set"],
		[{ CLAUDE_CODE_USE_FOUNDRY: "1" }, "CLAUDE_CODE_USE_FOUNDRY is set"],
	])("refuses under %o, naming it and the rule", (env, named) => {
		const why = refusal(env);
		expect(why).toContain(named);
		expect(why).toContain("bills the subscription seat, never per token");
		expect(why).toContain("#2236");
	});

	it("refuses a project's apiKeyHelper, read from the launch's cwd", () => {
		const project = path.join(dir, "project");
		fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(project, ".claude", "settings.json"),
			JSON.stringify({ apiKeyHelper: "echo k" }),
		);
		expect(refusal({}, project)).toContain("apiKeyHelper");
		expect(refusal({}, dir)).toBeNull();
	});

	it("refuses a seat with no login", () => {
		expect(refusal({ WFC_FAKE_AUTH_NO_LOGIN: "1" })).toContain(
			"the seat is not logged in",
		);
	});
});

describe("an overflow seat's helper under its plan dir (#3699)", () => {
	const plan = () => path.join(home, ".claude2");
	const declarePlanOverflow = (cycleDay = 20) =>
		fs.writeFileSync(
			path.join(home, ".claude", "refill-seats"),
			`${plan()}\n${plan()} api key=K grant=200 cycle-day=${cycleDay}\n`,
		);
	const withHelper = (extra: Record<string, string>, keyVar = "K") =>
		launchAuthRefusal({
			bin,
			env: { PATH: process.env.PATH, HOME: home, ...extra },
			cwd: dir,
			settings: JSON.stringify({
				apiKeyHelper: buildKeyHelper(keyVar, secrets),
			}),
			bg: false,
		});

	it("admits the plan login and no login", () => {
		declarePlanOverflow();
		expect(withHelper({ CLAUDE_CONFIG_DIR: plan() })).toBeNull();
		expect(
			withHelper({ WFC_FAKE_AUTH_NO_LOGIN: "1", CLAUDE_CONFIG_DIR: plan() }),
		).toBeNull();
	});

	it("refuses a key already in force, which outranks the helper", () => {
		declarePlanOverflow();
		expect(
			withHelper({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: plan() }),
		).toContain("ANTHROPIC_API_KEY");
	});

	it("refuses through the CLI, which takes no settings", () => {
		declarePlanOverflow();
		const r = runInProcess(CLI, [], {
			env: {
				PATH: process.env.PATH,
				HOME: home,
				WFC_CLAUDE_BIN: bin,
				WFC_FAKE_AUTH_NO_LOGIN: "1",
				CLAUDE_CONFIG_DIR: plan(),
			},
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("REFUSED:");
	});

	it("still refuses the key on a plain launch under the same dir", () => {
		declarePlanOverflow();
		expect(
			refusal({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: plan() }),
		).toContain("ANTHROPIC_API_KEY");
	});

	it("refuses a helper for a key variable no overflow line declares", () => {
		declarePlanOverflow();
		expect(withHelper({ CLAUDE_CONFIG_DIR: plan() }, "J")).toContain(
			"no declared overflow seat's",
		);
	});

	it("refuses the helper under a dir that is not its seat's", () => {
		declarePlanOverflow();
		expect(
			withHelper({ CLAUDE_CONFIG_DIR: path.join(home, ".claude3") }),
		).toContain("no declared overflow seat's");
	});

	it("refuses the helper as no declared seat where the seat file will not parse", () => {
		declarePlanOverflow(99);
		expect(
			withHelper({ WFC_FAKE_AUTH_NO_LOGIN: "1", CLAUDE_CONFIG_DIR: plan() }),
		).toContain("no declared overflow seat's");
	});

	it("still refuses ANTHROPIC_BASE_URL and a third-party provider", () => {
		declarePlanOverflow();
		expect(
			withHelper({ ANTHROPIC_BASE_URL: "http://x", CLAUDE_CONFIG_DIR: plan() }),
		).toContain("ANTHROPIC_BASE_URL");
		expect(
			withHelper({ CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CONFIG_DIR: plan() }),
		).toContain("CLAUDE_CODE_USE_VERTEX");
	});

	it("refuses any other apiKeyHelper in the settings", () => {
		declarePlanOverflow();
		expect(
			launchAuthRefusal({
				bin,
				env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: plan() },
				cwd: dir,
				settings: JSON.stringify({ apiKeyHelper: "echo K" }),
				bg: false,
			}),
		).toContain("no declared overflow seat's");
	});

	it("refuses a --settings that is not inline JSON, naming it as not inline JSON", () => {
		declarePlanOverflow();
		expect(
			launchAuthRefusal({
				bin,
				env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: plan() },
				cwd: dir,
				settings: "/tmp/settings.json",
				bg: false,
			}),
		).toContain("--settings is not inline JSON");
	});
});

describe("a status that will not read", () => {
	it("refuses, quoting what the binary said", () => {
		fs.writeFileSync(bin, "#!/bin/bash\necho 'unknown command' >&2\nexit 1\n");
		expect(refusal()).toContain("printed no JSON (exit 1: unknown command)");
	});

	it("refuses where the binary is missing", () => {
		fs.rmSync(bin);
		expect(refusal()).toContain("auth status` failed");
	});
});

describe("a --bg launch, which runs under the daemon's environment (#5607)", () => {
	const Daemon = "4242";
	let proc = "";
	beforeEach(() => {
		proc = path.join(dir, "proc");
		vi.stubEnv("WFC_PROC", proc);
	});

	const daemonWith = (env: Record<string, string>) => {
		fs.mkdirSync(path.join(proc, Daemon), { recursive: true });
		fs.writeFileSync(
			path.join(proc, Daemon, "environ"),
			Object.entries({ CLAUDE_CONFIG_DIR: "/c", ...env })
				.map(([k, v]) => `${k}=${v}\0`)
				.join(""),
		);
	};
	const bgRefusal = (extra: Record<string, string> = {}) =>
		launchAuthRefusal({
			bin,
			env: { PATH: process.env.PATH, HOME: home, ...extra },
			cwd: dir,
			bg: true,
		});

	it.each([
		[{ ANTHROPIC_API_KEY: "k" }, "ANTHROPIC_API_KEY"],
		[{ ANTHROPIC_AUTH_TOKEN: "t" }, "ANTHROPIC_AUTH_TOKEN"],
		[{ ANTHROPIC_BASE_URL: "http://x" }, "ANTHROPIC_BASE_URL"],
		[{ CLAUDE_CODE_USE_BEDROCK: "1" }, "CLAUDE_CODE_USE_BEDROCK"],
	])(
		"refuses a daemon whose environment carries %o, naming the daemon",
		(env, named) => {
			daemonWith(env);
			const why = bgRefusal({ WFC_FAKE_DAEMON: Daemon });
			expect(why).toContain(`the Claude daemon (pid ${Daemon})`);
			expect(why).toContain(`${named} set in its environment`);
			expect(why).toContain("let it idle-exit");
			expect(why).toContain("#2236");
		},
	);

	it("admits a clean daemon, and a provider flag turned off", () => {
		daemonWith({ CLAUDE_CODE_USE_VERTEX: "0" });
		expect(bgRefusal({ WFC_FAKE_DAEMON: Daemon })).toBeNull();
	});

	it("admits where no daemon runs, the launch starting one from its own env", () => {
		expect(bgRefusal()).toBeNull();
		expect(bgRefusal({ ANTHROPIC_API_KEY: "k" })).toContain(
			"ANTHROPIC_API_KEY is set",
		);
	});

	it("refuses a daemon whose environment will not read", () => {
		expect(bgRefusal({ WFC_FAKE_DAEMON: Daemon })).toContain(
			`the Claude daemon (pid ${Daemon}) this --bg launch hands its session to has an environment that will not read`,
		);
	});

	it("refuses a status that names no daemon pid, quoting it", () => {
		expect(bgRefusal({ WFC_FAKE_DAEMON_GARBLED: "1" })).toContain(
			"daemon status` named no daemon pid (exit 3: daemon: confused)",
		);
	});

	it("reads no daemon on a launch that is not --bg", () => {
		daemonWith({ ANTHROPIC_API_KEY: "k" });
		expect(refusal({ WFC_FAKE_DAEMON: Daemon })).toBeNull();
	});
});
