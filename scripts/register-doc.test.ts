// @vitest-environment node
/*
 * register-doc.js writes one docs/doc-map-classes.json key (mantahostels#1848):
 * every field validated, every malformed argument refused with nothing written,
 * a registered key never overwritten, and `--role`/`--route` alone touching
 * that one field (mantahostels#3376, mantahostels#3411, mantahostels#3412).
 *
 * Run in-process against a scratch data file with `--no-claim`, so no case
 * writes the live sidecar or takes an arbiter claim.
 *
 * It is the only sanctioned way to register a document (CLAUDE.md §Ground
 * truth): loosen a case and a malformed or clobbered key reaches the sidecar
 * §A renders from, and the authority map misstates a document's class.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const { CONSUMES_KINDS } = require("./lib/doc-map.js");

const SCRIPT = path.resolve(__dirname, "register-doc.js");

let dir: string;
let dataFile: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "register-doc-"));
	dataFile = path.join(dir, "doc-map-classes.json");
	fs.writeFileSync(dataFile, "{}\n");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const readData = () => JSON.parse(fs.readFileSync(dataFile, "utf8"));

const runRaw = (...args: string[]) => {
	const r = runInProcess(
		SCRIPT,
		[...args, "--no-claim", "--data-file", dataFile],
		{ cwd: dir },
	);
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
	};
};

/* A prose registration needs --reader (mantahostels#3412); cases about anything else get
 * one, and the --reader cases call runRaw. */
const withReader = (args: string[]) =>
	args.includes("--class") &&
	!args.includes("--reader") &&
	args.some((a) => /\.(md|html)$/.test(a))
		? [...args, "--reader", "agent"]
		: args;
const run = (...args: string[]) => runRaw(...withReader(args));

describe("register-doc", () => {
	it("writes a key with the given class, section and reader, and everything else null", () => {
		const r = run(
			"docs/research/new-note.md",
			"--class",
			"free-edit",
			"--section",
			"Research runs",
		);
		expect(r.status).toBe(0);
		expect(readData()).toEqual({
			"docs/research/new-note.md": {
				section: "Research runs",
				class: "free-edit",
				classQualifier: null,
				role: null,
				route: null,
				consumes: null,
				reader: "agent",
			},
		});
	});

	describe("--reader (mantahostels#3412)", () => {
		const register = (docPath: string, ...extra: string[]) =>
			runRaw(docPath, "--class", "free-edit", "--section", "Docs", ...extra);

		it("writes the reader on a .md and a .html path", () => {
			expect(register("docs/a.md", "--reader", "human").status).toBe(0);
			expect(register("docs/a.html", "--reader", "both").status).toBe(0);
			expect(readData()["docs/a.md"].reader).toBe("human");
			expect(readData()["docs/a.html"].reader).toBe("both");
		});

		it("refuses a prose registration with no --reader, naming the three tokens", () => {
			const r = register("docs/a.md");
			expect(r.status).toBe(1);
			expect(r.out).toContain("needs a --reader, one of: agent, human, both");
			expect(readData()).toEqual({});
		});

		it("refuses a token outside the vocabulary, quoting it", () => {
			const r = register("docs/a.html", "--reader", "humans");
			expect(r.status).toBe(1);
			expect(r.out).toContain('"humans" is not one of them');
		});

		it("refuses --reader on a path that is not a prose document, and registers nothing", () => {
			const r = register("docs/data.json", "--reader", "agent");
			expect(r.status).toBe(1);
			expect(r.out).toContain("takes no --reader");
			expect(readData()).toEqual({});
		});

		it("writes no reader field on a non-prose path", () => {
			expect(register("docs/data.json").status).toBe(0);
			expect(readData()["docs/data.json"]).not.toHaveProperty("reader");
		});
	});

	it("carries a --qualifier through as classQualifier", () => {
		run(
			"AGENTS.md",
			"--class",
			"source-of-truth",
			"--section",
			"Repo-root contracts",
			"--qualifier",
			"(for code rules) · consumer (for invariants)",
		);
		expect(readData()["AGENTS.md"].classQualifier).toBe(
			"(for code rules) · consumer (for invariants)",
		);
	});

	it("refuses, rather than defaulting, when no --class is given, naming the path, and registers nothing", () => {
		const r = run("docs/x.md", "--section", "Research runs");
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/x.md needs a --class");
		expect(r.out).toContain("None was given.");
		expect(readData()).toEqual({});
	});

	/* The five tokens are read off the refusal itself, never an imported constant (#1369). */
	it("refuses a --class outside the five documented tokens, naming it", () => {
		const r = run(
			"docs/x.md",
			"--class",
			"legacy",
			"--section",
			"Research runs",
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"one of: source-of-truth, derived, generated-only, free-edit, binary-asset.",
		);
		expect(r.out).toContain('"legacy" is not one of them');
		expect(readData()).toEqual({});
	});

	/* The typed-reference grammar mantahostels#2419 settled, taken at registration time (mantahostels#2535). */
	describe("--consumes", () => {
		it("writes a typed-reference array through as consumes", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([
					{ kind: "path", ref: "scripts/x.js", gloss: "the loop it wraps" },
					{ kind: "issue", ref: "457" },
				]),
			);
			expect(r.status).toBe(0);
			expect(readData()["docs/x.md"].consumes).toEqual([
				{ kind: "path", ref: "scripts/x.js", gloss: "the loop it wraps" },
				{ kind: "issue", ref: "457" },
			]);
		});

		it("still writes null when --consumes is not given", () => {
			run("docs/x.md", "--class", "free-edit", "--section", "S");
			expect(readData()["docs/x.md"].consumes).toBeNull();
		});

		it("refuses invalid JSON, naming the flag and writing nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				"{not json",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("--consumes is not valid JSON");
			expect(readData()).toEqual({});
		});

		it("refuses a reference carrying an unknown kind", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "url", ref: "https://example.com" }]),
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				'--consumes[0].kind is "url" — not one of path, glob, figure, issue, external, note',
			);
			expect(readData()).toEqual({});
		});

		it("refuses an element that is not an object, naming its index and the expected shape, and registers nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify(["scripts/x.js"]),
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				"--consumes[0] is not a { kind, ref, gloss? } object",
			);
			expect(readData()).toEqual({});
		});

		it("refuses a ref that is only whitespace, naming the field and writing nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "path", ref: "   " }]),
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("--consumes[0].ref is not a non-empty string");
			expect(readData()).toEqual({});
		});

		it("refuses an empty gloss, naming the field and writing nothing, and accepts an absent one", () => {
			const bad = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "path", ref: "scripts/x.js", gloss: "  " }]),
			);
			expect(bad.status).toBe(1);
			expect(bad.out).toContain(
				"--consumes[0].gloss is not a non-empty string",
			);
			expect(readData()).toEqual({});

			const ok = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "path", ref: "scripts/x.js", gloss: null }]),
			);
			expect(ok.status).toBe(0);
		});

		/*
		 * Two shape faults the commit-time checker would refuse, caught at
		 * registration instead (mantahostels#2535 review, F2).
		 */
		it("refuses an issue ref that is not a bare number, and registers nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "issue", ref: "#457" }]),
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("an issue reference is a bare number");
			expect(readData()).toEqual({});
		});

		it("refuses a glob ref that does not end in * or /, and registers nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "glob", ref: "scripts/*.test.ts" }]),
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain('a glob ends in "*" or "/"');
			expect(readData()).toEqual({});

			const ok = run(
				"docs/y.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "glob", ref: "docs/research/*" }]),
			);
			expect(ok.status).toBe(0);
		});

		it("takes its kind vocabulary from the loader, not a copy (mantahostels#1863)", () => {
			expect(CONSUMES_KINDS).toEqual([
				"path",
				"glob",
				"figure",
				"issue",
				"external",
				"note",
			]);
			for (const kind of CONSUMES_KINDS) {
				const r = run(
					`docs/${kind}.md`,
					"--class",
					"free-edit",
					"--section",
					"S",
					"--consumes",
					JSON.stringify([
						{ kind, ref: kind === "issue" ? "457" : "docs/research/*" },
					]),
				);
				expect(r.status).toBe(0);
			}
		});

		it("refuses a reference missing a ref, naming the field and writing nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "path" }]),
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("--consumes[0].ref is not a non-empty string");
			expect(readData()).toEqual({});
		});

		it("refuses a reference carrying an unknown key", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify([{ kind: "path", ref: "scripts/x.js", extra: "no" }]),
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("carries unknown field(s) extra");
			expect(readData()).toEqual({});
		});

		it("refuses an empty --consumes array, writing nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				"[]",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("--consumes does not hold a non-empty array");
			expect(readData()).toEqual({});
		});

		it("refuses --consumes that is not an array, and registers nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--consumes",
				JSON.stringify("scripts/x.js"),
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("--consumes does not hold a non-empty array");
			expect(readData()).toEqual({});
		});
	});

	it("refuses without a --section, naming the path, and registers nothing", () => {
		const r = run("docs/x.md", "--class", "free-edit");
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/x.md needs a --section");
		expect(readData()).toEqual({});
	});

	it("returns 2, distinct from a refusal, when the data file cannot be read", () => {
		/* Not runRaw: its own --data-file would be a second one, and the last
		 * given wins. */
		const r = runInProcess(
			SCRIPT,
			[
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--reader",
				"agent",
				"--no-claim",
				"--data-file",
				path.join(dir, "missing.json"),
			],
			{ cwd: dir },
		);
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toContain("could not read");
	});

	it("refuses a path already registered, naming it, and does not overwrite it", () => {
		run("docs/x.md", "--class", "free-edit", "--section", "S");
		const r = run("docs/x.md", "--class", "derived", "--section", "S2");
		expect(r.status).toBe(1);
		expect(r.out).toContain("docs/x.md is already registered");
		expect(readData()["docs/x.md"].class).toBe("free-edit");
	});

	describe("--role (mantahostels#3376)", () => {
		const register = (p = "docs/x.md") =>
			run(p, "--class", "free-edit", "--section", "S");

		it("writes a role at registration when given alongside --class", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--role",
				"What it is",
			);
			expect(r.status).toBe(0);
			expect(readData()["docs/x.md"].role).toBe("What it is");
		});

		it("sets the role of an already-registered key, touching nothing else", () => {
			run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--qualifier",
				"q",
			);
			const before = readData()["docs/x.md"];
			const r = run("docs/x.md", "--role", "Per guard — what it counts");
			expect(r.status).toBe(0);
			expect(readData()["docs/x.md"]).toEqual({
				...before,
				role: "Per guard — what it counts",
			});
			expect(r.out).not.toContain("Orphan check owed");
		});

		it("prints the role it replaces", () => {
			register();
			run("docs/x.md", "--role", "First");
			const r = run("docs/x.md", "--role", "Second");
			expect(r.status).toBe(0);
			expect(r.out).toContain("replaced: First");
			expect(readData()["docs/x.md"].role).toBe("Second");
		});

		it("refuses --role alone on an unregistered key, naming it and writing nothing", () => {
			const r = run("docs/x.md", "--role", "What it is");
			expect(r.status).toBe(1);
			expect(r.out).toContain("docs/x.md is not registered");
			expect(readData()).toEqual({});
		});

		it("still refuses a re-registration of an existing key when --role rides along, leaving the entry as it was", () => {
			register();
			const r = run(
				"docs/x.md",
				"--class",
				"derived",
				"--section",
				"S",
				"--role",
				"x",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("already registered");
			expect(readData()["docs/x.md"]).toMatchObject({
				class: "free-edit",
				role: null,
			});
		});

		it("treats --role beside --section alone as a registration, needing --class", () => {
			register();
			const r = run("docs/x.md", "--section", "S", "--role", "x");
			expect(r.status).toBe(1);
			expect(r.out).toContain("needs a --class");
			expect(readData()["docs/x.md"].role).toBeNull();
		});

		it("treats --role beside --class alone as a registration, needing --section", () => {
			register();
			const r = run("docs/x.md", "--class", "derived", "--role", "x");
			expect(r.status).toBe(1);
			expect(r.out).toContain("needs a --section");
			expect(readData()["docs/x.md"].role).toBeNull();
		});

		it("enforces the 300-word cap at the command, not the commit gate", () => {
			register();
			const { ROLE_CAP_WORDS } = require("./lib/doc-map.js");
			const atCap = new Array(ROLE_CAP_WORDS).fill("w").join(" ");
			expect(run("docs/x.md", "--role", atCap).status).toBe(0);
			const r = run("docs/x.md", "--role", `${atCap} over`);
			expect(r.status).toBe(1);
			expect(r.out).toContain(`301 words, over the ${ROLE_CAP_WORDS}-word cap`);
			expect(readData()["docs/x.md"].role).toBe(atCap);
		});

		it("writes the role trimmed", () => {
			register();
			expect(run("docs/x.md", "--role", "  What it is \n").status).toBe(0);
			expect(readData()["docs/x.md"].role).toBe("What it is");
		});

		it("refuses a --role given as the last token, with no text, as a missing value, leaving the stored role as it was", () => {
			register();
			const r = runInProcess(
				SCRIPT,
				["docs/x.md", "--no-claim", "--data-file", dataFile, "--role"],
				{ cwd: dir },
			);
			expect(r.status).toBe(2);
			expect(`${r.stdout}${r.stderr}`).toContain("--role needs a value");
			expect(readData()["docs/x.md"].role).toBeNull();
		});

		it("refuses an empty role and one carrying a line break", () => {
			register();
			expect(run("docs/x.md", "--role", "  ").out).toContain("--role is empty");
			expect(run("docs/x.md", "--role", "a\nb").out).toContain("line break");
			expect(readData()["docs/x.md"].role).toBeNull();
		});

		it("keeps the canonical write form: sorted keys, tabs, one newline, non-ASCII unescaped", () => {
			register("docs/z.md");
			register("docs/a.md");
			run("docs/z.md", "--role", "§ and — stay literal");
			const text = fs.readFileSync(dataFile, "utf8");
			const parsed = JSON.parse(text);
			const canonical = `${JSON.stringify(
				Object.fromEntries(
					Object.keys(parsed)
						.sort()
						.map((k) => [k, parsed[k]]),
				),
				null,
				"\t",
			)}\n`;
			expect(text).toBe(canonical);
			expect(text).toContain("§ and — stay literal");
		});
	});

	describe("--route (mantahostels#3411)", () => {
		const register = (p = "docs/x.md") =>
			run(p, "--class", "free-edit", "--section", "S");

		it("writes a route at registration when given alongside --class", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--route",
				"npm run gen:doc-pages",
			);
			expect(r.status).toBe(0);
			expect(readData()["docs/x.md"].route).toBe("npm run gen:doc-pages");
		});

		it("sets the route of an already-registered key, touching nothing else", () => {
			run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--qualifier",
				"q",
			);
			const before = readData()["docs/x.md"];
			const r = run("docs/x.md", "--route", "npm run gen:doc-pages");
			expect(r.status).toBe(0);
			expect(readData()["docs/x.md"]).toEqual({
				...before,
				route: "npm run gen:doc-pages",
			});
			expect(r.out).not.toContain("Orphan check owed");
		});

		it("prints the route it replaces", () => {
			register();
			run("docs/x.md", "--route", "First");
			const r = run("docs/x.md", "--route", "Second");
			expect(r.status).toBe(0);
			expect(r.out).toContain("replaced: First");
			expect(readData()["docs/x.md"].route).toBe("Second");
		});

		it("refuses --route alone on an unregistered key, naming it and writing nothing", () => {
			const r = run("docs/x.md", "--route", "npm run gen:doc-pages");
			expect(r.status).toBe(1);
			expect(r.out).toContain("docs/x.md is not registered");
			expect(readData()).toEqual({});
		});

		it("still refuses a re-registration of an existing key when --route rides along, leaving the entry as it was", () => {
			register();
			const r = run(
				"docs/x.md",
				"--class",
				"derived",
				"--section",
				"S",
				"--route",
				"x",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("already registered");
			expect(readData()["docs/x.md"]).toMatchObject({
				class: "free-edit",
				route: null,
			});
		});

		it("refuses an empty route and one carrying a line break", () => {
			register();
			expect(run("docs/x.md", "--route", "  ").out).toContain(
				"--route is empty",
			);
			expect(run("docs/x.md", "--route", "a\nb").out).toContain("line break");
			expect(readData()["docs/x.md"].route).toBeNull();
		});

		it("writes the route trimmed", () => {
			register();
			expect(
				run("docs/x.md", "--route", "  npm run gen:doc-pages \n").status,
			).toBe(0);
			expect(readData()["docs/x.md"].route).toBe("npm run gen:doc-pages");
		});

		it("sets both role and route in one call, naming both in the refusal on an unregistered key", () => {
			const r = run(
				"docs/x.md",
				"--role",
				"What it is",
				"--route",
				"npm run gen:doc-pages",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("--role or --route alone has no key to set");
			register();
			const r2 = run(
				"docs/x.md",
				"--role",
				"What it is",
				"--route",
				"npm run gen:doc-pages",
			);
			expect(r2.status).toBe(0);
			expect(readData()["docs/x.md"]).toMatchObject({
				role: "What it is",
				route: "npm run gen:doc-pages",
			});
		});
	});

	describe("argument shapes that used to slip past the checks", () => {
		it("refuses a value-taking flag whose value is the next flag, naming the flag and writing nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"--new-section",
			);
			expect(r.status).toBe(2);
			expect(r.out).toContain("--section needs a value");
			expect(readData()).toEqual({});
		});

		it("refuses an undeclared flag taken as a value-taking flag's value, quoting both and writing nothing", () => {
			const r = run(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"--bogus",
			);
			expect(r.status).toBe(2);
			expect(r.out).toContain('--section was given "--bogus"');
			expect(r.out).toContain("is a flag, not a value");
			expect(readData()).toEqual({});
		});

		it("refuses an unknown flag, naming it, and answers --help before any write (#920)", () => {
			const unknown = run("docs/x.md", "--clas", "free-edit");
			expect(unknown.status).toBe(2);
			expect(unknown.out).toContain("unknown flag: --clas");
			const help = run("docs/x.md", "--help");
			expect(help.status).toBe(0);
			expect(help.out).toContain("usage: node scripts/register-doc.js");
			expect(readData()).toEqual({});
		});

		it("does not take a flag's value as the path when flags come first", () => {
			const r = run(
				"--class",
				"free-edit",
				"--section",
				"Research runs",
				"docs/x.md",
			);
			expect(r.status).toBe(0);
			expect(Object.keys(readData())).toEqual(["docs/x.md"]);
		});
	});

	describe("--section spelling", () => {
		it("refuses a case-only variant even with --new-section, naming the existing section and writing nothing", () => {
			run("docs/a.md", "--class", "free-edit", "--section", "Research runs");
			const r = run(
				"docs/b.md",
				"--class",
				"free-edit",
				"--section",
				"research  Runs",
				"--new-section",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("only in case or spacing");
			expect(r.out).toContain("Research runs");
			expect(Object.keys(readData())).toEqual(["docs/a.md"]);
		});

		it("refuses a spelling no existing key uses, listing the real ones", () => {
			run("docs/a.md", "--class", "free-edit", "--section", "Research runs");
			const r = run(
				"docs/b.md",
				"--class",
				"free-edit",
				"--section",
				"Research run",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain('"Research run" is not one of');
			expect(r.out).toContain("Research runs");
			expect(r.out).toContain("--new-section");
			expect(Object.keys(readData())).toEqual(["docs/a.md"]);
		});

		it("accepts an unknown spelling when --new-section is given", () => {
			run("docs/a.md", "--class", "free-edit", "--section", "Research runs");
			const r = run(
				"docs/b.md",
				"--class",
				"free-edit",
				"--section",
				"Compliance",
				"--new-section",
			);
			expect(r.status).toBe(0);
			expect(readData()["docs/b.md"].section).toBe("Compliance");
		});

		it("ignores an entry carrying no section rather than refusing everything", () => {
			fs.writeFileSync(
				dataFile,
				JSON.stringify({ "docs/a.md": { class: "free-edit" } }),
			);
			const r = run(
				"docs/b.md",
				"--class",
				"free-edit",
				"--section",
				"Research runs",
			);
			expect(r.status).toBe(0);
			expect(readData()["docs/b.md"].section).toBe("Research runs");
		});

		it("accepts any spelling into an empty sidecar, with nothing to match", () => {
			const r = run(
				"docs/a.md",
				"--class",
				"free-edit",
				"--section",
				"Anything",
			);
			expect(r.status).toBe(0);
			expect(readData()["docs/a.md"].section).toBe("Anything");
		});
	});

	it("keeps the sidecar's keys sorted", () => {
		run("docs/z.md", "--class", "free-edit", "--section", "S");
		run("docs/a.md", "--class", "free-edit", "--section", "S");
		expect(Object.keys(readData())).toEqual(["docs/a.md", "docs/z.md"]);
	});

	describe("claiming", () => {
		let claimLog: string;
		let claimStub: string;

		// A stand-in for `session-arbiter.js claim <subject>`, matching
		// claimDataFile's real spawnSync(cmd, [subject]) shape — no shell, `cmd`
		// a single executable. Logs the subject it was invoked with and exits
		// `exitCode`, so both claimDataFile's ok and refused branches run
		// against it.
		const writeStub = (exitCode: number, stderr = "") => {
			fs.writeFileSync(
				claimStub,
				`#!/usr/bin/env bash\necho "$1" >> "${claimLog}"\n${stderr ? `echo "${stderr}" >&2\n` : ""}exit ${exitCode}\n`,
			);
			fs.chmodSync(claimStub, 0o755);
		};

		beforeEach(() => {
			claimLog = path.join(dir, "claim.log");
			claimStub = path.join(dir, "claim-stub.sh");
			writeStub(0);
		});

		const runClaiming = (...args: string[]) => {
			const r = runInProcess(
				SCRIPT,
				[
					...withReader(args),
					"--data-file",
					dataFile,
					"--claim-cmd",
					claimStub,
				],
				{ cwd: dir },
			);
			return {
				status: r.status,
				out: `${r.stdout}${r.stderr}`,
			};
		};

		it("claims docs/doc-map-classes.json#A:<path> before writing", () => {
			const r = runClaiming(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
			);
			expect(r.status).toBe(0);
			expect(fs.readFileSync(claimLog, "utf8").trim()).toBe(
				"docs/doc-map-classes.json#A:docs/x.md",
			);
			expect(readData()).toHaveProperty("docs/x.md");
		});

		const writeReleaseStub = () => {
			const releaseLog = path.join(dir, "release.log");
			const releaseStub = path.join(dir, "release-stub.sh");
			fs.writeFileSync(
				releaseStub,
				`#!/usr/bin/env bash\necho "$1" >> "${releaseLog}"\n`,
			);
			fs.chmodSync(releaseStub, 0o755);
			return { releaseLog, releaseStub };
		};

		it("releases the claim when a check after it refuses", () => {
			const { releaseLog, releaseStub } = writeReleaseStub();
			fs.writeFileSync(
				dataFile,
				JSON.stringify({ "docs/x.md": { class: "free-edit", section: "S" } }),
			);
			const r = runClaiming(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
				"--release-cmd",
				releaseStub,
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("already registered");
			expect(fs.readFileSync(releaseLog, "utf8").trim()).toBe(
				"docs/doc-map-classes.json#A:docs/x.md",
			);
		});

		it("claims the same subject for --role alone, and releases it on a refusal", () => {
			const { releaseLog, releaseStub } = writeReleaseStub();
			const r = runClaiming(
				"docs/x.md",
				"--role",
				"What it is",
				"--release-cmd",
				releaseStub,
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("is not registered");
			expect(fs.readFileSync(claimLog, "utf8").trim()).toBe(
				"docs/doc-map-classes.json#A:docs/x.md",
			);
			expect(fs.readFileSync(releaseLog, "utf8").trim()).toBe(
				"docs/doc-map-classes.json#A:docs/x.md",
			);
		});

		it("refuses with the denial reason, and writes nothing, when the claim is denied", () => {
			writeStub(1, "held by another session");
			const r = runClaiming(
				"docs/x.md",
				"--class",
				"free-edit",
				"--section",
				"S",
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain("held by another session");
			expect(readData()).toEqual({});
		});
	});

	/*
	 * The registration-time orphan trigger (mantahostels#3198). It prompts and never
	 * judges, so what is under test is reach: which registrations meet the
	 * line, and which do not.
	 */
	describe("the orphan check (mantahostels#3198)", () => {
		/* mantahostels#3195's five skip sections. */
		const skipSections = [
			"Agent-skill configuration",
			"Copy artefacts",
			"Non-prose",
			"Skills & settings",
			"Sync artefacts",
		];
		it("prints it for a section that can carry an obligation", () => {
			const r = run(
				"docs/compliance/new-assessment.md",
				"--class",
				"source-of-truth",
				"--section",
				"Compliance artefacts",
			);
			expect(r.status).toBe(0);
			expect(r.out).toContain("Orphan check owed (mantahostels#3198)");
			expect(r.out).toContain("docs/compliance/new-assessment.md");
		});

		it.each(skipSections)("stays silent for %s", (section) => {
			const r = run(
				"docs/somewhere/new-file.md",
				"--class",
				"source-of-truth",
				"--section",
				section,
			);
			expect(r.status).toBe(0);
			expect(r.out).toContain("registered docs/somewhere/new-file.md");
			expect(r.out).not.toContain("Orphan check owed");
		});

		/*
		 * The fail-safe direction, and the whole reason the constant is an
		 * exemption list rather than an inclusion one: a subsection nobody has
		 * classified yet triggers rather than being silently exempt.
		 */
		it("prints it for a section nobody has classified", () => {
			const r = run(
				"docs/whatever/new-thing.md",
				"--class",
				"source-of-truth",
				"--section",
				"A subsection minted after #3198",
			);
			expect(r.status).toBe(0);
			expect(r.out).toContain("Orphan check owed (mantahostels#3198)");
		});

		it("asks whether a newly minted subsection is obligation-bearing", () => {
			fs.writeFileSync(
				dataFile,
				JSON.stringify({ "docs/a.md": { section: "Copy artefacts" } }),
			);
			const r = run(
				"docs/new-area/thing.md",
				"--class",
				"source-of-truth",
				"--section",
				"Brand new heading",
				"--new-section",
			);
			expect(r.status).toBe(0);
			expect(r.out).toContain("is a new §A subsection");
			expect(r.out).toContain("ORPHAN_CHECK_EXEMPT");
			expect(r.out).toContain("Orphan check owed (mantahostels#3198)");
		});

		/*
		 * --new-section alongside a heading §A already carries is accepted, so
		 * the prompt has to fire on newness rather than on the flag, or it
		 * calls a live heading new.
		 */
		it("does not call a live subsection new, even with --new-section", () => {
			fs.writeFileSync(
				dataFile,
				JSON.stringify({ "docs/a.md": { section: "Copy artefacts" } }),
			);
			const r = run(
				"docs/copy/another.md",
				"--class",
				"source-of-truth",
				"--section",
				"Copy artefacts",
				"--new-section",
			);
			expect(r.status).toBe(0);
			expect(r.out).not.toContain("is a new §A subsection");
			expect(r.out).not.toContain("Orphan check owed");
		});

		it("prints nothing when the registration itself refuses", () => {
			const r = run(
				"docs/compliance/new-assessment.md",
				"--class",
				"not-a-class",
				"--section",
				"Compliance artefacts",
			);
			expect(r.status).toBe(1);
			expect(r.out).not.toContain("Orphan check owed");
		});
	});
});
