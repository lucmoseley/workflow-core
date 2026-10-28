// @vitest-environment node
/*
 * The guard-rm-unchecked core of guard-dispatch.js refuses, once per command,
 * an `rm` Claude Code's built-in removal check cannot resolve (#2436). These
 * are its boundary cases (§X11), the dispatcher entry run on it alone: the
 * payload on stdin, the rule store, and the latch on disk under
 * CLAUDE_PROJECT_DIR. Which command earns which verdict, and the refusal's
 * words, are lib/unchecked-rm.test.ts's (#2801); the entry's payload faults
 * and the throw policy are guard-dispatch's own tests' (#3226).
 *
 * `CLAUDE_PROJECT_DIR` and `CLAUDE_CONFIG_DIR` sit in a temp directory so the
 * latch and the fail-open log never land in the real checkout or the
 * founder's log.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";
import { readRuleText } from "./lib/rule-text";

const CORE = "guard-rm-unchecked";

const COMMAND = "rm -rf $T/*";

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("rm-unchecked-"));
});

afterEach(() => {
	const markers = path.join(dir, ".claude", "tmp", "markers");
	if (fs.existsSync(markers)) fs.chmodSync(markers, 0o755);
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The hook's hookSpecificOutput for `payload`, or null; exit 0 and a quiet
 * stderr asserted on every call. */
const emission = (
	payload: Record<string, unknown>,
	env: NodeJS.ProcessEnv = {},
) => dispatchCoreOutput(CORE, payload, { project: dir, config, cwd: dir, env });

/** The latch file at guard-entry.js's latchPath for `command`. */
const latchFile = (command: string, session: string, agent = "main") =>
	path.join(
		dir,
		".claude",
		"tmp",
		"markers",
		`.rule-injected-rm-unchecked.${crypto.createHash("sha1").update(command).digest("hex").slice(0, 16)}-${agent}-${session}`,
	);

const readLogLines = () =>
	readFailOpenLog(config, dir)
		.trim()
		.split("\n")
		.map((l) => l.split("\t").slice(1));

describe("the refusal, end to end", () => {
	it("refuses as JSON on exit 0 carrying the rule, writes the latch, and lets the re-send through", () => {
		const out = emission(buildBashPayload(COMMAND, "one-session"));
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain("`$T/*`");
		expect(out.permissionDecisionReason).toContain(
			readRuleText("rm-unchecked"),
		);
		expect(fs.readFileSync(latchFile(COMMAND, "one-session"), "utf8")).toBe("");
		expect(emission(buildBashPayload(COMMAND, "one-session"))).toBeNull();
		expect(
			emission(buildBashPayload(COMMAND, "another-session"))
				?.permissionDecision,
		).toBe("deny");
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("passes a re-send whose latch sits at guard-entry.js's latchPath, a subagent's keyed on its agent id", () => {
		fs.mkdirSync(path.join(dir, ".claude", "tmp", "markers"), {
			recursive: true,
		});
		fs.writeFileSync(latchFile(COMMAND, "s_1", "aag_7"), "");
		expect(
			emission({ ...buildBashPayload(COMMAND, "s:1"), agent_id: "ag/7" }),
		).toBeNull();
		expect(emission(buildBashPayload(COMMAND, "s:1"))?.permissionDecision).toBe(
			"deny",
		);
	});

	it("passes a command it has no cause to refuse, silently", () => {
		expect(emission(buildBashPayload("rm -rf .claude/tmp/abc"))).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("still refuses, carrying the fallback, where the rule store is empty", () => {
		const store = fs.mkdtempSync(path.join(dir, "store-"));
		const out = emission(buildBashPayload(COMMAND), { WFC_RULES_DIR: store });
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"the rule could not be read from docs/agents/rules/rm-unchecked.txt",
		);
	});

	it("spells the fragment's file at the plugin root in an install", () => {
		// WFC_SCRIPT_ROOT stands in for an install: a core root with no
		// package.json.
		const install = path.join(dir, "install");
		const rules = path.join(install, "docs", "agents", "rules");
		fs.mkdirSync(rules, { recursive: true });
		fs.writeFileSync(path.join(rules, "rm-unchecked.txt"), "x\n");
		const out = emission(buildBashPayload(COMMAND), {
			WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")),
			WFC_SCRIPT_ROOT: install,
		});
		expect(out.permissionDecisionReason).toContain(
			`read from ${rules}/rm-unchecked.txt.`,
		);
	});
});

describe("the fail-open record", () => {
	it.each([
		["no session id", buildBashPayload(COMMAND, null)],
		["an empty session id", buildBashPayload(COMMAND, "")],
		[
			"a session id that is no string",
			{ ...buildBashPayload(COMMAND), session_id: 7 },
		],
	])("allows, logged, a payload with %s to key the latch on", (_l, payload) => {
		expect(emission(payload)).toBeNull();
		expect(readLogLines()).toEqual([
			[CORE, "latch path unresolved — an unchecked rm allowed unrefused"],
		]);
	});

	it("allows, logged, where the markers directory is unwritable", () => {
		const markers = path.join(dir, ".claude", "tmp", "markers");
		fs.mkdirSync(markers, { recursive: true });
		fs.chmodSync(markers, 0o555);
		expect(emission(buildBashPayload(COMMAND))).toBeNull();
		expect(readLogLines()).toEqual([
			[CORE, "latch directory unwritable — an unchecked rm allowed unrefused"],
		]);
	});
});
