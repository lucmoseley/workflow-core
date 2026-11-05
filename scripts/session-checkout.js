#!/usr/bin/env node
/*
 * session-checkout.js — the command launchers and sessions call for a session
 * worktree (#4229); the lifecycle itself is lib/session-checkout.js.
 *
 *   node scripts/session-checkout.js cut <session-name>
 *     prints the new worktree's path on stdout
 *   node scripts/session-checkout.js launch-dir <prompt>
 *     prints the directory a session launched on <prompt> starts in: a
 *     worktree cut for it, or the main checkout where `landing` is off
 *   node scripts/session-checkout.js attach [<worktree>]
 *     re-points the worktree's node_modules at the store for its lockfile;
 *     the current directory's worktree where none is named
 *   node scripts/session-checkout.js land
 *     merges origin/landing into the current directory's worktree and pushes
 *     HEAD:landing, saying on stderr what it did; refused, it says why and
 *     what to do before landing again
 *   node scripts/session-checkout.js reap
 *     removes landed, clean worktrees no session can resume, stray
 *     directories and unlinked dependency stores, saying on stderr what it
 *     removed and naming each stranded worktree it may not remove
 *
 * Exit 0 done, 1 refused or failed (why on stderr), 2 a usage error. A reap
 * that could not remove something it should have exits 1; one that finds
 * stranded work exits 0, as reporting it is its job.
 *
 * IT JOINS NO FAMILY (§G4, §N3): it gates nothing (no `check-*`), no hook
 * runs it (no `guard-*`), it generates no file (no `generate-*`) and files no
 * issue (no `report-*`).
 */

const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { describeAge } = require("./lib/level-main.js");
const {
	attach,
	CheckoutError,
	cut,
	land,
	launchDir,
	reap,
} = require("./lib/session-checkout.js");
const { writeFd } = require("./lib/write-fd.js");

const CLI = {
	usage:
		"usage: node scripts/session-checkout.js cut <session-name> | launch-dir <prompt> | attach [<worktree>] | land | reap",
	commands: {
		cut: {
			usage: "usage: node scripts/session-checkout.js cut <session-name>",
			min: 1,
		},
		"launch-dir": {
			usage: "usage: node scripts/session-checkout.js launch-dir <prompt>",
			min: 1,
		},
		attach: {
			usage: "usage: node scripts/session-checkout.js attach [<worktree>]",
			max: 1,
		},
		land: {
			usage: "usage: node scripts/session-checkout.js land",
		},
		reap: {
			usage: "usage: node scripts/session-checkout.js reap",
		},
	},
};

/**
 * A reap pass's report lines, each stranded or orphaned worktree with its way
 * out; none where it found nothing to do.
 * @param {Exclude<ReturnType<typeof reap>, { busy: number | null }>} r
 * @returns {string[]}
 */
function renderReaped(r) {
	const name = (/** @type {string} */ dir) => path.basename(dir);
	/** @type {[string[], string][]} */
	const counted = [
		[r.removed, "removed landed worktree"],
		[r.pruned, "pruned stale registration"],
		[r.strays, "removed unregistered directory"],
		[r.stores, "removed unlinked dependency store"],
	];
	return [
		...(r.fetchFailed
			? [
					`fetching landing failed, so origin/landing may be stale and read more work as unlanded: ${r.fetchFailed}`,
				]
			: []),
		...counted.flatMap(([items, what]) =>
			items.length > 0
				? [
						`${what}${items.length === 1 ? "" : "s"}: ${items.map(name).join(", ")}`,
					]
				: [],
		),
		...r.stranded.map(
			(s) =>
				`stranded: ${name(s.dir)} — ${[
					s.dirty > 0
						? `${s.dirty} uncommitted path${s.dirty === 1 ? "" : "s"}`
						: "",
					s.unlanded > 0
						? `${s.unlanded} commit${s.unlanded === 1 ? "" : "s"} not on origin/landing`
						: "",
				]
					.filter(Boolean)
					.join(
						", ",
					)}; idle ${describeAge(s.idleMs)}; last commit ${s.last} — its session is gone: land it with \`node scripts/session-checkout.js land\` from inside it, or, judged worthless, \`git worktree remove --force ${s.dir}\``,
		),
		...r.orphans.map(
			(dir) =>
				`orphaned: ${name(dir)} has a .git file but no registration, so git cannot read its uncommitted work — look through it, then remove it by hand`,
		),
		...r.failed.map((f) => `could not reap ${f}`),
	];
}

/**
 * Each command's run, saying what it did; a refusal throws.
 * @type {Record<string, (named: string | undefined) => void>}
 */
const RUN = {
	cut: (named) => {
		if (named === undefined) throw new Error("cut names no session");
		writeFd(1, `${cut(process.cwd(), named).dir}\n`);
	},
	"launch-dir": (named) => {
		if (named === undefined) throw new Error("launch-dir names no prompt");
		writeFd(1, `${launchDir(process.cwd(), named)}\n`);
	},
	attach: (named) => {
		const made = attach(path.resolve(named ?? process.cwd()));
		writeFd(
			2,
			made.store === null
				? `session checkout: ${made.dir} has no lockfile, so nothing is attached\n`
				: `session checkout: ${made.dir} uses ${made.store}${made.built ? ", built now" : ""}\n`,
		);
	},
	land: () => {
		const made = land(process.cwd());
		writeFd(
			2,
			made.pushed
				? `session checkout: pushed ${made.head} to landing${made.merged ? ", origin/landing merged in first" : ""}\n${made.lander}\n`
				: `session checkout: nothing to land — every commit of ${made.dir}'s HEAD is on origin/landing already\n`,
		);
	},
	reap: () => {
		const r = reap(process.cwd());
		if ("busy" in r) {
			writeFd(
				2,
				`session checkout: a reap pass is running already${r.busy ? ` (pid ${r.busy})` : ""}\n`,
			);
			return;
		}
		for (const line of renderReaped(r))
			writeFd(2, `session checkout: ${line}\n`);
		if (r.failed.length > 0)
			throw new Error(
				`${r.failed.length} item${r.failed.length === 1 ? "" : "s"} could not be reaped, named above — clear what each names; the next pass tries again`,
			);
	},
};

/**
 * @param {string[]} [argv]
 * @returns {number}
 */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	try {
		const command = RUN[String(parsed.command)];
		if (command === undefined)
			throw new Error(`no run for command ${parsed.command}`);
		command(parsed.positionals[0]);
		return 0;
	} catch (err) {
		const why = caught(err).message.trim();
		writeFd(
			2,
			`session checkout: ${err instanceof CheckoutError ? why : `failed: ${why}`}\n`,
		);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
