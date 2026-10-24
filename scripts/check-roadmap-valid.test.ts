// @vitest-environment node
/*
 * Pins that check-roadmap-valid.js FAILs a structurally invalid roadmap — in
 * the index against HEAD by default, in the working tree under --tree — and
 * only warns on a validator WARNING (mantahostels#698, mantahostels#697,
 * mantahostels#974).
 *
 * check-roadmap-valid.js reads the git index in its default mode and the working
 * tree under --tree, so it runs inside a throwaway repository rather than
 * against this one — staging or writing files here would fight the working tree
 * the suite is running in.
 *
 * Every assertion is on the process's exit code and its output, never on the
 * checker's internals.
 *
 * It is a hard gate in .husky/pre-commit and a roadmap-digest.yml step: loosen
 * a case and a duplicate id, missing prerequisite or undrawable card state
 * reaches `main`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AHEAD_MIN,
	EARLIER_DAY_MIN,
	witaStamp,
} from "../.claude/skills/roadmap-edit/scripts/roadmap-fixture";

const SCRIPT = path.resolve(__dirname, "check-roadmap-valid.js");
const HTML = "docs/reference-roadmap.html";

let repo: string;

const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });
const git = (...args: string[]) => gitIn(repo, ...args);

/* A fresh repository with no commit in it yet. */
const newRepo = (tag: string) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), tag));
	gitIn(dir, "init", "-q", ".");
	gitIn(dir, "config", "user.email", "test@example.com");
	gitIn(dir, "config", "user.name", "test");
	return dir;
};

const { EXPECTED_MAJOR } = createRequire(import.meta.url)(
	"../.claude/skills/roadmap-edit/scripts/validate.js",
);
/* The core's own major, so a repin of EXPECTED_MAJOR moves every fixture. */
const v = (minor: number) => `${EXPECTED_MAJOR}.${minor}`;

type Card = Record<string, unknown>;

/* Carries every field in the validator's KNOWN_ITEM_FIELDS pin, so a fixture is
 * clean by default: a card missing one raises a SCHEMA DRIFT warning, which
 * would make the "no findings" cases unreachable. */
const card = (over: Card = {}): Card => ({
	id: "seed",
	p: 0,
	a: ["core"],
	kind: "action",
	state: "open",
	t: "A card",
	m: "max",
	b: "body",
	dw: "done when tested",
	log: "logged",
	c: { type: "info", k: "short label", x: "callout" },
	needs: [],
	span: 1,
	focus: "yes",
	why: "a direction under consideration, plus what it unlocks.",
	// 31 words, one over mn's 30-word ceiling. capOk needs a genuinely
	// over-ceiling field to exercise without itself going STALE.
	mn: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix twentyseven twentyeight twentynine thirty thirtyone",
	// Present so capOk isn't itself a SCHEMA DRIFT "known field unused" case.
	capOk: { mn: 1 },
	...over,
});

const roadmap = (version: string, items: Card[], at = witaStamp()) =>
	`<!doctype html>\n<span class="docmeta">v${version} · updated ${at}</span>\n` +
	`<script>\nconst AREAS = { core: "Core", ops: "Ops" };\n` +
	`const ITEMS = [\n${items.map((i) => JSON.stringify(i)).join(",\n")}\n];\n</script>\n`;

const stageIn = (cwd: string, file: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
	fs.writeFileSync(path.join(cwd, file), body);
	gitIn(cwd, "add", file);
};
const stage = (file: string, body: string) => stageIn(repo, file, body);

const run = (
	args: string[],
	cwd = repo,
	env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: cwd },
) => {
	const r = spawnSync("node", [SCRIPT, ...args], {
		cwd,
		encoding: "utf8",
		env,
	});
	return {
		status: r.status ?? -1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
};
const check = (cwd = repo) => run([], cwd);
const tree = (
	cwd = repo,
	env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: cwd },
) => run(["--tree"], cwd, env);

/* Writes the working tree WITHOUT staging, which is what tree mode judges. */
const put = (file: string, body: string, cwd = repo) => {
	fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
	fs.writeFileSync(path.join(cwd, file), body);
};

/* The phase-boundary checks run only where the host keeps a ladder (#748). */
const CONFIG = ".claude/workflow-core.json";
const keepsLadder = (extra: Record<string, unknown> = {}) =>
	put(CONFIG, JSON.stringify({ capacityLadder: true, ...extra }));

beforeEach(() => {
	repo = newRepo("roadmap-valid-test-");
	stage(HTML, roadmap(v(1), [card()]));
	git("commit", "-qm", "init");
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("check-roadmap-valid", () => {
	it("FAILs a card-level error, carrying the validator's own message", () => {
		stage(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('"seed" has bad state "nope"');
		expect(r.stderr).toContain("FAIL");
	});

	it("FAILs a card whose prerequisite does not exist, naming the missing id", () => {
		stage(HTML, roadmap(v(2), [card({ needs: ["ghost"] })]));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('needs missing id "ghost"');
	});

	it("WARNs without gating on a warnings-only roadmap, naming its version-unchanged finding", () => {
		stage(HTML, roadmap(v(1), [card({ t: "A retitled card" })]));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN");
		expect(r.stderr).toContain("version unchanged");
	});

	it("WARNs on a staged roadmap stamped on an earlier day", () => {
		stage(HTML, roadmap(v(2), [card()], witaStamp(EARLIER_DAY_MIN)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("STAMP MISDATED");
	});

	it("passes a legitimate card addition, reporting the added id", () => {
		stage(
			HTML,
			roadmap(v(2), [card(), card({ id: "fresh", mn: "note", capOk: {} })]),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("cards added:");
		expect(r.stderr).toContain("fresh");
		expect(r.stderr).toContain("OK:");
	});

	it("reports a removed card without gating", () => {
		stage(HTML, roadmap(v(2), [card({ id: "replacement" })]));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("cards removed:");
		expect(r.stderr).toContain("seed");
	});

	/* The phase-boundary warning (mantahostels#1130). A validate-pN card flipping to done is
	 * the roadmap's only machine-readable phase boundary, and a boundary
	 * re-opens the agent-spend ladder. It is advisory: crossing one is the
	 * commit doing right, so it must never gate. */
	const withGate = (state: string, version: string) =>
		roadmap(version, [card(), card({ id: "validate-p0", state })]);

	it("WARNs, without gating, when a phase-validation card flips to done, naming the card and pointing at the capacity-procurement ladder", () => {
		keepsLadder();
		stage(HTML, withGate("active", v(2)));
		git("commit", "-qm", "gate");
		stage(HTML, withGate("done", v(3)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN");
		expect(r.stderr).toContain("validate-p0 is newly done");
		// The one instruction the warning exists to deliver.
		expect(r.stderr).toContain("docs/capacity-procurement-ladder.md");
		expect(r.stderr).toContain("1 phase boundary crossed");
	});

	it("names every boundary a single commit crosses", () => {
		keepsLadder();
		const gates = (state: string, version: string) =>
			roadmap(version, [
				card(),
				card({ id: "validate-p0", state }),
				card({ id: "validate-p1", state }),
			]);
		stage(HTML, gates("active", v(2)));
		git("commit", "-qm", "gates");
		stage(HTML, gates("done", v(3)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("validate-p0 is newly done");
		expect(r.stderr).toContain("validate-p1 is newly done");
		expect(r.stderr).toContain("2 phase boundaries crossed");
	});

	it("stays OK when the phase-validation card was already done", () => {
		keepsLadder();
		stage(HTML, withGate("done", v(2)));
		git("commit", "-qm", "gate");
		stage(HTML, withGate("done", v(3)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).not.toContain("newly done");
	});

	it("stays OK when a gate card is added already done", () => {
		keepsLadder();
		stage(HTML, roadmap(v(2), [card()]));
		git("commit", "-qm", "no gate yet");
		stage(
			HTML,
			roadmap(v(3), [card(), card({ id: "validate-p9", state: "done" })]),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("cards added:");
		expect(r.stderr).not.toContain("newly done");
	});

	it("stays OK when an ordinary card goes done", () => {
		stage(HTML, roadmap(v(2), [card({ id: "ordinary", state: "active" })]));
		git("commit", "-qm", "ordinary");
		stage(HTML, roadmap(v(3), [card({ id: "ordinary", state: "done" })]));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).not.toContain("newly done");
	});

	/* Fails open, and must say so: a baseline that stops parsing would otherwise
	 * kill the boundary check silently and for good. */
	it("prints a SKIPPED line when the baseline is not a roadmap", () => {
		keepsLadder();
		stage(HTML, "<!doctype html>not a roadmap at all");
		git("commit", "-qm", "junk");
		stage(HTML, withGate("done", v(3)));
		const r = check();
		expect(r.stderr).toContain("phase-boundary check SKIPPED");
		expect(r.stderr).not.toContain("newly done");
	});

	it("validates the very first commit of a repo, which has no HEAD at all", () => {
		/* The bootstrap's own commit (#5): no HEAD to read is the same
		 * no-baseline judgement as a HEAD holding no roadmap yet, not an
		 * apparatus fault. */
		const bare = newRepo("roadmap-valid-nobase-");
		stageIn(bare, HTML, roadmap(v(1), [card()]));
		const r = check(bare);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("first roadmap commit");
		expect(r.stderr).not.toContain("BROKEN");
		fs.rmSync(bare, { recursive: true, force: true });
	});

	it("is still BROKEN where HEAD exists and cannot be read", () => {
		/* The repo HAS commits, so this is no first commit: a symbolic HEAD
		 * naming a deleted branch is an apparatus fault and stays one (#5). */
		const broken = newRepo("roadmap-valid-badhead-");
		stageIn(broken, "README.md", "x\n");
		spawnSync("git", ["commit", "-qm", "init"], { cwd: broken });
		spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/gone"], {
			cwd: broken,
		});
		stageIn(broken, HTML, roadmap(v(1), [card()]));
		const r = check(broken);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN");
		fs.rmSync(broken, { recursive: true, force: true });
	});

	it("validates a first roadmap commit, where HEAD exists but holds no roadmap", () => {
		const fresh = newRepo("roadmap-valid-first-");
		stageIn(fresh, "README.md", "x\n");
		spawnSync("git", ["commit", "-qm", "init"], { cwd: fresh });
		stageIn(fresh, HTML, roadmap(v(1), [card()]));
		const r = check(fresh);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("first roadmap commit");
		expect(r.stderr).not.toContain("SKIPPED");
		fs.rmSync(fresh, { recursive: true, force: true });
	});

	it("still FAILs a card-level error in a first roadmap commit, naming the missing id", () => {
		const fresh = newRepo("roadmap-valid-first-bad-");
		stageIn(fresh, "README.md", "x\n");
		spawnSync("git", ["commit", "-qm", "init"], { cwd: fresh });
		stageIn(fresh, HTML, roadmap(v(1), [card({ needs: ["ghost"] })]));
		const r = check(fresh);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('needs missing id "ghost"');
		fs.rmSync(fresh, { recursive: true, force: true });
	});

	it("is BROKEN when the git index cannot be read", () => {
		const notARepo = fs.mkdtempSync(
			path.join(os.tmpdir(), "roadmap-valid-norepo-"),
		);
		const r = check(notARepo);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("cannot read the git index");
		fs.rmSync(notARepo, { recursive: true, force: true });
	});

	it("is BROKEN when the staged roadmap cannot be parsed as one", () => {
		stage(HTML, "<html>not a roadmap at all</html>\n");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not be parsed");
	});

	/* A rename out of the index is the deletion it is, never a SKIP: git
	 * reports it as R, so a bare --name-only listed the new name alone and the
	 * roadmap's move landed unvalidated (#1483). */
	it("is BROKEN, not SKIPPED, when the roadmap is renamed away (#1483)", () => {
		git("mv", "--", HTML, "docs/roadmap-old.html");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.stderr).not.toContain("SKIP");
	});

	/* SKIP raises no finding and gates nothing. It still prints the family's one
	 * summary line, which check.js owns (mantahostels#155, the ticket that settled the checker
	 * family's exit-code and severity alphabet). */
	it("SKIPs a commit that does not stage the roadmap", () => {
		stage("docs/other.md", "unrelated\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP");
		expect(r.stderr).not.toContain("FAIL");
		expect(r.stderr).not.toContain("WARN");
	});

	/* mantahostels#179 (the pre-commit gate reading staged paths only) and mantahostels#298, the pair
	 * that ruled index mode must never judge a neighbour's half-saved tree. */
	it("judges the staged blob, not the working tree", () => {
		stage(HTML, roadmap(v(2), [card()]));
		fs.writeFileSync(
			path.join(repo, HTML),
			"<html>half-saved garbage</html>\n",
		);
		expect(check().status).toBe(0);
	});

	it("is not fooled by an unstaged roadmap change", () => {
		fs.writeFileSync(
			path.join(repo, HTML),
			roadmap(v(2), [card({ state: "nope" })]),
		);
		stage("docs/other.md", "unrelated\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP");
	});

	it("annotates its findings for Actions, on stdout", () => {
		stage(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = spawnSync("node", [SCRIPT], {
			cwd: repo,
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_ACTIONS: "true",
				CLAUDE_PROJECT_DIR: repo,
			},
		});
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("::error::");
		expect(r.stdout).toContain('bad state "nope"');
	});
});

/*
 * --tree (mantahostels#974).
 *
 * Every case below leaves a VALID roadmap staged and committed and puts the
 * interesting one in the tree alone.
 */
describe("check-roadmap-valid --tree", () => {
	it("FAILs a card-level error present only in the working tree, naming the card and its bad state and offering the roadmap-edit skill", () => {
		put(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = tree();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('"seed" has bad state "nope"');
		expect(r.stderr).toContain("FAIL");
		expect(r.stderr).toContain("roadmap-edit skill");
	});

	/* The mode runs under workflow_dispatch on any ref and locally over a dirty
	 * tree, so it cannot name the branch it is judging. */
	it("does not claim to be judging any particular ref", () => {
		put(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = tree();
		expect(r.stderr).toContain("in this checkout");
		expect(r.stderr).not.toContain("on main");
	});

	/* Index mode SKIPs this exact tree, so a break that arrived by a --no-verify
	 * commit is invisible to it and caught here. An auto-resolving merge was a
	 * second such route until mantahostels#1679 put .husky/pre-merge-commit behind it. */
	it("catches a break index mode SKIPs, nothing being staged", () => {
		put(HTML, roadmap(v(2), [card({ needs: ["ghost"] })]));
		expect(check().status).toBe(0);
		expect(check().stderr).toContain("SKIP");
		expect(tree().status).toBe(1);
		expect(tree().stderr).toContain('needs missing id "ghost"');
	});

	it("judges the tree, not the staged blob", () => {
		stage(HTML, roadmap(v(2), [card()]));
		put(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = tree();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('"seed" has bad state "nope"');
	});

	it("WARNs without gating on a warnings-only roadmap, naming its VERSION TRIPWIRE finding", () => {
		put(HTML, roadmap("9.9", [card()]));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN");
		expect(r.stderr).toContain("VERSION TRIPWIRE");
	});

	/* No parent, so no card list. "version unchanged" is the other baseline-only
	 * finding, and it must not fire either: the tree is at HEAD's version. */
	it("computes no added/removed list and no version-unchanged warning", () => {
		put(HTML, roadmap(v(1), [card(), card({ id: "fresh" })]));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("cards added");
		expect(r.stderr).not.toContain("cards removed");
		expect(r.stderr).not.toContain("version unchanged");
		expect(r.stderr).toContain("OK:");
	});

	it("needs no HEAD, so it runs in a repo with no commit in it", () => {
		const bare = newRepo("roadmap-valid-tree-nobase-");
		put(HTML, roadmap(v(1), [card()]), bare);
		const r = tree(bare);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		fs.rmSync(bare, { recursive: true, force: true });
	});

	it("passes a roadmap last stamped on an earlier day", () => {
		put(HTML, roadmap(v(1), [card()], witaStamp(EARLIER_DAY_MIN)));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("STAMP");
		expect(r.stderr).toContain("OK:");
	});

	it("still FAILs a stamp in the future", () => {
		put(HTML, roadmap(v(1), [card()], witaStamp(AHEAD_MIN)));
		const r = tree();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("STAMP IN THE FUTURE");
		expect(r.stderr).toContain("TZ=Asia/Makassar");
	});

	it("never SKIPs", () => {
		put("docs/other.md", "unrelated\n");
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("SKIP");
	});

	it("is BROKEN when the roadmap is missing from the tree", () => {
		fs.rmSync(path.join(repo, HTML));
		const r = tree();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain("cannot read");
	});

	it("is BROKEN when the roadmap cannot be parsed as one", () => {
		put(HTML, "<html>not a roadmap at all</html>\n");
		const r = tree();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain("could not be parsed");
	});

	it("annotates its findings for Actions, on stdout", () => {
		put(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = tree(repo, { ...process.env, GITHUB_ACTIONS: "true" });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("::error::");
		expect(r.stdout).toContain('bad state "nope"');
	});
});

/*
 * The durable half of the phase-boundary check (mantahostels#1377). Tree mode compares the
 * gate cards reading `done` against the ladder's Re-assessment log, which is
 * what records a boundary having been answered.
 */
describe("check-roadmap-valid --tree · unrecorded phase boundaries", () => {
	const ladderPath = "docs/capacity-procurement-ladder.md";

	const ladder = (log: string) =>
		"# Agent capacity and spend ladder\n\n" +
		"## Re-assessment — when to re-open the ladder itself\n\nPreamble.\n\n" +
		"### Re-assessment log\n\n" +
		"<!-- one line each: date · the validate-pN card id or other trigger -->\n\n" +
		`${log}\n`;

	const gate = (state: string, id = "validate-p0") =>
		roadmap(v(1), [card(), card({ id, state })]);

	beforeEach(() => keepsLadder());

	it("WARNs, without gating, on a done gate card the log does not name", () => {
		put(ladderPath, ladder("None yet."));
		put(HTML, gate("done"));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN");
		expect(r.stderr).toContain("validate-p0");
		expect(r.stderr).toContain("does not name it");
		expect(r.stderr).toContain(ladderPath);
		expect(r.stderr).toContain("1 unrecorded phase boundary");
	});

	it("catches a flip index mode SKIPs", () => {
		put(ladderPath, ladder("None yet."));
		put(HTML, gate("done"));
		expect(check().stderr).toContain("SKIP");
		expect(tree().stderr).toContain("validate-p0");
	});

	it("stops reporting once the log names the card", () => {
		put(
			ladderPath,
			ladder("- 2026-09-01 · validate-p0 · bill $400 · no change."),
		);
		put(HTML, gate("done"));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).not.toContain("validate-p0");
	});

	it("says nothing while no gate card reads done", () => {
		put(ladderPath, ladder("None yet."));
		put(HTML, gate("active"));
		const r = tree();
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).not.toContain("phase boundary");
	});

	it("reports only the boundary the log leaves out", () => {
		put(ladderPath, ladder("- 2026-09-01 · validate-p0 · nothing moved."));
		put(
			HTML,
			roadmap(v(1), [
				card(),
				card({ id: "validate-p0", state: "done" }),
				card({ id: "validate-p1", state: "done" }),
			]),
		);
		const r = tree();
		expect(r.stderr).toContain("validate-p1 reads done");
		expect(r.stderr).not.toContain("validate-p0 reads done");
		expect(r.stderr).toContain("1 unrecorded phase boundary");
	});

	/* A substring match would read validate-p10 as recording validate-p1. */
	it("does not let a longer card id record a shorter one", () => {
		put(ladderPath, ladder("- 2026-09-01 · validate-p10 · nothing moved."));
		put(HTML, gate("done", "validate-p1"));
		expect(tree().stderr).toContain("validate-p1 reads done");
	});

	it("counts an empty log as recording nothing", () => {
		put(ladderPath, ladder(""));
		put(HTML, gate("done"));
		expect(tree().stderr).toContain("validate-p0 reads done");
	});

	/* The heading's own comment sits inside the section it introduces. */
	it("does not let the log section's own comment record a card", () => {
		put(
			ladderPath,
			"# Ladder\n\n### Re-assessment log\n\n" +
				"<!-- one line each, e.g. 2026-09-01 · validate-p0 · nothing moved -->\n\nNone yet.\n",
		);
		put(HTML, gate("done"));
		expect(tree().stderr).toContain("validate-p0 reads done");
	});

	/* The log is a section, not the rest of the file: a later section naming a
	 * gate card records nothing. */
	it("reads only the log section, not what follows it", () => {
		put(
			ladderPath,
			"# Ladder\n\n### Re-assessment log\n\nNone yet.\n\n" +
				"## Appendix\n\n- validate-p0 is the Phase 0 gate.\n",
		);
		put(HTML, gate("done"));
		expect(tree().stderr).toContain("validate-p0 reads done");
	});

	it("reports the boundary, and why, when the ladder is missing", () => {
		put(HTML, gate("done"));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("could not be read");
		expect(r.stderr).toContain("validate-p0 reads done");
	});

	it("reports the boundary, and why, when the log heading has moved", () => {
		put(ladderPath, "# Ladder\n\n## Re-assessment\n\nNo log section at all.\n");
		put(HTML, gate("done"));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("no “### Re-assessment log” heading");
		expect(r.stderr).toContain("validate-p0 reads done");
	});

	/* The scheduled Document guards job is the only venue this finding has, and
	 * it stays green — so the Actions annotation is what reports it (mantahostels#1377). */
	it("annotates the unrecorded boundary for Actions, on stdout", () => {
		put(ladderPath, ladder("None yet."));
		put(HTML, gate("done"));
		const r = tree(repo, { ...process.env, GITHUB_ACTIONS: "true" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("::warning::");
		expect(r.stdout).toContain("validate-p0 reads done");
		expect(r.stdout).not.toContain("::error::");
	});

	it("names two unrecorded boundaries in the plural", () => {
		put(ladderPath, ladder("None yet."));
		put(
			HTML,
			roadmap(v(1), [
				card(),
				card({ id: "validate-p0", state: "done" }),
				card({ id: "validate-p1", state: "done" }),
			]),
		);
		expect(tree().stderr).toContain("2 unrecorded phase boundaries");
	});

	it("still FAILs on a structural error alongside an unrecorded boundary, reporting both", () => {
		put(ladderPath, ladder("None yet."));
		put(
			HTML,
			roadmap(v(1), [
				card({ state: "nope" }),
				card({ id: "validate-p0", state: "done" }),
			]),
		);
		const r = tree();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("validate-p0 reads done");
		expect(r.stderr).toContain("roadmap error(s)");
	});
});

/* The host config decides whether there is a ladder and where it sits (#401). */
describe("check-roadmap-valid · the ladder the host config declares", () => {
	const movedPath = "docs/machinery/capacity-procurement-ladder.md";
	const defaultPath = "docs/capacity-procurement-ladder.md";
	const withGate = (state: string, version: string) =>
		roadmap(version, [card(), card({ id: "validate-p0", state })]);
	const log = (line: string) =>
		`# Ladder\n\n### Re-assessment log\n\n${line}\n`;

	it("--tree names a skip, and no finding, where capacityLadder is false", () => {
		put(CONFIG, JSON.stringify({ capacityLadder: false }));
		put(HTML, withGate("done", v(1)));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"phase-boundary log check SKIPPED for validate-p0",
		);
		expect(r.stderr).toContain('does not declare "capacityLadder": true');
		expect(r.stderr).not.toContain("could not be read");
		expect(r.stderr).not.toContain("reads done and");
		expect(r.stderr).toContain("OK:");
	});

	it("index mode names a skip, and no warning, where capacityLadder is false", () => {
		put(CONFIG, JSON.stringify({ capacityLadder: false }));
		stage(HTML, withGate("active", v(2)));
		git("commit", "-qm", "gate");
		stage(HTML, withGate("done", v(3)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"phase-boundary warning SKIPPED for validate-p0",
		);
		expect(r.stderr).not.toContain("newly done");
		expect(r.stderr).not.toContain("phase boundary crossed");
	});

	it("--tree names a skip, and no finding, where capacityLadder is undeclared", () => {
		put(CONFIG, JSON.stringify({ founder: "F" }));
		put(HTML, withGate("done", v(1)));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"phase-boundary log check SKIPPED for validate-p0",
		);
		expect(r.stderr).toContain('does not declare "capacityLadder": true');
		expect(r.stderr).not.toContain("could not be read");
		expect(r.stderr).toContain("OK:");
	});

	it("index mode names a skip, and no warning, where capacityLadder is undeclared", () => {
		put(CONFIG, JSON.stringify({ founder: "F" }));
		stage(HTML, withGate("active", v(2)));
		git("commit", "-qm", "gate");
		stage(HTML, withGate("done", v(3)));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"phase-boundary warning SKIPPED for validate-p0",
		);
		expect(r.stderr).not.toContain("newly done");
	});

	it("names a skip where there is no host config at all", () => {
		put(HTML, withGate("done", v(1)));
		const r = tree();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"phase-boundary log check SKIPPED for validate-p0",
		);
		expect(r.stderr).not.toContain("could not be read");
		expect(r.stderr).toContain("OK:");
	});

	it("--tree reads the log at capacityLadderPath", () => {
		keepsLadder({ capacityLadderPath: movedPath });
		put(movedPath, log("- 2026-09-01 · validate-p0 · nothing moved."));
		put(HTML, withGate("done", v(1)));
		const r = tree();
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).not.toContain("validate-p0");
	});

	it("--tree names capacityLadderPath when its log leaves the card out", () => {
		keepsLadder({ capacityLadderPath: movedPath });
		put(movedPath, log("None yet."));
		put(defaultPath, log("- 2026-09-01 · validate-p0 · nothing moved."));
		put(HTML, withGate("done", v(1)));
		const r = tree();
		expect(r.stderr).toContain(`validate-p0 reads done and ${movedPath}'s`);
	});

	it("index mode points at capacityLadderPath", () => {
		keepsLadder({ capacityLadderPath: movedPath });
		stage(HTML, withGate("active", v(2)));
		git("commit", "-qm", "gate");
		stage(HTML, withGate("done", v(3)));
		const r = check();
		expect(r.stderr).toContain(`Read ${movedPath} §Re-assessment`);
	});

	it("warns on a capacityLadderPath that leaves the repo, reading the default", () => {
		keepsLadder({ capacityLadderPath: "../ladder.md" });
		put(defaultPath, log("- 2026-09-01 · validate-p0 · nothing moved."));
		put(HTML, withGate("done", v(1)));
		const r = tree();
		expect(r.stderr).toContain(
			'"capacityLadderPath" is not a repo-relative path — read as its default',
		);
		expect(r.stderr).not.toContain("validate-p0 reads done");
	});

	it("reads the default path where capacityLadderPath is undeclared", () => {
		keepsLadder();
		put(defaultPath, log("- 2026-09-01 · validate-p0 · nothing moved."));
		put(HTML, withGate("done", v(1)));
		const r = tree();
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).not.toContain("validate-p0");
	});
});

/*
 * mantahostels#1649 relocated the roadmap-validity rule out of CLAUDE.md and into this
 * checker's failure (spec mantahostels#1641). Keyed by fragment id, never by a literal
 * copied out of the fragment — a second copy is the drift the store exists to
 * prevent.
 *
 * The checker runs from a throwaway repo, but lib/rule-text.js resolves the
 * store off its own __dirname, so it reads this repo's fragment either way.
 */
describe("the relocated rule reaches the session whose commit fails", () => {
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
	const { ruleText } = require("./lib/rule-text") as any;

	it("index mode carries the whole rule on a structural error", () => {
		stage(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(ruleText("roadmap-validity"));
	});

	it("tree mode carries the same rule", () => {
		put(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = tree();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(ruleText("roadmap-validity"));
	});

	/* A literal anchor, deliberately: every assertion above reads the fragment at
	 * test time, so deleting a clause from the fragment changes both sides at once
	 * and nothing fails. One clause quoted here is what makes a fragment mutation
	 * detectable at all. */
	it("routes the fix through a pathspec commit, never `git add` first (#1732)", () => {
		stage(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const { stderr } = check();
		expect(stderr).toContain("This gate reads the commit's INDEX");
		expect(stderr).toContain("never `git add` first");
		expect(stderr).not.toMatch(/stage (the roadmap|first)/);
	});

	it("says nothing about the rule on a clean roadmap", () => {
		stage(HTML, roadmap(v(2), [card()]));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain(ruleText("roadmap-validity"));
	});
});
