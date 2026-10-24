#!/usr/bin/env node
/*
 * check-skill-body-size.js — reports an own skill body that has grown past the
 * size at which its re-reading is a recurring cost (mantahostels#3136), and
 * refuses a skill or command body holding a `$<digit>` the harness would
 * rewrite (workflow-core#1490).
 *
 * Usage:
 *   node check-skill-body-size.js [--root <dir>] [--cap <bytes>] [--touching <rev>] [--json]
 *
 * WHY IT EXISTS. A skill body is loaded only when its skill is invoked, so it
 * sits outside the always-loaded pool check-context-budget.js caps and outside
 * check-always-loaded-pass.js's cadence — and a body re-read on every turn of a
 * frequent skill costs what a pool file does (mantahostels#3136).
 *
 * THE SIZE LIMB IS REPORT-ONLY, BY RULING (mantahostels#3136), which binds that
 * limb alone. WARN is the highest severity a size finding takes: a body over
 * the cap never refuses a commit, because the bytes are
 * usually a rule someone meant to add, and the right answer is a pass over the
 * file, not a smaller rule. BROKEN still exits 2 — the alphabet's, not this
 * checker's, choice.
 *
 * --touching <rev> IS A SCOPE FILTER, not lib/check.js's --against: it reads the
 * WORKING TREE and reports only the bodies `git diff --name-only <rev>` names,
 * with each one's byte delta against <rev>, so the report lands on the commit
 * that grows a body and says nothing about a neighbour's. THERE THE FINDING IS
 * DIRECTIONAL: an over-cap body warns only where this commit GREW it. A commit
 * that shrinks one, or touches it without adding a byte, gets a measured line
 * and no finding — otherwise every commit to a body already over the cap
 * would warn whatever it did, and a standing warn is one a session learns
 * to skip (mantahostels#3136's review). Without --touching every own body is censused, over
 * or not — the `npm run status` route, where the standing figure is the point.
 *
 * SCOPE is the OWN skills only: a `.claude/skills/<name>` that is a symlink is
 * vendored from .agents/skills/, and an edit there is lost on the next vendor
 * pull (check-context-budget.js's own/vendored split, mantahostels#1826). The whole file is
 * measured, frontmatter included — that is what the harness loads.
 *
 * THE TOKEN LIMB REFUSES. Invoked with arguments, the harness rewrites `$N` in
 * a skill or command body to the Nth argument, 0-based, and `$ARGUMENTS` to
 * them all; `\$N` is the escape (workflow-core#1490's triage, measured on CLI 2.1.296). It
 * reads every own SKILL.md and every `.md` under `.claude/commands/`, its
 * subdirectories included, code blocks included: a recipe needing positional
 * fields belongs in a script, since `\$1` in code breaks for a session that
 * opens the file with Read. Supporting files are read with
 * Read and never rewritten, so are out of scope. --touching narrows it as it
 * does the size limb.
 *
 * IMPLICIT:  on every commit, refuses one whose touched skill or command body holds an unescaped `$` followed by a digit.
 * JUSTIFIED: fail-safe — a skills directory or git it cannot read is BROKEN rather than green.
 * DEFEAT:    --warn caps the refusal to a warn; HUSKY=0 skips the stack. --touching reads the worktree, so a neighbour's unstaged `$1` in a body your commit also touches refuses your commit until it is escaped or committed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { execFileSync } = require("node:child_process");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");

const SKILLS_DIR = path.join(".claude", "skills");
const COMMANDS_DIR = path.join(".claude", "commands");
/** A `$` and digits the harness substitutes: any not escaped as `\$`. */
const ARG_TOKEN_RE = /(?<!\\)\$\d+/g;

/*
 * The cap, in bytes on disk. 16,000 B rounds where mantahostels#2495's trim of
 * concision-pass/SKILL.md landed (16,066 B), the one body whose read rate
 * mantahostels#1085 measured. ⚠ Applied to every own body as an unmeasured
 * generalisation: no other skill's invocation rate has been read. Re-measure
 * before moving it.
 */
const CAP_BYTES = 16_000;

/**
 * A directory's entries; none where it is absent, as an adopter keeping no
 * skills or commands of its own is — a subject absent, not apparatus broken
 * (workflow-core#2, workflow-core#33). BROKEN where it exists and cannot be read.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rel
 * @param {boolean} [recursive] subdirectories' entries too, as relative paths
 * @returns {string[]}
 */
function dirNames(ctx, root, rel, recursive = false) {
	try {
		return fs.readdirSync(path.join(root, rel), {
			recursive,
			encoding: "utf8",
		});
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT") return [];
		ctx.broken(`cannot read ${rel} — ${message}`);
	}
}

/**
 * Every own skill body, repo-relative, sorted.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {string[]}
 */
function ownBodies(ctx, root) {
	const dir = path.join(root, SKILLS_DIR);
	const names = dirNames(ctx, root, SKILLS_DIR);
	/** @type {string[]} */
	const out = [];
	for (const name of names) {
		const at = path.join(dir, name);
		let vendored;
		try {
			vendored = fs.lstatSync(at).isSymbolicLink();
		} catch (e) {
			ctx.broken(
				`cannot lstat ${path.join(SKILLS_DIR, name)} — ${caught(e).message}`,
			);
		}
		if (vendored) continue;
		const body = path.join(at, "SKILL.md");
		if (fs.existsSync(body)) out.push(path.join(SKILLS_DIR, name, "SKILL.md"));
	}
	return out.sort();
}

/**
 * Every command body, repo-relative, sorted — a namespaced one in a
 * subdirectory included, since the harness loads and rewrites it too.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {string[]}
 */
function commandBodies(ctx, root) {
	return dirNames(ctx, root, COMMANDS_DIR, true)
		.filter((n) => n.endsWith(".md"))
		.map((n) => path.join(COMMANDS_DIR, n))
		.sort();
}

/**
 * Refuse each unescaped `$<digit>` in one body, naming file, line and token.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rel
 */
function checkArgTokens(ctx, root, rel) {
	let text;
	try {
		text = fs.readFileSync(path.join(root, rel), "utf8");
	} catch (e) {
		ctx.broken(`cannot read ${rel} — ${caught(e).message}`);
	}
	for (const [i, line] of text.split("\n").entries())
		for (const m of line.matchAll(ARG_TOKEN_RE)) {
			const at = `${rel}:${i + 1}`;
			const message = `${at} holds ${m[0]}, which the harness rewrites to an argument when the body is invoked with any — escape it as \\${m[0]} in prose, move code that needs it into a script, or write $ARGUMENTS for an intended placeholder`;
			ctx.fail(
				"ARG-TOKEN",
				message,
				{ path: rel, line: i + 1, token: m[0] },
				`${at}:${m[0]}`,
			);
			ctx.say(`  argument token: ${message}`);
		}
}

/**
 * The paths the working tree differs from `rev` on. BROKEN when git cannot
 * answer — an unresolvable rev is the usual cause, and nothing was checked.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rev
 * @returns {Set<string>}
 */
function touchedPaths(ctx, root, rev) {
	let out = "";
	try {
		out = execFileSync("git", ["diff", "--name-only", rev], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		const { message, stderr } = caught(e);
		ctx.broken(
			`git diff --name-only ${rev} failed — ${(stderr ?? message).trim()}`,
		);
	}
	return new Set(out.split("\n").filter(Boolean));
}

/**
 * The body's size at `rev`, or 0 where it did not exist there — a new skill's
 * whole size is its delta. touchedPaths() has already proven git runs and
 * `rev` resolves, so the one failure read as absence is git saying the path
 * is not in that revision; anything else is apparatus and BROKEN, never a
 * silent 0 that would inflate the delta (docs/code-standards-base.md §N5).
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rev
 * @param {string} rel
 * @returns {number}
 */
function bytesAt(ctx, root, rev, rel) {
	try {
		return execFileSync("git", ["show", `${rev}:${rel}`], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
		}).length;
	} catch (e) {
		const { message, stderr } = caught(e);
		const err = String(stderr ?? "");
		if (/does not exist|exists on disk, but not in/.test(err)) return 0;
		ctx.broken(`git show ${rev}:${rel} failed — ${err.trim() || message}`);
	}
}

/** @param {number} n */
const signed = (n) => (n >= 0 ? `+${n}` : String(n));

/**
 * --cap as a positive integer, else CAP_BYTES.
 * @param {Ctx} ctx
 */
function capOf(ctx) {
	const capArg = ctx.value("--cap");
	if (capArg === null) return CAP_BYTES;
	const cap = Number(capArg);
	if (!Number.isInteger(cap) || cap <= 0)
		ctx.usageError(`--cap needs a positive integer, got ${capArg}`);
	return cap;
}

/**
 * Measure one body, warning where it is over the cap and grew, and returning
 * its row.
 * @param {Ctx} ctx
 * @param {{ root: string, rel: string, cap: number, touching: string | null }} at
 */
function measureBody(ctx, { root, rel, cap, touching }) {
	let bytes;
	try {
		bytes = fs.statSync(path.join(root, rel)).size;
	} catch (e) {
		ctx.broken(`cannot stat ${rel} — ${caught(e).message}`);
	}
	const delta =
		touching === null ? null : bytes - bytesAt(ctx, root, touching, rel);
	const over = bytes - cap;
	const row = { path: rel, bytes, delta, over };
	const change = delta === null ? "" : `, ${signed(delta)} B since ${touching}`;
	const grew = delta === null || delta > 0;
	if (over > 0 && grew) {
		const message = `${rel} is ${bytes} B, ${over} B over the ${cap} B cap${change}`;
		ctx.warn(
			"SKILL-BODY",
			message,
			{ path: rel, bytes, cap, over, delta },
			rel,
		);
		/* check.js prints a finding's tag and the count, never its message,
		 * so the figures a reader acts on are said here. */
		ctx.say(`  over cap: ${message}`);
	} else if (touching !== null) {
		const standing =
			over > 0
				? `still ${over} B over the ${cap} B cap, not grown here`
				: `${-over} B under the ${cap} B cap`;
		ctx.say(`  measured: ${rel} ${bytes} B${change}, ${standing}`);
	}
	return row;
}

const SPEC = {
	name: "skill-body-size",
	usage:
		"node check-skill-body-size.js [--root <dir>] [--cap <bytes>] [--touching <rev>] [--json]",
	/* --cap is the test seam: the boundary case asserts on a fabricated body. */
	valueFlags: ["--root", "--cap", "--touching"],
	run(/** @type {Ctx} */ ctx) {
		/* The HOST repo, through the one seam (workflow-core#1), never this script's parent:
		 * in a plugin install that is the plugin root, and `git diff` from it ran
		 * outside any repository. */
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const cap = capOf(ctx);
		const touching = ctx.value("--touching");
		/* A root that does not exist is a wrong CLAUDE_PROJECT_DIR or --root, not
		 * an adopter without skills — the absent-directories check below would
		 * read it as SKIP (workflow-core#43). */
		if (!fs.existsSync(root))
			ctx.broken(`the host root ${root} does not exist — nothing was measured`);

		if (
			![SKILLS_DIR, COMMANDS_DIR].some((d) => fs.existsSync(path.join(root, d)))
		)
			ctx.skip(
				`this repo has no ${SKILLS_DIR} or ${COMMANDS_DIR} — no skill or command bodies to check`,
			);
		const all = ownBodies(ctx, root);
		const commands = commandBodies(ctx, root);
		const touched =
			touching === null ? null : touchedPaths(ctx, root, touching);
		/** @param {string[]} paths */
		const scoped = (paths) =>
			touched === null ? paths : paths.filter((b) => touched.has(b));
		const bodies = scoped(all);
		const commandsInScope = scoped(commands);

		/** @type {{ path: string, bytes: number, delta: number | null, over: number }[]} */
		const measured = [];
		for (const rel of bodies)
			measured.push(measureBody(ctx, { root, rel, cap, touching }));
		const overCount = ctx.findings.length;
		if (overCount)
			ctx.say(
				"  Run the concision-pass skill over each as a whole-file audit — reported, never refused (mantahostels#3136).",
			);
		for (const rel of [...bodies, ...commandsInScope])
			checkArgTokens(ctx, root, rel);
		const tokenCount = ctx.findings.length - overCount;

		const scope =
			touching === null
				? `${all.length} own skill bodies and ${commands.length} command bodies`
				: `${bodies.length} of ${all.length} own skill bodies and ${commandsInScope.length} of ${commands.length} command bodies touched since ${touching}`;
		return {
			okLine: `${scope}: every skill body under the ${cap} B cap, and no unescaped $<digit>.`,
			noun:
				tokenCount > 0
					? "unescaped $<digit> token(s) in a skill or command body"
					: "skill body(ies) over the cap",
			data: { cap, touching, bodies: measured },
		};
	},
};

if (require.main === module) runCheck(SPEC);
