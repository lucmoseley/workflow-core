// @vitest-environment node
/*
 * The guard-wide-read core of guard-dispatch.js warns where a Bash command
 * pours a whole file, a wide slice or an uncounted glob into the context
 * window (mantahostels#1562). These are its Bash boundary cases (§X11), the
 * dispatcher entry run on it alone: the payload on stdin, the
 * WFC_WIDE_READ_* thresholds from the environment, the hook's own directory
 * for a relative path, and the real file-size, glob and core-path adapters,
 * end to end. Which command earns which warning, and the `Read` limb, are
 * lib/wide-read.test.ts's (#2791); the entry's payload faults and the throw
 * policy are guard-dispatch's own tests' (#3227).
 *
 * Every warning asserts no `permissionDecision`: this guard warns and must
 * never deny.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";

const { CONTRACT } = require("./lib/workflow-core-config.js");

const CORE = "guard-wide-read";

let dir: string;
let config: string;
let project: string;

beforeEach(() => {
	({ dir, config } = guardDirs("guard-wide-read-"));
	project = path.join(dir, "project");
	fs.mkdirSync(project);
	fs.writeFileSync(path.join(project, "big.md"), "x".repeat(1001));
	fs.writeFileSync(path.join(project, "small.md"), "x".repeat(20));
	for (const n of [1, 2, 3])
		fs.writeFileSync(path.join(project, `part-${n}.txt`), "y".repeat(10));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const emission = (command: string, env: NodeJS.ProcessEnv = {}) =>
	dispatchCoreOutput(CORE, buildBashPayload(command), {
		project,
		config,
		cwd: project,
		env: { WFC_WIDE_READ_BYTES: "1000", WFC_WIDE_READ_MATCHES: "3", ...env },
	});

describe("the guard, end to end", () => {
	it("warns as additionalContext on exit 0, measuring a relative path from the hook's directory against the env's threshold", () => {
		const out = emission("cat big.md");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toMatch(
			/^Reading a whole file into context: big\.md is 1001 characters/,
		);
		expect(out.additionalContext).toMatch(
			/Why this fires and what the convention asks for: docs\/agents\/tool-output\.md\. It only ever warns\.$/,
		);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it("is silent under the env's threshold, and on the shipped default", () => {
		expect(emission("cat small.md")).toBeNull();
		expect(emission("cat big.md", { WFC_WIDE_READ_BYTES: undefined })).toBe(
			null,
		);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it("counts a glob through the shell's expansion on disk", () => {
		expect(emission("cat part-*.txt").additionalContext).toContain(
			"`part-*.txt` matches at least 3 files, 30 characters or more",
		);
	});

	it("spells core paths at the plugin root in an install", () => {
		// WFC_SCRIPT_ROOT stands in for an install: a core root with no
		// package.json.
		const install = path.join(dir, "install");
		fs.mkdirSync(path.join(install, "docs", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(install, "docs", "agents", "tool-output.md"),
			"",
		);
		expect(
			emission("cat big.md", { WFC_SCRIPT_ROOT: install }).additionalContext,
		).toContain(`asks for: ${install}/docs/agents/tool-output.md.`);
	});
});

describe("a host listing the guard under `disabled`", () => {
	const declare = (disabled: string[]) => {
		fs.mkdirSync(path.join(project, ".claude"));
		fs.writeFileSync(
			path.join(project, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: CONTRACT, disabled }),
		);
	};

	it("is silenced by the core's name, so one entry stands down both limbs (#569)", () => {
		declare(["guard-wide-read"]);
		expect(emission("cat big.md")).toBeNull();
	});

	it("still warns where the list names another hook", () => {
		declare(["guard-branch"]);
		expect(emission("cat big.md")?.additionalContext).toMatch(
			/^Reading a whole file into context/,
		);
	});
});
