#!/usr/bin/env node
/*
 * check-surface-contract.js — does the helper surface still offer every export
 * the last release promised adopters? (#463, spec #457)
 *
 * Compares scripts/lib/helper-surface.json at HEAD against the same file at the
 * last release tag (lib/release-tags.js, the tag release-plugin.js
 * judges a major bump against). An added entry point or export passes whatever
 * the version. A removed one — and a rename, which reads as a removal — FAILs
 * unless plugin.json's version is a major bump over that tag AND
 * migrations/v<version>.md exists. The note's shape is release-plugin.js's to
 * refuse, not this checker's. A listed command's argv contract is held the
 * same way (#655): a dropped command, flag, positional value or exit code, or
 * a positional renamed or moved, is a removal. A changed exit-code MEANING,
 * and a newly required flag or positional, pass unseen: the manifest marks
 * neither.
 *
 * THE MANIFEST IS THE SURFACE. That each listed name is really exported is
 * helper-surface.test.ts's to prove.
 *
 * READS COMMITS ONLY, as release-plugin.js does: a working-tree read would
 * judge a neighbour's half-written manifest. Commit an edit before checking it.
 *
 * NEEDS THE TAGS FETCHED. A checkout with none reads as "no release yet" and
 * SKIPs, so the CI step fetches them first.
 */

const { execFileSync } = require("node:child_process");
const { hostRoot } = require("./lib/host-root.js");
const { runCheck } = require("./lib/check");
const { TAG_RE, isMajorBump, latestTag } = require("./lib/release-tags.js");
const { MIGRATIONS_DIR } = require("./lib/workflow-core-config.js");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
/** @typedef {Record<string, string[]>} EntryPoints */
/** @typedef {{name: string, values?: string[]}} Positional */
/** @typedef {Record<string, {positionals: Positional[], flags: {name: string}[], exit: Record<string, string>}>} Commands */
/** @typedef {{file: string, name: string | null, key: string, what: string}} Removal */

const MANIFEST = "scripts/lib/helper-surface.json";

/**
 * @param {Ctx} ctx
 * @param {string} text
 * @param {string} label named in a BROKEN
 * @returns {EntryPoints}
 */
function entryPointsOf(ctx, text, label) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		ctx.broken(`${label} is not JSON — ${caught(e).message}`);
	}
	const entries = parsed?.entryPoints;
	const valid =
		entries !== null &&
		typeof entries === "object" &&
		!Array.isArray(entries) &&
		Object.values(entries).every(
			(names) =>
				Array.isArray(names) && names.every((n) => typeof n === "string"),
		);
	if (!valid) ctx.broken(`${label} has no entryPoints object of name lists`);
	return entries;
}

/**
 * The manifest's `commands`, none where it lists none (#655).
 * @param {Ctx} ctx
 * @param {string} text
 * @param {string} label named in a BROKEN
 * @returns {Commands}
 */
function commandsOf(ctx, text, label) {
	const commands = JSON.parse(text).commands ?? {};
	const named = (/** @type {unknown} */ list) =>
		Array.isArray(list) && list.every((x) => typeof x?.name === "string");
	const valid =
		typeof commands === "object" &&
		!Array.isArray(commands) &&
		Object.values(commands).every(
			(c) =>
				named(c?.positionals) &&
				named(c?.flags) &&
				c.exit !== null &&
				typeof c.exit === "object",
		);
	if (!valid)
		ctx.broken(
			`${label}'s commands are not each { positionals, flags, exit } with named positionals and flags`,
		);
	return commands;
}

/**
 * One dropped surface part; `name` null where the whole file went.
 * @param {string} file
 * @param {string | null} name
 * @param {string} what
 * @returns {Removal}
 */
const removal = (file, name, what) => ({
	file,
	name,
	key: name === null ? `removed:${file}` : `removed:${file}#${name}`,
	what: `${file} ${what}`,
});

/**
 * What `current` dropped of the argv contract `before` promised: a command, a
 * positional at its place, a positional value, a flag, an exit code.
 * @param {Commands} before
 * @param {Commands} current
 * @returns {Removal[]}
 */
function removedCommandParts(before, current) {
	/** @type {Removal[]} */
	const removed = [];
	for (const [file, was] of Object.entries(before)) {
		const now = current[file];
		if (!now) {
			removed.push(removal(file, null, "is no longer a surface command"));
			continue;
		}
		const drop = (/** @type {string} */ part, /** @type {string} */ what) =>
			removed.push(removal(file, part, what));
		was.positionals.forEach((p, i) => {
			const at = now.positionals[i];
			if (at?.name !== p.name) {
				drop(
					`positional:${p.name}`,
					`no longer takes ${p.name} as positional ${i + 1}`,
				);
				return;
			}
			for (const v of p.values ?? [])
				if (!at.values?.includes(v))
					drop(`${p.name}=${v}`, `no longer accepts ${v} as its ${p.name}`);
		});
		for (const f of was.flags)
			if (!now.flags.some((g) => g.name === f.name))
				drop(f.name, `no longer lists the flag ${f.name}`);
		for (const code of Object.keys(was.exit))
			if (!(code in now.exit))
				drop(`exit:${code}`, `no longer lists exit ${code}`);
	}
	return removed;
}

/**
 * The plugin's version, BROKEN where plugin.json is not JSON or the version
 * is not X.Y.Z.
 * @param {Ctx} ctx
 * @param {string} pluginText
 * @returns {string}
 */
function pluginVersion(ctx, pluginText) {
	let version;
	try {
		version = JSON.parse(pluginText).version;
	} catch (e) {
		ctx.broken(`.claude-plugin/plugin.json is not JSON — ${caught(e).message}`);
	}
	if (typeof version !== "string" || !TAG_RE.test(`v${version}`))
		ctx.broken(
			`.claude-plugin/plugin.json's version \`${version}\` is not X.Y.Z`,
		);
	return version;
}

/**
 * What `current` dropped of the entry points `before` promised: a file, or a
 * name it exported.
 * @param {Record<string, string[]>} before
 * @param {Record<string, string[]>} current
 * @returns {Removal[]}
 */
function removedEntryPoints(before, current) {
	/** @type {Removal[]} */
	const removed = [];
	for (const [file, names] of Object.entries(before)) {
		const now = current[file];
		if (now === undefined) {
			removed.push(removal(file, null, "is no longer a surface entry point"));
			continue;
		}
		for (const name of names)
			if (!now.includes(name))
				removed.push(removal(file, name, `no longer lists ${name}`));
	}
	return removed;
}

runCheck({
	name: "surface-contract",
	usage: "node check-surface-contract.js [--warn]",
	run(/** @type {Ctx} */ ctx) {
		const root = hostRoot();
		const git = (/** @type {string[]} */ args) => {
			try {
				return execFileSync("git", args, {
					cwd: root,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (e) {
				ctx.broken(`git cannot read ${args.at(-1)} — ${caught(e).message}`);
			}
		};
		/** The file at `rev`, or null where `rev` has none. */
		const readAt = (/** @type {string} */ rev, /** @type {string} */ rel) =>
			git(["ls-tree", "--name-only", rev, "--", rel]) === ""
				? null
				: git(["show", `${rev}:${rel}`]);

		const pluginText = readAt("HEAD", ".claude-plugin/plugin.json");
		if (pluginText === null)
			ctx.skip("this repo publishes no plugin — no release to hold to");
		const currentText = readAt("HEAD", MANIFEST);
		if (currentText === null)
			ctx.skip(`this repo declares no helper surface (${MANIFEST})`);

		const version = pluginVersion(ctx, pluginText);

		const current = entryPointsOf(ctx, currentText, MANIFEST);

		let prior;
		try {
			prior = latestTag(root);
		} catch (e) {
			ctx.broken(`git cannot list the release tags — ${caught(e).message}`);
		}
		if (prior === null)
			ctx.skip("no release tag yet — the first release has nothing to break");
		const priorText = readAt(prior, MANIFEST);
		if (priorText === null)
			ctx.skip(
				`${prior} ships no ${MANIFEST} — nothing to hold the surface to until a release carries one`,
			);
		const before = entryPointsOf(ctx, priorText, `${prior}:${MANIFEST}`);

		const removed = removedEntryPoints(before, current);
		removed.push(
			...removedCommandParts(
				commandsOf(ctx, priorText, `${prior}:${MANIFEST}`),
				commandsOf(ctx, currentText, MANIFEST),
			),
		);
		const addedCount = Object.entries(current).reduce(
			(n, [file, names]) =>
				n + names.filter((name) => !before[file]?.includes(name)).length,
			0,
		);
		const addedNote = addedCount ? `, and adds ${addedCount} export(s)` : "";

		if (removed.length === 0)
			return {
				okLine: `the surface keeps every export ${prior} promised${addedNote}`,
			};

		const tag = `v${version}`;
		const noteRel = `${MIGRATIONS_DIR}/${tag}.md`;
		const isMajor = isMajorBump(tag, prior);
		const hasNote = readAt("HEAD", noteRel) !== null;
		if (isMajor && hasNote)
			return {
				okLine: `${tag} is a major bump over ${prior} carrying ${noteRel}, so it may drop ${removed.length} surface entr(ies)${addedNote}`,
			};

		const why = isMajor
			? `${tag} is a major bump over ${prior} but ships no ${noteRel}`
			: `${tag} is not a major bump over ${prior}`;
		for (const { file, name, key, what } of removed) {
			ctx.fail(
				"SURFACE-REMOVED",
				`${what}, and ${why}`,
				{ file, name, prior, version },
				key,
			);
			ctx.say(`  ${what}`);
		}
		ctx.say(
			`\n${prior} promised adopters every entry above (${MANIFEST}); a rename\n` +
				`reads as a removal. ${why}, so an adopter moving its pin would break.\n` +
				"Either restore the entries, or bump plugin.json to the next major and\n" +
				`write ${noteRel} saying what an adopter changes in its imports or commands.`,
		);
		return { noun: "surface entr(ies) removed without a major release" };
	},
});
