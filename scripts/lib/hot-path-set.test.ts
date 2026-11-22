// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { readText } = require("./file-read.js") as {
	readText: (
		file: string,
	) =>
		| { state: "absent" }
		| { state: "read"; data: string }
		| { state: "unreadable"; error: unknown };
};
const { hotPathSet, isHookRegistration } = require("./hot-path-set.js") as {
	hotPathSet: (
		root: string,
		port: {
			readText: (rel: string) => string | null;
			isFile: (rel: string) => boolean;
		},
	) => string[];
	isHookRegistration: (rel: string) => boolean;
};

let root: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hot-path-")));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const plant = (files: Record<string, string>) => {
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	}
};

const json = (v: unknown) => JSON.stringify(v);

const entry = (command: string, extra: Record<string, unknown> = {}) => ({
	matcher: "Bash",
	hooks: [{ type: "command", command, ...extra }],
});

const derived = () =>
	hotPathSet(root, {
		readText: (rel) => {
			const read = readText(path.join(root, rel));
			if (read.state === "unreadable") throw read.error;
			return read.state === "read" ? read.data : null;
		},
		isFile: (rel) =>
			fs.statSync(path.join(root, rel), { throwIfNoEntry: false })?.isFile() ??
			false,
	});

const PROGRAMS = [
	"scripts/pre-guard.js",
	"scripts/post-guard.py",
	"scripts/narrowed.js",
	"scripts/failure.sh",
	"scripts/batch.js",
	"scripts/local-guard.js",
	"scripts/plugin-guard.js",
	"scripts/self-guard.js",
	"scripts/status.sh",
	"scripts/start-only.js",
	"scripts/stop-only.js",
	"scripts/precommit.js",
	"scripts/precommit-local.sh",
	"scripts/commit-msg.js",
	"scripts/lib/a-core.js",
	"scripts/lib/a-core-host.js",
	"scripts/lib/row-step.js",
	"scripts/row-check.js",
	"scripts/polled.js",
	"scripts/comment-only.js",
	"scripts/pre-push.js",
];

describe("the hot-path set of a planted tree", () => {
	it("holds each per-call, per-commit, registry and polled program, and nothing else", () => {
		plant(Object.fromEntries(PROGRAMS.map((p) => [p, "x\n"])));
		plant({
			".claude/settings.json": json({
				hooks: {
					PreToolUse: [
						entry(`node "\${CLAUDE_PROJECT_DIR}"/scripts/pre-guard.js`),
					],
					PostToolUse: [
						entry("python3 $CLAUDE_PROJECT_DIR/scripts/post-guard.py"),
						entry("node scripts/narrowed.js", { if: "Bash(git *)" }),
					],
					PostToolUseFailure: [entry("bash ./scripts/failure.sh")],
					PostToolBatch: [entry("node", { args: ["scripts/batch.js"] })],
					SessionStart: [entry("node scripts/start-only.js")],
					Stop: [entry("node scripts/stop-only.js")],
				},
				statusLine: { type: "command", command: "bash scripts/status.sh" },
			}),
			".claude/settings.local.json": json({
				hooks: {
					PreToolUse: [entry(`node ${root}/scripts/local-guard.js`)],
				},
			}),
			"hooks/hooks.json": json({
				hooks: {
					PreToolUse: [
						entry(
							`command -v node >/dev/null 2>&1 || exit 0; node "\${CLAUDE_PLUGIN_ROOT}"/scripts/plugin-guard.js`,
						),
					],
				},
			}),
			"self-plugin/hooks/hooks.json": json({
				hooks: {
					PostToolUse: [entry("node $WFC_PLUGIN_ROOT/scripts/self-guard.js")],
				},
			}),
			".husky/pre-commit": [
				"#!/usr/bin/env sh",
				"# scripts/comment-only.js is named in a comment alone",
				`node "\${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}/scripts/precommit.js"`,
				"cat package.json >/dev/null",
			].join("\n"),
			".husky/pre-commit.local": "bash scripts/precommit-local.sh\n",
			".husky/commit-msg": 'node "$(dirname "$0")"/../scripts/commit-msg.js\n',
			".husky/pre-push": "node scripts/pre-push.js\n",
			"package.json": "{}\n",
			"scripts/lib/guard-cores.json": json({
				PreToolUse: [
					{ name: "a", core: "a-core.js", host: "a-core-host.js" },
					{ name: "gone", core: "missing.js" },
				],
			}),
			"scripts/lib/commit-msg-rows.js": [
				'const step = require("./row-step.js");',
				'const ROWS = [{ script: "scripts/row-check.js" }];',
			].join("\n"),
			".claude/workflow-core.json": json({
				polled: ["scripts/polled.js"],
			}),
		});
		expect(derived()).toEqual(
			[
				"scripts/pre-guard.js",
				"scripts/post-guard.py",
				"scripts/narrowed.js",
				"scripts/failure.sh",
				"scripts/batch.js",
				"scripts/status.sh",
				"scripts/local-guard.js",
				"scripts/plugin-guard.js",
				"scripts/self-guard.js",
				"scripts/precommit.js",
				"scripts/precommit-local.sh",
				"scripts/commit-msg.js",
				"scripts/lib/a-core.js",
				"scripts/lib/a-core-host.js",
				"scripts/lib/row-step.js",
				"scripts/row-check.js",
				"scripts/polled.js",
			].sort(),
		);
	});

	it("leaves out a program only a SessionStart entry runs", () => {
		plant({
			"scripts/start-only.js": "x\n",
			".claude/settings.json": json({
				hooks: { SessionStart: [entry("node scripts/start-only.js")] },
			}),
		});
		expect(derived()).toEqual([]);
	});

	it("holds no polled program where one entry would make the config reader refuse the key", () => {
		plant({
			"scripts/polled.js": "x\n",
			".claude/workflow-core.json": json({
				polled: ["scripts/polled.js", "../outside.js", 3],
			}),
		});
		expect(derived()).toEqual([]);
	});

	it("is empty in a tree with no registration, and over a settings file that does not parse", () => {
		plant({ "scripts/a.js": "x\n", ".claude/settings.json": "{ nope" });
		expect(derived()).toEqual([]);
	});
});

describe("a hook registration", () => {
	it.each([
		".claude/settings.json",
		".claude/settings.local.json",
		"hooks/hooks.json",
		"self-plugin/hooks/hooks.json",
		".husky/pre-commit",
		".husky/prepare-commit-msg.local",
		".husky/commit-msg",
		".husky/post-commit",
		"scripts/lib/guard-cores.json",
		"scripts/lib/precommit-gates.js",
		"scripts/lib/prepare-commit-msg-rows.js",
		"scripts/lib/commit-msg-rows.js",
		"scripts/lib/post-commit-rows.js",
	])("is %s", (rel) => {
		expect(isHookRegistration(rel)).toBe(true);
	});

	it.each([
		".husky/pre-push",
		".claude/workflow-core.json",
		"scripts/guard-dispatch.js",
		"sub/.claude/settings.json",
	])("is not %s", (rel) => {
		expect(isHookRegistration(rel)).toBe(false);
	});
});
