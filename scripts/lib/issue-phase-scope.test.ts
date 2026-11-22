// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

type Decision = { deny: string } | { injectRules: string[] } | null;
const { decide } = require("./issue-phase-scope.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { treePorts } = require("./guard-host-ports.js") as {
	treePorts: (root: string) => object;
};

let dir: string;
let faults: string[];

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

const run = (command: string, ports: Record<string, unknown> = {}) =>
	decide(
		command,
		kitContextFake({
			fallbackCwd: dir,
			isDir: (p: string) =>
				fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
			log: (what: string) => faults.push(what),
			tree: () => treePorts(dir),
			...ports,
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
		expect(
			verdict(
				'gh issue create --title "search-core — which filters ship" --label takes:triage',
			),
		).toBe("deny");
	});

	it("denies every uncalled Phase-1 card, not just the first, naming the card", () => {
		const call = 'gh issue create --title "privacy-ops — Art. 34 re-read"';
		expect(verdict(call)).toBe("deny");
		expect(reason(call)).toMatch(
			/^This opens an issue for `privacy-ops`, a \*\*Phase 1\*\*/,
		);
	});

	it("judges gh by its basename, so a path-spelled call is no escape", () => {
		expect(
			verdict('/usr/bin/gh issue create --title "search-core — a thing"'),
		).toBe("deny");
	});

	it("denies the REST spelling of the same creation", () => {
		expect(
			verdict(
				'gh api --method POST repos/o/r/issues -f title="search-core — a thing"',
			),
		).toBe("deny");
	});

	it("denies a REST creation that names no method, gh defaulting to POST", () => {
		expect(
			verdict('gh api repos/o/r/issues -f title="search-core — a thing"'),
		).toBe("deny");
	});

	it.each([
		[
			'gh api --method POST repos/o/r/issues -f "title=search-core — x"',
			"the title field quoted whole",
		],
		[
			"gh api --method POST repos/o/r/issues -f title=\"search-core — x\" -f 'labels[]=takes:triage'",
			"a label field quoted whole beside a readable title",
		],
		[
			'gh api repos/o/r/issues -f "title=search-core — x" -f labels[]=takes:triage',
			"title quoted whole and no method, gh defaulting to POST",
		],
	])("denies a REST creation — %s — %s", (command) => {
		expect(verdict(command)).toBe("deny");
	});

	it("denies through the short -t spelling of the title", () => {
		expect(verdict('gh issue create -t "search-core — a thing"')).toBe("deny");
	});

	it("names the card, its phase, and who may call it", () => {
		const r = reason('gh issue create --title "search-core — a thing"');
		expect(r).toContain("search-core");
		expect(r).toContain("Phase 1");
		expect(r).toContain("docs/called-cards.md");
		expect(r).toMatch(/Never add the row to unblock yourself/);
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
		expect(reason(other)).toContain("privacy-ops");
	});

	it("ignores a row after the end marker", () => {
		writeFixtures(`${register()}- \`search-core\` — after the end\n`);
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"deny",
		);
	});

	it("ignores a row outside the markers, so the format example is not a licence", () => {
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"deny",
		);
	});
});

describe("the wrapper spellings it follows", () => {
	it("follows env, command, exec, nohup and nice -n", () => {
		for (const w of ["env", "command", "exec", "nohup", "nice -n 5"])
			expect(
				verdict(`${w} gh issue create --title "search-core — a thing"`),
			).toBe("deny");
	});

	it("follows timeout past its duration argument", () => {
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
		expect(
			verdict('gh issue create --title "search-core  — a doubled space"'),
		).toBe("deny");
	});

	it("reads an en dash as well as an em dash, and an unspaced em dash", () => {
		expect(verdict('gh issue create --title "search-core – a thing"')).toBe(
			"deny",
		);
		expect(verdict('gh issue create --title "search-core—a thing"')).toBe(
			"deny",
		);
	});

	it("judges a readable title even when another argument is not", () => {
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

	it("allows a create where no roadmap exists and records nothing, the module off (#5576)", () => {
		fs.rmSync(at("docs/reference-roadmap.html"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(verdict('gh issue create --title "$TITLE"')).toBe("allow");
		expect(readFaults()).toEqual([]);
	});

	it("allows and records a roadmap that opens but will not read, never as 'no such card'", () => {
		fs.rmSync(at("docs/reference-roadmap.html"));
		fs.mkdirSync(at("docs/reference-roadmap.html"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"docs/reference-roadmap.html is unreadable — issue creation allowed unchecked",
		]);
	});

	it("allows and records a register that opens but will not read, never as 'no rows'", () => {
		fs.rmSync(at("docs/called-cards.md"));
		fs.mkdirSync(at("docs/called-cards.md"));
		expect(verdict('gh issue create --title "search-core — a thing"')).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"docs/called-cards.md is unreadable — issue creation for search-core allowed unchecked",
		]);
	});

	it("allows and records a REST field whose own name is hidden", () => {
		expect(verdict('gh api --method POST repos/o/r/issues -f "$FIELD"')).toBe(
			"allow",
		);
		expect(readFaults()).toEqual([
			"could not read a field name on a gh api issue creation — create allowed unchecked",
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

	it("records nothing for a gh call that is not a creation (#3426)", () => {
		fs.rmSync(at("docs/reference-roadmap.html"));
		expect(verdict("gh issue list --state open")).toBe("allow");
		expect(verdict("gh pr view 5")).toBe("allow");
		expect(verdict("gh api repos/o/r/issues/5")).toBe("allow");
		expect(verdict('gh api graphql -f query="{viewer{login}}"')).toBe("allow");
		expect(readFaults()).toEqual([]);
	});

	it("never asks for the roadmap on a gh api read, so a tree that will not resolve refuses none (#3426)", () => {
		const tree = () => {
			throw new Error("tree down");
		};
		expect(() =>
			run('gh api repos/o/r/issues -f title="search-core — a thing"', {
				tree,
			}),
		).toThrow("tree down");
		expect(run("gh api repos/o/r/issues/5", { tree })).toBeNull();
		expect(
			run('gh api graphql -f query="{viewer{login}}"', { tree }),
		).toBeNull();
		expect(readFaults()).toEqual([]);
	});

	it("allows a REST creation where no roadmap exists and records nothing (#5576)", () => {
		fs.rmSync(at("docs/reference-roadmap.html"));
		expect(
			verdict('gh api repos/o/r/issues -f title="search-core — a thing"'),
		).toBe("allow");
		expect(readFaults()).toEqual([]);
	});

	it("allows and records an unreadable roadmap on a REST creation (#3426)", () => {
		fs.rmSync(at("docs/reference-roadmap.html"));
		fs.mkdirSync(at("docs/reference-roadmap.html"));
		expect(
			verdict('gh api repos/o/r/issues -f title="search-core — a thing"'),
		).toBe("allow");
		expect(readFaults()).toEqual([
			"docs/reference-roadmap.html is unreadable — issue creation allowed unchecked",
		]);
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

describe("a creation from a session in its own worktree (#4242)", () => {
	let split: { main: string; worktree: string };
	freshSandbox((sb) => {
		split = splitCheckout(path.join(sb.dir, "split"));
	});

	const fixturesIn = (tree: string, ...called: string[]) => {
		fs.mkdirSync(path.join(tree, "docs"), { recursive: true });
		fs.writeFileSync(path.join(tree, "docs/reference-roadmap.html"), ROADMAP);
		fs.writeFileSync(
			path.join(tree, "docs/called-cards.md"),
			register(...called),
		);
	};
	const fromWorktree = () =>
		runCore(
			"guard-issue-phase-scope",
			toolCall("Bash", {
				command: 'gh issue create --title "search-core — a thing"',
			}),
			{ root: split.main, worktree: split.worktree },
		).output?.permissionDecision;

	it("allows a card the worktree's register calls, the main checkout's calling none", () => {
		fixturesIn(split.main);
		fixturesIn(split.worktree, "search-core");
		expect(fromWorktree()).not.toBe("deny");
	});

	it("denies a card the worktree's register leaves uncalled, the main checkout's calling it", () => {
		fixturesIn(split.main, "search-core");
		fixturesIn(split.worktree);
		expect(fromWorktree()).toBe("deny");
	});
});
