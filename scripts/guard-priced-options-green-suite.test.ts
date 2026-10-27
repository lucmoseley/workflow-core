// @vitest-environment node
/*
 * The eighth refusal (mantahostels#1253) as the Stop hook applies it: a
 * background job's `result:` is blocked once where the session verdict
 * (`lib/session-verdict.js`, whose own tests pin what is owed) says its own
 * work is owed, and allowed, logged, where the verdict cannot be reached.
 * Driven through the CLI because the commit comes from the session id in the
 * hook payload; a throwaway git repo and a real commit ledger supply it.
 *
 * The guard runs at every `Stop` (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a case and a job reports done on a commit no
 * suite ever ran; widen it and a job that owes nothing is blocked.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import { readStopGuardBlock, type StopBlock } from "./lib/stop-guard-testkit";
import { researchCalls } from "./lib/transcript-testkit";

const req = createRequire(__filename);
/* The block counters (`*-nagged-<sid>`) live under gr_markers_dir
 * (.claude/tmp/markers), not the throwaway root itself — hook-block.js's
 * counterPath (mantahostels#3515 F8, issue #2). */
const { markersDir } = req("./lib/marker-root.js");

const GUARD = path.join(__dirname, "guard-priced-options.js");
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const store: any = req("./lib/arbiter-store.js");

let dir: string;
let home: string;
let sid: string;

/** A message the message-shape limbs all pass, so only this one can fire. */
const DONE = "Landed the fix and committed it.\n\nresult: the fix is in.";

const NO_SUCH_SHA = "0".repeat(40);

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "green-suite-")));
	home = path.join(dir, "home", ".claude");
	fs.mkdirSync(home, { recursive: true });
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	git("commit", "-q", "--allow-empty", "-m", "root");
	/* The published tip the composed attestation diffs from (#814). */
	git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `body` with the environment the guard's own libraries derive their paths
 * from, so a test never re-implements the arbiter's private path encoding.
 */
function inSandbox<T>(body: () => T): T {
	const saved = { ...process.env };
	process.env.CLAUDE_CONFIG_DIR = home;
	process.env.CLAUDE_PROJECT_DIR = dir;
	try {
		return body();
	} finally {
		process.env = saved;
	}
}

/** `session`'s commit ledger file, as `.husky/post-commit` writes it (#766). */
const ledgerFile = (session: string): string =>
	inSandbox(() => store.paths.commitLedger(session, dir));

/** A commit of `file`, entered in `session`'s commit ledger. */
function commitFile(file: string, session = sid): string {
	fs.writeFileSync(path.join(dir, file), `${file}\n${Math.random()}\n`);
	git("add", "--", file);
	git("commit", "-q", "-m", `add ${file}`);
	const sha = git("rev-parse", "HEAD");
	const ledger = ledgerFile(session);
	fs.mkdirSync(path.dirname(ledger), { recursive: true });
	fs.appendFileSync(ledger, `${sha}\n`);
	return sha;
}

function writeMarkerStore(lines: string[]) {
	fs.writeFileSync(
		path.join(markersDir(dir), ".test-pass-markers.jsonl"),
		lines.map((l) => `${l}\n`).join(""),
	);
}

/** The whole suite: nothing filtered, every module run. */
const FULL_SCOPE = {
	modulesRun: 40,
	modulesTotal: 40,
	tests: 200,
	skipped: 0,
	nameFilter: null,
	fileFilters: [] as string[],
	changed: false as string | boolean,
};

/** A full vitest certificate on `sha`. */
const certificate = (sha: string) =>
	JSON.stringify({
		sha,
		at: new Date().toISOString(),
		suite: "vitest",
		scope: FULL_SCOPE,
	});

/** The session's own commit, and a store attesting some OTHER commit. */
function committedUnattested(file = "a.txt"): string {
	const sha = commitFile(file);
	writeMarkerStore([certificate(NO_SUCH_SHA)]);
	return sha;
}

function runGuard(
	text: string,
	{ job = true, env = {} }: { job?: boolean; env?: NodeJS.ProcessEnv } = {},
): StopBlock | null {
	const file = path.join(dir, `${sid}.jsonl`);
	fs.writeFileSync(
		file,
		`${[
			{ type: "user", message: { content: "go" } },
			/* so the under-researched-round limb (#1710) passes a round */
			...researchCalls(),
			{ type: "assistant", message: { content: [{ type: "text", text }] } },
		]
			.map((r) => JSON.stringify(r))
			.join("\n")}\n`,
	);
	return readStopGuardBlock(GUARD, {
		dir,
		sid,
		transcript: file,
		job: job ? dir : false,
		config: home,
		env,
	});
}

/** A question round whose options carry no Confidence line, plus a `result:`. */
const DEFECTIVE_ROUND = [
	"❓ **Q1** - **Which**: pick one.",
	"",
	"(A) the first",
	"(B) the second",
	"",
	"result: nothing further waits on you.",
].join("\n");

/** Everything the guard wrote to the arbiter's fail-open log. */
const failOpenLog = () => readFailOpenLog(home, dir);

describe("a background job's result: on work the session verdict says is owed (mantahostels#1253)", () => {
	it("blocks, naming the sha and the command that clears it", () => {
		const sha = committedUnattested();

		const out = runGuard(DONE);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain(sha.slice(0, 12));
		/* The command on its own line, not the `npm run test` substring the prose
		 * elsewhere in the message would satisfy on its own. */
		expect(out?.reason).toContain("\n\nnpm run test\n\n");
		expect(out?.reason).toContain(".test-pass-markers.jsonl");
	});

	it("allows it where the landing module is on, the lander being the full gate (#2933)", () => {
		committedUnattested();

		expect(
			runGuard(DONE, { env: { WFC_MODULES: "suites,landing" } }),
		).toBeNull();
		expect(failOpenLog()).toBe("");
	});

	it("allows it once a marker names that commit", () => {
		writeMarkerStore([certificate(commitFile("a.txt"))]);

		expect(runGuard(DONE)).toBeNull();
	});

	it("never blocks on a neighbour's unattested commit under the session's attested one", () => {
		commitFile("theirs.txt", "a-neighbour");
		writeMarkerStore([
			JSON.stringify({
				...JSON.parse(certificate(commitFile("mine.txt"))),
				scope: { ...FULL_SCOPE, modulesRun: 3, changed: "x", admissible: true },
				changedPaths: ["mine.txt"],
			}),
		]);

		expect(runGuard(DONE)).toBeNull();
	});

	it("never blocks an interactive session", () => {
		committedUnattested();

		expect(runGuard(DONE, { job: false })).toBeNull();
	});

	it("never blocks a turn carrying no result: marker", () => {
		committedUnattested();

		/* `needs input:` rather than `waiting:`, which since mantahostels#2487 is refused by a
		 * sibling limb unless the transcript shows a launch still out; and a round
		 * above it, which mantahostels#2583 obliges of any `needs input:` in a
		 * background job. */
		expect(
			runGuard(
				"Committed the fix.\n\n❓ **Q1** — which CLI?\n\n" +
					"Relation: rivals for one slot.\n\n" +
					"(A) shellcheck\nConfidence: 80% (75% - 85%). It is already wired.\n\n" +
					"(B) nothing\nConfidence: 20% (15% - 25%). Leaves the gap open.\n\n" +
					"needs input: which CLI to add.",
			),
		).toBeNull();
	});
});

describe("a session that owes nothing, or cannot be judged, is allowed", () => {
	it("allows, reporting no fault, a job that committed nothing", () => {
		/* The fail-open log tells a clean allow from a fault the guard
		 * swallowed, which the stop alone cannot. */
		fs.writeFileSync(path.join(dir, "a.txt"), "uncommitted\n");
		writeMarkerStore([certificate(NO_SUCH_SHA)]);

		expect(runGuard(DONE)).toBeNull();
		expect(failOpenLog()).toBe("");
	});

	it("never blocks a job whose ledger names no commit HEAD contains", () => {
		git("switch", "-q", "-c", "spike/elsewhere");
		committedUnattested();
		git("switch", "-q", "main");

		expect(runGuard(DONE)).toBeNull();
		expect(failOpenLog()).toBe("");
	});

	it("allows the stop, and logs it, when the commit ledger cannot be read", () => {
		/* A directory where the ledger file belongs: the read raises EISDIR,
		 * which readCommitsBy reports as unavailable rather than as "made none". */
		committedUnattested();
		const ledger = ledgerFile(sid);
		fs.rmSync(ledger);
		fs.mkdirSync(ledger);

		expect(runGuard(DONE)).toBeNull();
		expect(failOpenLog()).toContain("commit ledger unreadable");
	});

	it("allows the stop, and logs it, when the marker store is missing", () => {
		commitFile("a.txt");

		expect(runGuard(DONE)).toBeNull();
		expect(failOpenLog()).toContain("certificate store missing");
	});

	it("allows the stop, and logs it, where the attestation cannot be judged", () => {
		git("update-ref", "-d", "refs/remotes/origin/main");
		committedUnattested();

		expect(runGuard(DONE)).toBeNull();
		expect(failOpenLog()).toContain("could not judge attestation");
	});
});

describe("the block is spent once, from its own counter", () => {
	it("blocks the first stop and allows the second", () => {
		committedUnattested();

		expect(runGuard(DONE)?.decision).toBe("block");
		expect(runGuard(DONE)).toBeNull();
	});

	it("spends no part of the priced-options allowance", () => {
		committedUnattested();

		expect(runGuard(DONE)?.decision).toBe("block");
		expect(
			fs.existsSync(path.join(markersDir(dir), `.green-suite-nagged-${sid}`)),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.priced-options-nagged-${sid}`),
			),
		).toBe(false);
	});

	it("lets a defective question round block first, and holds its own back", () => {
		committedUnattested();

		const out = runGuard(DEFECTIVE_ROUND);
		expect(out?.reason).toContain("Confidence line");
		expect(out?.reason).not.toContain("npm run test");
		expect(
			fs.existsSync(path.join(markersDir(dir), `.green-suite-nagged-${sid}`)),
		).toBe(false);
	});

	/* mantahostels#2786 put every shape and filing limb under one 5-block session ceiling.
	 * The evidence limb is outside it, and only this harness — a real repo, a
	 * commit ledger and a marker store — can prove that. */
	it("still fires once the whole session ceiling is spent (mantahostels#2786)", () => {
		const sha = committedUnattested();

		/* Five distinct defects, so no single limb caps out and only the ceiling
		 * ends the run — the sixth stop is refused by the shape limbs and must
		 * still reach the evidence one. */
		const ceilingTurns = [
			"❓ **Q1** - **Which**: pick one.\n\n(A) the first\n(B) the second\n\nneeds input: which.",
			"Both commits are in. Nothing else ran.",
			"Landed it.\n\nresult:",
			"needs input: whether to widen the guard.",
			"result: assessed.\n\nSay the word and I'll wire it in.",
		];
		for (const text of ceilingTurns) expect(runGuard(text)).not.toBeNull();

		const out = runGuard(DONE);
		expect(out?.reason).toContain("npm run test");
		expect(out?.reason).toContain(sha.slice(0, 7));
	});

	it("still fires once the priced-options allowance is spent", () => {
		committedUnattested();

		/* DEFECTIVE_ROUND carries a `result:` marker on a question round, which
		 * also trips missingNeedsInput (mantahostels#2544) — a second, independent counter.
		 * Swap in `needs input:` so only the format defect fires, leaving that
		 * second counter untouched, which the assertion below pins directly. */
		const formatOnly = DEFECTIVE_ROUND.replace(
			"result: nothing further waits on you.",
			"needs input: which.",
		);

		/* Three is hook-block.js's default cap; the fourth stop on formatOnly
		 * emits nothing for the format defect, and — formatOnly carrying no
		 * other defect — the turn is allowed outright. DONE checks separately
		 * that the still-unspent evidence limb fires on its own counter. */
		for (let i = 0; i < 3; i++)
			expect(runGuard(formatOnly)?.reason).toContain("Confidence line");
		expect(runGuard(formatOnly)).toBeNull();
		expect(
			fs.existsSync(
				path.join(markersDir(dir), `.missing-needs-input-nagged-${sid}`),
			),
		).toBe(false);
		expect(runGuard(DONE)?.reason).toContain("npm run test");
	});
});

/*
 * The refusal's order, as the hook prints it: the verdict's parts with this
 * gate's two exemptions set between them.
 */
describe("the refusal puts the exemptions where they qualify the commands", () => {
	let reason: string;
	beforeEach(() => {
		committedUnattested();
		const block = runGuard(DONE);
		expect(block).not.toBeNull();
		reason = block?.reason ?? "";
	});

	it("offers both escapes, and says how to spend the second stop", () => {
		/* Both limbs, so deleting either fails here rather than silently
		 * narrowing the escape (mantahostels#1842). */
		expect(reason).toContain("environment.md §6");
		expect(reason).toContain("never edited and did not break");
		expect(reason).toContain("a job nothing waits on is finished");
		/* The marker lands on the NEXT stop, this one having been spent. */
		expect(reason).toContain("stop again");
	});

	it("names the reap ahead of the escape it qualifies (mantahostels#1843)", () => {
		/* Ordering, not presence: a rewrite restoring the unqualified escape as
		 * the first sentence, keeping the reap named anywhere later, would pass a
		 * presence needle. */
		expect(reason.indexOf("scripts/pretest-reap.js")).toBeGreaterThan(-1);
		expect(reason.indexOf("scripts/pretest-reap.js")).toBeLessThan(
			reason.indexOf("environment.md §6"),
		);
		/* The escape is qualified where it is stated, not somewhere upstream. */
		expect(reason).toMatch(/environment.md §6[^.]*AFTER that reap/);
	});

	/* mantahostels#2194. */
	it("puts both escapes ahead of the first command it prescribes", () => {
		const firstCommand = reason.indexOf("\n\nnpm run ");
		/* Each needle is asserted present before it is ordered: `indexOf`
		 * answers -1 for an absent one, and -1 passes `toBeLessThan`. */
		for (const limb of [
			"environment.md §6",
			"never edited and did not break",
		]) {
			expect(reason.indexOf(limb)).toBeGreaterThan(-1);
			expect(reason.indexOf(limb)).toBeLessThan(firstCommand);
		}
		expect(firstCommand).toBeGreaterThan(-1);
	});

	it("names the cheap run by command and the full run in prose where the reap clause first refers to each", () => {
		/* mantahostels#2206: each must appear ABOVE the first prescribed command, not merely
		 * somewhere in the message. mantahostels#2672 took the full run's LITERAL command out
		 * of the reap clause, so it is named there in prose instead. */
		const firstCommand = reason.indexOf("\n\nnpm run ");
		expect(firstCommand).toBeGreaterThan(-1);
		for (const named of [
			"SO `npm run test` AND `npm run test:changed` BOTH PAY IT",
			"the run reaps",
		]) {
			expect(reason.indexOf(named)).toBeGreaterThan(-1);
			expect(reason.indexOf(named)).toBeLessThan(firstCommand);
		}
	});

	it("prescribes the narrowed default first and the full run once, below it", () => {
		/* mantahostels#3210: `npm run test` is named in prose higher up as the run that was
		 * not found, so only the commands on their own lines are read. */
		const prescribed = [...reason.matchAll(/\n\nnpm run ([^\n]*)\n\n/g)].map(
			(m) => m[1],
		);
		expect(prescribed).toEqual(["test", "test -- --full=push-gate"]);
		expect([
			...reason.matchAll(/npm run test -- --full=push-gate/g),
		]).toHaveLength(1);
		expect(reason).toMatch(
			/run the whole suite:\n\nnpm run test -- --full=push-gate\n\n/,
		);
	});

	it("marks the branch back to the commands after the exemptions", () => {
		/* mantahostels#2206: the connective sits between the exemption's own stop instruction
		 * and the first command, not anywhere in the message. */
		const connective = reason.indexOf(
			"Otherwise, run the narrowed default first:",
		);
		expect(connective).toBeGreaterThan(-1);
		const stopInstruction = reason.indexOf("`result:` and stop again.");
		expect(stopInstruction).toBeGreaterThan(-1);
		expect(stopInstruction).toBeLessThan(connective);
		expect(connective).toBeLessThan(reason.indexOf("\n\nnpm run "));
	});
});
