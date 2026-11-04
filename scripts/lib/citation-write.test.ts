// @vitest-environment node
/*
 * lib/citation-write.js names a `Write` or `Edit` adding a citation of the
 * inherited tracker for a number it never used, and hands the session the
 * rule (#2015). The rule left the always-loaded pool for this core, so a
 * silent core means a session never meets it before the commit gate refuses.
 *
 * Module cases on the core over the production adapters — real git and the
 * real file read — in a throwaway repo whose seed commit stands in for
 * `ec8654cd` through `WFC_CITATION_BASELINE`. The citations are built at run
 * time so the commit gate never reads this file's own lines as mis-copies.
 * The rule text and its latch are lib/guard-entry.test.ts's.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

const { decide } = require("./citation-write.js") as {
	decide: (file: string, ctx: Record<string, unknown>) => unknown;
};
const { hostAdapters } = require("./guard-dispatch.js") as {
	hostAdapters: (root: string, log: (what: string) => void) => Ports;
};

type Ports = Record<string, unknown> & {
	git: (args: string[], noMatch: number[]) => unknown;
};

const cite = (n: number) => `${"mantahostels"}#${n}`;

let dir: string;
let repo: string;
let baseline: string;
let logs: string[];

beforeAll(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "citation-")));
	repo = path.join(dir, "repo");
	fs.mkdirSync(repo);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	git("init", "-q", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	fs.writeFileSync(
		path.join(repo, "history.md"),
		`Cites ${cite(900)} and ${cite(63)}.\n`,
	);
	git("add", "--", ".");
	git("commit", "-qm", "seed");
	baseline = git("rev-parse", "HEAD").trim();
});

beforeEach(() => {
	vi.stubEnv("WFC_CITATION_BASELINE", baseline);
	logs = [];
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A copy of the seeded repo, for a case that writes into it. */
const repoCopy = () => {
	const copy = fs.mkdtempSync(path.join(dir, "copy-"));
	fs.cpSync(repo, copy, { recursive: true });
	return copy;
};

/** The host's ports, standing in for the session's tree as well. */
const portsAt = (at: string) => {
	const ports = hostAdapters(at, () => undefined);
	return { ...ports, tree: () => ports };
};

const judged = (
	tool: "Write" | "Edit",
	file: string,
	input: Record<string, string>,
	at = repo,
) =>
	decide(
		`${at}/${file}`,
		kitContextFake({
			...portsAt(at),
			input: { file_path: `${at}/${file}`, ...input },
			tool,
			log: (what: string) => logs.push(what),
		}),
	);

describe("a write adding a citation the inherited tracker never used", () => {
	it("names it with its bare form ahead of the rule", () => {
		expect(
			judged("Write", "notes.md", { content: `See ${cite(2015)}.\n` }),
		).toEqual({
			prelude: `notes.md adds ${cite(2015)} (write #2015) — the inherited tracker never used that number, so the citation means this repo's own issue.`,
			injectRules: ["citation-tracker"],
		});
	});

	it("names each number an Edit's new text adds, in order", () => {
		expect(
			judged("Edit", "history.md", {
				old_string: `Cites ${cite(900)}`,
				new_string: `Cites ${cite(900)} and ${cite(44)} and ${cite(12)}`,
			}),
		).toMatchObject({
			prelude: expect.stringContaining(
				`${cite(12)} (write #12) ${cite(44)} (write #44)`,
			),
		});
	});
});

describe("any other write", () => {
	it("is silent on a number the inherited tracker used, an exempt line and no citation", () => {
		expect(
			judged("Write", "a.md", { content: `See ${cite(900)}.\n` }),
		).toBeNull();
		expect(
			judged("Write", "b.md", {
				content: `See ${cite(2015)}. citation-exempt: the inherited one\n`,
			}),
		).toBeNull();
		expect(judged("Write", "c.md", { content: "See #2015.\n" })).toBeNull();
	});

	it("is silent where the line was already there before the write", () => {
		const line = `Old ${cite(2015)} line.`;
		const at = repoCopy();
		fs.writeFileSync(path.join(at, "old.md"), `${line}\n`);
		expect(
			judged("Write", "old.md", { content: `${line}\nA new line.\n` }, at),
		).toBeNull();
		expect(
			judged(
				"Edit",
				"old.md",
				{
					old_string: `${line}\n`,
					new_string: `${line}\nA new line.\n`,
				},
				at,
			),
		).toBeNull();
	});

	it.each(["../d.md", "sub/../../d.md"])(
		"is silent on %s, a write outside the checkout (#2546)",
		(file) => {
			expect(
				judged("Write", file, { content: `See ${cite(2015)}.\n` }),
			).toBeNull();
		},
	);

	it("is silent in an adopter, where the baseline commit does not resolve", () => {
		vi.stubEnv("WFC_CITATION_BASELINE", "0".repeat(40));
		expect(
			judged("Write", "d.md", { content: `See ${cite(2015)}.\n` }),
		).toBeNull();
		expect(logs).toEqual([]);
	});

	it("allows a write whose inherited numbers git cannot read, logged", () => {
		const real = portsAt(repo);
		const { git } = real;
		expect(
			decide(
				`${repo}/f.md`,
				kitContextFake({
					...real,
					git: (args: string[], noMatch: number[]) =>
						args[0] === "grep"
							? { ok: false, why: "grep broke" }
							: git(args, noMatch),
					input: { content: `See ${cite(2015)}.\n` },
					tool: "Write",
					log: (what: string) => logs.push(what),
				}),
			),
		).toBeNull();
		expect(logs).toEqual([
			"git did not judge f.md (grep broke) — citation rule not injected",
		]);
	});

	it("allows a write git cannot judge, logged (mantahostels#147)", () => {
		const bare = path.join(dir, "not-a-repo");
		fs.mkdirSync(bare, { recursive: true });
		expect(
			decide(`${bare}/e.md`, {
				...portsAt(bare),
				input: { content: `See ${cite(2015)}.\n` },
				tool: "Write",
				log: (what: string) => logs.push(what),
			}),
		).toBeNull();
		expect(logs).toEqual([
			expect.stringMatching(
				/^git did not judge e\.md \(.+\) — citation rule not injected$/,
			),
		]);
	});
});

describe("a write from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((sb) => {
		at = splitCheckout(path.join(sb.dir, "split"));
	});

	const prelude = (file: string, worktree?: string) => {
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: at.main,
			encoding: "utf8",
		}).trim();
		return runCore(
			"guard-citation-tracker",
			toolCall("Write", { file_path: file, content: `See ${cite(2015)}.\n` }),
			{
				root: at.main,
				worktree,
				env: { WFC_CITATION_BASELINE: head },
			},
		).output?.additionalContext;
	};

	it("names the file by its path in the worktree", () => {
		expect(prelude(path.join(at.worktree, "notes.md"), at.worktree)).toContain(
			`notes.md adds ${cite(2015)} (write #2015)`,
		);
	});

	it("is silent on a worktree file judged from the main checkout, where the path lies outside its tree", () => {
		expect(prelude(path.join(at.worktree, "notes.md"))).toBeUndefined();
	});
});
