/*
 * drop-evidence.js — why the queue lander dropped a member, as text: the one
 * builder its fix ticket's body and the owning session's landing status both
 * read (#4950, spec #4947), so the two never say different things of a drop;
 * and the few words a fix ticket's comment gives for it.
 */

const { QUEUE_PREFIX } = require("./landing-refs.js");

/** @param {readonly string[]} files */
const buildFileList = (files) => files.map((f) => `- \`${f}\``).join("\n");

/* A gate's output, fenced so no reader takes it for the text around it, its
 * backtick runs broken so none closes the fence. */
const quoteBlock = (/** @type {string} */ text) =>
	`\`\`\`text\n${text.replaceAll("```", "'''")}\n\`\`\``;

/**
 * The type-check's first errors, quoted, or that its log showed none.
 * @param {readonly string[]} errors
 */
const buildTypeErrors = (errors) =>
	errors.length > 0
		? `its first errors:\n\n${quoteBlock(errors.join("\n"))}`
		: "whose errors its log did not name";

/**
 * What a red did twice: failed its files, the type-check where that failed,
 * or the whole suite where the red named neither.
 * @param {{files: readonly string[], typecheck?: readonly string[]}} red
 * @param {boolean} onMain whether `main` is known to pass them
 */
function buildFailed({ files, typecheck }, onMain) {
	const where = onMain ? ", where `main` passes it" : "";
	const typecheckClause =
		typecheck && `the type-check twice${where}, ${buildTypeErrors(typecheck)}`;
	if (files.length === 0)
		return `failed ${typecheckClause ?? `the whole suite twice, naming no file${where}`}`;
	const listed = onMain
		? "these files twice, which pass on `main` there"
		: "twice";
	return `failed ${listed}:\n${buildFileList(files)}${typecheckClause ? `\n\nIt also failed ${typecheckClause}` : ""}`;
}

const NO_RUN =
	"no CI run fired for this tree, twice, where `main` passes, so its workflow's push triggers likely miss the lander's `lander/*` refs";

/**
 * @param {Pick<import("./lander-records.js").Drop, "onto" | "cause">} d
 * @returns {string}
 */
function buildDropEvidence({ onto, cause }) {
	const alone = `merged alone onto \`main\` at ${onto}`;
	switch (cause.kind) {
		case "conflict":
			return `${alone}, it conflicts with \`main\` in:\n${buildFileList(cause.files)}`;
		case "refused":
			return `${alone}, its merge was refused, the refusal's verdict lines and its end:\n\n${quoteBlock(cause.reason)}`;
		case "red":
			return `${alone} as ${cause.iso}, ${cause.noRun ? NO_RUN : `it ${buildFailed(cause, true)}`}`;
		case "unrecorded":
			return `why is unknown, as the lander's drop record lost its entry; its commits are read off \`main\` at ${onto}`;
		case "collision": {
			const after = cause.after.map((n) => `\`${QUEUE_PREFIX}${n}\``);
			return `each member of its batch passed alone, but merged onto \`main\` at ${onto}${after.length > 0 ? ` after ${after.join(", ")} landed,` : ""} as ${cause.step}, ${cause.noRun ? NO_RUN : `it ${buildFailed(cause, false)}`}`;
		}
	}
}

/**
 * Why the drop was made, in a few words, for a comment.
 * @param {import("./lander-records.js").Drop["cause"]} cause
 */
function buildCauseLine(cause) {
	switch (cause.kind) {
		case "conflict":
			return "it conflicts with `main`";
		case "refused":
			return "a commit gate refused its merge";
		case "red":
			return cause.noRun
				? "no CI run fired for its tree"
				: "it failed alone, twice";
		case "collision":
			return cause.noRun
				? "no CI run fired for its serial step"
				: "its serial step failed twice";
		case "unrecorded":
			return "why is unknown";
	}
}

module.exports = { buildCauseLine, buildDropEvidence, buildFileList };
