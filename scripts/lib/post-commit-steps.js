const path = require("node:path");
const { gitCommonDir, scrubbedGitEnv, spawnGitSync } = require("./git.js");
const { readTopLevel: readTreeTopLevel } = require("./git-tree.js");
const { inProgramScope } = require("./program-scope.js");
const { trimEndRun } = require("./trim-run.js");

/** @typedef {{ cwd: string, env: NodeJS.ProcessEnv }} HookIo */
/**
 * @typedef {HookIo & {
 *   readCommitted: () => string,
 *   readTopLevel: () => string | null,
 * }} RunIo
 */
/** @typedef {import("./program-scope.js").ProgramResult} ProgramResult */

/**
 * @typedef {{
 *   load: (script: string) => {
 *     PROGRAM?: (io: HookIo & { args: string[] }) => ProgramResult,
 *     SPEC?: import("./check.js").CheckSpec,
 *   },
 *   check: (
 *     spec: import("./check.js").CheckSpec,
 *     argv: string[],
 *     opts: { script: string },
 *   ) => Promise<ProgramResult>,
 * }} Programs
 */

/** @param {string} script */
const scriptAt = (script) => path.join(__dirname, "..", script);

/** @type {Programs} */
const PROGRAMS = {
	load: (script) => require(scriptAt(script)),
	check: (spec, argv, opts) =>
		require("./check.js").checkInProcess(spec, argv, opts),
};

/** @type {ProgramResult} */
const SILENT = Object.freeze({ exit: 0, stdout: "", stderr: "" });

/**
 * @param {HookIo} io
 * @param {string[]} args
 * @returns {string | null}
 */
function git({ cwd, env }, args) {
	const r = spawnGitSync(args, {
		cwd,
		env: scrubbedGitEnv(env),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (r.status !== 0 || r.error) return null;
	return trimEndRun(String(r.stdout), "\n");
}

/**
 * @param {HookIo} io
 * @returns {HookIo}
 */
const scrubbed = (io) => ({ cwd: io.cwd, env: scrubbedGitEnv(io.env) });

/**
 * @template T
 * @param {() => T} read
 * @returns {() => T}
 */
const once = (read) => {
	/** @type {{ value: T } | null} */
	let kept = null;
	return () => {
		kept ??= { value: read() };
		return kept.value;
	};
};

/**
 * @param {HookIo} io
 * @returns {RunIo}
 */
const buildRunIo = (io) => ({
	cwd: io.cwd,
	env: io.env,
	readCommitted: once(
		() => git(io, ["rev-parse", "--verify", "-q", "HEAD"]) ?? "",
	),
	readTopLevel: () =>
		inProgramScope(scrubbed(io), () => readTreeTopLevel(io.cwd)),
});

const PROGRAM_FILES = /** @type {const} */ ({
	newSharedFaults: "report-new-shared-faults.js",
	arbiter: "session-arbiter.js",
	keepShims: "keep-hook-shims.js",
	instructionSurface: "check-instruction-surface.js",
	guardRegistry: "check-guard-registry.js",
});

/**
 * @param {Programs} programs
 * @param {string} script
 * @param {HookIo} io
 * @param {string[]} args
 * @returns {ProgramResult}
 */
function runProgramAt(programs, script, io, args) {
	const { PROGRAM } = programs.load(script);
	if (!PROGRAM) throw new Error(`${script} exports no PROGRAM`);
	return PROGRAM({ ...scrubbed(io), args });
}

const BANG = "\u001b[33m!\u001b[0m";

/**
 * @param {RunIo} io
 * @returns {ProgramResult}
 */
function unpushedReport(io) {
	const toplevel = io.readTopLevel();
	if (toplevel === null) return SILENT;
	const ref = inProgramScope(scrubbed(io), () => {
		const { readUnpushedRef } = require("./landing-refs.js");
		return readUnpushedRef({ tree: toplevel });
	});
	if (git(io, ["rev-parse", "--verify", "-q", ref]) === null)
		return {
			exit: 0,
			stdout: `${BANG} ${ref} does not exist here — nothing is tracking these commits.\n`,
			stderr: "",
		};
	const ahead = git(io, ["rev-list", "--count", `${ref}..HEAD`]);
	if (ahead === null || !/^\d+$/.test(ahead) || Number(ahead) <= 0)
		return SILENT;
	return {
		exit: 0,
		stdout:
			Number(ahead) === 1
				? `${BANG} 1 commit not pushed to ${ref}.\n`
				: `${BANG} ${ahead} commits not pushed to ${ref}.\n`,
		stderr: "",
	};
}

/**
 * @param {RunIo} io
 * @param {Programs} [programs]
 * @returns {ProgramResult}
 */
function newSharedFaultsRow(io, programs = PROGRAMS) {
	const committed = io.readCommitted();
	if (!committed || io.readTopLevel() === null) return SILENT;
	const r = runProgramAt(programs, PROGRAM_FILES.newSharedFaults, io, [
		committed,
	]);
	const out = trimEndRun(r.stdout, "\n");
	return {
		exit: 0,
		stdout: (out ? `${out}\n` : "") + (r.exit === 2 ? r.stderr : ""),
		stderr: "",
	};
}

/**
 * @param {string} script
 * @returns {(io: RunIo, programs?: Programs) => Promise<ProgramResult>}
 */
const touchedByRow =
	(script) =>
	async (io, programs = PROGRAMS) => {
		const toplevel = io.readTopLevel();
		const committed = io.readCommitted();
		if (toplevel === null || !committed) return SILENT;
		const { SPEC } = programs.load(script);
		if (!SPEC) throw new Error(`${script} exports no SPEC`);
		const r = await inProgramScope(scrubbed(io), () =>
			programs.check(SPEC, ["--root", toplevel, "--touched-by", committed], {
				script: scriptAt(script),
			}),
		);
		const out = trimEndRun(r.stderr, "\n");
		const said =
			r.exit === 0
				? out !== "" && !out.startsWith("OK:")
				: /passed its [\s\S]* ceiling/.test(out);
		return said ? { exit: 0, stdout: `${out}\n`, stderr: "" } : SILENT;
	};

/**
 * @param {RunIo} io
 * @param {Programs} [programs]
 * @returns {ProgramResult}
 */
function releaseClaimsRow(io, programs = PROGRAMS) {
	const committed = io.readCommitted();
	if (!committed || io.readTopLevel() === null) return SILENT;
	const listed = git(io, [
		"-c",
		"core.quotePath=false",
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		"--root",
		committed,
	]);
	if (!listed) return SILENT;
	const paths = listed.split("\n").filter((rel) => rel !== "");
	const r = runProgramAt(programs, PROGRAM_FILES.arbiter, io, [
		"release-committed",
		"--commit",
		committed,
		...paths,
	]);
	return { exit: 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * @param {RunIo} io
 * @param {Programs} [programs]
 * @returns {ProgramResult}
 */
function recordCommitRow(io, programs = PROGRAMS) {
	if (!io.env.CLAUDE_CODE_SESSION_ID) return SILENT;
	const committed = io.readCommitted();
	if (!committed || io.readTopLevel() === null) return SILENT;
	const common = gitCommonDir(io.cwd, { env: scrubbedGitEnv(io.env) });
	if (common === null || !common.endsWith("/.git")) return SILENT;
	const r = runProgramAt(
		programs,
		PROGRAM_FILES.arbiter,
		{
			cwd: io.cwd,
			env: { ...io.env, CLAUDE_PROJECT_DIR: common.slice(0, -"/.git".length) },
		},
		["record-commit", committed],
	);
	return { exit: 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * @param {RunIo} io
 * @param {Programs} [programs]
 * @returns {ProgramResult}
 */
function keepShimsRow(io, programs = PROGRAMS) {
	if (io.readTopLevel() === null) return SILENT;
	const r = runProgramAt(programs, PROGRAM_FILES.keepShims, io, ["--lazy"]);
	return { exit: 0, stdout: r.stdout, stderr: r.stderr };
}

const REVIEW_TIER_LINE = /^Review-Tier[ \t\v\f\r]*:/i;

/** @param {string | null} message */
const carriesReviewTier = (message) =>
	(message ?? "").split("\n").some((line) => REVIEW_TIER_LINE.test(line));

const DROPPED_REVIEW_TIER =
	"post-commit: this amend dropped the Review-Tier: line the amended commit carried, so the review it recorded is now unrecorded. On an unchanged tree, amend again with that line in the message to keep it.\n";

/**
 * @param {RunIo} io
 * @returns {ProgramResult}
 */
function droppedReviewTier(io) {
	const subject = git(io, ["reflog", "-1", "--format=%gs", "HEAD"]);
	if (!subject?.startsWith("commit (amend):")) return SILENT;
	if (!carriesReviewTier(git(io, ["log", "-1", "--format=%B", "HEAD@{1}"])))
		return SILENT;
	if (carriesReviewTier(git(io, ["log", "-1", "--format=%B", "HEAD"])))
		return SILENT;
	return { exit: 0, stdout: "", stderr: DROPPED_REVIEW_TIER };
}

module.exports = {
	PROGRAM_FILES,
	buildRunIo,
	droppedReviewTier,
	keepShimsRow,
	newSharedFaultsRow,
	recordCommitRow,
	releaseClaimsRow,
	touchedByRow,
	unpushedReport,
};
