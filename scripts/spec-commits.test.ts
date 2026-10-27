// @vitest-environment node
/*
 * Guards the commit list a spec's whole-spec review reads (#892): a wrong one
 * reviews a neighbour's work, or the inherited tracker's, as the spec's. The
 * CLI runs against a throwaway git repo and a stub `gh` (WFC_GH), so no test
 * depends on this repo's history or its tracker.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript, subIssuesArm, writeSubIssues } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "spec-commits.js");
const REPO_URL = "https://api.github.com/repos/o/here";

describe("spec-commits CLI", () => {
	let dir: string;
	let repo: string;

	const git = (args: string[], date?: string) =>
		execFileSync("git", args, {
			cwd: repo,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
				...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
			},
		});

	const commit = (file: string, msg: string, date: string, body?: string) => {
		fs.writeFileSync(path.join(repo, file), `${msg}${body ?? ""}`);
		git(["add", file]);
		git(
			["commit", "-q", "--no-verify", "-m", msg, ...(body ? ["-m", body] : [])],
			date,
		);
	};

	const stub = (kids: unknown[]) => {
		fs.writeFileSync(
			path.join(dir, "issue.json"),
			JSON.stringify({
				number: 10,
				created_at: "2026-09-01T00:00:00Z",
				repository_url: REPO_URL,
			}),
		);
		writeSubIssues(dir, { 10: kids });
		return stubGhScript(
			dir,
			`#!/bin/sh
case "$2" in
${subIssuesArm(dir)}
  *) cat ${dir}/issue.json ;;
esac
`,
		);
	};

	const run = (kids: unknown[], args: string[] = []) => {
		const r = runInProcess(SCRIPT, ["10", ...args], {
			cwd: repo,
			env: { ...process.env, ...stub(kids).env },
		});
		return { ...r, out: `${r.stdout}${r.stderr}` };
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-commits-"));
		repo = path.join(dir, "repo");
		fs.mkdirSync(repo);
		git(["init", "-q", "-b", "main"]);
		commit(
			"old.js",
			"Inherited tracker's bare cite (#10)",
			"2026-08-01T00:00:00Z",
		);
		commit("a.js", "Build the first ticket (#11)", "2026-09-02T00:00:00Z");
		commit("n.js", "A neighbour's work (#99)", "2026-09-03T00:00:00Z");
		commit("b.js", "Fix as review found (#12 review)", "2026-09-04T00:00:00Z");
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const ticket = (
		number: number,
		state = "closed",
		repositoryUrl = REPO_URL,
	) => ({
		number,
		state,
		repository_url: repositoryUrl,
	});

	it("lists the spec's commits since it was filed, and one git show over them", () => {
		const r = run([ticket(11), ticket(12)]);
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"2 commit(s) cite #10 or its 2 ticket(s) (#11 #12)",
		);
		expect(r.out).toContain("Build the first ticket");
		expect(r.out).not.toContain("neighbour");
		expect(r.out).not.toContain("Inherited");
		expect(r.out).toMatch(/git show [0-9a-f]{12} [0-9a-f]{12}\n/);
	});

	it("says a spec no commit cites is decision-only and skips the review", () => {
		const r = run([ticket(50)]);
		expect(r.status).toBe(0);
		expect(r.out).toContain("a decision-only spec. Skip the review");
		expect(r.out).not.toContain("git show");
	});

	it("warns while a ticket is still open, naming it", () => {
		expect(run([ticket(11), ticket(12, "open")]).out).toContain(
			"#12 still open",
		);
	});

	it("names the newest listed commit for the triage comment's Reviewed through line (#897)", () => {
		const r = run([ticket(11), ticket(12)], ["--json"]);
		const out = JSON.parse(r.stdout);
		expect(out.reviewedThrough).toBe(out.commits.at(-1).sha);
		expect(run([ticket(11), ticket(12)]).out).toContain(
			`**Reviewed through:** ${out.reviewedThrough}`,
		);
	});

	describe("--since <sha> (#897)", () => {
		const readShaOf = (subject: string) =>
			git(["log", "--format=%H", `--grep=${subject}`]).trim();

		it("lists only the citing commits after that sha", () => {
			const first = readShaOf("Build the first ticket");
			const r = run([ticket(11), ticket(12)], ["--since", first, "--json"]);
			expect(r.status).toBe(0);
			const out = JSON.parse(r.stdout);
			expect(out.since).toBe(first);
			expect(out.commits.map((c: { subject: string }) => c.subject)).toEqual([
				"Fix as review found (#12 review)",
			]);
		});

		it("says nothing new is to review, not that the spec is decision-only", () => {
			const last = readShaOf("Fix as review found");
			const r = run([ticket(11), ticket(12)], ["--since", last]);
			expect(r.status).toBe(0);
			expect(r.out).toContain("nothing new to review");
			expect(r.out).toContain(`**Reviewed through:** ${last}`);
			expect(r.out).not.toContain("decision-only");
		});

		it("refuses a sha that is not on HEAD, offering to drop --since as the way out", () => {
			const head = git(["rev-parse", "HEAD"]).trim();
			git(["checkout", "-q", "-b", "side"]);
			commit("s.js", "Off-HEAD work (#11)", "2026-09-05T00:00:00Z");
			const side = git(["rev-parse", "HEAD"]).trim();
			git(["checkout", "-q", head]);
			const r = run([ticket(11)], ["--since", side]);
			expect(r.status).toBe(2);
			expect(r.out).toContain("is not a commit on HEAD");
			expect(r.out).toContain("or drop --since to review the whole spec");
		});

		describe("a rebased copy merged back onto HEAD (#3240)", () => {
			/* `pre` holds the reviewed, pre-landing copies; main lands their
			 * rebased twins — one patch-identical, one carrying an extra file
			 * under its original author date, as a rebase keeps it — then merges
			 * `pre` back, so both copies sit on HEAD. */
			const landTwins = () => {
				const base = git(["rev-parse", "HEAD"]).trim();
				git(["checkout", "-q", "-b", "pre"]);
				commit("p.js", "Land the parser (#11)", "2026-09-05T00:00:00Z");
				commit("q.js", "Wire the parser (#12)", "2026-09-06T00:00:00Z");
				const reviewed = git(["rev-parse", "HEAD"]).trim();
				git(["checkout", "-q", "-"]);
				expect(git(["rev-parse", "HEAD"]).trim()).toBe(base);
				commit(
					"n2.js",
					"A neighbour lands first (#99)",
					"2026-09-07T00:00:00Z",
				);
				commit("p.js", "Land the parser (#11)", "2026-09-08T00:00:00Z");
				fs.writeFileSync(path.join(repo, "q.js"), "Wire the parser (#12)");
				fs.writeFileSync(path.join(repo, "r.js"), "rebase fix-up");
				git(["add", "q.js", "r.js"]);
				git(
					[
						"commit",
						"-q",
						"--no-verify",
						"--date=2026-09-06T00:00:00Z",
						"-m",
						"Wire the parser (#12)",
					],
					"2026-09-08T00:00:00Z",
				);
				git(
					["merge", "-q", "--no-edit", "--no-verify", "pre"],
					"2026-09-09T00:00:00Z",
				);
				commit("f.js", "Fix a finding (#12)", "2026-09-10T00:00:00Z");
				return reviewed;
			};

			it("marks each landed twin, and leaves the patch-identical one out of the git show", () => {
				const reviewed = landTwins();
				const preCopy = (subject: string) =>
					git(["log", "--format=%H", `--grep=${subject}`, "pre"])
						.trim()
						.split("\n")[0];
				const r = run(
					[ticket(11), ticket(12)],
					["--since", reviewed, "--json"],
				);
				expect(r.status).toBe(0);
				const out = JSON.parse(r.stdout);
				expect(
					out.commits.map((c: { subject: string; twin: unknown }) => [
						c.subject,
						c.twin,
					]),
				).toEqual([
					[
						"Land the parser (#11)",
						{ sha: preCopy("Land the parser"), patchDiffers: false },
					],
					[
						"Wire the parser (#12)",
						{ sha: preCopy("Wire the parser"), patchDiffers: true },
					],
					["Fix a finding (#12)", null],
				]);
				const landed = out.commits.map((c: { sha: string }) =>
					c.sha.slice(0, 12),
				);
				expect(out.show).toBe(`git show ${landed[1]} ${landed[2]}`);
				expect(out.files.map((f: { path: string }) => f.path)).toEqual([
					"f.js",
					"q.js",
					"r.js",
				]);
				expect(out.reviewedThrough).toBe(out.commits.at(-1).sha);

				const text = run([ticket(11), ticket(12)], ["--since", reviewed]).out;
				expect(text).toContain(
					`Land the parser (#11)  [already reviewed (twin ${preCopy("Land the parser").slice(0, 12)})]`,
				);
				expect(text).toContain(
					`Wire the parser (#12)  [rebased, patch differs (twin ${preCopy("Wire the parser").slice(0, 12)}) — read this landed form]`,
				);
				expect(text).toContain("a sha main keeps");
			});

			it("says nothing new is to review where every listed commit is a reviewed twin", () => {
				const reviewed = landTwins();
				git(["reset", "-q", "--hard", "HEAD~1"]);
				const r = run([ticket(11)], ["--since", reviewed]);
				expect(r.status).toBe(0);
				expect(r.out).toContain("[already reviewed (twin");
				expect(r.out).toContain(
					"Each is a twin of a reviewed commit: nothing new to review",
				);
				expect(r.out).not.toContain("git show");
				expect(r.out).toContain("a sha main keeps");
				expect(r.out).not.toContain("is not on main");
			});

			it("does not call a later commit repeating a reviewed subject a twin", () => {
				const reviewed = landTwins();
				commit("g.js", "Wire the parser (#12)", "2026-09-11T00:00:00Z");
				const out = JSON.parse(
					run([ticket(11), ticket(12)], ["--since", reviewed, "--json"]).stdout,
				);
				expect(out.commits.at(-1).twin).toBeNull();
			});

			it("says so, marking nothing, where git gives no patch-ids", () => {
				const reviewed = landTwins();
				const fake = path.join(dir, "git-no-patch-id");
				fs.writeFileSync(
					fake,
					`#!/bin/sh\n[ "$1" = patch-id ] && exit 1\nexec git "$@"\n`,
					{ mode: 0o755 },
				);
				const r = runInProcess(SCRIPT, ["10", "--since", reviewed, "--json"], {
					cwd: repo,
					env: {
						...process.env,
						...stub([ticket(11), ticket(12)]).env,
						WFC_GIT: fake,
					},
				});
				const out = JSON.parse(r.stdout);
				expect(out.twinsRead).toBe(false);
				expect(
					out.commits.every((c: { twin: unknown }) => c.twin === null),
				).toBe(true);
			});

			it("warns where the sha to record is not on main", () => {
				git(["checkout", "-q", "-b", "worktree"]);
				commit("w.js", "Unlanded work (#11)", "2026-09-05T00:00:00Z");
				const r = run([ticket(11)]);
				expect(r.out).toMatch(/WARNING: [0-9a-f]{12} is not on main/);
				expect(
					JSON.parse(run([ticket(11)], ["--json"]).stdout).throughOnMain,
				).toBe(false);
			});
		});

		it("refuses --since with no sha, with usage", () => {
			const r = run([ticket(11)], ["--since"]);
			expect(r.status).toBe(2);
			expect(r.out).toContain(
				"usage: node scripts/spec-commits.js <spec> [--since <sha>]",
			);
		});
	});

	it("skips another tracker's citation, and does not read #11 out of #110", () => {
		commit(
			"x.js",
			"Not ours: mantahostels#11, design-vault#12, a/#11 or ##12",
			"2026-09-05T00:00:00Z",
		);
		commit("y.js", "Other work (#110)", "2026-09-06T00:00:00Z");
		const out = JSON.parse(run([ticket(11), ticket(12)], ["--json"]).stdout);
		expect(out.commits.map((c: { subject: string }) => c.subject)).toEqual([
			"Build the first ticket (#11)",
			"Fix as review found (#12 review)",
		]);
	});

	it("reads a citation in the body, and lists a file two commits touch once", () => {
		commit("a.js", "Second pass", "2026-09-05T00:00:00Z", "Body cites #11.");
		const out = JSON.parse(run([ticket(11), ticket(12)], ["--json"]).stdout);
		expect(out.commits.map((c: { subject: string }) => c.subject)).toEqual([
			"Build the first ticket (#11)",
			"Fix as review found (#12 review)",
			"Second pass",
		]);
		expect(out.files.map((f: { path: string }) => f.path)).toEqual([
			"a.js",
			"b.js",
		]);
	});

	it("ignores a sub-issue filed in another repo", () => {
		const r = run(
			[
				ticket(11),
				ticket(12, "closed", "https://api.github.com/repos/o/there"),
			],
			["--json"],
		);
		const out = JSON.parse(r.stdout);
		expect(out.tickets).toEqual([11]);
		expect(out.commits).toHaveLength(1);
	});
});
