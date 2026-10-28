// @vitest-environment node
/*
 * The safe issue-body edit path (mantahostels#131, building mantahostels#128's ruling).
 *
 * Every command but `replace` is checked for idempotence: running it twice
 * must write once, or a change cannot be re-applied onto a concurrent writer's
 * body.
 *
 * The loop is driven against a fake `gh` whose store this test can clobber on
 * cue, so a lost update is reproduced deterministically rather than raced for.
 * The genuinely concurrent version lives in proving-run.test.ts, which owns
 * Tier 2.
 *
 * scripts/issue-body.js is the route the `guard-issue-body` core (a `PreToolUse`
 * hook) sends every body edit through: loosen a case here and one session's
 * issue edit silently erases a concurrent session's.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store as arbiter, freshSandbox } from "./lib/arbiter-testkit";
import { asRecorded } from "./lib/gh-fake";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

// ---------------------------------------------------------------------------
// A fake `gh` over one issue body
// ---------------------------------------------------------------------------

let dir: string;
let store: string;
let counter: string;
let savedEnv: NodeJS.ProcessEnv;

/**
 * `gh` as this script uses it, plus three levers the real thing does not have:
 * on the edit calls named by STUB_CLOBBER_ON, it writes our body and then
 * immediately overwrites it with STUB_CLOBBER_BODY — a rival session's write,
 * derived from the base we both started from; and STUB_EDIT_FAILS fails any
 * edit at all, for a run that must write nothing; and STUB_LOCK_SEEN keeps a
 * copy of the lock at STUB_LOCK as it stood during the edit.
 */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const store = process.env.STUB_STORE;
const counter = process.env.STUB_COUNTER;
const a = process.argv.slice(2);
if (a[0] === "issue" && a[1] === "view") {
	process.stdout.write(JSON.stringify({ body: fs.readFileSync(store, "utf8") }));
	process.exit(0);
}
if (a[0] === "repo" && a[1] === "view") {
	if (process.env.STUB_REPO_FAILS) {
		process.stderr.write("gh stub: no default repo\\n");
		process.exit(1);
	}
	process.stdout.write(${JSON.stringify(asRecorded("repoView", { nameWithOwner: "acme/widgets" }))});
	process.exit(0);
}
if (a[0] === "issue" && a[1] === "edit") {
	if (process.env.STUB_EDIT_FAILS) {
		process.stderr.write("gh stub: an edit was attempted\\n");
		process.exit(1);
	}
	if (process.env.STUB_LOCK_SEEN && fs.existsSync(process.env.STUB_LOCK))
		fs.copyFileSync(process.env.STUB_LOCK, process.env.STUB_LOCK_SEEN);
	const n = Number(fs.readFileSync(counter, "utf8")) + 1;
	fs.writeFileSync(counter, String(n));
	fs.writeFileSync(store, fs.readFileSync(a[a.indexOf("--body-file") + 1], "utf8"));
	const on = (process.env.STUB_CLOBBER_ON || "").split(",").filter(Boolean);
	if (on.includes("all") || on.includes(String(n))) {
		fs.writeFileSync(store, process.env.STUB_CLOBBER_BODY);
	}
	process.exit(0);
}
process.stderr.write("gh stub: unsupported: " + a.join(" ") + "\\n");
process.exit(1);
`;

const readEdits = () => Number(fs.readFileSync(counter, "utf8"));
const readBody = () => fs.readFileSync(store, "utf8");

const SCRIPT = path.join(__dirname, "issue-body.js");
/** The script, run in process against the fake `gh`. */
const ib = (...args: string[]) =>
	runInProcess(SCRIPT, args, { env: process.env });

beforeEach(() => {
	savedEnv = { ...process.env };
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-body-test-"));
	store = path.join(dir, "body.md");
	counter = path.join(dir, "edits");
	fs.writeFileSync(counter, "0");
	process.env.WFC_GH = stubGhScript(dir, STUB).gh;
	process.env.STUB_STORE = store;
	process.env.STUB_COUNTER = counter;
	// Never the real ~/.claude: the lock lands under CLAUDE_CONFIG_DIR, and a
	// test that wrote there could wedge a live session.
	process.env.CLAUDE_CONFIG_DIR = path.join(dir, "config");
	process.env.CLAUDE_JOB_DIR = path.join(dir, "job");
	// A gate this suite adds would land in the real session's acts ledger.
	delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
	process.env = savedEnv;
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The transforms
// ---------------------------------------------------------------------------

describe("every command but replace is idempotent", () => {
	const cases: [string, string[], string][] = [
		["append", ["append", "96", "--text", "ENTRY-A"], "## Log\n\nv0\n"],
		[
			"append-section",
			[
				"append-section",
				"96",
				"--heading",
				"Decisions so far",
				"--text",
				"- #131 — the safe path",
			],
			"## Decisions so far\n\n- #128 — one helper\n\n## Not yet specified\n\nfog\n",
		],
		[
			"append-section, several lines",
			[
				"append-section",
				"96",
				"--heading",
				"Log",
				"--text",
				"- held\n  - sub\n- new\n- new",
			],
			"## Log\n\n- held\n\n## Other\n\nfog\n",
		],
		[
			"append-decision",
			["append-decision", "96", "--child", "531", "--gist", "keyed append"],
			"## Decisions so far\n\n- #528 — neighbour's line\n",
		],
		[
			"delete-lines",
			["delete-lines", "96", "--match", "drop me"],
			"keep\ndrop me now\nkeep\n",
		],
		[
			"tick",
			["tick", "96", "--match", "criterion one"],
			"- [ ] criterion one\n- [ ] criterion two\n",
		],
		[
			"annotate",
			[
				"annotate",
				"96",
				"--match",
				"criterion two",
				"--text",
				"**waived:** out of scope",
			],
			"- [ ] criterion one\n- [ ] criterion two\n",
		],
	];

	it.each(cases)("%s: running it twice writes once", (_name, args, start) => {
		fs.writeFileSync(store, start);
		expect(ib(...args).status).toBe(0);
		const once = readBody();
		expect(once).not.toBe(start);
		expect(readEdits()).toBe(1);
		expect(ib(...args).status).toBe(0);
		expect(readEdits()).toBe(1);
		expect(readBody()).toBe(once);
	});
});

describe("what each command actually does", () => {
	/** The body `args` leaves behind, from `start`. */
	const leaves = (start: string, ...args: string[]) => {
		fs.writeFileSync(store, start);
		const r = ib(...args);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		return readBody();
	};
	/** The refusal `args` exits with, having written nothing. */
	const refusal = (start: string, ...args: string[]) => {
		fs.writeFileSync(store, start);
		const r = ib(...args);
		expect(r.status).toBe(2);
		expect(readEdits()).toBe(0);
		return r.stderr;
	};

	it("append puts the block at the end, once", () => {
		expect(leaves("## Log\n\nv0", "append", "96", "--text", "ENTRY-A")).toBe(
			"## Log\n\nv0\n\nENTRY-A\n",
		);
	});

	it("append-section lands under its own heading, not a later one", () => {
		expect(
			leaves(
				"## Decisions so far\n\n- #128 — one helper\n\n## Not yet specified\n\nfog\n",
				"append-section",
				"96",
				"--heading",
				"Decisions so far",
				"--text",
				"- #131 — the safe path",
			),
		).toBe(
			"## Decisions so far\n\n- #128 — one helper\n- #131 — the safe path\n\n## Not yet specified\n\nfog\n",
		);
	});

	it("append-section appends each line of a multi-line text, in order", () => {
		expect(
			leaves(
				"## Decisions so far\n\n- #128 — one helper\n\n## Not yet specified\n\nfog\n",
				"append-section",
				"96",
				"--heading",
				"Decisions so far",
				"--text",
				"- #131 — a\n\n- #132 — b\n- #133 — c\n",
			),
		).toBe(
			"## Decisions so far\n\n- #128 — one helper\n- #131 — a\n- #132 — b\n- #133 — c\n\n## Not yet specified\n\nfog\n",
		);
	});

	it("append-section skips a line already in the section and lands the rest", () => {
		expect(
			leaves(
				"## Log\n\n- same\n\n## Other\n\n- new\n",
				"append-section",
				"96",
				"--heading",
				"Log",
				"--text",
				"- same\n- new",
			),
		).toBe("## Log\n\n- same\n- new\n\n## Other\n\n- new\n");
	});

	it("append-section refuses a text with no non-blank line", () => {
		expect(
			refusal(
				"## Log\n",
				"append-section",
				"96",
				"--heading",
				"Log",
				"--text",
				"\n  \n",
			),
		).toContain("nothing to append");
	});

	it("append-section refuses a '## ' line, which would open a section mid-section, offering append --file instead", () => {
		expect(
			refusal(
				"## Log\n",
				"append-section",
				"96",
				"--heading",
				"Log",
				"--text",
				"## New\n- a",
			),
		).toContain("for a new '## ' section use append --file");
	});

	it("append-section refuses a heading that is not there, naming the heading", () => {
		expect(
			refusal(
				"## Something else\n\nbody\n",
				"append-section",
				"96",
				"--heading",
				"Decisions so far",
				"--text",
				"- x",
			),
		).toContain("no '## Decisions so far' section");
	});

	it("delete-lines drops every matching line", () => {
		expect(
			leaves(
				"keep\ndrop me now\nkeep\n",
				"delete-lines",
				"96",
				"--match",
				"drop me",
			),
		).toBe("keep\nkeep\n");
	});

	it("tick ticks only the matching box", () => {
		expect(
			leaves(
				"- [ ] criterion one\n- [ ] criterion two\n",
				"tick",
				"96",
				"--match",
				"criterion one",
			),
		).toBe("- [x] criterion one\n- [ ] criterion two\n");
	});

	it("annotate waives a criterion without touching its neighbour", () => {
		expect(
			leaves(
				"- [ ] criterion one\n- [ ] criterion two\n",
				"annotate",
				"96",
				"--match",
				"criterion two",
				"--text",
				"**waived:** out of scope",
			),
		).toBe(
			"- [ ] criterion one\n- [ ] criterion two **waived:** out of scope\n",
		);
	});

	it("tick refuses when nothing matches, quoting the match text — silence would read as success", () => {
		expect(
			refusal(
				"- [ ] criterion one\n",
				"tick",
				"96",
				"--match",
				"criterion nine",
			),
		).toContain("no checkbox line contains: criterion nine");
	});
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

describe("the write loop", () => {
	it("writes nothing at all when the change is already present", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n\nENTRY-A\n");
		expect(ib("append", "96", "--text", "ENTRY-A").status).toBe(0);
		expect(readEdits()).toBe(0);
	});

	it("refuses a nonsense attempt count instead of reporting NaN writes", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		const r = ib("append", "96", "--text", "ENTRY-A", "--attempts", "abc");
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/positive whole number/);
		expect(readEdits()).toBe(0);
	});

	it("dry-run prints the body and writes nothing", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		const r = ib("append", "96", "--text", "ENTRY-A", "--dry-run");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("ENTRY-A");
		expect(readEdits()).toBe(0);
		expect(readBody()).toBe("## Log\n\nv0\n");
	});

	/**
	 * The two required mutations both fall to this:
	 *
	 *   drop the re-fetch check and this ends after write 1, with ENTRY-A gone;
	 *   re-upload the stale body instead of re-applying and it ends with
	 *   ENTRY-B gone.
	 *
	 * The lost update of mantahostels#128.
	 */
	it("repairs a clobber by re-applying onto the rival's body, so both survive", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		process.env.STUB_CLOBBER_ON = "1";
		process.env.STUB_CLOBBER_BODY = "## Log\n\nv0\n\nENTRY-B\n";

		const r = ib("append", "96", "--text", "ENTRY-A");

		expect(readBody()).toContain("ENTRY-A");
		expect(readBody()).toContain("ENTRY-B");
		expect(r.stdout).toContain("written and verified (2 writes)");
	});

	it("gives up loudly and saves the unwritten body when a rival never stops", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		process.env.STUB_CLOBBER_ON = "all";
		process.env.STUB_CLOBBER_BODY = "## Log\n\nv0\n\nENTRY-B\n";

		const r = ib("append", "96", "--text", "ENTRY-A", "--attempts", "3");
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/gave up after 3 writes/);
		expect(readEdits()).toBe(3);

		const rescue = path.join(
			process.env.CLAUDE_JOB_DIR as string,
			"tmp",
			"issue-96-unwritten.md",
		);
		expect(fs.readFileSync(rescue, "utf8")).toContain("ENTRY-A");
	});
});

describe("the CLI's argument handling, before any gh call (#920)", () => {
	/** Runs the script against a gh that records being called at all. */
	const cli = (...args: string[]) => {
		const called = path.join(dir, "gh-called");
		process.env.WFC_GH = stubGhScript(
			dir,
			`#!/bin/sh\necho "$@" >> "${called}"\nexit 1\n`,
		).gh;
		const r = runInProcess(path.join(__dirname, "issue-body.js"), args, {
			env: process.env,
		});
		return { ...r, ghCalled: fs.existsSync(called) };
	};

	it("prints tick's usage for `tick <n> --help`, exit 0", () => {
		const r = cli("tick", "920", "--help");
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^usage: issue-body\.js tick <issue> --match/);
		expect(r.ghCalled).toBe(false);
	});

	it("prints the top-level usage for a bare --help, exit 0", () => {
		const r = cli("--help");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("usage: issue-body.js <command> <issue>");
		expect(r.ghCalled).toBe(false);
	});

	it("refuses an unknown flag with the command's usage, exit 2", () => {
		const r = cli("tick", "920", "--match", "x", "--bogus");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown flag: --bogus");
		expect(r.stderr).toContain("usage: issue-body.js tick");
		expect(r.ghCalled).toBe(false);
	});
});

describe("the CLI", () => {
	const run = (...args: string[]) =>
		execFileSync("node", [path.join(__dirname, "issue-body.js"), ...args], {
			encoding: "utf8",
			env: process.env,
		});

	it("appends into a named section", () => {
		fs.writeFileSync(store, "## Decisions so far\n\n- #128 — one helper\n");
		run(
			"append-section",
			"96",
			"--heading",
			"Decisions so far",
			"--text",
			"- #131 — safe path",
		);
		expect(readBody()).toBe(
			"## Decisions so far\n\n- #128 — one helper\n- #131 — safe path\n",
		);
	});

	it("appends a multi-line --file under the heading in one write", () => {
		fs.writeFileSync(store, "## Decisions so far\n\n- #128 — one helper\n");
		const file = path.join(dir, "lines.md");
		fs.writeFileSync(file, "- #131 — a\n- #132 — b\n- #133 — c\n");
		run(
			"append-section",
			"96",
			"--heading",
			"Decisions so far",
			"--file",
			file,
		);
		expect(readBody()).toBe(
			"## Decisions so far\n\n- #128 — one helper\n- #131 — a\n- #132 — b\n- #133 — c\n",
		);
		expect(readEdits()).toBe(1);
	});

	/**
	 * `replace` is the one operation that cannot be re-applied — a whole-body
	 * rewrite (mantahostels#133): a retry there is the clobber.
	 */
	it("replace refuses on divergence instead of retrying, leaving the parallel edit in place", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		process.env.STUB_CLOBBER_ON = "all";
		process.env.STUB_CLOBBER_BODY = "## Log\n\nv0\n\nENTRY-B\n";
		const next = path.join(dir, "next.md");
		fs.writeFileSync(next, "wholly new body\n");

		let status = 0;
		try {
			run("replace", "96", "--file", next);
		} catch (e) {
			status = (e as { status: number }).status;
		}
		expect(status).toBe(1);
		expect(readEdits()).toBe(1);
		expect(readBody()).toContain("ENTRY-B");
	});

	it("replace writes a valid non-blank --file", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		const next = path.join(dir, "next.md");
		fs.writeFileSync(next, "wholly new body\n");
		run("replace", "96", "--file", next);
		expect(readEdits()).toBe(1);
		expect(readBody()).toBe("wholly new body\n");
	});

	/**
	 * mantahostels#1579: a --file that reads empty or whitespace-only is almost always a
	 * truncated or mis-read source, not a deliberate blank — refuse before any
	 * write reaches gh at all.
	 */
	it.each(["", "   \n\t \n"])(
		"replace refuses a --file whose contents are %j, naming the file and editing nothing",
		(contents) => {
			fs.writeFileSync(store, "## Log\n\nv0\n");
			const next = path.join(dir, "empty.md");
			fs.writeFileSync(next, contents);

			let status = 0;
			let stderr = "";
			try {
				run("replace", "96", "--file", next);
			} catch (e) {
				status = (e as { status: number }).status;
				stderr = (e as { stderr: string }).stderr;
			}
			expect(status).toBe(2);
			expect(stderr).toContain("empty or whitespace-only");
			expect(stderr).toContain(next);
			expect(readEdits()).toBe(0);
			expect(readBody()).toBe("## Log\n\nv0\n");
		},
	);

	const refusal = (...args: string[]) => {
		try {
			run(...args);
		} catch (e) {
			return e as { status: number; stderr: string };
		}
		throw new Error("expected a refusal");
	};

	it("refuses an edit that adds a gate line or a prose wait with no basis, and edits nothing (#672)", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		const next = path.join(dir, "next.md");
		fs.writeFileSync(next, "**Gated until:** 2026-10-05 — a week\n");
		for (const r of [
			refusal("replace", "96", "--file", next),
			refusal("append", "96", "--text", "run it two weeks after the fix"),
		]) {
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("no `**Gate basis:**` line");
		}
		expect(readEdits()).toBe(0);
	});

	const dryReplace = (contents: string) => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		process.env.STUB_EDIT_FAILS = "1";
		const next = path.join(dir, "next.md");
		fs.writeFileSync(next, contents);
		return runInProcess(
			path.join(__dirname, "issue-body.js"),
			["replace", "96", "--file", next, "--dry-run"],
			{ env: process.env },
		);
	};

	it("replace --dry-run prints the body it would write and writes nothing (#821)", () => {
		const r = dryReplace("wholly new body\n");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("wholly new body\n");
		expect(readBody()).toBe("## Log\n\nv0\n");
	});

	it("replace --dry-run is refused for a missing basis, as a real replace is", () => {
		const r = dryReplace("**Gated until:** 2026-10-05 — a week\n");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no `**Gate basis:**` line");
	});

	it("hands over rule:roadmap-gating on a write adding a gate line, and only then (#823)", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		const gated = runInProcess(
			path.join(__dirname, "issue-body.js"),
			[
				"append",
				"96",
				"--text",
				"**Gated until:** 2026-10-09 — x\n**Gate basis:** y",
			],
			{ env: process.env },
		);
		expect(gated.status).toBe(0);
		expect(gated.stderr.match(/rule that governs it/g)).toHaveLength(1);
		const plain = runInProcess(
			path.join(__dirname, "issue-body.js"),
			["append", "96", "--text", "unrelated note"],
			{ env: process.env },
		);
		expect(plain.status).toBe(0);
		expect(plain.stderr).not.toContain("§Gating an issue");
	});

	it("refuses a window the basis does not name, naming it (#823)", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		const r = refusal(
			"append",
			"96",
			"--text",
			"**Gated on:** x — abandon if: 7 days pass after creation\n**Gate basis:** 3 days",
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('"7 days", a window the `**Gate basis:**` line');
		expect(r.stderr).toContain(
			"Rule: docs/agents/issue-tracker.md §Gating an issue",
		);
		expect(readEdits()).toBe(0);
	});

	it("leaves a body's existing fault editable, and passes a written basis", () => {
		fs.writeFileSync(store, "run it after a week live\n");
		run("append", "96", "--text", "unrelated note");
		expect(readBody()).toContain("unrelated note");
		run(
			"append",
			"96",
			"--text",
			"no earlier than 2026-09-29\n**Gate basis:** counters live 24 hours",
		);
		expect(readBody()).toContain("Gate basis");
	});
});

/**
 * `append-decision`, the map-line half of resolve-ticket (#531).
 */
describe("append-decision", () => {
	const mapBody =
		"## Decisions so far\n\n- #528 — neighbour's line\n\n## Not yet specified\n\nfog\n";
	const decide = (child: string, gist: string) =>
		runInProcess(
			path.join(__dirname, "issue-body.js"),
			["append-decision", "96", "--child", child, "--gist", gist],
			{ env: process.env },
		);

	it("adds exactly one line to the section, under the ones already there", () => {
		fs.writeFileSync(store, mapBody);
		const r = decide("531", "keyed append");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("issue 96: written and verified");
		expect(readBody()).toBe(
			"## Decisions so far\n\n- #528 — neighbour's line\n- #531 — keyed append\n\n## Not yet specified\n\nfog\n",
		);
	});

	it.each([
		["ending in one newline", "\n"],
		["with no trailing newline", ""],
		["with trailing blank lines", "\n\n\n"],
	])(
		"skips and reports a line already there for this child, whatever its gist, on a body %s",
		(_, tail) => {
			const start = `## Decisions so far\n\n- #528 — neighbour's line\n- #531 — first gist${tail}`;
			fs.writeFileSync(store, start);
			const r = decide("531", "a different gist");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"issue 96: #531 already has a line in Decisions so far, nothing written: - #531 — first gist",
			);
			expect(readEdits()).toBe(0);
			expect(readBody()).toBe(start);
		},
	);

	it("keys on the whole number, so #53 is not mistaken for #531", () => {
		fs.writeFileSync(store, "## Decisions so far\n\n- #53 — shorter\n");
		expect(decide("531", "keyed append").status).toBe(0);
		expect(readBody()).toContain("- #531 — keyed append");
	});

	it("reports a neighbour's line lost in the write as not landed", () => {
		fs.writeFileSync(store, mapBody);
		// A rival writing from a base older than #528's line lands right after
		// our write; the loop repairs our line, but #528's is gone.
		process.env.STUB_CLOBBER_ON = "1";
		process.env.STUB_CLOBBER_BODY =
			"## Decisions so far\n\n## Not yet specified\n\nfog\n";
		const r = decide("531", "keyed append");
		expect(r.status).toBe(1);
		expect(r.stdout).not.toContain("written and verified");
		expect(r.stderr).toContain("- #528 — neighbour's line");
		expect(r.stderr).toContain("Restore each with append-section");
		expect(readBody()).toContain("- #531 — keyed append");
		const rescue = path.join(
			process.env.CLAUDE_JOB_DIR as string,
			"tmp",
			"issue-96-before-append.md",
		);
		expect(fs.readFileSync(rescue, "utf8")).toBe(mapBody);
	});

	it("exits 1 naming the map when it has no Decisions so far section, writing nothing", () => {
		fs.writeFileSync(store, "## Something else\n\nbody\n");
		const r = decide("531", "keyed append");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"issue 96: no '## Decisions so far' section — add the section to the map by hand",
		);
		expect(readEdits()).toBe(0);
		expect(readBody()).toBe("## Something else\n\nbody\n");
	});

	it.each([
		["a multi-line gist", "531", "one\ntwo", "single-line --gist"],
		["an empty gist", "531", "  ", "needs a --gist"],
		[
			"a child that is not a number",
			"#531",
			"gist",
			"--child must be an issue number: #531",
		],
	])(
		"refuses %s before reading the map, saying why and editing nothing",
		(_, child, gist, message) => {
			fs.writeFileSync(store, mapBody);
			const r = decide(child, gist);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(message);
			expect(readEdits()).toBe(0);
		},
	);
});

// ---------------------------------------------------------------------------
// The local write lock
// ---------------------------------------------------------------------------

describe("the lock is never observable without its holder (mantahostels#139)", () => {
	const lockDir = () =>
		path.join(process.env.CLAUDE_CONFIG_DIR as string, "issue-locks");
	const lockFile = () => path.join(lockDir(), "owner-repo-96.lock");

	/** Older than LOCK_STALE_MS, which is a fixed 60s. */
	const age = (file: string) => {
		const when = new Date(Date.now() - 61_000);
		fs.utimesSync(file, when, when);
	};

	const appendUnder = (waitMs: number) => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		process.env.WFC_ISSUE_LOCK_WAIT_MS = String(waitMs);
		return ib("append", "96", "--repo", "owner/repo", "--text", "ENTRY-A");
	};

	/** The lock's content as the fake `gh` saw it mid-write, or null where there was none. */
	const readSeenMidWrite = () => {
		const seen = path.join(dir, "lock-seen");
		return fs.existsSync(seen) ? fs.readFileSync(seen, "utf8") : null;
	};

	beforeEach(() => {
		fs.mkdirSync(lockDir(), { recursive: true });
		process.env.STUB_LOCK = lockFile();
		process.env.STUB_LOCK_SEEN = path.join(dir, "lock-seen");
	});

	it("names its holder the instant the lock file exists", () => {
		// A written temp file is linked in, so the lock never exists empty.
		const r = appendUnder(0);
		expect(r.status).toBe(0);
		expect(JSON.parse(readSeenMidWrite() ?? "{}").pid).toBe(process.pid);
		expect(fs.existsSync(lockFile())).toBe(false);
	});

	it("refuses to steal a fresh lock it cannot parse, leaving it in place and writing without it, saying so", () => {
		// Stealing it would delete a live holder's lock, and both would then
		// write at once.
		fs.writeFileSync(lockFile(), "");
		const r = appendUnder(0);
		expect(r.stderr).toBe(
			`issue-body: lock ${lockFile()} is still held by an unnamed holder after 0ms; writing without it\n`,
		);
		expect(fs.readFileSync(lockFile(), "utf8")).toBe("");
		expect(readBody()).toContain("ENTRY-A");
	});

	it("prints that it writes without the lock when the lock cannot be created (#595)", () => {
		fs.chmodSync(lockDir(), 0o500);
		try {
			const r = appendUnder(0);
			expect(r.stderr).toBe(
				`issue-body: lock ${lockFile()} cannot be created (EACCES); writing without it\n`,
			);
			expect(readBody()).toContain("ENTRY-A");
		} finally {
			fs.chmodSync(lockDir(), 0o700);
		}
	});

	it("steals an unparseable lock once it has aged out", () => {
		// Otherwise a genuinely corrupt lock would wedge every writer forever.
		fs.writeFileSync(lockFile(), "");
		age(lockFile());

		const r = appendUnder(0);
		expect(r.stderr).toBe("");
		expect(JSON.parse(readSeenMidWrite() ?? "{}").pid).toBe(process.pid);
	});

	it("refuses a lock held by a live process, printing that it writes without it (#595)", () => {
		const held = JSON.stringify({ pid: process.pid, at: Date.now() });
		fs.writeFileSync(lockFile(), held);
		const r = appendUnder(0);
		expect(r.stderr).toBe(
			`issue-body: lock ${lockFile()} is still held by pid ${process.pid} after 0ms; writing without it\n`,
		);
		// Never released: it was not this run's to give back.
		expect(fs.readFileSync(lockFile(), "utf8")).toBe(held);
	});

	it("takes a lock whose holder is gone", () => {
		// A pid that exited: spawn one and let it finish.
		const dead = execFileSync("bash", ["-c", 'echo -n "$$"'], {
			encoding: "utf8",
		});
		fs.writeFileSync(
			lockFile(),
			JSON.stringify({ pid: Number(dead), at: Date.now() }),
		);

		const r = appendUnder(0);
		expect(r.stderr).toBe("");
		expect(JSON.parse(readSeenMidWrite() ?? "{}").pid).toBe(process.pid);
	});

	it("gives up by the deadline on a stale lock it cannot delete (#586)", () => {
		fs.writeFileSync(lockFile(), "");
		age(lockFile());
		// A real seam cannot reach this branch: a read-only lock directory also
		// refuses createLock's temp file, which returns before the stale check.
		const realRm = fs.rmSync;
		let refusals = 0;
		const rm = vi.spyOn(fs, "rmSync").mockImplementation((p, opts) => {
			// After 2000 refusals let it through, so a regression fails the
			// assertion below instead of hanging the worker.
			if (p === lockFile() && refusals++ < 2000) {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			}
			return realRm(p, opts);
		});
		try {
			const r = appendUnder(100);
			// One refusal per 25ms poll inside the 100ms deadline; a retry at
			// once would spend all 2000.
			expect(refusals).toBeGreaterThan(0);
			expect(refusals).toBeLessThan(50);
			expect(r.stderr).toMatch(
				/is stale and cannot be removed \(EPERM\); writing without it/,
			);
		} finally {
			rm.mockRestore();
		}
	});

	it("leaves no temp files beside the lock", () => {
		appendUnder(0);
		expect(fs.readdirSync(lockDir())).toEqual([]);
	});
});

describe("the gate act (#3301)", () => {
	const Me = "issue-body-gate-session";
	const sb = freshSandbox();
	const Gate = "**Gated until:** 2026-10-09 — x\n**Gate basis:** y";
	const acts = () => arbiter.readActsBy(Me, [sb.repo]).acts;
	const run = (...args: string[]) =>
		runInProcess(SCRIPT, args, {
			env: { ...process.env, CLAUDE_CODE_SESSION_ID: Me },
		});
	const replaceWith = (body: string, ...flags: string[]) => {
		const next = path.join(dir, "next.md");
		fs.writeFileSync(next, body);
		return run("replace", "96", "--file", next, ...flags);
	};

	it("records one gate act where a write gives the issue its first gate line", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		expect(run("append", "96", "--text", Gate).status).toBe(0);
		expect(acts()).toEqual(["gate acme/widgets#96"]);
	});

	it("still writes, recording nothing, where the repo will not resolve", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		process.env.STUB_REPO_FAILS = "1";
		const r = run("append", "96", "--text", Gate);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("gated, but no gate act was recorded");
		expect(readBody()).toContain("Gated until");
		expect(acts()).toEqual([]);
	});

	it("records a Gated on line as it does a Gated until one", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		const on =
			"**Gated on:** x — check: true — abandon if: never\n**Gate basis:** y";
		expect(run("append", "96", "--text", on).status).toBe(0);
		expect(acts()).toEqual(["gate acme/widgets#96"]);
	});

	it("records nothing where a rival's write, not this one, added the gate", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		process.env.STUB_CLOBBER_ON = "1";
		process.env.STUB_CLOBBER_BODY = `## Log\n\nv0\n\n${Gate}\n`;
		expect(run("append", "96", "--text", "ENTRY-A").status).toBe(0);
		expect(readBody()).toContain("ENTRY-A");
		expect(acts()).toEqual([]);
	});

	it("names the --repo it wrote to, and records a whole-body replace too", () => {
		fs.writeFileSync(store, "## Log\n\nv0\n");
		expect(replaceWith(`${Gate}\n`, "--repo", "o/r").status).toBe(0);
		expect(acts()).toEqual(["gate o/r#96"]);
	});

	it("records nothing for a reworded or removed gate line, or a dry run", () => {
		fs.writeFileSync(store, `${Gate}\n`);
		expect(replaceWith(`${Gate.replace("10-09", "10-11")}\n`).status).toBe(0);
		expect(run("delete-lines", "96", "--match", "Gated until").status).toBe(0);
		fs.writeFileSync(store, "## Log\n\nv0\n");
		expect(run("append", "96", "--text", Gate, "--dry-run").status).toBe(0);
		expect(replaceWith(`${Gate}\n`, "--dry-run").status).toBe(0);
		expect(readEdits()).toBe(2);
		expect(acts()).toEqual([]);
	});
});
