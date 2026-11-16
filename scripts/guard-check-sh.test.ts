// @vitest-environment node
/*
 * The boundary set of the guard-check-sh core of guard-dispatch.js (#2800),
 * the dispatcher entry run on it alone: it states the two shellcheck rules
 * before the shell gate runs rather than after it has misled someone
 * (mantahostels#1805, spec mantahostels#1762). Each exit path, the payload's
 * channels, the rule store and the latch crossed for real; which commands are
 * the gate is lib/check-sh-rules.test.ts's module cases on the core; the
 * entry's payload faults and the throw policy are guard-dispatch's own tests'
 * (#3224).
 *
 * It never denies and never warns bar the store fault, so every injection
 * case asserts `permissionDecision` is ABSENT as well as asserting the text.
 *
 * It runs as a core of the `PreToolUse` dispatcher on a shellcheck or npm
 * command: break it and a session
 * runs `npm run check:sh` without the rules, where a missing binary's silent
 * exit 0 reads as a clean gate; make it deny and every shell-gate run is
 * wedged.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
	runDispatchCore,
} from "./lib/pretool-guard-testkit";
/* The store's Node accessor, so a test asks for a rule by id rather than
 * holding a second copy of its text. */
import { readRuleText } from "./lib/rule-text";

const CORE = "guard-check-sh";

let dir: string;
let config: string;
let root: string;

beforeEach(() => {
	({ dir, config } = guardDirs("check-sh-"));
	/* No git repo is needed: this guard reads npm script names, not a tree. The
	 * directory exists only to key the latch and the fail-open log. */
	root = path.join(dir, "root");
	fs.mkdirSync(root);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The whole hook output for `command`, parsed. Null where it said nothing. */
const emission = (command: string, session = "test") =>
	dispatchCoreOutput(CORE, buildBashPayload(command, session), {
		project: root,
		config,
		cwd: root,
	});

describe("each exit path", () => {
	it("hands a direct run the two rules, in priority order, refusing nothing", () => {
		const out = emission("shellcheck scripts/guard-branch.sh");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.hookEventName).toBe("PreToolUse");
		// The kit takes the ids in priority order and concatenates in that
		// order: whether the run means anything at all comes before how to read
		// what it found.
		expect(out.additionalContext).toBe(
			`${readRuleText("shellcheck-not-installed")}\n\n${readRuleText("shellcheck-source-directive")}`,
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
				.map((id) => readRuleText(id))
				.join("\n\n"),
		);
	});

	it("says nothing on a command that is not the gate, logging nothing", () => {
		expect(emission("npm run lint")).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, root))).toBe(false);
	});
});

/*
 * MUTATION ANCHORS. `toContain(readRuleText(<id>))` reads the same file the guard
 * does, so it moves with a mutation to the fragment instead of catching it: cut
 * a clause and both sides lose it together.
 *
 * A row reads the ONE fragment its block names, not the emission, which
 * concatenates both (mantahostels#2230, following mantahostels#2226): over the emission a clause
 * deleted from one fragment stays green on the other's copy, and a clause moved
 * between the two is never caught at all.
 *
 * Both fragments are hard-wrapped at ~80 columns, so a clause straddles a
 * newline whenever a reflow moves it. Collapsing the fragment's whitespace pins
 * the words and never the wrapping — so a wrap CANNOT be pinned here.
 */
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
		// RULE_CAP is BYTES, and both fragments are multibyte — guard-entry.js
		// measures with Buffer.byteLength for exactly this reason.
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(4000);
	});
});

describe("what it cannot resolve, it records and allows", () => {
	const run = (payload: Record<string, unknown>) =>
		runDispatchCore(CORE, payload, { project: root, config, cwd: root });

	it("says nothing and logs when the payload carries no session", () => {
		// The kit's payload side keeps the house fail-open (mantahostels#103 §6);
		// only its store side refuses. Without a session id there is no latch
		// key, so an injection would repeat on every call.
		const r = run(buildBashPayload("npm run check:sh", null));
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(readFailOpenLog(config, root)).toMatch(/no session_id in payload/);
	});

	it("refuses the call when the fragment cannot be read, naming the rule", () => {
		// The one place this guard refuses (mantahostels#1762): a rule that
		// cannot be stated is worth a refused tool call. A deny on exit 0.
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
