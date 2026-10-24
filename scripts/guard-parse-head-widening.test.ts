// @vitest-environment node
/*
 * The class test for lib/guard-parse.sh's `_gp_guarded_head` (mantahostels#2346, on the
 * near-miss mantahostels#1818, which carries the measurement): pins its head-word
 * list at exactly `git` and `gh`, and that quoted prose naming another head word
 * reaches no deny guard as a command.
 *
 * Loosen it and a widening lands unnoticed, and the `PreToolUse` Bash guards
 * in self-plugin/hooks/hooks.json start refusing ordinary commands whose quoted
 * argument — a commit message, an issue body — has a line beginning with the
 * new word.
 *
 * That function decides when the multi-line join abandons, and every guard
 * sourcing the library sees the segmentation it produces. Widening it looks
 * conservative and is the opposite: a head word that an ordinary PROSE line can
 * begin makes the join abandon mid-string, exposing the REST of a quoted
 * argument as commands — which the deny guards then judge and refuse.
 *
 * TWO LAYERS. "the word list is exactly git and gh" reads the case statement off
 * the parser and fails on ANY widening, guessed or not. The fixture matrix below
 * it demonstrates what a widening refuses.
 *
 * READING THE PARSER'S SOURCE IS ALSO WHAT PUTS THIS FILE IN
 * docs/test-read-edges.json. Nothing else here names a tracked path — the
 * guards are spawned, not imported — so without that literal `npm run
 * test:changed` would select this test neither by import graph nor by manifest
 * edge (mantahostels#2095).
 *
 * WHAT THE MATRIX CANNOT COVER: `git` and `gh`, the two words in the list. A
 * line a deny guard refuses always BEGINS with one of them, so such a line
 * trips the abandon itself — the accepted price of the current list, not a bug
 * a fixture could assert away. Every bait line is therefore an `npm`/`npx` one,
 * which no word in the list reaches. That also means `guard-npm-install.sh` is
 * the only guard the bait can provoke: the other fourteen are driven, and a
 * guard added tomorrow is driven too, but none of them is BAITED on its own
 * refusal surface.
 *
 * NOTHING HERE REACHES THE NETWORK: `npm` and `curl` are stubs on a prepended
 * PATH, and at WFC_NPM and WFC_CURL for guard-npm-install.sh (base §N7, #2422),
 * each recording every call, so a fixture exposing its bait to
 * guard-npm-install.sh's registry checks fails on the record.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO_ROOT, "scripts");
const PARSER = path.join(REPO_ROOT, "scripts/lib/guard-parse.sh");

/**
 * Every guard that sources the shared parser AND denies through it, by
 * `gp_deny` — the one deny route the parser's head walk governs.
 *
 * WALKED OFF THE WORKING TREE, not the tracked set, so a neighbour's
 * half-written `guard-*.sh` joins the set and its own breakage reads as this
 * file's (`rule:suite-tree-dirty`). Accepted: the tracked-set alternative would
 * miss a guard added in this very commit, which is exactly when the pin below
 * matters most.
 */
const GUARDS = fs
	.readdirSync(SCRIPTS)
	.filter((f) => /^guard-.*\.sh$/.test(f))
	.filter((f) => {
		const text = fs.readFileSync(path.join(SCRIPTS, f), "utf8");
		return /guard-parse\.sh/.test(text) && /\bgp_deny\b/.test(text);
	})
	.sort();

/*
 * Head words a session might reach for. mantahostels#1818's actual widening, then the three
 * guard-wide-read.sh ruled out, then the write-shaped and interpreter names a
 * guard for a third command would arrive with. ILLUSTRATIVE, NOT THE GATE — the
 * pin on the word list is what catches a word nobody listed here.
 */
const CANDIDATE_HEADS = [
	"cp",
	"mv",
	"sed",
	"perl",
	"truncate",
	"cat",
	"grep",
	"awk",
	"rm",
	"tee",
	"chmod",
	"dd",
	"node",
	"npm",
];

/**
 * A benign call on this repo's prescribed issue-body writer, carrying quoted
 * prose: one line naming `word`, and two naming commands a deny guard refuses
 * once it reads them as commands rather than as text.
 */
const proseFixture = (word: string) =>
	`node scripts/issue-body.js comment 1 "Line one is prose.
${word} docs/a docs/b was the write.
npm install left-pad was refused.
npx left-pad was refused too."`;

let dir: string;
let shared: string;
let stubbin: string;
let stubCalls: string;

/*
 * Stubs, not mocks: a guard is a separate process, so the only way to hold it
 * off the registry is to own what its PATH and WFC_NPM/WFC_CURL resolve. Both
 * exit non-zero, which is the shape guard-npm-install.sh reads as "registry
 * unreachable". Each also sits on PATH, failing every call, because every
 * guard is driven here, a guard added tomorrow included: one calling a bare
 * `curl` or `npm` must fail on the record rather than reach the network. That
 * PATH decoy is the base §N7 departure #2547 ruled for.
 */
const writeStubs = () => {
	fs.mkdirSync(stubbin, { recursive: true });
	for (const tool of ["npm", "curl"]) {
		const file = path.join(stubbin, tool);
		fs.writeFileSync(
			file,
			`#!/usr/bin/env bash\necho "${tool} $*" >> "$STUB_CALLS"\nexit 1\n`,
		);
		fs.chmodSync(file, 0o755);
	}
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "head-widening-"));
	shared = path.join(dir, "shared");
	stubbin = path.join(dir, "bin");
	stubCalls = path.join(dir, "calls");
	fs.mkdirSync(shared, { recursive: true });
	fs.writeFileSync(stubCalls, "");
	writeStubs();
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: shared });
	fs.writeFileSync(
		path.join(shared, "package.json"),
		JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {} }),
	);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/*
 * CLAUDE_CONFIG_DIR is redirected so the fail-opens these guards may record go
 * to the case's temp directory rather than the developer's live log (mantahostels#1452,
 * gated by check-guard-test-isolation.js).
 */
const guardEnv = () => ({
	...process.env,
	PATH: `${stubbin}${path.delimiter}${process.env.PATH ?? ""}`,
	WFC_NPM: path.join(stubbin, "npm"),
	WFC_CURL: path.join(stubbin, "curl"),
	STUB_CALLS: stubCalls,
	CLAUDE_PROJECT_DIR: shared,
	CLAUDE_CONFIG_DIR: dir,
});

const run = (guard: string, command: string) =>
	spawnSync(path.join(SCRIPTS, guard), [], {
		cwd: shared,
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "head-widening",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: guardEnv(),
		timeout: 20_000,
	});

/** Which of the deny-capable guards emit a verdict on this command. */
const refusers = (command: string) =>
	GUARDS.filter((guard) => {
		const r = run(guard, command);
		if (r.status === null) throw new Error(`${guard} did not run: ${r.error}`);
		return /"permissionDecision"/.test(r.stdout ?? "");
	});

/** What the stubs were asked for while the case ran. */
const stubbedCalls = () =>
	fs.readFileSync(stubCalls, "utf8").split("\n").filter(Boolean);

describe("the word list itself", () => {
	/*
	 * THE GATE. The rulings it enforces are in lib/guard-parse.sh above the
	 * function and in guard-wide-read.sh:47-52 — read either before changing the
	 * expectation here.
	 */
	it("is exactly git and gh, and a widening is what this file exists to stop", () => {
		const source = fs.readFileSync(PARSER, "utf8");
		const list = source.match(
			/_gp_guarded_head\(\)\s*\{\s*\n\s*case\s+"\$\{1##\*\/}"\s+in\s+([^)]+)\)/,
		);
		if (!list)
			throw new Error(`no _gp_guarded_head case statement in ${PARSER}`);

		expect(list[1].split("|").map((w) => w.trim())).toEqual(["git", "gh"]);
	});
});

describe("the guard set under test", () => {
	/*
	 * A discovery that silently found nothing would make every case below pass
	 * over an empty list.
	 */
	it("is discovered off disk and is not empty", () => {
		expect(GUARDS.length).toBeGreaterThan(5);
		expect(GUARDS).toContain("guard-npm-install.sh");
	});

	it("really does refuse, naming npx and calling no stubbed tool, driven the way the cases below drive it", () => {
		// The armed control: same spawn, same env, a command that IS a bare npx —
		// check 3 of guard-npm-install.sh, refused on the name alone.
		const r = run("guard-npm-install.sh", "npx left-pad");

		expect(r.status).toBe(0);
		expect(r.stdout).toContain('"permissionDecision":"deny"');
		expect(r.stdout).toContain("npx");
		expect(stubbedCalls()).toEqual([]);
	});
});

describe("the network decoys", () => {
	it("fail a bare curl on the record, as they do a bare npm", () => {
		for (const tool of ["curl", "npm"]) {
			const r = spawnSync(
				"bash",
				["-c", `${tool} https://registry.npmjs.org/`],
				{
					cwd: shared,
					encoding: "utf8",
					env: guardEnv(),
				},
			);
			expect(r.status).toBe(1);
		}
		expect(stubbedCalls()).toEqual([
			"curl https://registry.npmjs.org/",
			"npm https://registry.npmjs.org/",
		]);
	});
});

describe("a head word named in quoted prose", () => {
	it("does not turn mantahostels#1818's reproducer into a refusal", () => {
		expect(
			refusers(`node scripts/issue-body.js comment 1 "Line one is prose.
cp docs/a docs/b was the write.
npm install left-pad was refused."`),
		).toEqual([]);
		expect(stubbedCalls()).toEqual([]);
	});

	it.each(CANDIDATE_HEADS)(
		"leaves every deny-capable guard silent when the prose names %s",
		(word) => {
			expect(refusers(proseFixture(word))).toEqual([]);
			expect(stubbedCalls()).toEqual([]);
		},
	);
});
