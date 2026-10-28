#!/usr/bin/env node
/*
 * check-scripts-typecheck.js — reports every `scripts/` JS file that has opted
 * OUT of type checking, and whether it said why (mantahostels#1464, under map mantahostels#1076).
 *
 * Usage:
 *   node check-scripts-typecheck.js [--full] [--notify] [--json] [--warn]
 *   [--root <dir>] points every read at another checkout, for the tests.
 *
 * WHAT IT WAS, AND WHY IT IS NOT THAT ANY MORE. Until mantahostels#1464 `tsconfig.json`
 * listed this corpus in `include` with `checkJs` OFF, so a file was checked
 * only if it carried `// @ts-check`, and this script counted how many still
 * did not. That count reached zero and the flag went on, so the pragma, the
 * pre-commit ratchet that demanded one on a new file, and the burndown itself
 * all retired together. The corpus is checked by default now.
 *
 * WHAT IS LEFT TO WATCH. `checkJs` makes silencing a whole file a one-line
 * edit — `// @ts-nocheck` at the top — and nothing else in the repo reports
 * one. That is the whole subject here.
 *
 * IT NEVER GATES. Standing repo state, read on `npm run status` and in the
 * scheduled sweep, and the session reading it is rarely the one that wrote the
 * pragma — so every finding is WARN (§N4).
 *
 * A SILENCED FILE OWES A REASON. §N8 sends the reason to §G3 and fixes its
 * spelling so this can read it: `NO type checking (§N8).` followed by why.
 * A file silenced with no reason is the sharper finding of the two, and --full
 * is where the reasons are printed.
 *
 * QUIET WHEN NOTHING MOVED, AND THAT IS A DEPARTURE (§G4). Under --notify the
 * subject is whether the count MOVED, not the count itself, so an unchanged
 * count raises no finding and the outcome is OK. It bends §N4's "severity is a
 * property of the finding": `--json --notify` reports OK beside a non-zero
 * `data.silenced`, so **never read a machine verdict off --notify** — every
 * other invocation reports the standing number and raises the finding.
 *
 * **Residual:** the cache is one file per checkout, not per session, so in a
 * tree running a dozen sessions a change is announced to whichever session
 * starts first and withheld from the rest.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), counts the scripts/ .js files that have silenced the type checker and reports the standing number; --notify alone narrows that to a count that has moved.
 * JUSTIFIED: fail-safe — `checkJs` is repo-wide (mantahostels#1464), so opting a file out is a one-line edit that no gate sees.
 * DEFEAT:    none; --notify is silent while the count holds.
 */

const fs = require("node:fs");
const { markersDir } = require("./lib/marker-root.js");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { hostRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { execGit } = require("./lib/git.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

/** @typedef {{ path: string, lines: number, reason: string|null }} Silenced */

/* The two globs tsconfig.json lists in `include` for this corpus — scripts/ at
 * any depth, and the skill scripts narrowed to one directory level so the 25
 * vendored skill symlinks are never walked into (mantahostels#1147). */
const IN_SCOPE = [
	/^scripts\/.+\.js$/,
	/^\.claude\/skills\/[^/]+\/scripts\/[^/]+\.js$/,
];

const isInScope = (/** @type {string} */ p) =>
	IN_SCOPE.some((re) => re.test(p));

/* The pragma as TypeScript reads it: a whole comment line and nothing else. A
 * loose substring match would read a file that merely NAMES the pragma — this
 * one, and §N8's own prose — as having used it. */
const NOCHECK = /^[ \t]*\/\/[ \t]*@ts-nocheck[ \t]*$/m;

/* The spelling §N8 prescribes for the reason, so it can be read back here. */
const REASON = /NO\s+type\s+checking\s*\(§N8\)\.?\s*(.*)/;

/**
 * The leading shebang/comment/blank region — where TypeScript honours
 * `@ts-nocheck` and where §N2 puts the header block. Scanning the whole file
 * would count a pragma quoted inside a doc comment far below the code, which
 * TypeScript ignores.
 */
const preamble = (/** @type {string} */ src) => {
	const out = [];
	let inBlock = false;
	for (const line of src.split("\n")) {
		const t = line.trim();
		if (inBlock) {
			out.push(line);
			if (t.includes("*/")) inBlock = false;
			continue;
		}
		if (t === "" || t.startsWith("#!") || t.startsWith("//")) {
			out.push(line);
			continue;
		}
		if (t.startsWith("/*")) {
			out.push(line);
			if (!t.includes("*/")) inBlock = true;
			continue;
		}
		break;
	}
	return out.join("\n");
};

/**
 * Whether a file has silenced the checker, and the reason it gave — null where
 * it gave none.
 *
 * @param {string} src
 * @returns {{silenced: boolean, reason: string|null}}
 */
const classify = (src) => {
	const pre = preamble(src);
	if (!NOCHECK.test(pre)) return { silenced: false, reason: null };
	const m = REASON.exec(pre);
	const said = m
		? requiredGroup(m, 1, REASON)
				.trimEnd()
				.replace(/\*\/?$/, "")
				.trim()
		: "";
	return { silenced: true, reason: said || null };
};

/** git, with every failure landing as BROKEN: this is reading apparatus. */
const git = (
	/** @type {Ctx} */ ctx,
	/** @type {string} */ root,
	/** @type {string[]} */ args,
	/** @type {string} */ what,
) => {
	try {
		return execGit(args, {
			cwd: root,
			encoding: "utf8",
		});
	} catch (e) {
		return ctx.broken(`git ${args[0]} failed while ${what}: ${errMessage(e)}`);
	}
};

const nulList = (/** @type {string} */ out) => out.split("\0").filter(Boolean);

/**
 * Every tracked in-scope `.js` path, and the ones that have silenced the
 * checker. Reads the worktree, which is what this is about — the standing
 * state of the checkout.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {{paths: string[], silenced: Silenced[]}}
 */
const survey = (ctx, root) => {
	const paths = nulList(
		git(
			ctx,
			root,
			["ls-files", "-z", "--", "scripts", ".claude/skills"],
			"enumerating the tracked set",
		),
	).filter(isInScope);

	/** @type {Silenced[]} */
	const silenced = [];
	for (const p of paths) {
		let src;
		try {
			src = fs.readFileSync(path.join(root, p), "utf8");
		} catch (e) {
			/* Usually a neighbour's unstaged delete in the shared tree, not a repo
			 * fault — but git is the reading apparatus, so it is BROKEN either way
			 * (check.js:16-26), and a partial count read as a verdict is worse. */
			return ctx.broken(
				`cannot read tracked file ${p} — often a neighbour's unstaged delete in the shared tree; re-run: ${errMessage(e)}`,
			);
		}
		const { silenced: off, reason } = classify(src);
		if (off) silenced.push({ path: p, lines: src.split("\n").length, reason });
	}
	return { paths, silenced };
};

/**
 * The silenced count the last --notify run cached, or null where there is no
 * baseline; the cache is then rewritten with this run's count.
 *
 * @param {string} statePath
 * @param {number} count
 * @returns {number|null}
 */
const swapBaseline = (statePath, count) => {
	let previous = null;
	try {
		previous = JSON.parse(fs.readFileSync(statePath, "utf8")).silenced;
	} catch {
		/* Absent, unreadable or corrupt all mean the same thing here — no
		 * baseline — so the check speaks, which is the safe direction: the
		 * cost is one extra line, against a file silenced and nobody hearing
		 * about it. Not reported: a first run and a corrupt cache are
		 * indistinguishable to a reader, and the file is regenerated below. */
		previous = null;
	}
	try {
		fs.writeFileSync(
			statePath,
			`${JSON.stringify({ silenced: count, at: new Date().toISOString() }, null, 2)}\n`,
		);
	} catch {
		/* Fails open: a read-only checkout must not cost the run its
		 * verdict. Uncached, it simply speaks on every --notify run until the
		 * write works. */
	}
	return previous;
};

/**
 * One finding per silenced file — with a reason or without — and §N8's
 * spelling where any declares none.
 *
 * @param {Ctx} ctx
 * @param {Silenced[]} silenced
 */
const warnSilenced = (ctx, silenced) => {
	/* Two findings, not one: a file silenced WITH a reason is a decision §N8
	 * allows and this only reports; one silenced without is the rule breach. */
	const unexplained = silenced.filter((s) => !s.reason);
	for (const s of silenced)
		ctx.warn(
			s.reason ? "TYPECHECK-SILENCED" : "TYPECHECK-SILENCED-NO-REASON",
			s.reason
				? `${s.path} carries \`// @ts-nocheck\`: ${s.reason}`
				: `${s.path} carries \`// @ts-nocheck\` and declares no reason — §N8 sends that reason to §G3`,
			{ path: s.path, lines: s.lines, reason: s.reason },
		);
	if (unexplained.length > 0)
		ctx.say(
			`\n  ${unexplained.length} of them declare no reason. §N8's spelling, in the header:\n` +
				"    NO type checking (§N8). <what the file does that defeats inference>",
		);
};

runCheck({
	name: "scripts-typecheck",
	usage:
		"node check-scripts-typecheck.js [--full] [--notify] [--json] [--warn] [--root <dir>]",
	valueFlags: ["--root"],
	flags: ["--full"],
	run(/** @type {Ctx} */ ctx) {
		const root = ctx.value("--root") || hostRoot();
		const { paths, silenced } = survey(ctx, root);

		const statePath = path.join(
			markersDir(root),
			".scripts-typecheck-state.json",
		);
		let previous = null;
		if (ctx.notify) {
			previous = swapBaseline(statePath, silenced.length);
			if (previous === silenced.length)
				return {
					okLine: `${silenced.length} file(s) have silenced the type checker, unchanged since the last run.`,
					data: { total: paths.length, silenced: silenced.length },
				};
		}

		if (silenced.length === 0)
			return {
				okLine: `all ${paths.length} in-scope .js file(s) are type-checked; none carries \`// @ts-nocheck\`.`,
				noun: "scripts/ .js file(s) that have silenced the type checker",
				count: 0,
				data: { total: paths.length, silenced: [] },
			};

		ctx.say(
			`${silenced.length} of ${paths.length} in-scope .js file(s) carry ` +
				"`// @ts-nocheck`, so tsc reads nothing in them:",
		);
		for (const s of silenced)
			ctx.say(
				ctx.has("--full")
					? `  ${s.path}  (${s.lines} lines)\n    ${s.reason || "NO REASON DECLARED"}`
					: `  ${s.path}`,
			);
		if (ctx.notify && previous !== null)
			ctx.say(`  Was ${previous} at the last session that read this.`);

		warnSilenced(ctx, silenced);

		return {
			okLine: `all ${paths.length} in-scope .js file(s) are type-checked; none carries \`// @ts-nocheck\`.`,
			noun: "scripts/ .js file(s) that have silenced the type checker",
			count: silenced.length,
			data: { total: paths.length, silenced },
		};
	},
});
