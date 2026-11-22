// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROGRAM } from "./lib/doc-map-gate-program.js";
import { dispatch } from "./lib/precommit-dispatch.js";
import {
	cutGateScript,
	expectFixtureSupplies,
	newRepo,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { buildRepoPorts, HOOK, ROOT } from "./lib/precommit-gate-testkit";
import { GATES, type PrecommitGate } from "./lib/precommit-gates.js";

const VERSION_ANCHOR = "scripts/check-digest-version.js";
const SUPERSEDED_ANCHOR = "--broken-only";
const DOC_MAP_ROW = GATES.find((g) => g.id === "doc-map") as PrecommitGate;

const ROADMAP = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";
const MAP = "docs/doc-map.md";
const NEEDLES = "docs/doc-map-superseded.json";

const STUB_MARKER = "STUB-CHECKER-RAN";
const ESCAPE = "WFC_ALLOW_GATE_INPUT_DELETE";
const DOLLAR = "$";

const temps = registerTempCleanup();

function write(root: string, rel: string, body: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
}

function fixture(opts: {
	checkers: string[];
	committed: Record<string, string>;
	staged?: Record<string, string>;
	deleted?: string[];
}): TempRepo {
	const stubs = Object.fromEntries(
		opts.checkers.map((c) => [
			c,
			`console.log("${STUB_MARKER}");\nprocess.exit(1);\n`,
		]),
	);
	const repo = stagedRepo(
		"gate-input-deletion-",
		temps,
		{ ...stubs, ...opts.committed },
		opts.staged ?? {},
	);
	for (const rel of opts.deleted ?? [])
		repo.git("rm", "-q", "--cached", "--", rel);
	return repo;
}

function conflicted(): TempRepo {
	const { root, git } = newRepo("gate-input-deletion-merge-", temps);
	for (const c of VERSION_CHECKERS)
		write(root, c, `console.log("${STUB_MARKER}");\nprocess.exit(1);\n`);
	write(root, ROADMAP, "html\n");
	write(root, DIGEST, "base\n");
	git("add", "--", ".");
	git("commit", "-qm", "seed");
	git("checkout", "-q", "-b", "other");
	write(root, DIGEST, "theirs\n");
	git("commit", "-qm", "theirs", "--", DIGEST);
	git("checkout", "-q", "-");
	write(root, DIGEST, "ours\n");
	git("commit", "-qm", "ours", "--", DIGEST);
	try {
		git("merge", "--no-edit", "other");
		throw new Error("the fixture's merge was expected to conflict");
	} catch (e) {
		if ((e as Error).message.includes("expected to conflict")) throw e;
	}
	return { root, git };
}

function runGate(
	cwd: string,
	fragment: string,
	env: Record<string, string> = {},
): { code: number; output: string } {
	try {
		const out = execFileSync("sh", ["-ec", `{\n${fragment}\n:\n} 2>&1\n`], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});
		return { code: 0, output: out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

const versionGate = () => cutGateScript(VERSION_ANCHOR);
const supersededGate = () => cutGateScript(SUPERSEDED_ANCHOR);
async function runDocMapRow(
	cwd: string,
	env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
	let output = "";
	const code = await dispatch({
		rows: [DOC_MAP_ROW],
		gates: "batch",
		ports: buildRepoPorts(cwd, {
			load: () => () => PROGRAM({ cwd, env: { ...process.env, ...env } }),
			write: (_fd: number, text: string) => {
				output += text;
			},
		}),
	});
	return { code, output };
}

const PAIR = { [ROADMAP]: "html\n", [DIGEST]: "digest\n" };
const VERSION_CHECKERS = ["scripts/check-digest-version.js"];
const SUPERSEDED_CHECKERS = ["scripts/check-superseded-values.js"];
const DOC_MAP_CHECKERS = [
	"scripts/check-doc-map.js",
	"scripts/checker-new-faults.js",
];

describe("a staged deletion of a gate's required input", () => {
	it("supplies exactly the scripts each gate under test invokes", () => {
		expectFixtureSupplies(VERSION_ANCHOR, VERSION_CHECKERS);
		expectFixtureSupplies(SUPERSEDED_ANCHOR, SUPERSEDED_CHECKERS);
	});

	it("refuses the commit as a deletion, before the checker runs", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
		expect(output).not.toContain(STUB_MARKER);
	});

	it("names the deleted file and the way through", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		const { output } = runGate(root, versionGate());
		expect(output).toContain(DIGEST);
		expect(output).toContain("git checkout HEAD --");
		expect(output).toContain(`${ESCAPE}=1`);
	});

	it("refuses on a second staged_gate caller too, before the checker runs", () => {
		const { root } = fixture({
			checkers: SUPERSEDED_CHECKERS,
			committed: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
			deleted: [MAP],
		});

		const { code, output } = runGate(root, supersededGate());
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
		expect(output).not.toContain(STUB_MARKER);
	});

	it("carries the gate's label in the refusal", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		expect(runGate(root, versionGate()).output).toContain(
			"the digest-version check reads",
		);
	});

	it("refuses when the file is renamed rather than deleted, naming it as deleted, before its checker runs", () => {
		const { root, git } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
		});
		git("mv", DIGEST, "docs/roadmap-digest-renamed.md");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("DELETES");
		expect(output).toContain(DIGEST);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("refuses when the roadmap is renamed, out of docs/ included, naming the roadmap as deleted", () => {
		const { root, git } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
		});
		git("mv", ROADMAP, "elsewhere.html");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("DELETES");
		expect(output).toContain(ROADMAP);
	});

	it("does not arm on an ordinary rename of an ungated file", () => {
		const { root, git } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { ...PAIR, "docs/notes.md": "notes\n" },
		});
		git("mv", "docs/notes.md", "docs/notes-renamed.md");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).not.toContain("DELETES");
		expect(output).not.toContain(STUB_MARKER);
	});

	it("names renaming as a cause when a gated path is moved", () => {
		const { root, git } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			staged: { [DIGEST]: "digest edited\n" },
		});
		git("mv", ROADMAP, "docs/reference-roadmap-renamed.html");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("Renaming it?");
		expect(output).toContain(ROADMAP);
	});

	it("names only the deleted path, not one that was never in the index", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { [ROADMAP]: "html\n", [DIGEST]: "digest\n" },
			deleted: [DIGEST, ROADMAP],
		});

		const { output } = runGate(root, versionGate());
		expect(output).toContain(DIGEST);
		expect(output).toContain(ROADMAP);
	});
});

describe("the escape", () => {
	it("lets the deletion through when it is set", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		const { code, output } = runGate(root, versionGate(), { [ESCAPE]: "1" });
		expect(code).toBe(0);
		expect(output).toContain(`${ESCAPE} is set`);
		expect(output).toContain(`to delete ${DIGEST}.`);
		expect(output).toContain("skipped the digest-version check");
		expect(output).not.toContain(STUB_MARKER);
	});

	it("takes any non-empty value", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		expect(runGate(root, versionGate(), { [ESCAPE]: "yes" }).code).toBe(0);
	});

	it("does not stand the gate down when it is empty", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		});

		expect(runGate(root, versionGate(), { [ESCAPE]: "" }).code).toBe(1);
	});
});

describe("a commit retiring the roadmap module", () => {
	const config = ".claude/workflow-core.json";
	const on = '{ "modules": ["roadmap"] }\n';
	const off = '{ "modules": [] }\n';

	it("stands the digest-version gate down, saying so, when the staged config drops the module", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { ...PAIR, [config]: on },
			staged: { [config]: off },
			deleted: [ROADMAP, DIGEST],
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).toContain(
			"drops the roadmap module from .claude/workflow-core.json — the digest-version check stands down",
		);
		expect(output).not.toContain("DELETES");
		expect(output).not.toContain(STUB_MARKER);
	});

	it("stands the digest-render gate down too", () => {
		const { root } = fixture({
			checkers: ["scripts/check-digest-render.js"],
			committed: { ...PAIR, [config]: on },
			staged: { [config]: off },
			deleted: [ROADMAP, DIGEST],
		});

		const { code, output } = runGate(
			root,
			cutGateScript("scripts/check-digest-render.js"),
		);
		expect(code).toBe(0);
		expect(output).toContain("the digest-render check stands down");
		expect(output).not.toContain("DELETES");
	});

	it("still refuses where the staged config keeps the module", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { ...PAIR, [config]: on },
			staged: { [config]: '{ "modules": ["roadmap", "landing"] }\n' },
			deleted: [ROADMAP, DIGEST],
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("DELETES");
	});

	it("still refuses where HEAD's config never listed the module", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { ...PAIR, [config]: off },
			staged: { [config]: '{ "modules": [], "x": 1 }\n' },
			deleted: [ROADMAP, DIGEST],
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain("DELETES");
	});
});

describe("apparatus genuinely missing is unchanged", () => {
	it("skips and passes when the path was never in the index", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { [ROADMAP]: "html\n" },
			staged: { [ROADMAP]: "html edited\n" },
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the digest-version check");
		expect(output).toContain(DIGEST);
		expect(output).not.toContain("DELETES");
	});

	it("still runs the checker when an opt: path is deleted", () => {
		const { root } = fixture({
			checkers: SUPERSEDED_CHECKERS,
			committed: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
			staged: { [MAP]: "map edited\n" },
			deleted: [NEEDLES],
		});

		const { code, output } = runGate(root, supersededGate());
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("DELETES");
	});

	it("skips and passes on an unmerged path mid-conflict", () => {
		const { root } = conflicted();

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the digest-version check");
		expect(output).not.toContain("DELETES");
	});

	it("skips and passes on the first commit of a fresh repo", () => {
		const { root, git } = newRepo("gate-input-deletion-fresh-", temps);
		for (const c of VERSION_CHECKERS)
			write(root, c, `console.log("${STUB_MARKER}");\nprocess.exit(1);\n`);
		write(root, ROADMAP, "html\n");
		git("add", "--", ".");

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(0);
		expect(output).toContain("skipped the digest-version check");
		expect(output).not.toContain("DELETES");
	});

	it("runs the checker normally when nothing is deleted", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			staged: { [DIGEST]: "digest edited\n" },
		});

		const { code, output } = runGate(root, versionGate());
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("DELETES");
	});
});

describe("mutations of the library are caught by the cases above", () => {
	const mutate = (find: string | RegExp, replace: string): string => {
		const original = versionGate();
		const mutant = original.replace(find, replace);
		expect(mutant, `mutation '${find}' did not apply`).not.toBe(original);
		return mutant;
	};

	const deletedFixture = () =>
		fixture({
			checkers: VERSION_CHECKERS,
			committed: PAIR,
			deleted: [DIGEST],
		}).root;

	it("stops refusing when the exit is dropped", () => {
		const mutant = mutate(
			'gate_refuse_deleted "$1"\n    exit 1\n',
			'gate_refuse_deleted "$1"\n',
		);
		expect(runGate(deletedFixture(), mutant).code).toBe(0);
	});

	it("stops refusing when GATE_DELETED is never populated", () => {
		const mutant = mutate(
			'GATE_DELETED="$GATE_DELETED, $gate_p"',
			'GATE_DELETED="$GATE_DELETED"',
		);
		expect(runGate(deletedFixture(), mutant).code).toBe(0);
	});

	it("refuses a never-present path as deleted when the deletion test is unconditional", () => {
		const { root } = fixture({
			checkers: VERSION_CHECKERS,
			committed: { [ROADMAP]: "html\n" },
			staged: { [ROADMAP]: "html edited\n" },
		});

		const mutant = mutate('[ -n "$gate_del" ]', "true");
		const { code, output } = runGate(root, mutant);
		expect(code).toBe(1);
		expect(output).toContain("DELETES");
	});

	it("stops honouring the escape when its test is inverted", () => {
		const escapeTest = (flag: string) => `[ ${flag} "${DOLLAR}{${ESCAPE}:-}" ]`;
		const mutant = mutate(escapeTest("-z"), escapeTest("-n"));
		expect(runGate(deletedFixture(), mutant, { [ESCAPE]: "1" }).code).toBe(1);
	});
});

function badBlobMap(): TempRepo {
	const { root, git } = newRepo("gate-input-deletion-map-badblob-", temps);
	for (const c of DOC_MAP_CHECKERS)
		write(root, c, `console.log("${STUB_MARKER}");\nprocess.exit(1);\n`);
	write(root, MAP, "map\n");
	git("add", "--", ".");
	git("commit", "-qm", "seed");
	git(
		"update-index",
		"--add",
		"--cacheinfo",
		"100644,1111111111111111111111111111111111111111,docs/doc-map.md",
	);
	return { root, git };
}

function conflictedMap(): TempRepo {
	const { root, git } = newRepo("gate-input-deletion-map-merge-", temps);
	for (const c of DOC_MAP_CHECKERS)
		write(root, c, `console.log("${STUB_MARKER}");\nprocess.exit(1);\n`);
	write(root, MAP, "base\n");
	git("add", "--", ".");
	git("commit", "-qm", "seed");
	git("checkout", "-q", "-b", "other");
	write(root, MAP, "theirs\n");
	git("commit", "-qm", "theirs", "--", MAP);
	git("checkout", "-q", "-");
	write(root, MAP, "ours\n");
	git("commit", "-qm", "ours", "--", MAP);
	try {
		git("merge", "--no-edit", "other");
		throw new Error("the fixture's merge was expected to conflict");
	} catch (e) {
		if ((e as Error).message.includes("expected to conflict")) throw e;
	}
	return { root, git };
}

describe("the doc-map gate, which spells itself out", () => {
	it("supplies exactly the scripts the gate under test invokes", () => {
		const ports = fs.readFileSync(
			path.join(ROOT, "scripts/lib/doc-map-gate-ports.js"),
			"utf8",
		);
		const invoked = [
			...new Set([...ports.matchAll(/"([\w-]+\.js)"/g)].map((m) => m[1])),
		]
			.map((n) => `scripts/${n}`)
			.sort();
		expect(invoked).toEqual([...DOC_MAP_CHECKERS].sort());
	});

	it("refuses the commit as a deletion, before the checker runs", async () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			deleted: [MAP],
		});

		const { code, output } = await runDocMapRow(root);
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
		expect(output).not.toContain(STUB_MARKER);
	});

	it("refuses when the map is renamed out of docs/, naming it as deleted, before the checker runs", async () => {
		const { root, git } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
		});
		git("mv", MAP, "elsewhere.md");

		const { code, output } = await runDocMapRow(root);
		expect(code).toBe(1);
		expect(output).toContain("this commit DELETES it");
		expect(output).toContain(MAP);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("names the deleted file and the way through", async () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			deleted: [MAP],
		});

		const { output } = await runDocMapRow(root);
		expect(output).toContain(MAP);
		expect(output).toContain("git checkout HEAD --");
		expect(output).toContain(`${ESCAPE}=1`);
		expect(output).toContain("the doc-map check reads");
	});

	it("lets the deletion through when the escape is set", async () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			deleted: [MAP],
		});

		const { code, output } = await runDocMapRow(root, { [ESCAPE]: "1" });
		expect(code).toBe(0);
		expect(output).toContain(`${ESCAPE} is set`);
		expect(output).toContain("skipped the doc-map check");
		expect(output).not.toContain(STUB_MARKER);
	});

	it("skips and passes when the map was never in the index", async () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { "docs/other.md": "x\n" },
			staged: { "docs/other.md": "x edited\n" },
		});

		const { code, output } = await runDocMapRow(root);
		expect(code).toBe(0);
		expect(output).toContain("skipped the doc-map check");
		expect(output).not.toContain("DELETES");
	});

	it("skips and passes when checkout-index fails on a missing blob", async () => {
		const { root } = badBlobMap();

		const { code, output } = await runDocMapRow(root);
		expect(code).toBe(0);
		expect(output).toContain("skipped the doc-map check");
		expect(output).not.toContain("DELETES");
	});

	it("skips and passes on an unmerged map mid-conflict", async () => {
		const { root } = conflictedMap();

		const { code, output } = await runDocMapRow(root);
		expect(code).toBe(0);
		expect(output).toContain("skipped the doc-map check");
		expect(output).not.toContain("DELETES");
	});

	it("runs the checker normally when nothing is deleted", async () => {
		const { root } = fixture({
			checkers: DOC_MAP_CHECKERS,
			committed: { [MAP]: "map\n" },
			staged: { [MAP]: "map edited\n" },
		});

		const { output } = await runDocMapRow(root);
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("DELETES");
	});
});

describe("a rename of a gated document", () => {
	it("refuses when the superseded gate's map is renamed, naming the map and the check that reads it, before the checker runs", () => {
		const { root, git } = fixture({
			checkers: SUPERSEDED_CHECKERS,
			committed: { [MAP]: "map\n", [NEEDLES]: "{}\n" },
		});
		git("mv", MAP, "elsewhere.md");

		const { code, output } = runGate(root, supersededGate());
		expect(code).toBe(1);
		expect(output).toContain("the superseded-needle check reads");
		expect(output).toContain(MAP);
		expect(output).not.toContain(STUB_MARKER);
	});

	const IndexRead =
		/\bgit (?:-\S+ )*(?:diff(?:-index)?\b[^\n]*--(?:cached|staged)|ls-files)\b/;
	const rawReads = (text: string) =>
		text
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#") && IndexRead.test(l));

	it("holds no raw read of the index in .husky/pre-commit (#1504)", () => {
		expect(rawReads(HOOK)).toEqual([]);
	});

	it.each([
		"git diff --cached --name-only",
		"git diff --staged --name-only",
		"git diff-index --cached --name-only HEAD",
		"git ls-files",
	])("reports a raw `%s` put back into the hook", (read) => {
		const gate = "if armed '^skills-lock\\.json$'; then";
		expect(HOOK).toContain(gate);
		const mutant = HOOK.replace(
			gate,
			`if ${read} | grep -q '^skills-lock\\.json$'; then`,
		);
		expect(rawReads(mutant)).toHaveLength(1);
	});
});
