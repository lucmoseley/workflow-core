// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_FAULT_TEXT } from "./core-fault.js";
import { readProbeFailure, readReplayFailure } from "./guard-probe.js";
import { buildHookEnv } from "./hook-env.js";
import { GUARD_HOOKS_JSON, probedCheckout } from "./repo-hold-fixture";

const REAL_HOOKS = path.join(__dirname, "../../self-plugin/hooks/hooks.json");
const REAL_RUNNER = path.join(__dirname, "../run-pinned-guards.js");

let dir: string;
let repo: string;
const at = (name: string) => path.join(dir, name);
const hooksFile = () => path.join(repo, "self-plugin", "hooks", "hooks.json");

const writeHooks = (text: string) => {
	fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
	fs.writeFileSync(hooksFile(), text);
};

const writeMatchers = (...matchers: (string | undefined)[]) =>
	writeHooks(
		JSON.stringify({
			hooks: {
				PreToolUse: matchers.map((matcher) => ({
					...(matcher === undefined ? {} : { matcher }),
					hooks: [
						{ type: "command", command: "node scripts/guard-dispatch.js" },
					],
				})),
			},
		}),
	);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-probe-"));
	repo = at("repo");
	probedCheckout.instantiate(repo);
	vi.stubEnv("WFC_GUARD_PROBE_RETRY_MS", "0");
	vi.stubEnv("WFC_MODULES", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the hook line a matcher covers (#4914)", () => {
	beforeEach(() => {
		fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(repo, "scripts", "guard-dispatch.js"),
			"process.exit(0);\n",
		);
	});
	const edit = { tool_name: "Edit", tool_input: {} };

	it.each([
		["absent", undefined],
		["empty", ""],
		["a star", "*"],
	])("reads a matcher that is %s as covering every tool", (_, matcher) => {
		writeMatchers(matcher);

		expect(readProbeFailure(repo)).toBeNull();
		expect(readReplayFailure(repo, edit)).toBeNull();
	});

	it("covers each tool of an alternation and none beside them", () => {
		writeMatchers("Bash|Read");

		expect(readProbeFailure(repo)).toBeNull();
		expect(readReplayFailure(repo, edit)).toBe(
			"self-plugin/hooks/hooks.json registers no guard line for Edit",
		);
	});

	it("fails the probe on a matcher that is not a valid regex, naming it (#4907)", () => {
		writeMatchers("Bash|(");

		expect(readProbeFailure(repo)).toEqual({
			text: expect.stringMatching(
				/^guard entry: self-plugin\/hooks\/hooks\.json: the matcher "Bash\|\(" is not a valid regular expression/,
			),
			isOutage: false,
		});
	});

	it.each([
		["is absent", null, "cannot be read at"],
		["carries no hooks object", '{"x":1}', "carries no hooks object"],
		[
			"holds no list of PreToolUse groups",
			'{"hooks":{"PreToolUse":{}}}',
			"its PreToolUse hooks are not a list",
		],
	])(
		"fails the probe, never throwing, where the hooks file %s",
		(_, text, why) => {
			if (text === null)
				fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
			else writeHooks(text);

			expect(readProbeFailure(repo)).toEqual({
				text: expect.stringContaining(why),
				isOutage: false,
			});
		},
	);

	it("fails the probe on a hooks file that is not JSON", () => {
		writeHooks("{");

		expect(readProbeFailure(repo)?.text).toContain("is not valid JSON");
	});
});

describe("the hook environment (#4736)", () => {
	const LoginVars = new Set(["HOME", "PATH"]);
	const parseRequiredVars = (hooksJson: string) => {
		const commands: string[] = [];
		JSON.parse(hooksJson, (key, value) => {
			if (key === "command" && typeof value === "string") commands.push(value);
			return value;
		});
		return new Set(
			commands.flatMap((c) =>
				[
					...c.matchAll(
						/\$\{([A-Za-z_]\w*)(:?[-=?+])?[^}]*\}|\$([A-Za-z_]\w*)/g,
					),
				]
					.filter(
						([, , op]) =>
							!["-", ":-", "=", ":=", "+", ":+"].includes(String(op)),
					)
					.map(([, braced, , bare]) => String(braced ?? bare)),
			),
		);
	};
	const findUnsetVars = (hooksJson: string) => {
		const env = buildHookEnv(repo, {});
		return [...parseRequiredVars(hooksJson)].filter(
			(v) => !LoginVars.has(v) && env[v] === undefined,
		);
	};

	it("sets every variable this repo's self-plugin hook lines read", () => {
		const real = fs.readFileSync(REAL_HOOKS, "utf8");

		expect(parseRequiredVars(real)).toContain("CLAUDE_PLUGIN_ROOT");
		expect(findUnsetVars(real)).toEqual([]);
	});

	it("sets every variable the probe fixture's hook line reads", () => {
		expect(findUnsetVars(GUARD_HOOKS_JSON)).toEqual([]);
	});

	it("names a variable a hook line reads that it does not set", () => {
		const shellVar = (body: string) => `\${${body}}`;
		const command = `node "${shellVar("CLAUDE_ENV_FILE")}" "${shellVar("WFC_X:-y")}" ${shellVar("WFC_Y:+z")}`;
		const drifted = JSON.stringify({
			hooks: { Stop: [{ hooks: [{ command }] }] },
		});

		expect(findUnsetVars(drifted)).toEqual(["CLAUDE_ENV_FILE"]);
	});
});

describe("a guard entry that will not load (#4226)", () => {
	const guardEntry = () => path.join(repo, "scripts", "guard-dispatch.js");
	const writeGuardEntry = (body: string) => {
		fs.mkdirSync(path.dirname(guardEntry()), { recursive: true });
		fs.writeFileSync(
			guardEntry(),
			`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(at("guard-runs"))}, "run\\n");
${body}`,
		);
	};
	const Failing =
		'process.stderr.write("\\nLexer is not defined\\n");\nprocess.exit(1);\n';
	const Healthy = "process.exit(0);\n";
	const guardRuns = () =>
		fs.existsSync(at("guard-runs"))
			? fs.readFileSync(at("guard-runs"), "utf8").split("\n").filter(Boolean)
			: [];

	beforeEach(() => writeHooks(GUARD_HOOKS_JSON));

	const registerRealHooks = () => {
		const scripts = path.join(repo, "scripts");
		fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
		fs.copyFileSync(REAL_RUNNER, path.join(scripts, "run-pinned-guards.js"));
		fs.writeFileSync(path.join(scripts, "lib", "guard-dispatch.js"), "");
		fs.copyFileSync(REAL_HOOKS, hooksFile());
		fs.symlinkSync(repo, `${at("guard-code")}.current`);
		vi.stubEnv("WFC_GUARD_CODE_DIR", at("guard-code"));
	};

	it("passes this repo's own hook lines over a healthy entry, and fails them over a broken one", () => {
		registerRealHooks();
		writeGuardEntry(Healthy);

		expect(readProbeFailure(repo)).toBeNull();
		expect(guardRuns()).toHaveLength(1);

		writeGuardEntry(Failing);

		expect(readProbeFailure(repo)).toEqual({
			text: "guard entry: Lexer is not defined",
			isOutage: false,
		});
	});

	it("reads a deny of its benign Read as a failure", () => {
		writeGuardEntry(
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "kit fault\\nmore" } }));\n`,
		);

		expect(readProbeFailure(repo)?.text).toBe(
			"guard entry: refused a benign Read: kit fault",
		);
	});

	it("reads nothing failing where the re-run passes", () => {
		writeGuardEntry(
			`const once = ${JSON.stringify(at("failed-once"))};
if (!fs.existsSync(once)) { fs.writeFileSync(once, ""); process.exit(1); }
process.exit(0);
`,
		);

		expect(readProbeFailure(repo)).toBeNull();
		expect(guardRuns()).toHaveLength(2);
	});

	it("runs no step in a checkout with no self-plugin", () => {
		fs.rmSync(path.join(repo, "self-plugin"), { recursive: true });
		writeGuardEntry(Failing);

		expect(readProbeFailure(repo)).toBeNull();
		expect(guardRuns()).toHaveLength(0);
	});

	describe("a locked-out session's replayed call (#4228)", () => {
		const Fault = `guard-x ${CORE_FAULT_TEXT}, and it fails closed: boom`;
		const Judging = `const p = JSON.parse(fs.readFileSync(0, "utf8"));
const why = p.tool_name !== "Bash" ? null : p.tool_input.command === "locked" ? ${JSON.stringify(Fault)} : p.tool_input.command === "merits" ? "Refused: rule:x" : null;
if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } }));
`;
		const bash = (command: string) => ({
			tool_name: "Bash",
			tool_input: { command },
		});

		it("fails a call still refused for want of a guard, though the benign Read passes", () => {
			writeGuardEntry(Judging);

			expect(readProbeFailure(repo)).toBeNull();
			expect(readReplayFailure(repo, bash("locked"))).toBe(
				`refused a replayed Bash: ${Fault}`,
			);
		});

		it("passes a call refused only on its merits", () => {
			writeGuardEntry(Judging);

			expect(readReplayFailure(repo, bash("merits"))).toBeNull();
		});
	});
});
