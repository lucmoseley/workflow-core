#!/usr/bin/env node
/*
 * check-stray-scratch.js — report the untracked, non-ignored paths sitting in
 * this repo, in two buckets under two opposite remedies: SESSION SCRATCH that
 * landed outside the one sanctioned in-repo scratch directory, which
 * `docs/environment.md` §12 says should have been written under `.claude/tmp/`
 * and whose remedy is `rm`; and RESEARCH ARTEFACTS left under
 * `docs/research/`, whose remedy is the opposite (§TWO BUCKETS below).
 *
 * Usage:  npm run check:stray-scratch  [--root <dir>] [--notify] [--json]
 *
 * WHY IT IS A REPORT AND NOT A Stop WARN (mantahostels#2338, option (E); built here at
 * mantahostels#2349 as a SessionStart one, lifted to `npm run status` by ad6edc1e4). The
 * same detection ran as a `Stop`-hook `systemMessage` limb
 * of `guard-uncommitted-work.js` and reached nobody (mantahostels#2319, mantahostels#2338).
 *
 * THIS IS LIMB 2. `scripts/guard-root-scratch.sh` is limb 1 and REFUSES the
 * write before it happens (mantahostels#2436), off the Bash
 * command string and a file tool's path (mantahostels#3380). That route is lexical: it
 * reads lib/guard-parse.sh's gp_write_targets spellings only (workflow-core#1827), so a `dd`
 * or a script writing on your behalf passes it unseen. That residual is only
 * ever visible AS A TREE STATE, AFTER THE FACT.
 *
 * `.claude/tmp/` NEVER APPEARS HERE: the sanctioned directory is gitignored, and
 * `git status --porcelain` without `--ignored` drops an ignored path.
 * `lib/dirty-tree.js`'s `untrackedEntries` owns that reading — a directory
 * collapsed to one entry rather than walked into, so a scratch subdirectory
 * counts once.
 *
 * IT NAMES ONLY WHAT HAS SETTLED, ON BOTH LIMBS OF THE REAPER'S OWN TEST
 * (mantahostels#2436, whose census is on mantahostels#2418). A scratch path under 24 hours old — or one whose mtime this could not read at
 * all — is counted and not named, and no `rm` is prescribed for it. Age is
 * the later of mtime and ctime, read by the reaper's own `writtenAtMs`, so a
 * path `tar -x` or `cp -p` backdated reads as written when it landed (workflow-core#1003).
 * §SETTLED_AGE_MS carries the cut and why it is 24 hours; the research bucket
 * is exempt from it. A path that clears that age cut is named ONLY where the
 * liveness oracle also confirms no live session predates its write time — exactly
 * `scripts/lib/scratch-sweep.js`'s limb 2, read from here with the same
 * `earliestStart` and the same fail-safe direction: an unreadable oracle
 * spares every age-settled path rather than naming one under `rm` on a guess.
 * §readLiveness below carries the detail.
 *
 * TWO LIMITS, BOTH ACCEPTED (mantahostels#2349):
 *
 *   1. IT READS THE WHOLE TREE, NOT THIS SESSION'S OWN WRITES. A neighbour's
 *      stray is named to whoever next runs this, unattributed, and there is
 *      nothing to attribute with: the breach route is a Bash redirect, which
 *      records no author.
 *   2. IT REACHES A LATER RUN, NOT THE SESSION THAT STRAYED. By the time a tree
 *      state exists that session's turn is over.
 *
 * A THIRD, FOUND AT REVIEW (mantahostels#2349): there is no `inSharedTree()` gate, so a run
 * inside a throwaway worktree is told about that worktree's own untracked paths
 * and never the shared tree's. Deliberate — scratch dropped in a
 * worktree is just as stray — but the count will not match a neighbour's.
 *
 * DEGRADES TO SILENCE, NEVER TO "TIDY". A `null` from `untrackedEntries` is
 * "git would not answer", so the run SKIPs rather than reporting all-clear over
 * a tree it never read.
 *
 * IT REPORTS; A HUMAN DECIDES. WARN, never FAIL, and nothing here moves or
 * deletes anything. `scripts/lib/scratch-sweep.js` reaps inside `.claude/tmp/`
 * alone, mantahostels#2323 having declined extending it to the repo root.
 *
 * IT RE-REPORTS WHILE THE PATH IS STILL THERE, like check-orphan-wait-loops.js
 * and unlike check-ghost-jobs.js: a stray file is a live tree state until it is
 * dealt with, not a record to retire once. IT RUNS ON `npm run status`, not
 * at session start, so a standing finding is reported only when someone asks.
 *
 * TWO BUCKETS, ONE TREE READ (mantahostels#2447 ruled it, mantahostels#2455 built it; workflow-core#2162 set
 * the research remedy). An untracked path
 * under `docs/research/` is someone's finished research, whose lifecycle belongs
 * to `docs/agents/issue-tracker.md` §Research artefacts: the remedy is to post
 * it as a comment on its issue and then delete the file, never to commit it,
 * and NEVER the bare `rm` the scratch bucket prescribes. REJECTED (mantahostels#2418,
 * reversed by mantahostels#2447): dropping the directory from this report altogether, on
 * the ground that one report cannot carry two remedies. Residual: it can, but
 * only while each remedy stays inside its own bucket's block.
 *
 * BOTH BUCKETS TAKE `untrackedEntries`, AND A COLLAPSED `docs/research/` ENTRY
 * COUNTS AS ONE. The two buckets partition one read, so a path lands in exactly
 * one of them; a second read with `untrackedFiles` — which walks an untracked
 * directory out into its files — would give the same report two granularities
 * and two views of a tree that can change between the reads. So where
 * `docs/research/` holds no tracked file at all, git collapses it and this
 * report says `docs/research/`: one line, one cap slot, and true — nothing
 * under it is tracked.
 *
 * ONE LIMIT OF THAT READING, ACCEPTED: git collapses no further than the
 * shallowest untracked directory, so an untracked `docs/` swallows the research
 * paths under it into the SCRATCH bucket, under the `rm` remedy. Unreachable in
 * this checkout, where `docs/` carries hundreds of tracked files; pinned by a
 * test because `--root` points this at any tree.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), counts the untracked paths sitting in the repo outside `.claude/tmp/` and names the first few, in two buckets under two remedies — scratch to delete, research to post to its issue and then delete. It never moves, deletes or commits one. The persist-and-replay route below is unwired: nothing runs this with `--notify` today.
 * JUSTIFIED: fail-safe — the write route it covers is the one no command-string matcher can see, and a run that cannot read git reports nothing rather than calling the tree tidy.
 * DEFEAT:    WFC_SCRATCH_AGE_MTIME_ONLY=1 ages by mtime alone, so a backdated path is named again (workflow-core#1003) — the suite's switch; --root <dir> points a hand run at another tree.
 */

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { docPath } = require("./lib/script-path.js");
const { shellWord, untrackedEntries } = require("./lib/dirty-tree.js");
const { listedAgents } = require("./lib/agent-liveness");
const { earliestStart, writtenAtMs } = require("./lib/scratch-sweep");
const { hostRoot } = require("./lib/host-root.js");

/*
 * How many paths EACH bucket names before it hands over the command listing the
 * rest. Unmeasured.
 */
const NAMED_MAX = 5;

/*
 * Prefix whose untracked paths are unlanded research artefacts rather than
 * scratch, and so take the second bucket and its opposite remedy (mantahostels#2455; header,
 * §TWO BUCKETS). The trailing slash matches both a file under it and the
 * collapsed directory entry `untrackedEntries` returns where the directory
 * itself is untracked.
 */
const RESEARCH_PREFIX = "docs/research/";

/*
 * How old a stray must be before this report NAMES it (mantahostels#2436).
 *
 * WHY THERE IS A CUT AT ALL: a live session's working scratch is not litter,
 * and `rm` on it destroys work. mantahostels#2418 has the census that made that the modal
 * case rather than an edge one.
 *
 * WHY 24 HOURS. It is the sanctioned directory's own sweep age
 * (`docs/environment.md` §12), so that directory and this report retire scratch
 * on one clock. Unmeasured as an optimum — a session running longer than a day
 * has its scratch named while it is still using it, which is the known cost.
 */
const SETTLED_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Limb 1 alone: is this path old enough on its write time that whatever wrote
 * it has PROBABLY finished? Limb 2 — `readLiveness` below — is what turns
 * "probably" into the reaper's actual verdict.
 *
 * FAIL-SAFE DIRECTION IS AWAY FROM `rm`: an mtime this cannot read must never
 * become a delete instruction, so a dangling symlink, an `EACCES` and a path
 * removed between the `git status` and the stat all land outside the named
 * block.
 *
 * A COLLAPSED DIRECTORY IS STAT'D AS THE DIRECTORY, AND THAT READING HAS A HOLE.
 * A directory's mtime and ctime move when an entry is created, deleted or renamed — NOT
 * when an existing file inside it is written. So a session that created
 * `scratchdir/a.out` two days ago and has been appending to it since leaves
 * `scratchdir` reading aged, and this report names it under the `rm` remedy
 * while it is still in use. Unfixed: closing it means walking the directory on
 * every run, and the shape is rare — scratch is written once, not
 * appended to for days.
 *
 * @param {string} root
 * @param {string} rel
 * @param {number} now
 * @returns {{state: "aged" | "fresh" | "unreadable", writtenMs?: number}}
 */
function ageOf(root, rel, now) {
	const writtenMs = writtenAtMs(path.join(root, rel), { follow: true });
	if (writtenMs === null) return { state: "unreadable" };
	return {
		state: now - writtenMs >= SETTLED_AGE_MS ? "aged" : "fresh",
		writtenMs,
	};
}

/**
 * Limb 2, paid only where limb 1 named at least one candidate — `agent-liveness.js`
 * costs ~465 ms per call, so `run()` below gates it behind `if (aged.length)`
 * rather than reading it on every run (mantahostels#2505).
 *
 * STRICT, NOT WAIVED (workflow-core#1446).
 * The `requireSelf: false` waiver `sweepScratch` still takes exists for a
 * SessionStart caller the daemon has not yet registered. This check runs under
 * `npm run status` and `check:stray-scratch`: mid-session, where the oracle
 * lists its caller, or from a plain terminal, where there is no self to test.
 * So the waiver could only bite on a genuinely short list — and a list missing
 * an older live session moves `earliest` later, naming that session's scratch
 * under the `rm` remedy. Strict, that list lands in the `unverified` bucket.
 * RESIDUAL: a plain-terminal run has no self to test, so a short list still
 * names that scratch there.
 *
 * ON AN UNREADABLE ORACLE, NAME NOTHING (mantahostels#2505, kept on the figures at mantahostels#2526)
 * — the same fail-safe direction as an unreadable mtime, and the reaper's own
 * choice (`scripts/lib/scratch-sweep.js` `sweepScratch`: "ON AN UNREADABLE
 * ORACLE, DELETE NOTHING AND LOG"). Every age-settled candidate is spared and
 * counted in its own bucket instead of silently vanishing.
 *
 * A HUNG ORACLE DOES NOT COST BOTH BUCKETS (mantahostels#2537, which holds the census).
 * These caps are 10 s plus a 20 s retry (`agent-liveness.js`). It runs under
 * `npm run status`, synchronously, so a slow oracle costs the founder that
 * wait.
 *
 * `earliestStart` ALSO answers `-Infinity` where the listing came back but
 * carried no readable `startedAt` (`scratch-sweep.js`'s own doc) — a doubt
 * about the DATA, not evidence of a live session. Read as `why` here rather
 * than as an earliest start: naming that a live session predates the mtime
 * would be a claim `readLiveness` cannot back, where the caller's own
 * `unverified` bucket already says "could not confirm" honestly.
 *
 * @returns {{earliest: number, why?: undefined} | {earliest?: undefined, why: string}}
 */
function readLiveness() {
	const listed = listedAgents();
	if (!listed.agents) return { why: listed.why };
	const earliest = earliestStart(listed.agents);
	if (!Number.isFinite(earliest))
		return {
			why: "the liveness oracle listed no session with a readable start time",
		};
	return { earliest };
}

/** The host repository being scanned for stray scratch (workflow-core#1). */
const REPO_ROOT = hostRoot();

/**
 * How the unnamed scratch paths are described, in the ONE phrasing both
 * carriers use — the trailing block and the summary line.
 *
 * @param {number} fresh
 * @param {number} unreadable
 * @param {number} liveSpared age-settled but limb 2 spares them — a live
 *   session predates the mtime
 * @param {{count: number, why: string} | null} unverified age-settled but
 *   limb 2 could not be read at all
 */
function unnamed(fresh, unreadable, liveSpared = 0, unverified = null) {
	const parts = [];
	if (fresh) parts.push(`${fresh} under 24 hours old`);
	if (unreadable) parts.push(`${unreadable} whose mtime could not be read`);
	if (liveSpared)
		parts.push(`${liveSpared} settled by age, spared by a live session`);
	if (unverified?.count)
		parts.push(
			`${unverified.count} settled by age, unverifiable — ${unverified.why}`,
		);
	const total = fresh + unreadable + liveSpared + (unverified?.count || 0);
	return `${total} further untracked path(s) outside \`.claude/tmp/\` — ${parts.join(", ")}`;
}

/**
 * One bucket's block: heading, up to `NAMED_MAX` paths, the hand-over
 * where more are hidden, then that bucket's own remedy.
 *
 * THE SHAPE IS SHARED AND THE REMEDY IS NOT. Each caller passes its own remedy
 * text, printed under its own list and nowhere else, so neither can be read as
 * an instruction about the other's paths (header, §TWO BUCKETS).
 *
 * @param {import("./lib/check").Ctx} ctx
 * @param {{paths: string[], heading: string, listAll: string, remedy: string}} bucket
 * @returns {number} how many paths went unnamed
 */
function sayBucket(ctx, { paths, heading, listAll, remedy }) {
	if (paths.length === 0) return 0;
	const named = paths.slice(0, NAMED_MAX);
	const hidden = paths.length - named.length;

	ctx.say(heading);
	for (const p of named) ctx.say(`  ${shellWord(p)}`);
	if (hidden) {
		ctx.say(`  … and ${hidden} more, not listed. See them all:`);
		ctx.say(`    ${listAll}`);
	}
	ctx.say(remedy);
	return hidden;
}

/**
 * Splits the age-settled paths on the liveness oracle: stray where no live
 * session predates the write, spared where one does, and all of them
 * unverified where the oracle would not read.
 * @param {string[]} aged
 * @param {(p: string) => {writtenMs?: number}} ageStateOf
 * @returns {{stray: string[], liveSpared: number,
 *   unverified: {count: number, why: string} | null}}
 */
function splitAged(aged, ageStateOf) {
	/** @type {string[]} */
	const stray = [];
	let liveSpared = 0;
	if (aged.length === 0) return { stray, liveSpared, unverified: null };
	const liveness = readLiveness();
	if (liveness.why)
		return {
			stray,
			liveSpared,
			unverified: { count: aged.length, why: liveness.why },
		};
	const earliest = /** @type {number} */ (liveness.earliest);
	for (const p of aged) {
		const writtenMs = /** @type {number} */ (ageStateOf(p).writtenMs);
		if (earliest >= writtenMs) stray.push(p);
		else liveSpared++;
	}
	return { stray, liveSpared, unverified: null };
}

/**
 * A WARN per stray path, per research artefact, and one for an unverified
 * batch.
 * @param {import("./lib/check").Ctx} ctx
 * @param {{stray: string[], unverified: {count: number, why: string} | null,
 *   research: string[]}} opts
 */
function raiseWarnings(ctx, { stray, unverified, research }) {
	for (const p of stray)
		ctx.warn("STRAY-SCRATCH", `${p} — untracked, outside .claude/tmp/`, {
			path: p,
		});
	/* A WARN, not a silent OK: an unread oracle means the tree was NOT fully
	 * assessed, and "subject, not apparatus" (`reading === null` in run())
	 * says that reads as unknown, never as tidy. */
	if (unverified)
		ctx.warn(
			"STRAY-UNVERIFIED",
			`${unverified.count} settled-by-age path(s) could not be checked against the liveness oracle: ${unverified.why}`,
			{ count: unverified.count },
		);
	for (const p of research)
		ctx.warn(
			"STRANDED-UNTRACKED",
			`${p} — untracked under ${RESEARCH_PREFIX}`,
			{ path: p },
		);
}

/**
 * What the count is counting, so a summary line naming a single total
 * over two populations does not read as one of them.
 * @param {string[]} stray
 * @param {string[]} research
 */
function nounFor(stray, research) {
	if (stray.length > 0 && research.length > 0)
		return "untracked path(s) outside `.claude/tmp/`";
	if (research.length > 0) return "untracked research artefact(s)";
	return "stray scratch path(s)";
}

runCheck({
	name: "stray-scratch",
	usage: "node check-stray-scratch.js [--root <dir>] [--notify] [--json]",
	valueFlags: ["--root"],
	run(ctx) {
		const root = ctx.value("--root", REPO_ROOT);

		const reading = untrackedEntries(root);
		// The working tree is subject, not apparatus: SKIP, never BROKEN.
		if (reading === null)
			ctx.skip(
				`git would not answer for ${root}, so what sits untracked there is unknown — not nothing.`,
			);
		const read = /** @type {string[]} */ (reading);
		const research = read.filter((p) => p.startsWith(RESEARCH_PREFIX));
		/*
		 * THE SCRATCH BUCKET IS SPLIT ON AGE AND THE RESEARCH BUCKET IS NOT.
		 * A research artefact is somebody's finished work whatever its mtime,
		 * and its remedy — post it to its issue, then delete it — is safe to
		 * give on a file written a minute ago. A bare `rm` is not.
		 */
		const now = Date.now();
		const all = read.filter((p) => !p.startsWith(RESEARCH_PREFIX));
		/** @typedef {{state: "aged" | "fresh" | "unreadable", writtenMs?: number}} AgeState */
		/** @type {Map<string, AgeState>} */
		const age = new Map(all.map((p) => [p, ageOf(root, p, now)]));
		/* Every `p` passed in below came off `all`, the exact array `age`'s keys
		 * were built from, so the map always has it — the cast just tells the
		 * checker what the walk above already guarantees. */
		/** @param {string} p @returns {AgeState} */
		const ageStateOf = (p) => /** @type {AgeState} */ (age.get(p));
		const aged = all.filter((p) => ageStateOf(p).state === "aged");
		const fresh = all.filter((p) => ageStateOf(p).state === "fresh").length;
		const unreadable = all.filter(
			(p) => ageStateOf(p).state === "unreadable",
		).length;

		/* Limb 2, paid only where limb 1 named a candidate (§readLiveness). */
		const { stray, liveSpared, unverified } = splitAged(aged, ageStateOf);

		raiseWarnings(ctx, { stray, unverified, research });

		const strayHidden = sayBucket(ctx, {
			paths: stray,
			heading: `STRAY-SCRATCH (${stray.length}) — untracked path(s) in the repo outside \`.claude/tmp/\`:`,
			listAll: "git status --porcelain | grep '^??'",
			remedy:
				`\n  \`${docPath("environment.md")}\` §12: \`.claude/tmp/\` is the one sanctioned\n` +
				"  in-repo scratch directory, gitignored and swept. Nothing here was\n" +
				"  moved, deleted or committed, and this sweep has no way to do any of\n" +
				"  those. A path that belongs in a commit gets committed; the rest is\n" +
				"  scratch written to the wrong place, and `rm` is the remedy.\n" +
				"\n  It reads the whole tree, so a neighbour's stray is named here too.\n" +
				"  It re-reports on every run while a path is still there, and it runs\n" +
				"  only when asked, so a report nobody ran named nothing: an unrun\n" +
				"  report is not a clean tree.\n",
		});

		/*
		 * THE UNNAMED POPULATION GETS A COUNT AND NO NAMES, deliberately: naming
		 * it would put paths under the `rm` remedy above that must not be deleted.
		 *
		 * IT PRINTS ONLY WHERE THAT BLOCK EXISTS. A `say` from here escapes
		 * `runCheck`'s OK suppression (`lib/check.js`), so on an all-fresh tree an
		 * unconditional one would inject an unactionable count into every run,
		 * referring to a block above it that was never printed. Where there
		 * is no named block the count rides the summary line instead, which IS
		 * suppressed.
		 */
		const anyUnnamed =
			fresh + unreadable + liveSpared + (unverified?.count || 0);
		/* `unverified` alone (no stray) already raised its own WARN above, so the
		 * detail line prints there too — not only where STRAY-SCRATCH also fired. */
		if ((stray.length > 0 || unverified) && anyUnnamed)
			ctx.say(
				`\n  ${unnamed(fresh, unreadable, liveSpared, unverified)}, not named above and NOT\n` +
					"  yours to delete. A fresh one ages into that block on its own; one\n" +
					"  whose mtime could not be read never will, and neither will one a live\n" +
					"  session predates or one the liveness oracle could not confirm.\n",
			);

		const researchHidden = sayBucket(ctx, {
			paths: research,
			heading: `STRANDED-UNTRACKED (${research.length}) — research artefact(s) left untracked under \`${RESEARCH_PREFIX}\`:`,
			listAll: `git ls-files --others --exclude-standard -- ${RESEARCH_PREFIX}`,
			remedy:
				"\n  THESE ARE NOT SCRATCH AND A BARE `rm` IS NOT THE REMEDY. Read each one,\n" +
				"  run the `concision-pass` skill over it, and post it as a comment on its\n" +
				`  issue (\`${docPath("agents/issue-tracker.md")}\` §Research artefacts);\n` +
				"  then delete the file. A research artefact is never committed. One never\n" +
				"  worth posting is deleted deliberately, after reading it.\n",
		});

		const noun = nounFor(stray, research);
		return {
			okLine: anyUnnamed
				? `no SETTLED untracked path sits outside \`.claude/tmp/\`; ${unnamed(fresh, unreadable, liveSpared, unverified)}, left alone.`
				: "no untracked path sits in the repo outside `.claude/tmp/`.",
			noun,
			data: {
				stray,
				strayCount: stray.length,
				strayFresh: fresh,
				strayUnreadable: unreadable,
				strayLiveSpared: liveSpared,
				strayUnverified: unverified?.count || 0,
				strayUnverifiedWhy: unverified?.why,
				strayHidden,
				research,
				researchCount: research.length,
				researchHidden,
				namedMax: NAMED_MAX,
				root,
			},
		};
	},
});
