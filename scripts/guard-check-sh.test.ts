// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import { seenFrom } from "./lib/core-path-testkit";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
	runDispatchCore,
} from "./lib/pretool-guard-testkit";
import { readRuleText } from "./lib/rule-text";

const CORE = "guard-check-sh";

let dir: string;
let config: string;
let root: string;

beforeEach(() => {
	({ dir, config } = guardDirs("check-sh-"));
	root = path.join(dir, "root");
	fs.mkdirSync(root);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const emission = (command: string, session = "test") =>
	dispatchCoreOutput(CORE, buildBashPayload(command, session), {
		project: root,
		config,
		cwd: root,
	});
const seenRule = (id: string) => seenFrom(root, () => readRuleText(id));

describe("each exit path", () => {
	it("hands a direct run the two rules, in priority order, refusing nothing", () => {
		const out = emission("shellcheck scripts/guard-branch.sh");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.additionalContext).toBe(
			`${seenRule("shellcheck-not-installed")}\n\n${seenRule("shellcheck-source-directive")}`,
		);
	});

	it("hands the full run the changed-paths route third (#1015)", () => {
		const ctx = emission("npm run check:sh").additionalContext as string;
		expect(ctx).toBe(
			[
				"shellcheck-not-installed",
				"shellcheck-source-directive",
				"shellcheck-changed-scope",
			]
				.map(seenRule)
				.join("\n\n"),
		);
	});

	it("says nothing on a command that is not the gate, logging nothing", () => {
		expect(emission("npm run lint")).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, root))).toBe(false);
	});
});

const carries = (id: string, clause: string) =>
	expect(readRuleText(id).replace(/\s+/g, " ")).toContain(clause);

describe("the injected rules still carry their operative clauses", () => {
	it("a clause no fragment carries fails", () => {
		expect(() =>
			carries("shellcheck-not-installed", "a clause no fragment carries"),
		).toThrow();
	});

	it.each([
		["fails to find it rather than passing vacuously", "the whole point"],
		["~/.local/bin", "where the binary actually is here"],
		["0.9.0", "why apt is not the answer"],
	])("shellcheck-not-installed keeps %s — %s", (clause) => {
		carries("shellcheck-not-installed", clause);
	});

	it.each([
		["bash scripts/check-sh-changed.sh", "the route it points at"],
		["300 s", "why the full run is the wrong in-session check"],
		["unchanged caller", "what the narrow run misses"],
	])("shellcheck-changed-scope keeps %s — %s", (clause) => {
		carries("shellcheck-changed-scope", clause);
	});

	it.each([
		["# shellcheck source=scripts/lib/", "the directive itself"],
		["unassigned-variable noise", "what its absence produces"],
	])("shellcheck-source-directive keeps %s — %s", (clause) => {
		carries("shellcheck-source-directive", clause);
	});
});

describe("it says it once, and spends no more of the cap than it needs", () => {
	it("is silent on a session's second run, and speaks to a new session", () => {
		expect(emission("npm run check:sh", "sess-A")).not.toBeNull();
		expect(emission("npm run check:sh", "sess-A")).toBeNull();
		expect(emission("npm run check:sh", "sess-B")).not.toBeNull();
	}, 30_000);

	it("requests the three shellcheck ids and no others", () => {
		const ctx = emission("npm run check:sh").additionalContext as string;
		expect(ctx).not.toContain(readRuleText("commit-pathspec"));
		expect(ctx).not.toContain(readRuleText("push-cadence"));
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(4000);
	});
});

describe("what it cannot resolve, it records and allows", () => {
	const run = (payload: Record<string, unknown>) =>
		runDispatchCore(CORE, payload, { project: root, config, cwd: root });

	it("says nothing and logs when the payload carries no session", () => {
		const r = run(buildBashPayload("npm run check:sh", null));
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(readFailOpenLog(config, root)).toMatch(/no session_id in payload/);
	});

	it("refuses the call when the fragment cannot be read, naming the rule", () => {
		const empty = fs.mkdtempSync(path.join(dir, "store-"));
		const out = dispatchCoreOutput(
			CORE,
			buildBashPayload("npm run check:sh", "test"),
			{ project: root, config, cwd: root, env: { WFC_RULES_DIR: empty } },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toMatch(
			/^guard-check-sh: .*shellcheck-not-installed/,
		);
		expect(readFailOpenLog(config, root)).toMatch(
			/rule fragment unreadable — refusing/,
		);
	});
});
