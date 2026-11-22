#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { execGit } = require("./lib/git.js");

const SKILLS_DIR = path.join(".claude", "skills");
const COMMANDS_DIR = path.join(".claude", "commands");
const ARG_TOKEN_RE = /(?<!\\)\$\d+/g;

// lucmoseley/mantahostels#2495 guess
const CAP_BYTES = 16_000;

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rel
 * @param {boolean} [recursive]
 * @returns {string[]}
 */
function readDirNames(ctx, root, rel, recursive = false) {
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
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {string[]}
 */
function readOwnBodyPaths(ctx, root) {
	const dir = path.join(root, SKILLS_DIR);
	const names = readDirNames(ctx, root, SKILLS_DIR);
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
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {string[]}
 */
function readCommandBodyPaths(ctx, root) {
	return readDirNames(ctx, root, COMMANDS_DIR, true)
		.filter((n) => n.endsWith(".md"))
		.map((n) => path.join(COMMANDS_DIR, n))
		.sort();
}

/**
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
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rev
 * @returns {Set<string>}
 */
function readTouchedPaths(ctx, root, rev) {
	let out = "";
	try {
		out = execGit(["diff", "--name-only", rev], {
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
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rev
 * @param {string} rel
 * @returns {number}
 */
function readSizeAt(ctx, root, rev, rel) {
	try {
		return execGit(["show", `${rev}:${rel}`], {
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

/** @param {Ctx} ctx */
function capOf(ctx) {
	const capArg = ctx.value("--cap");
	if (capArg === null) return CAP_BYTES;
	const cap = Number(capArg);
	if (!Number.isInteger(cap) || cap <= 0)
		ctx.usageError(`--cap needs a positive integer, got ${capArg}`);
	return cap;
}

/**
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
		touching === null ? null : bytes - readSizeAt(ctx, root, touching, rel);
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
	valueFlags: ["--root", "--cap", "--touching"],
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const cap = capOf(ctx);
		const touching = ctx.value("--touching");
		// #43
		if (!fs.existsSync(root))
			ctx.broken(`the host root ${root} does not exist — nothing was measured`);

		if (
			![SKILLS_DIR, COMMANDS_DIR].some((d) => fs.existsSync(path.join(root, d)))
		)
			ctx.skip(
				`this repo has no ${SKILLS_DIR} or ${COMMANDS_DIR} — no skill or command bodies to check`,
			);
		const all = readOwnBodyPaths(ctx, root);
		const commands = readCommandBodyPaths(ctx, root);
		const touched =
			touching === null ? null : readTouchedPaths(ctx, root, touching);
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

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
