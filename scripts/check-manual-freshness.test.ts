// @vitest-environment node
/*
 * Pins check-manual-freshness.js's verdict on the operating manual: how far its
 * provenance stamp trails the roadmap, that its corrections log is well-formed,
 * that `--notify` speaks only on drift, and that every path it cites still
 * exists (thresholds mantahostels#389, the WARN band mantahostels#391).
 *
 * check-manual-freshness.js resolves the stamp's SHAs against real git history,
 * so it is exercised inside a throwaway repository with commits of its own
 * rather than against this one — pinning a fixture to this repo's SHAs would
 * rot on the next rebase.
 *
 * Assertions 1–3 are covered incidentally: every fixture here has to produce a
 * valid stamp for the rest to be reached.
 *
 * The last block is the exception to the throwaway repository — it runs against
 * this repo's real manual and real allowlist, which is what makes removing an
 * allowlist entry visible as a failing test.
 *
 * The daily repo-checks run's report-manual-staleness.js files an issue on its FAIL,
 * and `npm run status` prints its drift line: loosen a case and a manual stale
 * against the roadmap reads as fresh, so sessions take strategy from it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-manual-freshness.js");
const MANUAL = "docs/operating-manual.md";
const ROADMAP = "docs/reference-roadmap.html";

let repo: string;
let sha: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** The manual as the script sees it: stamp paragraph, then the corrections line. */
const manual = (corrections: string, stampSha = sha, body = "") =>
	[
		"# Manual",
		"",
		`Reviewed against roadmap v1.0 (1 January 2026), roadmap commit ${stampSha} · reviewed against repo at ${stampSha}.`,
		"",
		corrections,
		"",
		"## 1. Mission — *Timeless*",
		"",
		body,
		"",
	].join("\n");

const write = (corrections: string, stampSha?: string) =>
	fs.writeFileSync(path.join(repo, MANUAL), manual(corrections, stampSha));

/** A manual whose body is `body`, with a clean corrections log. */
const writeBody = (body: string) =>
	fs.writeFileSync(
		path.join(repo, MANUAL),
		manual("**Corrections since last sync:** none.", sha, body),
	);

/** The checker run under `env`, or this process's own where undefined. */
const checkUnder = (env: NodeJS.ProcessEnv | undefined, ...extra: string[]) => {
	const r = runInProcess(SCRIPT, [MANUAL, ROADMAP, ...extra], {
		cwd: repo,
		env,
	});
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
	};
};
const checkWith = (...extra: string[]) => checkUnder(undefined, ...extra);
const check = checkWith;

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "manual-fresh-test-"));
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	fs.mkdirSync(path.join(repo, "docs"));
	// A root commit shows no diff to `git diff-tree`, so the anchor commit needs a
	// parent for the script's "does this commit touch the roadmap?" check to see it.
	git("commit", "-q", "--allow-empty", "-m", "root");
	// The roadmap commit anchor must be a commit that actually touches the HTML.
	fs.writeFileSync(
		path.join(repo, ROADMAP),
		"<p>v1.0 · updated 1 Jan 2026</p>\n",
	);
	git("add", ROADMAP);
	git("commit", "-qm", "roadmap");
	sha = git("rev-parse", "HEAD").trim();
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("check-manual-freshness — corrections log", () => {
	it("passes when nothing is outstanding", () => {
		write("**Corrections since last sync:** none.");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/corrections log:\s+none outstanding/);
	});

	it("passes a well-formed entry recorded at the current anchor", () => {
		write(
			[
				"**Corrections since last sync:**",
				`- 2026-08-02 · repo ${sha} · source founder ruling · §4 — weekly review slot recorded as 90 minutes.`,
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/corrections log:\s+1 entry line\(s\)/);
	});

	// The whole point of the source requirement: an uncited correction is a
	// hand-edit wearing targeted-correction clothes.
	it("fails an entry that cites no source", () => {
		write(
			[
				"**Corrections since last sync:**",
				`- 2026-08-02 · repo ${sha} · §4 — weekly review slot recorded as 90 minutes.`,
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("cites no source");
	});

	// A targeted correction advances neither anchor, so a stamp that has moved
	// past a live entry means a full sync ran and skipped the clear-down step.
	it("fails when the stamp has advanced past a live entry", () => {
		fs.appendFileSync(path.join(repo, ROADMAP), "<p>later</p>\n");
		git("add", ROADMAP);
		git("commit", "-qm", "later roadmap");
		const newer = git("rev-parse", "HEAD").trim();
		write(
			[
				"**Corrections since last sync:**",
				`- 2026-08-02 · repo ${sha} · source #73 · §4 — OTA rate.`,
			].join("\n"),
			newer,
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("advanced the anchor without clearing the log");
	});

	it("fails an entry that is sourced but otherwise malformed", () => {
		write(
			[
				"**Corrections since last sync:**",
				"- sometime · source #73 — OTA rate.",
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("malformed");
	});

	// A blank line between a bold lead-in and its list is ordinary Markdown.
	it("accepts a blank line between the header and its entries", () => {
		write(
			[
				"**Corrections since last sync:**",
				"",
				`- 2026-08-02 · repo ${sha} · source #73 · §4 — OTA rate.`,
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/corrections log:\s+1 entry line\(s\)/);
	});

	// The log is the one under the stamp. A later line quoting the label — in a
	// section explaining the mechanism, say — must not be parsed as the log.
	it("reads the log under the stamp, not a later line quoting the label", () => {
		fs.writeFileSync(
			path.join(repo, MANUAL),
			[
				"# Manual",
				"",
				`Reviewed against roadmap v1.0 (1 January 2026), roadmap commit ${sha} · reviewed against repo at ${sha}.`,
				"",
				"**Corrections since last sync:** none.",
				"",
				"## 9. How this works",
				"",
				"**Corrections since last sync:** is where a targeted correction is logged.",
				"",
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/corrections log:\s+none outstanding/);
	});

	it("fails a manual with no corrections line at all", () => {
		fs.writeFileSync(
			path.join(repo, MANUAL),
			[
				"# Manual",
				"",
				`Reviewed against roadmap v1.0 (1 January 2026), roadmap commit ${sha} · reviewed against repo at ${sha}.`,
				"",
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("carries no");
	});

	it('fails when the log reads "none." but entries follow it', () => {
		write(
			[
				"**Corrections since last sync:** none.",
				`- 2026-08-02 · repo ${sha} · source #73 — OTA rate.`,
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain('reads "none."');
	});

	it("fails when the log opens a list and carries no entries", () => {
		write("**Corrections since last sync:**");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("opens a list but carries no entries");
	});

	// check.js owns the one `SEVERITY:` line a run emits, and this checker is the
	// only one of the fourteen that prints per-assertion detail as well. Prefixing
	// that detail put `OK: stamp shape valid` inside a run that ended FAIL — the
	// outcome vocabulary meaning two different things in one stream.
	it("emits exactly one severity line, whatever the per-assertion state", () => {
		write(
			[
				"**Corrections since last sync:**",
				`- 2026-08-02 · repo ${sha} · §4 — OTA rate.`,
			].join("\n"),
		);
		const r = check();
		expect(r.status).toBe(1);
		const severity = r.out.match(/^(OK|SKIP|WARN|FAIL|BROKEN):/gm) || [];
		expect(severity).toEqual(["FAIL:"]);
		expect(r.out).toMatch(/stamp shape:\s+valid/);
		expect(r.out).toContain("cites no source");
	});
});

/*
 * --notify is the SessionStart path (mantahostels#391). It exists so the 5-9 MINOR band —
 * a WARN, and so exit 0, which report-manual-staleness.js reads as fresh and
 * never files — reaches the session that would run manual-sync. Its stdout is
 * injected into every session that starts.
 */
describe("check-manual-freshness — --notify", () => {
	const notify = () => check("--notify");

	/** Set the roadmap's version, the manual's stamp staying at v1.0. */
	const roadmapAt = (version: string) => {
		fs.writeFileSync(
			path.join(repo, ROADMAP),
			`<p>${version} · updated 1 Jan 2026</p>\n`,
		);
	};

	it("says nothing at all when the manual is current", () => {
		write("**Corrections since last sync:** none.");
		const r = notify();
		expect(r.status).toBe(0);
		expect(r.out).toBe("");
	});

	it("reports a 5-9 MINOR drift", () => {
		roadmapAt("v1.6");
		write("**Corrections since last sync:** none.");
		const r = notify();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/6 roadmap MINOR versions behind/);
		expect(r.out).toMatch(/^WARN:/m);
	});

	it("prints the finding and drops the assertions that passed", () => {
		roadmapAt("v1.6");
		write("**Corrections since last sync:** none.");
		const r = notify();
		expect(r.out).toMatch(/roadmap distance:/);
		expect(r.out).not.toMatch(/stamp shape:/);
		expect(r.out).not.toMatch(/corrections log:/);
	});

	it("still reports a FAIL, which the daily run files as an issue as well", () => {
		roadmapAt("v1.12");
		write("**Corrections since last sync:** none.");
		const r = notify();
		// --notify exits 0 unconditionally (check.js), so the exit code says nothing
		// about severity here; the printed line is the whole signal.
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^FAIL:/m);
		expect(r.out).toMatch(/12 roadmap MINOR versions behind/);
	});
});

/*
 * Assertion 5 (mantahostels#1149). The failure mode it exists to avoid is a FALSE POSITIVE:
 * this runs on a hook that is silent when the manual is current, so a token
 * wrongly read as a path would put noise into every session start.
 */
describe("check-manual-freshness — cited paths", () => {
	// `repo` is minted per test, so the path is read at call time, not here.
	const allowlistPath = () => path.join(repo, "allowlist.json");
	const allowlist = (entries: unknown[]) =>
		fs.writeFileSync(allowlistPath(), JSON.stringify({ allowlist: entries }));
	const checkAllowlisted = (...extra: string[]) =>
		checkWith("--allowlist", allowlistPath(), ...extra);

	it("reports a cited path that does not exist", () => {
		writeBody("Evidence: `docs/research/gone.md` (#1).");
		const r = checkAllowlisted();
		expect(r.out).toMatch(
			/cited paths:\s+1 miss\(es\): docs\/research\/gone\.md/,
		);
		// A stale citation is a documentation defect, not the sync routine
		// stalling — WARN, so it never gates and never files an issue (mantahostels#391).
		expect(r.out).toMatch(/^WARN:/m);
		expect(r.status).toBe(0);
	});

	it("passes a cited path that exists", () => {
		writeBody("The roadmap lives at `docs/reference-roadmap.html`.");
		const r = checkAllowlisted();
		expect(r.out).toMatch(/cited paths:\s+1 cited path\(s\) resolve/);
		expect(r.out).toMatch(/^OK:/m);
	});

	it("adds nothing under --notify when every cited path resolves", () => {
		writeBody("The roadmap lives at `docs/reference-roadmap.html`.");
		expect(checkAllowlisted("--notify").out).toBe("");
	});

	it("ignores code spans that are not paths at all", () => {
		writeBody(
			"Cards `econ-revalidate` and `owner-uvp`, region `ap-southeast-1`, " +
				"`cookieless_mode: 'always'`, and `and/or` prose.",
		);
		const r = checkAllowlisted();
		expect(r.out).toMatch(/cited paths:\s+0 cited path\(s\) resolve/);
		expect(r.out).toMatch(/^OK:/m);
	});

	it("reads paths only from code spans, not from prose", () => {
		writeBody("Bare docs/research/gone.md in prose is not a citation.");
		expect(checkAllowlisted().out).toMatch(
			/cited paths:\s+0 cited path\(s\) resolve/,
		);
	});

	it("strips the sentence punctuation around a citation", () => {
		writeBody("See (`docs/reference-roadmap.html`), and stop.");
		expect(checkAllowlisted().out).toMatch(/1 cited path\(s\) resolve/);
	});

	it("suppresses an allowlisted token", () => {
		allowlist([{ token: "lib/nothing-yet/", reason: "not built yet" }]);
		writeBody("Planned home: `lib/nothing-yet/`.");
		const r = checkAllowlisted();
		expect(r.out).not.toMatch(/miss\(es\)/);
		expect(r.out).toMatch(/^OK:/m);
	});

	it("checks the path an allowlisted token stands for, so a rename still shows", () => {
		allowlist([
			{ token: "roadmap.html", path: "docs/roadmap.html", reason: "basename" },
		]);
		writeBody("The roadmap (`roadmap.html`) is authoritative.");
		const r = checkAllowlisted();
		expect(r.out).toMatch(/roadmap\.html \(stands for docs\/roadmap\.html\)/);
		expect(r.out).toMatch(/^WARN:/m);
		expect(r.status).toBe(0);
	});

	it("warns about an allowlist entry the manual no longer cites", () => {
		allowlist([{ token: "lib/gone/", reason: "removed from the manual" }]);
		writeBody("Nothing cited here.");
		const r = checkAllowlisted();
		expect(r.out).toMatch(
			/allowlists "lib\/gone\/", which the manual no longer cites/,
		);
		expect(r.status).toBe(0);
	});

	it("caps the list so a mass rename cannot flood a session start", () => {
		writeBody(
			[1, 2, 3, 4, 5, 6, 7].map((n) => `\`docs/gone-${n}.md\``).join(" and "),
		);
		const r = checkAllowlisted();
		expect(r.out).toMatch(/7 miss\(es\)/);
		expect(r.out).toMatch(/\(\+2 more\)/);
		expect(r.out).not.toMatch(/gone-6\.md/);
	});

	it("is BROKEN on an allowlist it cannot parse", () => {
		fs.writeFileSync(allowlistPath(), "{ not json");
		writeBody("");
		const r = checkAllowlisted();
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/cannot parse/);
	});

	it("is BROKEN on an allowlist entry missing its reason, naming the two fields an entry needs", () => {
		allowlist([{ token: "lib/x/" }]);
		writeBody("");
		const r = checkAllowlisted();
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/needs a string "token" and "reason"/);
	});
});

describe("check-manual-freshness — a git that will not answer (#3068)", () => {
	it("is BROKEN, never a stamp that fails to resolve", () => {
		write("**Corrections since last sync:** none.");
		const exitsOne = path.join(repo, "git");
		fs.writeFileSync(exitsOne, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const r = checkUnder({ ...process.env, WFC_GIT: exitsOne });
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/would not resolve/);
		expect(r.out).not.toMatch(/does not resolve/);
	});
});
