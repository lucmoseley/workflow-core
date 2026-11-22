#!/usr/bin/env node

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { docPath } = require("./lib/script-path.js");
const { readUntrackedEntries } = require("./lib/dirty-tree.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { listedAgents } = require("./lib/agent-liveness");
const { earliestStart, writtenAtMs } = require("./lib/scratch-sweep");
const { hostRoot } = require("./lib/host-root.js");

const NAMED_MAX = 5;

const RESEARCH_PREFIX = "docs/research/";

// lucmoseley/mantahostels#2436 guess
const SETTLED_AGE_MS = 24 * 60 * 60 * 1000;

/**
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

// #1446
/**
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

const REPO_ROOT = hostRoot();

/**
 * @param {number} fresh
 * @param {number} unreadable
 * @param {number} liveSpared
 * @param {{count: number, why: string} | null} unverified
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
 * @param {import("./lib/check").Ctx} ctx
 * @param {{paths: string[], heading: string, listAll: string, remedy: string}} bucket
 * @returns {number}
 */
function sayBucket(ctx, { paths, heading, listAll, remedy }) {
	if (paths.length === 0) return 0;
	const named = paths.slice(0, NAMED_MAX);
	const hidden = paths.length - named.length;

	ctx.say(heading);
	for (const p of named) ctx.say(`  ${shellQuote(p)}`);
	if (hidden) {
		ctx.say(`  … and ${hidden} more, not listed. See them all:`);
		ctx.say(`    ${listAll}`);
	}
	ctx.say(remedy);
	return hidden;
}

/**
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
 * @param {import("./lib/check").Ctx} ctx
 * @param {{stray: string[], unverified: {count: number, why: string} | null,
 *   research: string[]}} opts
 */
function raiseWarnings(ctx, { stray, unverified, research }) {
	for (const p of stray)
		ctx.warn("STRAY-SCRATCH", `${p} — untracked, outside .claude/tmp/`, {
			path: p,
		});
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

		const reading = readUntrackedEntries(root);
		if (reading === null)
			ctx.skip(
				`git would not answer for ${root}, so what sits untracked there is unknown — not nothing.`,
			);
		const read = /** @type {string[]} */ (reading);
		const research = read.filter((p) => p.startsWith(RESEARCH_PREFIX));
		const now = Date.now();
		const all = read.filter((p) => !p.startsWith(RESEARCH_PREFIX));
		/** @typedef {{state: "aged" | "fresh" | "unreadable", writtenMs?: number}} AgeState */
		/** @type {Map<string, AgeState>} */
		const age = new Map(all.map((p) => [p, ageOf(root, p, now)]));
		/** @param {string} p @returns {AgeState} */
		const ageStateOf = (p) => /** @type {AgeState} */ (age.get(p));
		const aged = all.filter((p) => ageStateOf(p).state === "aged");
		const fresh = all.filter((p) => ageStateOf(p).state === "fresh").length;
		const unreadable = all.filter(
			(p) => ageStateOf(p).state === "unreadable",
		).length;

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
				"\n  It reads the whole tree, so a stray this session did not write is named too.\n" +
				"  It re-reports on every run while a path is still there, and it runs\n" +
				"  only when asked, so a report nobody ran named nothing: an unrun\n" +
				"  report is not a clean tree.\n",
		});

		const anyUnnamed =
			fresh + unreadable + liveSpared + (unverified?.count || 0);
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
