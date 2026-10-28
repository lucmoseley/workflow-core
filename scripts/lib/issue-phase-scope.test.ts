// @vitest-environment node
/*
 * lib/issue-phase-scope.js, the guard-issue-phase-scope core (#2798), in
 * process: it denies a `gh issue create` whose title names a roadmap card
 * outside Phase 0 that the founder has not called (mantahostels#1613).
 *
 * A deny is only defensible while it cannot wedge sanctioned work, so every
 * allow-case below is a shape that would otherwise be a false positive: a
 * Phase-0 card, a called card, a title with no card prefix at all, a card the
 * roadmap does not know, and a command that merely mentions `gh issue create`.
 * Do not thin them out.
 *
 * The roadmap and the register are FIXTURES, not the real files: a test that
 * read `docs/reference-roadmap.html` would change its verdict every time a
 * card moved phase, and would go green for the wrong reason once every card
 * was called. The entry's own cases — the JSON it prints, the hook line, the
 * failure policy — are guard-issue-phase-scope.test.ts's.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";

type Decision = { deny: string } | { injectRules: string[] } | null;
const { decide } = require("./issue-phase-scope.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { buildHostPorts } = require("./issue-phase-scope-host.js") as {
	buildHostPorts: (root: string) => Record<string, unknown>;
};

let dir: string;
let faults: string[];

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

const at = (rel: string) => path.join(dir, rel);

const writeFixtures = (registerBody: string) => {
	fs.mkdirSync(at("docs"), { recursive: true });
	fs.writeFileSync(at("docs/reference-roadmap.html"), ROADMAP);
	fs.writeFileSync(at("docs/called-cards.md"), registerBody);
};

const run = (command: string) =>
	decide(
		command,
		kitContextFake({
			fallbackCwd: dir,
			isDir: (p: string) =>
				fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
			log: (what: string) => faults.push(what),
			...buildHostPorts(dir),
		}),
	);

const verdict = (command: string) => {
	const d = run(command);
	if (!d) return "allow";
	return "deny" in d ? "deny" : "warn";
};

const reason = (command: string) => {
	const d = run(command);
	if (!d || !("deny" in d)) throw new Error(`expected a deny for: ${command}`);
	return d.deny;
};

const readFaults = () => faults;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-phase-scope-"));
	faults = [];
	writeFixtures(register());
});

afterEach(() => {
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
		expect(reason(call)).toMatch(
			/^This opens an issue for `privacy-ops`, a \*\*Phase 1\*\*/,
		);
	});

	it("judges gh by its basename, so a path-spelled call is no escape", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(
			verdict('/usr/bin/gh issue create --title "search-core — a thing"'),
		).toBe("deny");
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
		// @CMD@ is spliced with the segment as unmask renders it, quoted
		// spans elided.
		expect(r).toContain('has not called: gh issue create --title "…"');
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

	it("allows a prefix that is not a card id's shape, so no pattern is built from it", () => {
		// `search.core` would match `search-core` as a pattern: the id's shape
		// is what keeps the roadmap lookup literal.
		expect(verdict('gh issue create --title "search.core — a thing"')).toBe(
			"allow",
		);
	});

	it("allows another program's `issue create`", () => {
		expect(verdict('hub issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
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
		expect(
			verdict(
				'gh api --method GET repos/o/r/issues -f title="search-core — a thing"',
			),
		).toBe("allow");
		expect(
			verdict(
				'gh api --method POST repos/o/r/issues/5/comments -f title="search-core — a thing"',
			),
		).toBe("allow");
		expect(verdict('gh api graphql -f title="search-core — a thing"')).toBe(
			"allow",
		);
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

	it("ignores a row after the end marker", () => {
		writeFixtures(`${register()}- \`search-core\` — after the end\n`);
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"deny",
		);
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
	it("follows env, command, exec, nohup and nice -n", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		for (const w of ["env", "command", "exec", "nohup", "nice -n 5"])
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

	it("does not follow a wrapper that takes arguments of its own (LIMITS)", () => {
		expect(
			verdict(
				'timeout --signal=INT 60 gh issue create --title "search-core — a thing"',
			),
		).toBe("allow");
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

	it("reads an en dash as well as an em dash, and an unspaced em dash", () => {
		// exempt (mantahostels#2145): the guard has one deny message, pinned — card, phase and
		// escape — by "names the card, its phase, and who may call it".
		expect(verdict('gh issue create --title "search-core – a thing"')).toBe(
			"deny",
		);
		expect(verdict('gh issue create --title "search-core—a thing"')).toBe(
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
		expect(readFaults()).toEqual([
			"could not read the --title of a gh issue create — create allowed unchecked",
		]);
	});

	it("allows and records a title whose card prefix reads but whose rest does not", () => {
		// The visible text names a card, but a title not read whole is not
		// judged.
		expect(verdict('gh issue create --title "search-core — $X"')).toBe("allow");
		expect(readFaults()).toEqual([
			"could not read the --title of a gh issue create — create allowed unchecked",
		]);
	});

	it("allows and records a --title with no value", () => {
		expect(verdict("gh issue create --title")).toBe("allow");
		expect(readFaults()).toEqual([
			"a gh issue create ends in a --title with no value — create allowed unchecked",
		]);
	});

	it("allows and records an unreadable bare argument beside a prefix-less title", () => {
		expect(verdict('gh issue create --title "plain" $ARGS')).toBe("allow");
		expect(readFaults()).toEqual([
			"could not read the arguments of a gh issue create — create allowed unchecked",
		]);
	});

	it("allows and records a missing roadmap", () => {
		fs.rmSync(at("docs/reference-roadmap.html"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"docs/reference-roadmap.html is unreadable — issue creation allowed unchecked",
		]);
	});

	it("allows and records a roadmap that opens but will not read, never as 'no such card'", () => {
		fs.rmSync(at("docs/reference-roadmap.html"));
		fs.mkdirSync(at("docs/reference-roadmap.html"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"docs/reference-roadmap.html would not read — issue creation for search-core allowed unchecked",
		]);
	});

	it("allows and records a REST field whose own name is hidden", () => {
		// The name decides whether the value matters, so a masked field could be
		// the title and cannot be told from any other.
		expect(verdict('gh api --method POST repos/o/r/issues -f "$FIELD"')).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"a gh api issue creation carried a masked field word — create allowed unchecked",
		]);
	});

	it("allows and records a REST field name carrying a bare expansion", () => {
		expect(verdict("gh api --method POST repos/o/r/issues -f $F=x")).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"could not read a field name on a gh api issue creation — create allowed unchecked",
		]);
	});

	it("allows and records a REST title whose value is hidden", () => {
		expect(verdict('gh api --method POST repos/o/r/issues -f title="$T"')).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"could not read the title field on a gh api issue creation — create allowed unchecked",
		]);
	});

	it("allows and records a REST creation whose method, endpoint or payload it cannot read", () => {
		for (const call of [
			'gh api --method "$M" repos/o/r/issues -f title="search-core — a thing"',
			'gh api "$EP" -f title="search-core — a thing"',
			"gh api repos/o/r/issues --input body.json",
		]) {
			faults = [];
			expect(verdict(call)).toBe("allow");
			expect(readFaults()).toEqual([
				"could not read a gh api issue creation — create allowed unchecked",
			]);
		}
	});

	it("records nothing for a gh call that is not a creation", () => {
		// The roadmap check waits until the command is known to be a create;
		// ahead of that, every `gh` call in the repo would write a fail-open record.
		fs.rmSync(at("docs/reference-roadmap.html"));
		expect(verdict("gh issue list --state open")).toBe("allow");
		expect(verdict("gh pr view 5")).toBe("allow");
		expect(readFaults()).toEqual([]);
	});

	it("allows and records a missing register", () => {
		fs.rmSync(at("docs/called-cards.md"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"docs/called-cards.md is unreadable — issue creation for search-core allowed unchecked",
		]);
	});
});
