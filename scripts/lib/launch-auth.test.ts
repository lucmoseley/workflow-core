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

let dir = "";
let bin = "";
let home = "";
let seat = "";
const was = process.env.HOME;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-auth-"));
	bin = path.join(dir, "claude");
	fs.writeFileSync(bin, `#!/bin/bash\n${buildAuthStatusBranch()}\nexit 9\n`, {
		mode: 0o755,
	});
	home = path.join(dir, "home");
	seat = path.join(home, ".claude-api");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	process.env.HOME = home;
});

afterEach(() => {
	process.env.HOME = was;
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A bare environment: none of the parent's auth leaks into a case. */
const refusal = (
	extra: Record<string, string> = {},
	cwd = dir,
	overflow = false,
) =>
	launchAuthRefusal({
		bin,
		env: { PATH: process.env.PATH, HOME: home, ...extra },
		cwd,
		overflow,
	});
/** As the headless overflow launch asks. */
const overflowRefusal = (extra: Record<string, string>) =>
	refusal(extra, dir, true);

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
