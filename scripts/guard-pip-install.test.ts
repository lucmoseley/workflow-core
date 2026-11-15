// @vitest-environment node
/*
 * The guard-pip-install core of guard-dispatch.js vets a new Python package
 * with a deny at the install boundary (#5232). These are its boundary cases
 * (§X11), the dispatcher entry run on it alone, end to end.
 *
 * NOTHING HERE TOUCHES THE NETWORK. curl is lib/pypi-registry-fake.ts's stub
 * injected at WFC_CURL (§N7).
 *
 * NOT DRIVEN: curl's 8 s timeout, which only a stub hanging past it would
 * reach (§X9).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import { readText } from "./lib/file-read.js";
import {
	buildBashPayload,
	dispatchCoreOutput,
} from "./lib/pretool-guard-testkit";
import {
	buildPassingPyPI,
	type PyPI,
	writePyPIStub,
} from "./lib/pypi-registry-fake";
import { readRuleText } from "./lib/rule-text";

const CORE = "guard-pip-install";

let dir: string;
let config: string;
let shared: string;
let serve: ReturnType<typeof writePyPIStub>;

const calls = () => path.join(dir, "stub-calls.log");
const readStubCalls = () => {
	const got = readText(calls());
	if (got.state === "unreadable") throw got.error;
	return got.state === "read" ? got.data : "";
};

const emission = (
	command: string,
	reg: Partial<PyPI> = {},
	over: NodeJS.ProcessEnv = {},
) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "test"), {
		project: shared,
		config,
		cwd: shared,
		env: {
			...serve({ ...buildPassingPyPI(Date.now()), ...reg }),
			STUB_CALLS: calls(),
			WFC_ALLOW_NEW_PACKAGE: "",
			...over,
		},
	});

const denial = (
	command: string,
	reg: Partial<PyPI> = {},
	over: NodeJS.ProcessEnv = {},
): string | null => {
	const out = emission(command, reg, over);
	if (out === null) return null;
	expect(out.hookEventName).toBe("PreToolUse");
	expect(out.permissionDecision).toBe("deny");
	return out.permissionDecisionReason as string;
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pip-"));
	config = path.join(dir, "config");
	shared = path.join(dir, "shared");
	fs.mkdirSync(shared, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: shared });
	fs.writeFileSync(path.join(shared, "requirements.txt"), "requests==2.32.3\n");
	execFileSync("git", ["add", "requirements.txt"], { cwd: shared });
	/* Untracked, and still declared. */
	fs.writeFileSync(
		path.join(shared, "pyproject.toml"),
		'[project]\ndependencies = ["httpx"]\n',
	);
	serve = writePyPIStub(path.join(dir, "stubs"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the guard, end to end", () => {
	it("refuses a made-up PyPI name, and the refusal carries the rule's whole text", () => {
		const why = denial(
			"python3 -m pip install --only-binary :all: wfc-nope-5232",
			{ created: "404", downloads: "404" },
		);
		expect(why).toMatch(/^No package named `wfc-nope-5232` exists on PyPI: /);
		expect(why).toContain(readRuleText("new-package-vetted"));
		expect(denial("python3 -m pip install wfc-nope-5232")).toContain(
			readRuleText("new-package-vetted"),
		);
	});

	it("asks PyPI and pypistats about a known package, and passes one that clears both", () => {
		expect(
			emission("python3 -m pip install --only-binary :all: Playwright"),
		).toBeNull();
		expect(readStubCalls()).toBe(
			"curl -sS --max-time 8 -w \n%{http_code} https://pypi.org/pypi/playwright/json\n" +
				"curl -sS --max-time 8 -w \n%{http_code} https://pypistats.org/api/packages/playwright/recent\n",
		);
	});

	/* Sits through the host's real 1 s wait: the host's pause is no port. */
	it("waits out one pypistats 429 and asks again", () => {
		expect(
			emission("pip install --only-binary :all: playwright", {
				statsFirstCode: 429,
			}),
		).toBeNull();
		expect(readStubCalls()).toBe(
			"curl -sS --max-time 8 -w \n%{http_code} https://pypi.org/pypi/playwright/json\n" +
				"curl -sS --max-time 8 -w \n%{http_code} https://pypistats.org/api/packages/playwright/recent\n" +
				"curl -sS --max-time 3 -w \n%{http_code} https://pypistats.org/api/packages/playwright/recent\n",
		);
	});

	it("refuses the build window before asking anything", () => {
		expect(denial("pip install playwright")).toMatch(
			/does not carry `--only-binary :all:`/,
		);
		expect(readStubCalls()).toBe("");
	});

	it("reads tracked and untracked declaring files through git", () => {
		expect(emission("pip install requests httpx")).toBeNull();
		expect(readStubCalls()).toBe("");
	});

	it("reads the stub's age and downloads against the real clock", () => {
		const days = (n: number) =>
			new Date(Date.now() - n * 86_400_000).toISOString();
		const cmd = "uv add --no-build left-pad";
		expect(denial(cmd, { created: days(179) })).toMatch(
			/first published 179 days ago/,
		);
		expect(denial(cmd, { downloads: 999 })).toMatch(/downloaded 999 time/);
		expect(denial(cmd, { downloads: "404" })).toMatch(/downloaded 0 time/);
		expect(denial(cmd, { created: "FAIL" })).toMatch(
			/^PyPI could not be reached/,
		);
	});
});

describe("the escape", () => {
	it("stands down the legitimacy check when set in the hook's environment", () => {
		expect(
			emission(
				"pip install --only-binary :all: wfc-nope-5232",
				{ created: "404" },
				{ WFC_ALLOW_NEW_PACKAGE: "1" },
			),
		).toBeNull();
		expect(readStubCalls()).toBe("");
	});
});

describe("fail-closed, where PyPI cannot be asked", () => {
	it("DENIES and records when curl has gone missing", () => {
		const why = denial(
			"pip install --only-binary :all: left-pad",
			{},
			{ WFC_CURL: path.join(dir, "no-such-curl") },
		);
		expect(why).toMatch(/^PyPI could not be reached/);
		const [line] = readFailOpenLog(config, shared).trim().split("\n");
		expect(line?.split("\t")).toEqual([
			expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			CORE,
			"curl not found — legitimacy of left-pad could not be checked, denying",
		]);
	});
});
