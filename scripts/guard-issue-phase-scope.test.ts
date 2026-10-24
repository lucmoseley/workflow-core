// @vitest-environment node
/*
 * guard-issue-phase-scope.sh denies a `gh issue create` whose title names a
 * roadmap card outside Phase 0 that the founder has not called (mantahostels#1613).
 *
 * A deny is only defensible while it cannot wedge sanctioned work, so every
 * allow-case below is a shape that would otherwise be a false positive: a
 * Phase-0 card, a called card, a title with no card prefix at all, a card the
 * roadmap does not know, and a command that merely mentions `gh issue create`.
 * Do not thin them out.
 *
 * The roadmap and the register are FIXTURES, not the real files: a test that
 * read `docs/reference-roadmap.html` would change its verdict every time a card
 * moved phase, and would go green for the wrong reason once every card was
 * called.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a deny case and a session files work on a later
 * phase's card the founder never called; lose an allow case and filing
 * Phase-0 or called work is wedged.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";

const GUARD = path.resolve(__dirname, "guard-issue-phase-scope.sh");

let dir: string;
let config: string;
let shared: string;

/** A roadmap holding one Phase-0 card and two Phase-1 cards. */
const ROADMAP = [
	'<p class="docmeta">v9.99 · updated 1 January 2026, 00:00</p>',
	"const ITEMS = [",
	'  {id:"guide-pages",p:0,a:["mkt"],kind:"action",state:"active",t:"Destination guides",',
	'  {id:"search-core",p:1,a:["prod"],kind:"action",state:"active",t:"Search core",',
	'  {id:"privacy-ops",p:1,a:["legal"],kind:"action",state:"active",t:"Privacy plumbing",',
	"];",
].join("\n");

const register = (...cards: string[]) =>
	[
		"# Called cards",
		"",
		"Format example, deliberately outside the markers:",
		"",
		"- `search-core` — called some day",
		"",
		"<!-- called-cards:begin -->",
		...cards.map((c) => `- \`${c}\` — called 1 January 2026`),
		"<!-- called-cards:end -->",
		"",
	].join("\n");

const writeFixtures = (registerBody: string) => {
	fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(shared, "docs", "reference-roadmap.html"),
		ROADMAP,
	);
	fs.writeFileSync(path.join(shared, "docs", "called-cards.md"), registerBody);
};

const run = (command: string) =>
	spawnSync(GUARD, [], {
		cwd: shared,
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: shared,
			// Unset, a test run appends to the founder's own fail-open log and
			// manufactures the very records check-guard-errors.js exists to report.
			CLAUDE_CONFIG_DIR: config,
		},
	});

const verdict = (command: string) => {
	const r = run(command);
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	// A crashing guard emits no verdict either, so "allow" must mean silence by
	// design rather than by accident (mantahostels#123).
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return "deny";
	if (/"additionalContext"/.test(out)) return "warn";
	expect(out).toBe("");
	return "allow";
};

const reason = (command: string) => {
	const out = run(command).stdout ?? "";
	return JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string;
};

/** The fail-open records this run left, parsed as check-guard-errors.js parses them. */
const faults = () => {
	const at = failOpenLogPath(config, shared);
	if (!fs.existsSync(at)) return [];
	return fs
		.readFileSync(at, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t")[2]);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-issue-phase-scope-"));
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	fs.mkdirSync(shared);
	writeFixtures(register());
});

afterEach(() => {
	// Every case mkdtemps a tree; without this they accumulate in /tmp for the
	// life of the machine.
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the creates it denies", () => {
	it("denies a Phase-1 card nobody has called", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(
			verdict(
				'gh issue create --title "search-core — which filters ship" --label takes:triage',
			),
		).toBe("deny");
	});

	it("denies every uncalled Phase-1 card, not just the first, naming the card", () => {
		const call = 'gh issue create --title "privacy-ops — Art. 34 re-read"';
		expect(verdict(call)).toBe("deny");
		// The refusal must name THIS card: the pin below is written against
		// search-core, so a deny that named it would pass unnoticed here.
		expect(reason(call)).toContain("privacy-ops");
	});

	it("denies the REST spelling of the same creation", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(
			verdict(
				'gh api --method POST repos/o/r/issues -f title="search-core — a thing"',
			),
		).toBe("deny");
	});

	it("denies a REST creation that names no method, gh defaulting to POST", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(
			verdict('gh api repos/o/r/issues -f title="search-core — a thing"'),
		).toBe("deny");
	});

	it("denies through the short -t spelling of the title", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(verdict('gh issue create -t "search-core — a thing"')).toBe("deny");
	});

	it("names the card, its phase, and who may call it", () => {
		const r = reason('gh issue create --title "search-core — a thing"');
		expect(r).toContain("search-core");
		expect(r).toContain("Phase 1");
		expect(r).toContain("docs/called-cards.md");
		// The one instruction that must survive any rewording: the session is
		// told not to grant itself the permission it was just refused.
		expect(r).toMatch(/Never add the row to unblock yourself/);
	});
});

describe("the creates it allows", () => {
	it("allows a Phase-0 card, which needs no row", () => {
		expect(
			verdict(
				'gh issue create --title "guide-pages — draft the Velmora guide"',
			),
		).toBe("allow");
	});

	it("allows a Phase-1 card once the founder has called it", () => {
		writeFixtures(register("search-core"));
		expect(
			verdict('gh issue create --title "search-core — which filters ship"'),
		).toBe("allow");
	});

	it("allows a title with no card prefix — workflow machinery", () => {
		expect(
			verdict(
				'gh issue create --title "Refuse a commit that adds an over-cap entry"',
			),
		).toBe("allow");
	});

	it("allows an em-dashed title whose prefix is prose, not a card id", () => {
		expect(
			verdict(
				'gh issue create --title "Something went wrong — and here is why"',
			),
		).toBe("allow");
	});

	it("allows a card id the roadmap does not know", () => {
		expect(verdict('gh issue create --title "no-such-card — a thing"')).toBe(
			"allow",
		);
	});

	it("allows a hyphen-separated title, which cannot be split without guessing", () => {
		// `seed-listings - x` has no unambiguous split: card ids contain hyphens.
		expect(verdict('gh issue create --title "search-core - a thing"')).toBe(
			"allow",
		);
	});

	it("allows a command that merely mentions gh issue create", () => {
		expect(
			verdict('echo gh issue create --title "search-core — a decoy"'),
		).toBe("allow");
	});

	it("allows other gh subcommands and other REST endpoints", () => {
		expect(verdict('gh issue edit 5 --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(verdict('gh issue list --search "search-core — a thing"')).toBe(
			"allow",
		);
		expect(
			verdict(
				'gh api --method POST repos/o/r/issues/5/comments -f body="search-core — a thing"',
			),
		).toBe("allow");
	});

	it("allows --help, which files nothing", () => {
		expect(
			verdict('gh issue create --title "search-core — a thing" --help'),
		).toBe("allow");
	});
});

describe("what the register does and does not license", () => {
	it("lifts the deny for the called card and for no other", () => {
		writeFixtures(register("search-core"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		const other = 'gh issue create --title "privacy-ops — a thing"';
		expect(verdict(other)).toBe("deny");
		// The refusal must name privacy-ops: a deny still naming search-core would
		// mean the register was not read at all, which is what this test denies.
		expect(reason(other)).toContain("privacy-ops");
	});

	it("ignores a row outside the markers, so the format example is not a licence", () => {
		// The register's own prose shows `- \`search-core\`` as the row format,
		// outside the markers. Reading it would call the very card the fixture is
		// there to protect, and every deny case above would pass for that reason.
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"deny",
		);
	});
});

describe("the wrapper spellings it follows", () => {
	// Without these, prefixing one word escapes the whole guard.
	it("follows env, command and exec", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		for (const w of ["env", "command", "exec"])
			expect(
				verdict(`${w} gh issue create --title "search-core — a thing"`),
			).toBe("deny");
	});

	it("follows timeout past its duration argument", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(
			verdict('timeout 60 gh issue create --title "search-core — a thing"'),
		).toBe("deny");
		expect(
			verdict('timeout 1.5s gh issue create --title "search-core — a thing"'),
		).toBe("deny");
	});
});

describe("the title spellings it still reads as a card", () => {
	it("trims the prefix, so a doubled space is not an escape", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(
			verdict('gh issue create --title "search-core  — a doubled space"'),
		).toBe("deny");
	});

	it("reads an en dash as well as an em dash", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(verdict('gh issue create --title "search-core – a thing"')).toBe(
			"deny",
		);
	});

	it("judges a readable title even when another argument is not", () => {
		// The title is the guard's only input. Failing open on an unrelated
		// expansion would walk a deniable creation through.
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(verdict('gh issue create --title "search-core — a thing" $_')).toBe(
			"deny",
		);
	});
});

describe("what it fails open on, and records", () => {
	it("allows and records a title it cannot read", () => {
		expect(verdict('gh issue create --title "$TITLE"')).toBe("allow");
		expect(faults().join("\n")).toMatch(/title/i);
	});

	it("allows and records a --title with no value", () => {
		expect(verdict("gh issue create --title")).toBe("allow");
		expect(faults().join("\n")).toMatch(/title/i);
	});

	it("allows and records a missing roadmap", () => {
		fs.rmSync(path.join(shared, "docs", "reference-roadmap.html"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(faults().join("\n")).toMatch(/reference-roadmap/);
	});

	it("allows and records a REST field whose own name is hidden", () => {
		// The name decides whether the value matters, so a masked field could be
		// the title and cannot be told from any other.
		expect(verdict('gh api --method POST repos/o/r/issues -f "$FIELD"')).toBe(
			"allow",
		);
		// Two paths cover this: guard-gh-api.sh's own $api_opaque flag, which
		// fires first, and the `$`-in-the-field-name arm behind it. Either is a pass.
		expect(faults().join("\n")).toMatch(/masked field word|field name/i);
	});

	it("allows and records a REST title whose value is hidden", () => {
		expect(verdict('gh api --method POST repos/o/r/issues -f title="$T"')).toBe(
			"allow",
		);
		expect(faults().join("\n")).toMatch(/title field/i);
	});

	it("records nothing for a gh call that is not a creation", () => {
		// The roadmap check used to sit before the command was known to be a
		// create, so every `gh` call in the repo wrote a fail-open record.
		fs.rmSync(path.join(shared, "docs", "reference-roadmap.html"));
		expect(verdict("gh issue list --state open")).toBe("allow");
		expect(verdict("gh pr view 5")).toBe("allow");
		expect(faults()).toEqual([]);
	});

	it("allows and records a missing register", () => {
		fs.rmSync(path.join(shared, "docs", "called-cards.md"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(faults().join("\n")).toMatch(/called-cards/);
	});
});
