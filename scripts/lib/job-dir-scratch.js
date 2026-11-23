const path = require("node:path");
const { parseCommand, walkCommands, normAbs } = require("./shell-parse.js");
const { literal } = require("./shell-words.js");
const { SCRATCH_DIR } = require("./scratch-dir.js");
const { isJobDir, jobRel } = require("./job-dir.js");
const { readJobDir } = require("./job-paths.js");
const { remedyKind } = require("./scratch-remedy.js");
const { ruleOrFallback } = require("./guard-verdict.js");
const { treeOrHost } = require("./tree-or.js");
const { isUnder } = require("./is-under.js");

/**
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {{ flat: string, flatName: string, stray: string }} Found
 */

const JOB_DIR_STANDIN = "/CLAUDE_JOB_DIR";

const RULE = "job-dir-scratch";

const STANDS_ALONE_RE = /^[/$~]/;

// #5600
/** @param {string} lit @param {string} cwd */
const landingOf = (lit, cwd) => {
	if (STANDS_ALONE_RE.test(lit)) return lit;
	return cwd ? path.posix.join(cwd, lit) : "";
};

/** @param {string | null} rel */
function flatName(rel) {
	if (rel === null || !rel.startsWith("tmp/")) return null;
	const name = rel.slice(4);
	return name && !name.includes("/") ? name : null;
}

const CHECKOUT_SCRATCH_RE = /^tmp\/[^/]+\/(?:.*\/)?\.claude\/tmp\/./s;

/** @param {string | null} rel */
function inCheckoutScratch(rel) {
	return rel !== null && CHECKOUT_SCRATCH_RE.test(rel);
}

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Decision}
 */
function decide(subject, ctx) {
	/** @type {Found} */
	const found = { flat: "", flatName: "", stray: "" };
	const live = readJobDir(ctx.env);
	/** @param {string} shown @param {string} p @param {string | null} jobDir */
	const classify = (shown, p, jobDir) => {
		const raw = jobRel(p, { pwd: ctx.fallbackCwd, jobDir });
		const rel = raw === null ? null : path.posix.normalize(raw);
		if (inCheckoutScratch(rel)) return;
		const name = found.flat ? null : flatName(rel);
		if (name !== null) {
			found.flat = shown;
			found.flatName = name;
		} else if (!found.stray) found.stray = shown;
	};
	if (ctx.tool === "Bash") {
		const jobDir = live ?? JOB_DIR_STANDIN;
		const parsed = parseCommand(subject);
		walkCommands(
			parsed,
			(cmd) => {
				for (const { target, cwd } of writesFromEveryDir(cmd))
					if (!found.flat)
						considerTarget(target, cwd, {
							spans: parsed.spans,
							where: { pwd: ctx.fallbackCwd, jobDir },
							classify,
						});
			},
			{
				...ctx,
				vars: { ...ctx.vars, CLAUDE_JOB_DIR: jobDir },
				bareRedirects: true,
			},
		);
	} else {
		const p = subject.startsWith("/") ? normAbs(subject) : subject;
		if (isJobDir(p, { pwd: ctx.fallbackCwd, jobDir: live }))
			classify(subject, p, live);
	}
	if (!found.flat && !found.stray) return null;
	const rule = ruleOrFallback(
		ctx,
		"job-dir-scratch",
		"Session scratch goes in .claude/tmp/, never under $CLAUDE_JOB_DIR",
	);
	if (found.flat) return { deny: ctx.corePaths(refusal(found, rule, ctx)) };
	if (ctx.told(RULE)) return null;
	return {
		injectRules: [],
		prelude: ctx.corePaths(
			`Warn only, nothing refused: this writes session scratch under the job directory — ${found.stray}\n\n${rule}\n`,
		),
		latchAfter: RULE,
	};
}

/** @param {import("./shell-parse.js").Command} cmd */
function* writesFromEveryDir(cmd) {
	for (const run of cmd.runs()) {
		const [first, ...rest] = run.dirs();
		for (const cwd of [first, ...rest.filter(Boolean)])
			for (const t of cmd.writeTargets(run.words, cwd))
				if (t.mode === "write") yield { target: t, cwd };
	}
}

/**
 * @param {import("./shell-parse.js").WriteTarget} target
 * @param {string} cwd
 * @param {{ spans: string[], where: import("./job-dir.js").Where,
 *   classify: (shown: string, p: string, jobDir: string | null) => void }} at
 */
function considerTarget({ target: word, path: resolved }, cwd, at) {
	const { spans, where, classify } = at;
	const lit = literal(word, spans).text;
	if (!lit) return;
	const p = resolved || landingOf(lit, cwd);
	if (!p) return;
	if (!isJobDir(p, where)) return;
	const landed = isUnder(p, [JOB_DIR_STANDIN])
		? `$CLAUDE_JOB_DIR${p.slice(JOB_DIR_STANDIN.length)}`
		: p;
	classify(
		landed === lit ? lit : `${lit} (lands at ${landed})`,
		p,
		where.jobDir,
	);
}

/** @type {Record<import("./scratch-remedy.js").RemedyKind, (sanctioned: string) => string>} */
const REMEDY = {
	write: (s) => `Same write, sanctioned path: ${s}`,
	move: (s) => `Move it to ${s}, then edit it there.`,
	command: (s) => `Same command, sanctioned target: ${s}`,
};

/**
 * @param {Found} found
 * @param {string} rule
 * @param {CoreContext} ctx
 */
function refusal(found, rule, ctx) {
	const sanctioned = `${treeOrHost(ctx).root}/${SCRATCH_DIR}${found.flatName}`;
	return `Refused: this writes a file straight into the job directory's own tmp folder — ${found.flat}

Session scratch goes in \`.claude/tmp/\`. ${REMEDY[remedyKind(ctx.tool)](sanctioned)}

A fixture, or a child session's directory, that must sit outside the repo goes in a subfolder of its own under the job directory (\`<job dir>/tmp/<name>/<file>\`), which is warned once a session and never refused (#1139).

${rule}`;
}

module.exports = {
	field: ["command", "file_path", "notebook_path"],
	noun: "write",
	decide,
};
