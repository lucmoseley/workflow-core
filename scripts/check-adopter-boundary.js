#!/usr/bin/env node

const path = require("node:path");
const { runCheck } = require("./lib/check");
const { readText } = require("./lib/file-read.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { spawnGitSync } = require("./lib/git.js");
const { isUnder } = require("./lib/is-under.js");
const { initPaths } = require("./lib/init-adopter-core.js");
const { MODULES } = require("./lib/workflow-core-config.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {"ships" | "written" | "machine" | "core"} Group */

const PAGE = "docs/adopter-boundary.md";

/** @type {ReadonlyArray<readonly [Group, string]>} */
const GROUPS = [
	["ships", "Ships in the plugin"],
	["written", "Written into the adopter"],
	["machine", "Reaches adopters through this machine only"],
	["core", "Stays core-only"],
];

/**
 * @param {string} text
 * @returns {Map<Group, string[]>}
 */
function parsePage(text) {
	/** @type {Map<Group, string[]>} */
	const named = new Map();
	/** @type {Group | null} */
	let group = null;
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			const title = line.slice(3).trim();
			group = GROUPS.find(([, t]) => t === title)?.[0] ?? null;
			if (group) named.set(group, []);
			continue;
		}
		if (!group || !line.startsWith("- ")) continue;
		const head = line.split(" — ")[0] ?? "";
		for (const m of head.matchAll(/`([^`\s]+)`/g))
			named.get(group)?.push((m[1] ?? "").replace(/\/$/, ""));
	}
	return named;
}

/**
 * @param {string} root
 * @param {Ctx} ctx
 * @returns {string[]}
 */
function readTopLevelPaths(root, ctx) {
	const r = spawnGitSync(["ls-files", "-z"], { cwd: root, encoding: "utf8" });
	if (r.status !== 0) ctx.broken(`git ls-files failed in ${root}`);
	return [
		...new Set(
			String(r.stdout)
				.split("\0")
				.filter(Boolean)
				.map((rel) => rel.split("/")[0] ?? rel),
		),
	];
}

/**
 * @param {Ctx} ctx
 * @param {Map<Group, string[]>} named
 * @param {Record<Exclude<Group, "machine">, (rel: string) => boolean>} classifies
 */
function groupFaults(ctx, named, classifies) {
	for (const [group, title] of GROUPS) {
		if (!named.has(group))
			ctx.fail("MISSING-GROUP", `${PAGE} has no \`## ${title}\` heading`, {
				group,
			});
		if (group === "machine") continue;
		for (const rel of named.get(group) ?? [])
			if (!classifies[group](rel))
				ctx.fail(
					"WRONG-GROUP",
					`${PAGE} names \`${rel}\` under "${title}", which the code does not put it in — move it to the group it belongs to`,
					{ group, path: rel },
				);
	}
}

/**
 * @param {Ctx} ctx
 * @param {string[]} all
 * @param {Iterable<string>} entries
 * @param {string[]} tops
 */
function coverageFaults(ctx, all, entries, tops) {
	for (const rel of new Set(entries))
		if (!all.includes(rel))
			ctx.fail(
				"UNNAMED",
				`${PAGE} names \`${rel}\` in no group — add it to the group the code puts it in`,
				{ path: rel },
			);
	for (const top of tops)
		if (!all.some((rel) => isUnder(rel, [top])))
			ctx.fail(
				"UNNAMED",
				`${PAGE} names the top-level path \`${top}\` in no group — add it, or a path under it, to the group it belongs to`,
				{ path: top },
			);
}

/** @param {Ctx} ctx */
function run(ctx) {
	const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
	const page = readText(path.join(root, PAGE));
	if (page.state === "absent")
		return ctx.skip(`no ${PAGE}: an adopter, which holds no boundary page.`);
	if (page.state === "unreadable")
		return ctx.broken(`${PAGE} will not read: ${page.message}`);
	const tree = require("./lib/plugin-tree.js");
	const written = new Set([
		...initPaths([...MODULES]),
		...tree.HOST_OWNED_DOCS,
	]);
	const named = parsePage(page.data);
	groupFaults(ctx, named, {
		ships: (rel) => tree.isShipped(root, rel),
		written: (rel) => written.has(rel),
		core: (rel) => !tree.isShipped(root, rel),
	});
	const all = [...named.values()].flat();
	coverageFaults(
		ctx,
		all,
		[...tree.COPIED, ...tree.LEFT_BEHIND, ...tree.KEPT, ...written],
		readTopLevelPaths(root, ctx),
	);
	for (const f of ctx.findings) ctx.say(`  ${f.message}`);
	if (ctx.findings.length > 0)
		ctx.say(
			`  ${PAGE} is the founder's boundary page; fix it in the commit that moves the path (#5294).`,
		);
	return {
		okLine: `${PAGE} names ${all.length} path(s), each in the group the code puts it in.`,
		noun: "boundary page fault(s)",
		count: ctx.findings.length,
	};
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "adopter-boundary",
	usage: "node check-adopter-boundary.js [--root <dir>] [--json] [--warn]",
	valueFlags: ["--root"],
	run,
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
