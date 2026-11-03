// @vitest-environment node
/*
 * lib/launch-auth.js against a `claude` stub answering `auth status` through
 * lib/auth-status-fake.ts (#2236): which auth each launch admits, and that a
 * refusal names what set the auth and the rule. No case bills: the fake
 * makes no model call, and neither does the real `auth status`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAuthStatusBranch } from "./auth-status-fake";
import { launchAuthRefusal } from "./launch-auth.js";
import { buildKeyHelper } from "./overflow-key.js";
import { runInProcess } from "./run-in-process.js";

let dir = "";
let bin = "";
let home = "";
let seat = "";
let secrets = "";
const CLI = path.join(__dirname, "launch-auth.js");
const was = process.env.HOME;
const wasSecrets = process.env.WFC_SECRETS_FILE;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-auth-"));
	bin = path.join(dir, "claude");
	fs.writeFileSync(bin, `#!/bin/bash\n${buildAuthStatusBranch()}\nexit 9\n`, {
		mode: 0o755,
	});
	home = path.join(dir, "home");
	seat = path.join(home, ".claude-api");
	secrets = path.join(dir, "secrets.env");
	process.env.WFC_SECRETS_FILE = secrets;
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	process.env.HOME = home;
});

afterEach(() => {
	process.env.HOME = was;
	if (wasSecrets === undefined) delete process.env.WFC_SECRETS_FILE;
	else process.env.WFC_SECRETS_FILE = wasSecrets;
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A bare environment: none of the parent's auth leaks into a case. */
const refusal = (
	extra: Record<string, string> = {},
	cwd = dir,
	overflowKey?: string,
) =>
	launchAuthRefusal({
		bin,
		env: { PATH: process.env.PATH, HOME: home, ...extra },
		cwd,
		overflowKey,
	});
/** As the headless overflow launch asks. */
const overflowRefusal = (extra: Record<string, string>) =>
	refusal(extra, dir, "K");

const declareOverflow = (line = `${seat} api key=K grant=200 cycle-day=20`) =>
	fs.writeFileSync(path.join(home, ".claude", "refill-seats"), `${line}\n`);

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

	it("refuses an API key on a seat the seat file does not declare overflow", () => {
		declareOverflow();
		expect(
			overflowRefusal({
				ANTHROPIC_API_KEY: "k",
				CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
			}),
		).toContain("ANTHROPIC_API_KEY");
	});
});

describe("an overflow seat (#2570)", () => {
	it("admits its API key on the headless launch", () => {
		declareOverflow();
		expect(
			overflowRefusal({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: seat }),
		).toBeNull();
	});

	it("admits no login on the headless launch, which supplies the key itself", () => {
		declareOverflow();
		expect(
			overflowRefusal({ WFC_FAKE_AUTH_NO_LOGIN: "1", CLAUDE_CONFIG_DIR: seat }),
		).toBeNull();
	});

	it("admits the key only for the key the launch names, on a shared dir (#3693)", () => {
		fs.writeFileSync(
			path.join(home, ".claude", "refill-seats"),
			`${seat}\n${seat} api key=K grant=200 cycle-day=20\n`,
		);
		const env = { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: seat };
		expect(overflowRefusal(env)).toBeNull();
		expect(refusal(env)).toContain("ANTHROPIC_API_KEY");
		expect(refusal(env, dir, "OTHER")).toContain("ANTHROPIC_API_KEY");
	});

	it("keeps the seat's login alone at every other launch site", () => {
		declareOverflow();
		expect(
			refusal({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: seat }),
		).toContain("ANTHROPIC_API_KEY");
	});

	it("refuses the key once the seat file refuses", () => {
		declareOverflow(`${seat} api key=K grant=200 cycle-day=99`);
		expect(
			overflowRefusal({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: seat }),
		).toContain("ANTHROPIC_API_KEY");
	});

	it("still refuses ANTHROPIC_BASE_URL and a third-party provider", () => {
		declareOverflow();
		expect(
			overflowRefusal({
				ANTHROPIC_BASE_URL: "http://x",
				CLAUDE_CONFIG_DIR: seat,
			}),
		).toContain("ANTHROPIC_BASE_URL");
		expect(
			overflowRefusal({ CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CONFIG_DIR: seat }),
		).toContain("CLAUDE_CODE_USE_VERTEX");
	});
});

describe("an overflow seat's helper under its plan dir (#3699)", () => {
	const plan = () => path.join(home, ".claude2");
	const declarePlanOverflow = () =>
		fs.writeFileSync(
			path.join(home, ".claude", "refill-seats"),
			`${plan()}\n${plan()} api key=K grant=200 cycle-day=20\n`,
		);
	const withHelper = (extra: Record<string, string>, keyVar = "K") =>
		launchAuthRefusal({
			bin,
			env: { PATH: process.env.PATH, HOME: home, ...extra },
			cwd: dir,
			settings: JSON.stringify({
				apiKeyHelper: buildKeyHelper(keyVar, secrets),
			}),
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

	it("admits it through the CLI's --settings", () => {
		declarePlanOverflow();
		const settings = JSON.stringify({
			apiKeyHelper: buildKeyHelper("K", secrets),
		});
		const run = (args: string[]) =>
			runInProcess(CLI, args, {
				env: {
					PATH: process.env.PATH,
					HOME: home,
					WFC_CLAUDE_BIN: bin,
					WFC_SECRETS_FILE: secrets,
					WFC_FAKE_AUTH_NO_LOGIN: "1",
					CLAUDE_CONFIG_DIR: plan(),
				},
			});
		expect(run(["--settings", settings]).status).toBe(0);
		const plain = run([]);
		expect(plain.status).toBe(2);
		expect(plain.stderr).toContain("REFUSED:");
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

	it("refuses any other apiKeyHelper in the settings", () => {
		declarePlanOverflow();
		expect(
			launchAuthRefusal({
				bin,
				env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: plan() },
				cwd: dir,
				settings: JSON.stringify({ apiKeyHelper: "echo K" }),
			}),
		).toContain("no declared overflow seat's");
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
