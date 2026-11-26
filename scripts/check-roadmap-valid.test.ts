// @vitest-environment node

import { spawnSync } from "node:child_process";
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
import { seenFrom } from "./lib/core-path-testkit";
import { defineTemplate, identityRepoTemplate } from "./lib/git-fixture";
import { gitIn } from "./lib/repo-tree-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-roadmap-valid.js");
const HTML = "docs/reference-roadmap.html";

let repo: string;

const git = (...args: string[]) => gitIn(repo, ...args);

const configuredRepo = defineTemplate(identityRepoTemplate);

const newRepo = (tag: string) =>
	configuredRepo.instantiate(fs.mkdtempSync(path.join(os.tmpdir(), tag)));

const { EXPECTED_MAJOR } = createRequire(import.meta.url)(
	"../.claude/skills/roadmap-edit/scripts/validate.js",
);
const v = (minor: number) => `${EXPECTED_MAJOR}.${minor}`;

type Card = Record<string, unknown>;

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
	mn: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix twentyseven twentyeight twentynine thirty thirtyone",
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

const run = (args: string[], cwd = repo, extra: NodeJS.ProcessEnv = {}) => {
	const r = runInProcess(SCRIPT, args, {
		cwd,
		env: { ...process.env, ...extra, CLAUDE_PROJECT_DIR: cwd },
	});
	return {
		status: r.status,
		stdout: r.stdout,
		stderr: r.stderr,
	};
};
const check = (cwd = repo, extra: NodeJS.ProcessEnv = {}) =>
	run([], cwd, extra);
const tree = (cwd = repo, extra: NodeJS.ProcessEnv = {}) =>
	run(["--tree"], cwd, extra);

const put = (file: string, body: string, cwd = repo) => {
	fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
	fs.writeFileSync(path.join(cwd, file), body);
};

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
		const bare = newRepo("roadmap-valid-nobase-");
		stageIn(bare, HTML, roadmap(v(1), [card()]));
		const r = check(bare);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("first roadmap commit");
		expect(r.stderr).not.toContain("BROKEN");
		fs.rmSync(bare, { recursive: true, force: true });
	});

	it("is still BROKEN where HEAD exists and cannot be read", () => {
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

	it("is BROKEN, not SKIPPED, when the roadmap is renamed away (#1483)", () => {
		git("mv", "--", HTML, "docs/roadmap-old.html");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.stderr).not.toContain("SKIP");
	});

	it("SKIPs a commit that does not stage the roadmap", () => {
		stage("docs/other.md", "unrelated\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP");
		expect(r.stderr).not.toContain("FAIL");
		expect(r.stderr).not.toContain("WARN");
	});

	describe("a commit deleting the roadmap (#5405)", () => {
		beforeEach(() => {
			stage(HTML, roadmap(v(2), [card()]));
			stage(".claude/workflow-core.json", '{ "modules": ["roadmap"] }\n');
			git("commit", "-q", "-m", "roadmap");
			git("rm", "-q", HTML);
		});

		const expectUnreadableRoadmap = () => {
			const r = check();
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(`cannot read the staged ${HTML}`);
		};

		it("SKIPs where the same commit's staged config drops the module", () => {
			stage(".claude/workflow-core.json", '{ "modules": [] }\n');
			const r = check();
			expect(r.status).toBe(0);
			expect(r.stderr).toContain(`SKIP: this commit deletes ${HTML}`);
		});

		it("stays BROKEN, naming the unreadable staged roadmap, where the staged config keeps the module", () => {
			stage(
				".claude/workflow-core.json",
				'{ "modules": ["roadmap", "landing"] }\n',
			);
			expectUnreadableRoadmap();
		});

		it("stays BROKEN, naming the unreadable staged roadmap, where the staged config is unchanged", () => {
			expectUnreadableRoadmap();
		});

		it("stays BROKEN, naming the unreadable staged roadmap, where HEAD's config never listed the module", () => {
			stage(".claude/workflow-core.json", '{ "modules": [] }\n');
			git(
				"commit",
				"-q",
				"-m",
				"module off",
				"--",
				".claude/workflow-core.json",
			);
			expectUnreadableRoadmap();
		});
	});

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
		const r = check(repo, { GITHUB_ACTIONS: "true" });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("::error::");
		expect(r.stdout).toContain('bad state "nope"');
	});
});

describe("check-roadmap-valid --tree", () => {
	it("FAILs a card-level error present only in the working tree, naming the card and its bad state and offering the roadmap-edit skill", () => {
		put(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = tree();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('"seed" has bad state "nope"');
		expect(r.stderr).toContain("FAIL");
		expect(r.stderr).toContain("roadmap-edit skill");
	});

	it("does not claim to be judging any particular ref", () => {
		put(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = tree();
		expect(r.stderr).toContain("in this checkout");
		expect(r.stderr).not.toContain("on main");
	});

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
		const r = tree(repo, { GITHUB_ACTIONS: "true" });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("::error::");
		expect(r.stdout).toContain('bad state "nope"');
	});
});

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

	it("does not let the log section's own comment record a card", () => {
		put(
			ladderPath,
			"# Ladder\n\n### Re-assessment log\n\n" +
				"<!-- one line each, e.g. 2026-09-01 · validate-p0 · nothing moved -->\n\nNone yet.\n",
		);
		put(HTML, gate("done"));
		expect(tree().stderr).toContain("validate-p0 reads done");
	});

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

	it("annotates the unrecorded boundary for Actions, on stdout", () => {
		put(ladderPath, ladder("None yet."));
		put(HTML, gate("done"));
		const r = tree(repo, { GITHUB_ACTIONS: "true" });
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

describe("the relocated rule reaches the session whose commit fails", () => {
	const { readRuleText } =
		require("./lib/rule-text") as typeof import("./lib/rule-text");

	it("index mode carries the whole rule on a structural error", () => {
		stage(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			seenFrom(repo, () => readRuleText("roadmap-validity")),
		);
	});

	it("tree mode carries the same rule", () => {
		put(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const r = tree();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			seenFrom(repo, () => readRuleText("roadmap-validity")),
		);
	});

	it("routes the fix through a pathspec commit (#1732)", () => {
		stage(HTML, roadmap(v(2), [card({ state: "nope" })]));
		const { stderr } = check();
		expect(stderr).toContain("This gate reads the commit's INDEX");
		expect(stderr).toContain("Then commit it by pathspec:");
		expect(stderr).not.toMatch(/stage (the roadmap|first)/);
	});

	it("says nothing about the rule on a clean roadmap", () => {
		stage(HTML, roadmap(v(2), [card()]));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain(readRuleText("roadmap-validity"));
	});
});
