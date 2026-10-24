// @vitest-environment node
/*
 * guard-check-sh.sh states the two shellcheck rules before the shell gate runs
 * rather than after it has misled someone (mantahostels#1805, spec mantahostels#1762).
 *
 * It never denies and never warns, so every case here asserts `permissionDecision`
 * is ABSENT as well as asserting the text, and takes none of the shared deny
 * fixtures, which drive a payload they expect to be refused.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`) on a shellcheck or npm command: break it and a session
 * runs `npm run check:sh` without the rules, where a missing binary's silent
 * exit 0 reads as a clean gate; make it deny and every shell-gate run is
 * wedged.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-check-sh.sh");
/* The store's Node accessor, so a test asks for a rule by id rather than
 * holding a second copy of its text. CommonJS, hence the require. */
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};

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
	guardOutput(GUARD, buildBashPayload(command, session), {
		project: root,
		config,
		cwd: root,
	});

describe("a shell-gate run is handed both rules, and refused nothing", () => {
	it.each([
		["npm run check:sh", "the spelling package.json defines"],
		["npm check:sh", "npm's own shorthand for the same script"],
		["npm run check:sh:changed", "the changed-paths form (#1015)"],
		["npm check:sh:changed", "its shorthand"],
		["shellcheck scripts/guard-branch.sh", "the tool driven directly"],
		["npm run typecheck && npm run check:sh", "the tail of a chain"],
	])("%s is handed the rules — %s", (command) => {
		const out = emission(command);
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(
			ruleText("shellcheck-not-installed"),
		);
		expect(out.additionalContext).toContain(
			ruleText("shellcheck-source-directive"),
		);
	});

	it.each([
		["npm run check:sh", true],
		["npm check:sh", true],
		["npm run check:sh:changed", false],
		["shellcheck scripts/guard-branch.sh", false],
	])("%s names check:sh:changed: %s", (command, named) => {
		// Only the full run has a cheaper route to point at (#1015).
		const ctx = emission(command).additionalContext as string;
		expect(ctx.includes(ruleText("shellcheck-changed-scope"))).toBe(named);
	});

	it("states the missing binary first, the directive second", () => {
		// gp_rule takes its ids in priority order and concatenates in that order.
		// Whether the run means anything at all comes before how to read what it
		// found.
		const ctx = emission("npm run check:sh").additionalContext as string;
		expect(ctx.indexOf("does not supply shellcheck")).toBeLessThan(
			ctx.indexOf("NEEDS A DIRECTIVE"),
		);
	});
});

/*
 * MUTATION ANCHORS. `toContain(ruleText(<id>))` reads the same file the guard
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
	expect(ruleText(id).replace(/\s+/g, " ")).toContain(clause);

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
		expect(ctx).not.toContain(ruleText("commit-pathspec"));
		expect(ctx).not.toContain(ruleText("push-cadence"));
		// GP_RULE_CAP is BYTES, and both fragments are multibyte — guard-parse.sh
		// forces LC_ALL=C on its own length for exactly this reason.
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(4000);
	});
});

describe("things that are not the shell gate", () => {
	it.each([
		["npm run lint", "lint never sees a .sh file (CLAUDE.md §Commands)"],
		["npm run check", "Biome over the repo, not shellcheck"],
		["npm run check:staged", "the pre-commit form of the Biome gate"],
		["npm test", "a different gate entirely"],
		["echo 'run npm run check:sh first'", "prose about the gate"],
		["grep -rn 'shellcheck' scripts", "a search for it"],
	])("%s is handed nothing — %s", (command) => {
		expect(emission(command)).toBeNull();
	});

	it("a bare npm does not crash the hook on an absent word", () => {
		// `set -u` is on, and is_check_sh reads $2 and $3 — an unbound-variable
		// crash here would be a silent stand-down on every short segment.
		expect(emission("npm")).toBeNull();
	});
});

describe("what it cannot resolve, it records and allows", () => {
	it("says nothing and logs when the payload carries no session", () => {
		// gp_rule's payload side keeps the house fail-open (mantahostels#103 §6); only its
		// store side refuses. Without a session id there is no latch key, so an
		// injection would repeat on every call.
		const r = spawnGuard(GUARD, buildBashPayload("npm run check:sh", null), {
			project: root,
			config,
			cwd: root,
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/no session_id in payload/,
		);
	});

	it("disarms itself, silently and on the record, without the parser", () => {
		// The one fault that stands the guard down entirely (mantahostels#103 §6). It is
		// copied to a scratch directory whose lib/ holds guard-log.sh alone, so
		// the `declare -F gp_begin` gate finds nothing.
		const at = fs.mkdtempSync(path.join(dir, "nolib-"));
		fs.mkdirSync(path.join(at, "lib"));
		fs.copyFileSync(GUARD, path.join(at, "guard-check-sh.sh"));
		// guard-log.sh reads the repo root through gr_root, which lives in
		// guard-root.sh since mantahostels#1905 — without it the fail-open record lands under
		// the wrong slug and this case tests nothing.
		for (const lib of ["guard-log.sh", "guard-root.sh"]) {
			fs.copyFileSync(
				path.resolve(__dirname, "lib", lib),
				path.join(at, "lib", lib),
			);
		}
		const r = spawnGuard(
			path.join(at, "guard-check-sh.sh"),
			buildBashPayload("npm run check:sh", "test"),
			{ project: root, config, cwd: root },
		);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/guard-parse\.sh did not load/,
		);
	});

	it("refuses the call when the fragment cannot be read, naming the rule", () => {
		// The one place this guard exits non-zero (mantahostels#1762): a rule that cannot be
		// stated is worth a refused tool call.
		const empty = fs.mkdtempSync(path.join(dir, "store-"));
		const r = spawnGuard(GUARD, buildBashPayload("npm run check:sh", "test"), {
			project: root,
			config,
			cwd: root,
			env: { WFC_RULES_DIR: empty },
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("shellcheck-not-installed");
	});
});
