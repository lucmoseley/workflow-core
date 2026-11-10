// @vitest-environment node
/*
 * Pins that an undeclared, stale or reverted edit to a vendored skill file
 * gates, that a declared one passes, and that the lock and upstream reports
 * say what they found (mantahostels#1809, mantahostels#3522).
 *
 * What is under test is the VERDICT: given a tree in a known state, does the
 * checker gate, and does its message name the file and the command that clears
 * it? The check modes reach it through the CLI, so the classification helpers
 * stay implementation.
 *
 * Every fixture hash is computed by the fixture: a hard-coded digest would test
 * the fixture's own bytes, not the checker. The one known-answer test is the
 * exception, and says why in place. Each tree is built in a temp directory on
 * `--root`, never this repo's `.agents/skills/`, whose real edits would move
 * the verdicts.
 *
 * The upstream-record cases (#2394) run the `--covered` limb cut from the
 * real `.husky/pre-commit` in a throwaway repo, not on `--root`: the limb
 * reads the staged blobs, so only a real index can tell a staged record from
 * one left in the worktree. A false pass lands a lock no licence check has
 * covered.
 *
 * The `--revendor --from` cases (#4802) each run git on a real clone, which is
 * most of this file's run time: the cases that only read the clone share one,
 * and a case that changes its clone builds its own.
 *
 * It is a hard gate in `.husky/pre-commit` on any commit staging a vendored
 * path: a false pass lands an undeclared edit, which the next re-pull reverts
 * silently, or an accidental edit that reads as approved.
 */

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GH_NOT_FOUND, GH_VALIDATION_FAILED } from "./lib/gh-fake";
import {
	printed,
	type RouteAnswer,
	refused,
	stubGhRoutes,
} from "./lib/gh-stub";
import { splitCheckout } from "./lib/guard-core-testkit";
import {
	cutGateScript,
	registerTempCleanup,
	stagedRepo,
} from "./lib/precommit-gate-harness";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-vendored-skills.js");
const REPO = path.join(__dirname, "..");
/** The fix command a finding prints in this checkout (#2515). */
const IN_REPO = "node scripts/check-vendored-skills.js";
/** The fix command a finding prints in an adopter, the plugin root elsewhere. */
const ADOPTER = `node "${SCRIPT}"`;
/** process.env less any gate stand-down a developer has exported. */
const ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !/^WFC_[A-Z0-9_]+_OFF$/.test(k)),
);
const temps: string[] = [];

afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

const sha256 = (s: string) =>
	crypto.createHash("sha256").update(s).digest("hex");

interface Edit {
	editedHash: string;
	issue: number;
	why: string;
}

interface Fixture {
	/** Files under .agents/skills/, path relative to that directory. */
	disk: Record<string, string>;
	/** What the manifest claims was vendored. Defaults to `disk` verbatim. */
	vendored?: Record<string, string>;
	edits?: Record<string, Edit>;
	/** Skill names the lock lists. Defaults to the directories in `disk`. */
	locked?: string[];
	/** Omit the sidecar entirely. */
	noSidecar?: boolean;
	/**
	 * Overrides for the lock's `computedHash`, by skill name. Unnamed skills get
	 * the real folder hash of what `disk` wrote, so the lock agrees by default.
	 */
	lockHashes?: Record<string, string>;
	/** Defaults to a section for the one source the lock names. */
	notices?: string;
}

/**
 * `computeSkillFolderHash` again, independently of the checker's copy: the two
 * agreeing is the guarantee under test, so sharing one implementation would test
 * nothing (mantahostels#3522).
 */
function folderHash(dir: string): string {
	const files: { rel: string; content: Buffer }[] = [];
	const walk = (cur: string) => {
		for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
			const p = path.join(cur, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile())
				files.push({
					rel: path.relative(dir, p).split(path.sep).join("/"),
					content: fs.readFileSync(p),
				});
		}
	};
	walk(dir);
	files.sort((a, b) => a.rel.localeCompare(b.rel));
	const h = crypto.createHash("sha256");
	for (const f of files) {
		h.update(f.rel);
		h.update(f.content);
	}
	return h.digest("hex");
}

function build(fx: Fixture): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-skills-"));
	temps.push(root);
	for (const [rel, body] of Object.entries(fx.disk)) {
		const abs = path.join(root, ".agents/skills", rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	const source = fx.vendored ?? fx.disk;
	const vendored: Record<string, string> = {};
	for (const [rel, body] of Object.entries(source))
		vendored[`.agents/skills/${rel}`] = sha256(body);

	const skills = (fx.locked ?? Object.keys(fx.disk).map((r) => r.split("/")[0]))
		.filter((n, i, a) => a.indexOf(n) === i)
		.reduce<Record<string, object>>((acc, name) => {
			const dir = path.join(root, ".agents/skills", name);
			acc[name] = {
				source: "mattpocock/skills",
				skillPath: `skills/engineering/${name}/SKILL.md`,
				computedHash:
					fx.lockHashes?.[name] ??
					(fs.existsSync(dir) ? folderHash(dir) : "no directory to hash"),
			};
			return acc;
		}, {});
	fs.writeFileSync(
		path.join(root, "skills-lock.json"),
		JSON.stringify({ version: 1, skills }, null, "\t"),
	);
	fs.mkdirSync(path.join(root, ".claude/skills"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude/skills/THIRD-PARTY-NOTICES.md"),
		fx.notices ??
			`# Notices\n\n## mattpocock/skills\n\nSkills: ${Object.keys(skills).join(", ")}\n\nMIT License\n`,
	);

	if (!fx.noSidecar) {
		fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".agents/vendored-skill-edits.json"),
			JSON.stringify(
				{ vendoredAt: "abc1234", vendored, edits: fx.edits ?? {} },
				null,
				"\t",
			),
		);
	}
	return root;
}

interface Result {
	code: number;
	tags: string[];
	stderr: string;
}

/** `cwd` unset runs from the suite's own, this checkout. */
function run(root: string, args: string[] = [], cwd?: string): Result {
	const r = runInProcess(SCRIPT, ["--root", root, "--json", ...args], { cwd });
	const parsed = JSON.parse(r.stdout);
	return {
		code: r.status,
		tags: (parsed.findings ?? []).map((f: { tag: string }) => f.tag),
		stderr: JSON.stringify(parsed.findings ?? []),
	};
}

/** Runs without --json, so the human report is what comes back. */
function runText(root: string, args: string[] = []) {
	const r = runInProcess(SCRIPT, ["--root", root, ...args]);
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const SKILL = "---\nname: a\n---\n\nOriginal body.\n";

describe("check-vendored-skills", () => {
	it("passes a tree that matches what was vendored", () => {
		const root = build({ disk: { "a/SKILL.md": SKILL } });
		expect(run(root)).toMatchObject({ code: 0, tags: [] });
	});

	it("fails an edit nothing declares, and names the declare command", () => {
		const root = build({
			disk: { "a/SKILL.md": `${SKILL}Locally added.\n` },
			vendored: { "a/SKILL.md": SKILL },
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.tags).toEqual(["UNDECLARED"]);
		expect(r.stderr).toContain(".agents/skills/a/SKILL.md");
		expect(r.stderr).toContain(
			`${IN_REPO} --declare .agents/skills/a/SKILL.md`,
		);
	});

	it("passes an edit that is declared at the bytes on disk", () => {
		const edited = `${SKILL}Locally added.\n`;
		const root = build({
			disk: { "a/SKILL.md": edited },
			vendored: { "a/SKILL.md": SKILL },
			edits: {
				".agents/skills/a/SKILL.md": {
					editedHash: sha256(edited),
					issue: 42,
					why: "because",
				},
			},
		});
		expect(run(root)).toMatchObject({ code: 0, tags: [] });
	});

	it("fails a declaration whose edit has since been reverted, tagging it STALE-ENTRY and offering --drop as the way out", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL },
			edits: {
				".agents/skills/a/SKILL.md": {
					editedHash: sha256("something else"),
					issue: 42,
					why: "because",
				},
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.tags).toEqual(["STALE-ENTRY"]);
		expect(r.stderr).toContain(`${IN_REPO} --drop .agents/skills/a/SKILL.md`);
	});

	it("fails a file edited again since it was declared, tagging it DRIFTED", () => {
		const root = build({
			disk: { "a/SKILL.md": `${SKILL}Second edit.\n` },
			vendored: { "a/SKILL.md": SKILL },
			edits: {
				".agents/skills/a/SKILL.md": {
					editedHash: sha256(`${SKILL}First edit.\n`),
					issue: 42,
					why: "because",
				},
			},
		});
		expect(run(root)).toMatchObject({ code: 1, tags: ["DRIFTED"] });
	});

	it("checks reference files, not SKILL.md alone", () => {
		const root = build({
			disk: {
				"a/SKILL.md": SKILL,
				"a/LOGIC.md": "edited reference\n",
				"a/agents/openai.yaml": "name: a\n",
			},
			vendored: {
				"a/SKILL.md": SKILL,
				"a/LOGIC.md": "original reference\n",
				"a/agents/openai.yaml": "name: a\n",
			},
		});
		const r = run(root);
		expect(r.tags).toEqual(["UNDECLARED"]);
		expect(r.stderr).toContain("LOGIC.md");
	});

	it("fails a file added locally after vendoring, tagging it UNTRACKED", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL, "a/EXTRA.md": "ours\n" },
			vendored: { "a/SKILL.md": SKILL },
		});
		expect(run(root)).toMatchObject({ code: 1, tags: ["UNTRACKED"] });
	});

	it("passes a file added locally once it is declared", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL, "a/EXTRA.md": "ours\n" },
			vendored: { "a/SKILL.md": SKILL },
			edits: {
				".agents/skills/a/EXTRA.md": {
					editedHash: sha256("ours\n"),
					issue: 1,
					why: "added",
				},
			},
		});
		expect(run(root)).toMatchObject({ code: 0, tags: [] });
	});

	it("fails a declared added file edited again since, tagging it DRIFTED", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL, "a/EXTRA.md": "ours, edited\n" },
			vendored: { "a/SKILL.md": SKILL },
			edits: {
				".agents/skills/a/EXTRA.md": {
					editedHash: sha256("ours\n"),
					issue: 1,
					why: "added",
				},
			},
		});
		expect(run(root)).toMatchObject({ code: 1, tags: ["DRIFTED"] });
	});

	it("fails a declared added file no longer on disk, tagging it STALE-ENTRY and offering --drop", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL },
			vendored: { "a/SKILL.md": SKILL },
			edits: {
				".agents/skills/a/EXTRA.md": {
					editedHash: sha256("ours\n"),
					issue: 1,
					why: "added",
				},
			},
		});
		const r = run(root);
		expect(r).toMatchObject({ code: 1, tags: ["STALE-ENTRY"] });
		expect(r.stderr).toContain(`${IN_REPO} --drop .agents/skills/a/EXTRA.md`);
	});

	it("warns, and does not gate, on a de-vendored file still in the manifest, tagged REMOVED and offering --forget on its path as the way out", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL },
			vendored: { "a/SKILL.md": SKILL, "b/SKILL.md": "gone\n" },
			locked: ["a"],
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.tags).toEqual(["REMOVED"]);
		expect(r.stderr).toContain(`${IN_REPO} --forget .agents/skills/b/SKILL.md`);
	});

	it.each<[string, Fixture, string]>([
		[
			"UNDECLARED",
			{
				disk: { "a/SKILL.md": `${SKILL}Locally added.\n` },
				vendored: { "a/SKILL.md": SKILL },
			},
			"--declare .agents/skills/a/SKILL.md",
		],
		[
			"STALE-ENTRY",
			{
				disk: { "a/SKILL.md": SKILL },
				edits: {
					".agents/skills/a/SKILL.md": {
						editedHash: sha256("something else"),
						issue: 42,
						why: "because",
					},
				},
			},
			"--drop .agents/skills/a/SKILL.md",
		],
		[
			"REMOVED",
			{
				disk: { "a/SKILL.md": SKILL },
				vendored: { "a/SKILL.md": SKILL, "b/SKILL.md": "gone\n" },
				locked: ["a"],
			},
			"--forget .agents/skills/b/SKILL.md",
		],
	])(
		"run from a plugin root outside the working tree, prints %s's command at the plugin's path (#2515)",
		(tag, tree, args) => {
			const root = build(tree);
			const r = run(root, [], root);
			expect(r.tags).toEqual([tag]);
			/* `stderr` holds the findings as JSON, so the quotes arrive escaped. */
			expect(r.stderr).toContain(
				JSON.stringify(`${ADOPTER} ${args}`).slice(1, -1),
			);
		},
	);

	it("warns when the lock and the directories disagree, tagged LOCK-ORPHAN", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL },
			locked: ["a", "b"],
		});
		expect(run(root).tags).toEqual(["LOCK-ORPHAN"]);
	});

	it("fails a lock source the licence notices carry no section for, tagged NOTICE-MISSING and naming the source (#1939)", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL },
			notices:
				"# Notices\n\nmattpocock/skills is named, but under no heading.\n",
		});
		const r = run(root);
		expect(r).toMatchObject({ code: 1, tags: ["NOTICE-MISSING"] });
		expect(r.stderr).toContain("mattpocock/skills");
		expect(r.stderr).toContain("Add the section: a `Skills: a` line");
	});

	it("fails a notices section whose Skills line disagrees with the lock, naming the line to set (#1939)", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL, "b/SKILL.md": SKILL },
			notices:
				"# Notices\n\n## mattpocock/skills\n\nSkills: a\n\nMIT License\n",
		});
		const r = run(root);
		expect(r).toMatchObject({ code: 1, tags: ["NOTICE-MISSING"] });
		expect(r.stderr).toContain("`Skills: a, b`");
	});

	it("fails a notices section naming a source the lock no longer vendors from, which would join the licence above it (#2378)", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL },
			notices:
				"# Notices\n\n## mattpocock/skills\n\nSkills: a\n\nMIT License\n\n## gone/skills\n\nSkills: b\n\nOther\n",
		});
		const r = run(root);
		expect(r).toMatchObject({ code: 1, tags: ["NOTICE-MISSING"] });
		expect(r.stderr).toContain("`## gone/skills` section");
	});

	it("leaves an unparseable lock to LOCK-UNREADABLE, raising no notice finding beside it (#1939)", () => {
		const root = build({ disk: { "a/SKILL.md": SKILL } });
		fs.writeFileSync(path.join(root, "skills-lock.json"), "{ not json");
		expect(run(root).tags).not.toContain("NOTICE-MISSING");
	});

	/*
	 * The known-answer vector for the port (mantahostels#3522). A fixture can only show this
	 * file's transcription of `computeSkillFolderHash` agreeing with the
	 * checker's, which a shared mistranscription passes. The repo's own lock was
	 * written by the vendor installer, so it is the only value here neither copy
	 * produced.
	 */
	it("reproduces the installer's own computedHash for every clean skill (mantahostels#3522)", () => {
		const repo = path.join(__dirname, "..");
		const lock = JSON.parse(
			fs.readFileSync(path.join(repo, "skills-lock.json"), "utf8"),
		).skills as Record<string, { computedHash: string }>;
		const edited = new Set(
			Object.keys(
				JSON.parse(
					fs.readFileSync(
						path.join(repo, ".agents/vendored-skill-edits.json"),
						"utf8",
					),
				).edits,
			).map((rel: string) => rel.split("/")[2]),
		);
		const clean = Object.keys(lock).filter((n) => !edited.has(n));
		// Non-vacuous only: every declared edit takes a skill off this list.
		expect(clean.length).toBeGreaterThan(0);
		for (const name of clean)
			expect(
				`${name}:${folderHash(path.join(repo, ".agents/skills", name))}`,
			).toBe(`${name}:${lock[name].computedHash}`);
		for (const name of edited)
			expect(folderHash(path.join(repo, ".agents/skills", name))).not.toBe(
				lock[name].computedHash,
			);
		/* And the CHECKER's own copy against the same vector: a LOCK-HASH here is
		 * the port drifting from upstream, not the tree. Tags are filtered rather
		 * than compared, because a neighbour's undeclared edit is not this test's
		 * business. */
		expect(run(repo).tags.filter((t) => t === "LOCK-HASH")).toEqual([]);
	});

	it("warns when the manifest agrees with disk but the lock does not, tagged LOCK-HASH, naming the skill and offering --revendor as the way out (mantahostels#3522)", () => {
		const root = build({
			disk: { "a/SKILL.md": SKILL },
			lockHashes: { a: sha256("a tree nobody here ever had") },
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.tags).toEqual(["LOCK-HASH"]);
		expect(r.stderr).toContain(".agents/skills/a/");
		expect(r.stderr).toContain("The manifest is the first suspect");
		expect(r.stderr).toContain("--revendor at what was pulled");
	});

	it("says so when the lock is on disk and will not parse (mantahostels#3522)", () => {
		const root = build({ disk: { "a/SKILL.md": SKILL } });
		fs.writeFileSync(path.join(root, "skills-lock.json"), "{ not json");
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.tags).toEqual(["LOCK-UNREADABLE"]);
		expect(r.stderr).toContain("went unrun");
	});

	it("stays quiet about a skill whose divergence a per-file verdict explains (mantahostels#3522)", () => {
		const edited = `${SKILL}Locally added.\n`;
		const root = build({
			disk: { "a/SKILL.md": edited },
			vendored: { "a/SKILL.md": SKILL },
			edits: {
				".agents/skills/a/SKILL.md": {
					editedHash: sha256(edited),
					issue: 1,
					why: "declared",
				},
			},
			lockHashes: { a: sha256("whatever upstream shipped") },
		});
		expect(run(root)).toMatchObject({ code: 0, tags: [] });
	});

	it("is BROKEN, not green, when the manifest cannot be read", () => {
		const root = build({ disk: { "a/SKILL.md": SKILL }, noSidecar: true });
		expect(runText(root).code).toBe(2);
	});

	it("refuses to declare an edit with no approving issue, naming the --issue flag", () => {
		const root = build({
			disk: { "a/SKILL.md": `${SKILL}edited\n` },
			vendored: { "a/SKILL.md": SKILL },
		});
		const r = runText(root, [
			"--declare",
			".agents/skills/a/SKILL.md",
			"--why",
			"x",
		]);
		expect(r.code).toBe(2);
		expect(r.out).toContain("--issue");
	});

	it("refuses to declare a file that matches the vendored bytes", () => {
		const root = build({ disk: { "a/SKILL.md": SKILL } });
		expect(
			runText(root, [
				"--declare",
				".agents/skills/a/SKILL.md",
				"--issue",
				"42",
				"--why",
				"x",
			]).out,
		).toContain("there is no edit to declare");
	});

	it("declares an edit, and the check then passes", () => {
		const root = build({
			disk: { "a/SKILL.md": `${SKILL}edited\n` },
			vendored: { "a/SKILL.md": SKILL },
		});
		expect(run(root).code).toBe(1);
		runText(root, [
			"--declare",
			".agents/skills/a/SKILL.md",
			"--issue",
			"42",
			"--why",
			"a reason",
		]);
		expect(run(root)).toMatchObject({ code: 0, tags: [] });
	});

	it("refuses to forget a file that is still on disk", () => {
		const root = build({ disk: { "a/SKILL.md": SKILL } });
		expect(
			runText(root, ["--forget", ".agents/skills/a/SKILL.md"]).out,
		).toContain("still exists");
	});
});

/*
 * The --upstream re-pull pre-flight, driven through the CLI with `gh` stubbed
 * at WFC_GH: which repo and path each declared edit is fetched from, and how a
 * fetched body is classified.
 */

/** A root whose one declared edit sits in a skill vendored from `source`. */
function upstreamRoot(source: string) {
	const root = build({
		disk: { "a/SKILL.md": `${SKILL}Edited.\n` },
		vendored: { "a/SKILL.md": SKILL },
		edits: {
			".agents/skills/a/SKILL.md": {
				editedHash: sha256(`${SKILL}Edited.\n`),
				issue: 1,
				why: "declared",
			},
		},
	});
	const lockFile = path.join(root, "skills-lock.json");
	const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
	lock.skills.a.source = source;
	lock.skills.a.skillPath = "skills/a/SKILL.md";
	fs.writeFileSync(lockFile, JSON.stringify(lock, null, "\t"));
	return root;
}

/** The licence text `build`'s default notices section holds. */
const LICENCE = "MIT License\n";

/**
 * A `gh` for `stubGh`: its routes, keyed on the path fetched, and the file its
 * calls' arguments are appended to; with no `log`, no call is recorded.
 */
interface Gh {
	routes: Record<string, RouteAnswer>;
	log?: string;
}

/** What `gh api <path> --jq .content` prints for a file holding `text`. */
const content = (text: string) =>
	printed(`${Buffer.from(text).toString("base64")}\n`);

/** A `gh` failing every fetch with `stderr`. */
const refusing = (stderr: string): Gh => ({ routes: { "*": refused(stderr) } });

/** A `gh` failing every fetch as GitHub refuses a request it cannot process. */
const GH_422: Gh = { routes: { "*": GH_VALIDATION_FAILED } };

/**
 * A `gh` that answers every contents fetch with `body` and every licence
 * fetch with `licence`, and appends each call's arguments to `log`. A path
 * matching the `missing` glob 404s instead.
 */
function answering(
	body: string,
	log: string,
	licence = LICENCE,
	missing?: string,
): Gh {
	return {
		routes: {
			...(missing ? { [missing]: GH_NOT_FOUND } : {}),
			"*/license*": content(licence),
			"*": content(body),
		},
		log,
	};
}

const licenceFailing = (stderr: string): Gh => ({
	routes: { "*/license*": refused(stderr), "*": content(SKILL) },
});

function readEndpoints(log: string, kind: "contents" | "license") {
	return fs.existsSync(log)
		? fs
				.readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((l) => l.split(" ")[1] ?? "")
				.filter((e) => e.split("/")[3] === kind)
		: [];
}

/** The repos/<owner>/<repo>/contents/<path> each logged call asked for. */
const readContentsEndpoints = (log: string) => readEndpoints(log, "contents");

/** upstreamRoot plus a declared added file, `a/EXTRA.md`. */
function rootWithAddition() {
	const root = upstreamRoot("mattpocock/skills");
	const extra = ".agents/skills/a/EXTRA.md";
	fs.writeFileSync(path.join(root, extra), "ours\n");
	const file = path.join(root, ".agents/vendored-skill-edits.json");
	const sidecar = JSON.parse(fs.readFileSync(file, "utf8"));
	sidecar.edits[extra] = {
		editedHash: sha256("ours\n"),
		issue: 2,
		why: "added",
	};
	fs.writeFileSync(file, JSON.stringify(sidecar, null, "\t"));
	return root;
}

describe("check-vendored-skills --upstream", () => {
	it("asks each skill's own upstream, at the path its lock entry gives", () => {
		const root = upstreamRoot("emilkowalski/skills");
		const log = path.join(root, "gh.log");
		expect(runUpstream(root, answering(SKILL, log)).outcome).toBe("OK");
		expect(readContentsEndpoints(log)).toEqual([
			"repos/emilkowalski/skills/contents/skills/a/SKILL.md",
		]);
	});

	it("fetches a reference file from beside its skill's SKILL.md upstream", () => {
		const root = upstreamRoot("emilkowalski/skills");
		const recipes = ".agents/skills/a/RECIPES.md";
		fs.writeFileSync(path.join(root, recipes), "edited recipes\n");
		const file = path.join(root, ".agents/vendored-skill-edits.json");
		const sidecar = JSON.parse(fs.readFileSync(file, "utf8"));
		sidecar.vendored[recipes] = sha256("vendored recipes\n");
		sidecar.edits[recipes] = {
			editedHash: sha256("edited recipes\n"),
			issue: 2,
			why: "also declared",
		};
		fs.writeFileSync(file, JSON.stringify(sidecar, null, "\t"));
		const log = path.join(root, "gh.log");
		runUpstream(root, answering(SKILL, log));
		expect(readContentsEndpoints(log)).toContain(
			"repos/emilkowalski/skills/contents/skills/a/RECIPES.md",
		);
	});

	it("resolves nothing, and fetches nothing, for an edit not under a skill directory", () => {
		const root = upstreamRoot("mattpocock/skills");
		const file = path.join(root, ".agents/vendored-skill-edits.json");
		const sidecar = JSON.parse(fs.readFileSync(file, "utf8"));
		sidecar.edits = {
			".agents/skills/a": sidecar.edits[".agents/skills/a/SKILL.md"],
		};
		fs.writeFileSync(file, JSON.stringify(sidecar, null, "\t"));
		const log = path.join(root, "gh.log");
		const r = runUpstream(root, answering(SKILL, log));
		expect(r.tags).toEqual(["UPSTREAM-UNRESOLVED"]);
		expect(readContentsEndpoints(log)).toEqual([]);
	});

	it("fetches nothing where the lock names no source", () => {
		const root = upstreamRoot("mattpocock/skills");
		const lockFile = path.join(root, "skills-lock.json");
		const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
		lock.skills.a.source = undefined;
		fs.writeFileSync(lockFile, JSON.stringify(lock, null, "\t"));
		const log = path.join(root, "gh.log");
		const r = runUpstream(root, answering(SKILL, log));
		expect(r.tags).toEqual(["UPSTREAM-UNRESOLVED"]);
		expect(r.outcome).not.toBe("SKIP");
		expect(readContentsEndpoints(log)).toEqual([]);
	});

	it("still tells same from moved", () => {
		const root = upstreamRoot("mattpocock/skills");
		const log = path.join(root, "gh.log");
		const same = runUpstream(root, answering(SKILL, log));
		expect(same.outcome).toBe("OK");
		expect(same.tags).toEqual([]);
		expect(
			runUpstream(root, answering(`${SKILL}upstream moved.\n`, log)).tags,
		).toEqual(["UPSTREAM-MOVED"]);
	});

	it("passes a declared added file that upstream 404s on", () => {
		const root = rootWithAddition();
		const log = path.join(root, "gh.log");
		const r = runUpstream(root, answering(SKILL, log, LICENCE, "*EXTRA*"));
		expect(r).toMatchObject({ outcome: "OK", tags: [] });
	});

	it("names a declared added file UPSTREAM-TAKEN where upstream now ships that path", () => {
		const root = rootWithAddition();
		const r = runUpstream(root, answering(SKILL, path.join(root, "gh.log")));
		expect(r.tags).toEqual(["UPSTREAM-TAKEN"]);
		expect(r.text).toContain(".agents/skills/a/EXTRA.md was added locally");
	});
});

describe("check-vendored-skills --upstream, licences (#1951)", () => {
	it("asks each noticed source for its licence, and passes where the text matches", () => {
		const root = upstreamRoot("mattpocock/skills");
		const log = path.join(root, "gh.log");
		const r = runUpstream(root, answering(SKILL, log));
		expect(r.tags).toEqual([]);
		expect(r.text).toContain("1 licence notice(s)");
		expect(readEndpoints(log, "license")).toEqual([
			"repos/mattpocock/skills/license",
		]);
	});

	it("reads line endings and trailing whitespace as no change", () => {
		const root = upstreamRoot("mattpocock/skills");
		const log = path.join(root, "gh.log");
		expect(
			runUpstream(root, answering(SKILL, log, "MIT License  \r\n\r\n")).tags,
		).toEqual([]);
	});

	it("names the section to refresh where upstream's licence text differs", () => {
		const root = upstreamRoot("mattpocock/skills");
		const log = path.join(root, "gh.log");
		const r = runUpstream(
			root,
			answering(SKILL, log, "MIT License\n\nCopyright (c) 2027 Someone Else\n"),
		);
		expect(r.tags).toEqual(["UPSTREAM-LICENCE"]);
		expect(r.outcome).not.toBe("SKIP");
		expect(r.text).toContain("`## mattpocock/skills`");
		expect(r.text).toContain("gh api repos/mattpocock/skills/license");
	});

	it("checks the licence even where no edit is declared", () => {
		const root = build({ disk: { "a/SKILL.md": SKILL } });
		const log = path.join(root, "gh.log");
		const r = runUpstream(root, answering(SKILL, log, "Apache License\n"));
		expect(r.tags).toEqual(["UPSTREAM-LICENCE"]);
		expect(readContentsEndpoints(log)).toEqual([]);
	});

	it("reads a licence fetch that failed as UPSTREAM-UNREADABLE, never as a difference", () => {
		const r = runUpstream(
			upstreamRoot("mattpocock/skills"),
			licenceFailing("gh: could not resolve host"),
		);
		expect(r.tags).toEqual(["UPSTREAM-UNREADABLE"]);
		expect(r.outcome).not.toBe("SKIP");
		expect(r.text).toContain(
			"mattpocock/skills's licence could not be fetched",
		);
	});

	it("reads a licence holding a ## heading of its own whole, ending its section only at the next source's heading (#2378)", () => {
		const markdown = "# Licence\n\n## Terms\n\nUse it freely.\n";
		const root = build({
			disk: { "a/SKILL.md": SKILL },
			notices: `# Notices\n\n## mattpocock/skills\n\nSkills: a\n\n${markdown}\n## other/skills\n\nSkills: z\n\n${markdown}`,
		});
		const lockFile = path.join(root, "skills-lock.json");
		const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
		lock.skills.z = { ...lock.skills.a, source: "other/skills" };
		fs.writeFileSync(lockFile, JSON.stringify(lock, null, "\t"));
		const log = path.join(root, "gh.log");
		expect(runUpstream(root, answering(SKILL, log, markdown)).tags).toEqual([]);
		expect(
			runUpstream(root, answering(SKILL, log, "# Licence\n\n")).tags,
		).toEqual(["UPSTREAM-LICENCE", "UPSTREAM-LICENCE"]);
	});

	it("names the licences, not upstream bodies, where only licence fetches ran and all failed (#2378)", () => {
		const r = runUpstream(
			build({ disk: { "a/SKILL.md": SKILL } }),
			refusing("gh: could not resolve host"),
		);
		expect(r.outcome).toBe("SKIP");
		expect(r.text).toContain("upstream's copy of the 1 licence(s) checked");
		expect(r.text).not.toContain("edited file");
	});

	it("names a licence 404 as UPSTREAM-GONE", () => {
		const r = runUpstream(
			upstreamRoot("mattpocock/skills"),
			licenceFailing("gh: Not Found (HTTP 404)"),
		);
		expect(r.tags).toEqual(["UPSTREAM-GONE"]);
		expect(r.text).toContain("no licence GitHub can find");
	});

	it("asks nothing of a source with no notices section, which NOTICE-MISSING owns", () => {
		const root = upstreamRoot("emilkowalski/skills");
		const log = path.join(root, "gh.log");
		runUpstream(root, answering(SKILL, log, "anything\n"));
		expect(readEndpoints(log, "license")).toEqual([]);
	});
});

/*
 * The CLI's --upstream reporting of a failed fetch: the tags, the SKIP
 * condition and the 404 spelling (mantahostels#3025).
 */

const stubGh = (root: string, { routes, log }: Gh) =>
	stubGhRoutes(root, routes, { log }).gh;

/**
 * `--upstream` over `root`, against the stub. Reads --json: the tag is what
 * classifies a row, and the human report prints the severity alone.
 */
function runUpstream(root: string, gh: Gh, extra: string[] = []) {
	const r = runInProcess(
		SCRIPT,
		["--root", root, "--upstream", "--json", ...extra],
		{ env: { ...process.env, WFC_GH: stubGh(root, gh) } },
	);
	const parsed = JSON.parse(r.stdout);
	const findings: { tag: string; message: string }[] = parsed.findings ?? [];
	return {
		code: r.status,
		outcome: parsed.outcome as string,
		tags: findings.map((f) => f.tag),
		text: `${parsed.summary}\n${findings.map((f) => f.message).join("\n")}`,
	};
}

/** A `gh` answering every fetch as it does a path that is not there. */
const GH_404: Gh = { routes: { "*": GH_NOT_FOUND } };

describe("check-vendored-skills --upstream, over the CLI", () => {
	it("names a 404 as UPSTREAM-GONE, and does not skip on it", () => {
		const r = runUpstream(upstreamRoot("emilkowalski/skills"), GH_404);
		expect(r.tags).toEqual(["UPSTREAM-GONE"]);
		expect(r.outcome).not.toBe("SKIP");
		expect(r.text).toContain("emilkowalski/skills/skills/a/SKILL.md");
	});

	it("skips when every fetch failed for a reason that is not a 404", () => {
		const r = runUpstream(
			upstreamRoot("mattpocock/skills"),
			refusing("gh: could not resolve host"),
		);
		expect(r.outcome).toBe("SKIP");
		expect(r.text).toContain("could not resolve host");
		expect(r.text).toContain("1 edited file(s) or 1 licence(s)");
	});

	it("reports rather than skipping when a 404 sits beside an unreachable fetch", () => {
		const root = upstreamRoot("mattpocock/skills");
		const second = ".agents/skills/a/RECIPES.md";
		fs.writeFileSync(path.join(root, second), "edited recipes\n");
		const file = path.join(root, ".agents/vendored-skill-edits.json");
		const sidecar = JSON.parse(fs.readFileSync(file, "utf8"));
		sidecar.vendored[second] = sha256("vendored recipes\n");
		sidecar.edits[second] = {
			editedHash: sha256("edited recipes\n"),
			issue: 2,
			why: "also declared",
		};
		fs.writeFileSync(file, JSON.stringify(sidecar, null, "\t"));
		const r = runUpstream(root, {
			routes: {
				"*RECIPES*": GH_NOT_FOUND,
				"*": refused("gh: could not resolve host"),
			},
		});
		/* The second UNREADABLE is the licence fetch. */
		expect([...r.tags].sort()).toEqual([
			"UPSTREAM-GONE",
			"UPSTREAM-UNREADABLE",
			"UPSTREAM-UNREADABLE",
		]);
		expect(r.outcome).not.toBe("SKIP");
	});

	it("breaks, rather than skipping, on a failure the call is at fault for, naming the HTTP error and saying it is not a finding about upstream (mantahostels#3066)", () => {
		const r = runUpstream(upstreamRoot("mattpocock/skills"), GH_422);
		expect(r.outcome).toBe("BROKEN");
		expect(r.text).toContain("HTTP 422");
		expect(r.text).toContain("not a finding about upstream");
	});

	it("skips on an unauthenticated gh (mantahostels#3066)", () => {
		const r = runUpstream(
			upstreamRoot("mattpocock/skills"),
			refusing("gh: Bad credentials (HTTP 401)"),
		);
		expect(r.outcome).toBe("SKIP");
		expect(r.text).toContain("`gh` unauthenticated");
	});

	it("reports the lock finding rather than skipping when the only fetch is unreachable", () => {
		const root = upstreamRoot("mattpocock/skills");
		const second = ".agents/skills/b/SKILL.md";
		fs.mkdirSync(path.join(root, ".agents/skills/b"), { recursive: true });
		fs.writeFileSync(path.join(root, second), "edited b\n");
		const file = path.join(root, ".agents/vendored-skill-edits.json");
		const sidecar = JSON.parse(fs.readFileSync(file, "utf8"));
		sidecar.vendored[second] = sha256("vendored b\n");
		sidecar.edits[second] = {
			editedHash: sha256("edited b\n"),
			issue: 3,
			why: "no upstream in the lock",
		};
		fs.writeFileSync(file, JSON.stringify(sidecar, null, "\t"));
		const r = runUpstream(root, refusing("gh: could not resolve host"));
		expect(r.outcome).not.toBe("SKIP");
		/* The second UNREADABLE is the licence fetch. */
		expect([...r.tags].sort()).toEqual([
			"UPSTREAM-UNREADABLE",
			"UPSTREAM-UNREADABLE",
			"UPSTREAM-UNRESOLVED",
		]);
		expect(r.text).toContain(second);
		expect(r.text).toContain("skills-lock.json");
	});

	it("passes, and asks only for the licence, when no edit is declared", () => {
		const root = build({ disk: { "a/SKILL.md": SKILL } });
		const log = path.join(root, "gh.log");
		const r = runUpstream(root, answering(SKILL, log));
		expect(r.code).toBe(0);
		expect(r.outcome).toBe("OK");
		expect(r.text).toContain("0 declared edit(s)");
		expect(readContentsEndpoints(log)).toEqual([]);
	});

	it("does not read a bare 404 in an error's text as a missing path", () => {
		const r = runUpstream(
			upstreamRoot("mattpocock/skills"),
			refusing("gh: rate limited after 404 attempts"),
		);
		expect(r.outcome).toBe("SKIP");
		expect(r.tags).not.toContain("UPSTREAM-GONE");
	});
});

const RECORD = ".agents/vendored-upstream-pass.json";
const SIDECAR = ".agents/vendored-skill-edits.json";
const LOCK = "skills-lock.json";
const NOTICES = ".claude/skills/THIRD-PARTY-NOTICES.md";

const readRecord = (root: string) =>
	JSON.parse(fs.readFileSync(path.join(root, RECORD), "utf8"));

describe("check-vendored-skills --upstream, the record", () => {
	it("writes the lock's and the notices' hashes, the date and each licence verdict on a completed run with every licence matching", () => {
		const root = upstreamRoot("mattpocock/skills");
		const r = runUpstream(root, answering(SKILL, path.join(root, "gh.log")), [
			"--write",
		]);
		expect(r.outcome).toBe("OK");
		const record = readRecord(root);
		expect(record.sha256).toEqual({
			[LOCK]: sha256(fs.readFileSync(path.join(root, LOCK), "utf8")),
			[NOTICES]: sha256(fs.readFileSync(path.join(root, NOTICES), "utf8")),
		});
		expect(record.ranOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(record.licences).toEqual({ "mattpocock/skills": "matches" });
	});

	it("still writes it beside an UPSTREAM-MOVED", () => {
		const root = upstreamRoot("mattpocock/skills");
		const r = runUpstream(
			root,
			answering(`${SKILL}upstream moved.\n`, path.join(root, "gh.log")),
			["--write"],
		);
		expect(r.tags).toEqual(["UPSTREAM-MOVED"]);
		expect(fs.existsSync(path.join(root, RECORD))).toBe(true);
	});

	it.each([
		[
			"UPSTREAM-LICENCE",
			(log: string) => answering(SKILL, log, "Apache License\n"),
		],
		[
			"a licence UPSTREAM-GONE",
			() => licenceFailing("gh: Not Found (HTTP 404)"),
		],
		[
			"a licence UPSTREAM-UNREADABLE",
			() => licenceFailing("gh: could not resolve host"),
		],
		["SKIP", () => refusing("gh: could not resolve host")],
		["BROKEN", () => GH_422],
	])("writes none on %s", (_, gh) => {
		const root = upstreamRoot("mattpocock/skills");
		runUpstream(root, gh(path.join(root, "gh.log")), ["--write"]);
		expect(fs.existsSync(path.join(root, RECORD))).toBe(false);
	});

	it("writes none without --write, and says one is due (#4449)", () => {
		const root = upstreamRoot("mattpocock/skills");
		const r = runInProcess(SCRIPT, ["--root", root, "--upstream"], {
			env: {
				...process.env,
				WFC_GH: stubGh(root, answering(SKILL, path.join(root, "gh.log"))),
			},
		});
		expect(fs.existsSync(path.join(root, RECORD))).toBe(false);
		expect(`${r.stdout}${r.stderr}`).toContain("run again with --write");
	});

	it("refuses --write in a cut-over main checkout before any fetch (#4449)", () => {
		const at = splitCheckout(
			path.join(upstreamRoot("mattpocock/skills"), "split"),
		);
		const log = path.join(at.main, "..", "gh.log");
		const r = runInProcess(
			SCRIPT,
			["--root", at.main, "--upstream", "--write"],
			{
				env: {
					...process.env,
					WFC_MODULES: "landing",
					WFC_GH: stubGh(at.main, answering(SKILL, log)),
				},
			},
		);
		expect(`${r.stdout}${r.stderr}`).toContain("is the main checkout");
		expect(fs.existsSync(log)).toBe(false);
		expect(fs.existsSync(path.join(at.main, RECORD))).toBe(false);
	});

	it("names the source whose licence kept the record from being written", () => {
		const root = upstreamRoot("mattpocock/skills");
		const r = runInProcess(SCRIPT, ["--root", root, "--upstream", "--write"], {
			env: {
				...process.env,
				WFC_GH: stubGh(
					root,
					answering(SKILL, path.join(root, "gh.log"), "Apache License\n"),
				),
			},
		});
		expect(`${r.stdout}${r.stderr}`).toContain(
			`No ${RECORD} written: the licence of mattpocock/skills was not read as matching`,
		);
	});
});

describe("the pre-commit upstream-record gate (#2394)", () => {
	const repoTemps = registerTempCleanup(afterEach);
	const lockBody = '{\n\t"version": 1,\n\t"skills": {}\n}\n';
	const noticesBody = "# Notices\n";
	const record = (lock: string, notices: string) =>
		`${JSON.stringify({ ranOn: "2026-10-22", sha256: { [LOCK]: sha256(lock), [NOTICES]: sha256(notices) }, licences: {} }, null, "\t")}\n`;
	const Upstream = `${ADOPTER} --upstream`;

	/** The limb, cut from the real hook, run over `root`'s index. */
	function runLimb(root: string, env: Record<string, string> = {}) {
		const r = spawnSync("sh", ["-e", "-c", cutGateScript("--covered")], {
			cwd: root,
			encoding: "utf8",
			env: { ...ENV, WFC_PLUGIN_ROOT: REPO, ...env },
		});
		return { status: r.status, out: `${r.stdout}${r.stderr}` };
	}

	/** A repo whose index holds the manifest, as one vendoring skills does. */
	const repo = (
		staged: Record<string, string>,
		committed: Record<string, string> = {},
	) =>
		stagedRepo(
			"upstream-record-",
			repoTemps,
			{ [SIDECAR]: "{}\n", ...committed },
			staged,
		);

	it("refuses a staged lock with no staged record, naming the command and the record to stage", () => {
		const r = runLimb(repo({ [LOCK]: lockBody, [NOTICES]: noticesBody }).root);
		expect(r.status).toBe(1);
		expect(r.out).toContain(Upstream);
		expect(r.out).toContain(`stage the ${RECORD}`);
	});

	it("passes a staged lock whose staged record matches it and the notices", () => {
		const r = runLimb(
			repo({
				[LOCK]: lockBody,
				[NOTICES]: noticesBody,
				[RECORD]: record(lockBody, noticesBody),
			}).root,
		);
		expect(r.status, r.out).toBe(0);
	});

	it.each([
		["the lock", record(`${lockBody} `, noticesBody), LOCK],
		["the notices", record(lockBody, "# Other notices\n"), NOTICES],
	])(
		"refuses a record written over a different %s, naming it",
		(_, body, named) => {
			const r = runLimb(
				repo({ [LOCK]: lockBody, [NOTICES]: noticesBody, [RECORD]: body }).root,
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain(`over a different ${named}`);
			expect(r.out).toContain(Upstream);
		},
	);

	it("refuses a record that will not parse, naming the command", () => {
		const r = runLimb(
			repo({ [LOCK]: lockBody, [NOTICES]: noticesBody, [RECORD]: "{" }).root,
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("will not parse");
		expect(r.out).toContain(Upstream);
	});

	it("prints the in-repo command where the plugin root is the cwd (#2515)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-in-repo-"));
		temps.push(dir);
		for (const [rel, body] of [
			[SIDECAR, "{}\n"],
			[LOCK, lockBody],
			[NOTICES, noticesBody],
		])
			fs.writeFileSync(path.join(dir, path.basename(rel)), body);
		const r = runInProcess(SCRIPT, ["--covered", dir], { cwd: REPO, env: ENV });
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain(`${IN_REPO} --upstream`);
	});

	it("reads the staged record, not the worktree's", () => {
		const { root } = repo({ [LOCK]: lockBody, [NOTICES]: noticesBody });
		fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
		fs.writeFileSync(path.join(root, RECORD), record(lockBody, noticesBody));
		const r = runLimb(root);
		expect(r.status).toBe(1);
		expect(r.out).toContain(`${RECORD} is not staged`);
		expect(r.out).toContain(Upstream);
	});

	it("does not arm on a commit staging a vendored skill or the manifest with the lock unchanged", () => {
		const r = runLimb(
			repo(
				{
					".agents/skills/a/SKILL.md": SKILL,
					".agents/vendored-skill-edits.json": "{}\n",
				},
				{ [LOCK]: lockBody },
			).root,
		);
		expect(r.status, r.out).toBe(0);
		expect(r.out).not.toContain("--upstream");
	});

	it("owes no record where the index holds no manifest, as --upstream could never write one", () => {
		const { root, git } = repo({ [LOCK]: lockBody, [NOTICES]: noticesBody });
		git("rm", "-q", "--cached", "--", SIDECAR);
		const r = runLimb(root);
		expect(r.status, r.out).toBe(0);
		expect(r.out).toContain("nothing vendored");
	});

	it("matches a record written over a CRLF worktree against the LF blobs staged from it", () => {
		const root = upstreamRoot("mattpocock/skills");
		const crlf = (rel: string) => {
			const file = path.join(root, rel);
			fs.writeFileSync(
				file,
				fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"),
			);
		};
		crlf(LOCK);
		crlf(NOTICES);
		runUpstream(root, answering(SKILL, path.join(root, "gh.log")), ["--write"]);
		const staged = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-staged-"));
		temps.push(staged);
		for (const rel of [LOCK, NOTICES, RECORD, SIDECAR])
			fs.writeFileSync(
				path.join(staged, path.basename(rel)),
				fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n"),
			);
		const r = runInProcess(SCRIPT, ["--covered", staged, "--json"], {
			env: ENV,
		});
		expect(JSON.parse(r.stdout).outcome).toBe("OK");
	});

	it("owes no record for a commit deleting the lock", () => {
		const { root, git } = repo({}, { [LOCK]: lockBody });
		git("rm", "-q", "--", LOCK);
		const r = runLimb(root);
		expect(r.status, r.out).toBe(0);
	});

	it("stands down for one commit on WFC_UPSTREAM_RECORD_OFF, saying to name it on the Weakens: line", () => {
		const r = runLimb(repo({ [LOCK]: lockBody, [NOTICES]: noticesBody }).root, {
			WFC_UPSTREAM_RECORD_OFF: "1",
		});
		expect(r.status, r.out).toBe(0);
		expect(r.out).toContain("Weakens: line");
	});
});

/*
 * `--revendor --at <rev> --from <clone>` (#4802): a re-pull's record, read out
 * of a clone of the upstream repo. The clone is a real repository, because the
 * command reads blobs at a revision and only git can hold a tag apart from a
 * working tree.
 */

/**
 * A repository standing in for a clone of `source`: `files` committed and
 * tagged `tag`, its `origin` naming the GitHub repo and never fetched.
 */
function upstreamClone(
	source: string,
	files: Record<string, string>,
	tag: string,
) {
	const clone = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-upstream-"));
	temps.push(clone);
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"tag.gpgsign=false",
				...args,
			],
			{ cwd: clone, encoding: "utf8" },
		).trim();
	const write = (tree: Record<string, string>) => {
		for (const [rel, body] of Object.entries(tree)) {
			const abs = path.join(clone, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, body);
		}
	};
	git("init", "-q");
	git("remote", "add", "origin", `https://github.com/${source}.git`);
	write(files);
	git("add", "-A");
	git("commit", "-q", "-m", "release");
	git("tag", tag);
	return { clone, git, write, sha: git("rev-parse", "HEAD") };
}

const readJson = (root: string, rel: string) =>
	JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

/**
 * A tree vendoring `a` from mattpocock/skills, with a declared edit, and `z`
 * from emilkowalski/skills.
 */
function twoSourceRoot() {
	const root = build({
		disk: { "a/SKILL.md": `${SKILL}Edited.\n`, "z/SKILL.md": "z body\n" },
		vendored: { "a/SKILL.md": SKILL, "z/SKILL.md": "z body\n" },
		edits: {
			".agents/skills/a/SKILL.md": {
				editedHash: sha256(`${SKILL}Edited.\n`),
				issue: 1,
				why: "declared",
			},
		},
		notices:
			"# Notices\n\n## mattpocock/skills\n\nSkills: a\n\nMIT License\n\n## emilkowalski/skills\n\nSkills: z\n\nMIT License\n",
	});
	const lock = readJson(root, "skills-lock.json");
	lock.skills.z.source = "emilkowalski/skills";
	fs.writeFileSync(
		path.join(root, "skills-lock.json"),
		JSON.stringify(lock, null, "\t"),
	);
	return root;
}

/** What upstream ships for `a` at the pulled tag: SKILL.md moved, a file added. */
const PULLED = {
	"skills/engineering/a/SKILL.md": `${SKILL}Upstream's new line.\n`,
	"skills/engineering/a/refs/NOTES.md": "notes\n",
};

describe("check-vendored-skills --revendor --from (#4802)", () => {
	/** Upstream at the pulled tag, for the cases that only read it. */
	let pulled: ReturnType<typeof upstreamClone>;
	beforeAll(() => {
		pulled = upstreamClone("mattpocock/skills", PULLED, "v9.9.9");
		temps.splice(temps.indexOf(pulled.clone), 1);
	});
	afterAll(() => fs.rmSync(pulled.clone, { recursive: true, force: true }));

	it("records the manifest, vendoredAt and the lock's computedHash from the clone's tag, and leaves another source's skill alone", () => {
		const root = twoSourceRoot();
		const before = {
			sidecar: readJson(root, SIDECAR),
			lock: readJson(root, "skills-lock.json"),
		};
		const up = pulled;

		const r = runText(root, [
			"--revendor",
			"--at",
			"v9.9.9",
			"--from",
			up.clone,
		]);

		expect(r.code).toBe(0);
		const sidecar = readJson(root, SIDECAR);
		expect(sidecar.vendoredAt).toBe(
			`mattpocock/skills@${up.sha.slice(0, 8)} (v9.9.9)`,
		);
		expect(sidecar.vendored).toEqual({
			".agents/skills/a/SKILL.md": sha256(
				PULLED["skills/engineering/a/SKILL.md"],
			),
			".agents/skills/a/refs/NOTES.md": sha256("notes\n"),
			".agents/skills/z/SKILL.md":
				before.sidecar.vendored[".agents/skills/z/SKILL.md"],
		});
		expect(sidecar.edits).toEqual(before.sidecar.edits);
		const lock = readJson(root, "skills-lock.json");
		expect(lock.skills.a.computedHash).toBe(
			folderHash(path.join(up.clone, "skills/engineering/a")),
		);
		expect(lock.skills.z).toEqual(before.lock.skills.z);
		expect(r.out).toContain("computedHash for a");
	});

	it("leaves a tree the check passes once upstream's bytes are on disk under the re-declared edit", () => {
		const root = twoSourceRoot();
		runText(root, ["--revendor", "--at", "v9.9.9", "--from", pulled.clone]);
		const dir = path.join(root, ".agents/skills/a");
		fs.mkdirSync(path.join(dir, "refs"));
		fs.writeFileSync(path.join(dir, "refs/NOTES.md"), "notes\n");

		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			PULLED["skills/engineering/a/SKILL.md"],
		);
		expect(run(root).tags).toEqual(["STALE-ENTRY"]);

		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`${PULLED["skills/engineering/a/SKILL.md"]}Edited.\n`,
		);
		runText(root, [
			"--declare",
			".agents/skills/a/SKILL.md",
			"--issue",
			"1",
			"--why",
			"declared",
		]);
		expect(run(root)).toMatchObject({ code: 0, tags: [] });
	});

	it("reads the tag's blobs, not the clone's later commits or its working tree", () => {
		const root = twoSourceRoot();
		const up = upstreamClone("mattpocock/skills", PULLED, "v9.9.9");
		up.write({ "skills/engineering/a/SKILL.md": "a later release\n" });
		up.git("commit", "-q", "-am", "later");
		up.write({ "skills/engineering/a/SKILL.md": "uncommitted\n" });

		runText(root, ["--revendor", "--at", "v9.9.9", "--from", up.clone]);

		expect(readJson(root, SIDECAR).vendored[".agents/skills/a/SKILL.md"]).toBe(
			sha256(PULLED["skills/engineering/a/SKILL.md"]),
		);
	});

	it.each([
		[
			"the clone's origin names a repo the lock sources nothing from",
			() => upstreamClone("someone/else", PULLED, "v9.9.9"),
			"sources no skill",
		],
		[
			"a skill's folder is absent at the tag",
			() =>
				upstreamClone(
					"mattpocock/skills",
					{ "skills/renamed/a/SKILL.md": SKILL },
					"v9.9.9",
				),
			"has no skills/engineering/a/ at v9.9.9",
		],
		[
			"the tag names no commit in the clone",
			() => pulled,
			"v0.0.0 names no commit",
		],
		[
			"the clone has no origin",
			() => {
				const up = upstreamClone("mattpocock/skills", PULLED, "v9.9.9");
				up.git("remote", "remove", "origin");
				return up;
			},
			"has no `origin` remote",
		],
		[
			"the clone's origin is not on GitHub",
			() => {
				const up = upstreamClone("mattpocock/skills", PULLED, "v9.9.9");
				up.git(
					"remote",
					"set-url",
					"origin",
					"https://example.invalid/a/b.git",
				);
				return up;
			},
			"is not a GitHub repo",
		],
	])("refuses and writes nothing where %s", (_name, clone, says) => {
		const rev = says.startsWith("v0.0.0") ? "v0.0.0" : "v9.9.9";
		const root = twoSourceRoot();
		const files = [SIDECAR, "skills-lock.json"].map((rel) =>
			path.join(root, rel),
		);
		const before = files.map((f) => fs.readFileSync(f, "utf8"));

		const r = runText(root, [
			"--revendor",
			"--at",
			rev,
			"--from",
			clone().clone,
		]);

		expect(r.code).toBe(2);
		expect(r.out).toContain(says);
		expect(files.map((f) => fs.readFileSync(f, "utf8"))).toEqual(before);
	});

	it("records no symlink upstream ships in a skill folder, as the walk over the folder on disk skips one", () => {
		const root = twoSourceRoot();
		const up = upstreamClone("mattpocock/skills", PULLED, "v9.9.8");
		fs.symlinkSync(
			"SKILL.md",
			path.join(up.clone, "skills/engineering/a/LINK.md"),
		);
		up.git("add", "-A");
		up.git("commit", "-q", "-m", "a link");
		up.git("tag", "v9.9.9");

		runText(root, ["--revendor", "--at", "v9.9.9", "--from", up.clone]);

		expect(
			Object.keys(readJson(root, SIDECAR).vendored).filter((r) =>
				r.includes("LINK"),
			),
		).toEqual([]);
		expect(readJson(root, "skills-lock.json").skills.a.computedHash).toBe(
			folderHash(path.join(up.clone, "skills/engineering/a")),
		);
	});

	it("refuses --from without --revendor as a usage error", () => {
		const r = runText(twoSourceRoot(), ["--from", "/nowhere"]);
		expect(r.code).toBe(2);
		expect(r.out).toContain("it needs --revendor");
	});

	it("names the --from route in the advice under an UPSTREAM-MOVED", () => {
		const root = upstreamRoot("mattpocock/skills");
		const gh = stubGh(
			root,
			answering(`${SKILL}upstream moved.\n`, path.join(root, "gh.log")),
		);
		const r = runInProcess(SCRIPT, ["--root", root, "--upstream"], {
			env: { ...process.env, WFC_GH: gh },
		});
		expect(`${r.stdout}${r.stderr}`).toContain(
			"--revendor --at <the pulled tag> --from <a clone of the upstream repo>",
		);
	});
});
