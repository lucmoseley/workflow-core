const { short } = require("./lander-git.js");
const { queueBranch } = require("./landing-refs.js");

/** @param {readonly string[]} files */
const buildFileList = (files) => files.map((f) => `- \`${f}\``).join("\n");

const quoteBlock = (/** @type {string} */ text) =>
	`\`\`\`text\n${text.replaceAll("```", "'''")}\n\`\`\``;

/** @param {readonly string[]} errors */
const buildTypeErrors = (errors) =>
	errors.length > 0
		? `its first errors:\n\n${quoteBlock(errors.join("\n"))}`
		: "whose errors its log did not name";

/**
 * @param {{files: readonly string[], typecheck?: readonly string[],
 *   mainRed?: readonly string[]}} red
 * @param {boolean} onMain
 */
function buildFailed({ files, typecheck, mainRed }, onMain) {
	const where = onMain ? ", where `main` passes it" : "";
	const typecheckClause =
		typecheck && `the type-check twice${where}, ${buildTypeErrors(typecheck)}`;
	if (files.length === 0)
		return `failed ${typecheckClause ?? `the whole suite twice, naming no file${where}`}`;
	const listed =
		onMain && !mainRed
			? "these files twice, which pass on `main` there"
			: "twice";
	return `failed ${listed}:\n${buildFileList(files)}${typecheckClause ? `\n\nIt also failed ${typecheckClause}` : ""}`;
}

/** @param {{files: readonly string[], mainRed?: readonly string[]}} red */
const buildMainRed = ({ files, mainRed }) => {
	if (!mainRed) return "";
	const passing = files.filter((f) => !mainRed.includes(f));
	return `\n\n\`main\` fails these files too, but the tester read different failures there:\n${buildFileList(mainRed)}${passing.length > 0 ? `\n\nThese pass on \`main\` there:\n${buildFileList(passing)}` : ""}`;
};

/**
 * @param {{files: readonly string[], runs?: readonly number[],
 *   mainRun?: number}} red
 */
function buildRuns({ files, runs = [], mainRun }) {
	const cited = [
		...(runs.length > 0
			? [`Its red CI ${runs.length > 1 ? "runs" : "run"}: ${runs.join(", ")}.`]
			: []),
		...(mainRun === undefined
			? []
			: [
					`\`main\` passed ${files.length > 0 ? "those of them its tree holds" : "the whole suite"} in CI run ${mainRun}.`,
				]),
	];
	return cited.length > 0
		? `\n\n${cited.join(" ")} \`gh run view <run>\` reads one.`
		: "";
}

/** @param {{failures?: readonly import("./lander-records.js").QuotedFailure[]}} red */
const buildFailures = ({ failures = [] }) =>
	failures.length > 0
		? `\n\nThe failing tests' errors, as the tester read them:\n\n${quoteBlock(
				failures.map((f) => `${f.file} > ${f.test}\n  ${f.message}`).join("\n"),
			)}`
		: "";

/** @param {Parameters<typeof buildRuns>[0] & Parameters<typeof buildFailures>[0]} red */
const buildCited = (red) => `${buildRuns(red)}${buildFailures(red)}`;

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
			return `${alone} as ${cause.iso}, ${cause.noRun ? NO_RUN : `it ${buildFailed(cause, true)}${buildMainRed(cause)}${buildCited(cause)}`}`;
		case "unrecorded":
			return `why is unknown, as the lander's drop record lost its entry; its commits are read off \`main\` at ${onto}`;
		case "collision": {
			const after = cause.after.map((n) => `\`${queueBranch(n)}\``);
			return `each member of its batch passed alone, but merged onto \`main\` at ${onto}${after.length > 0 ? ` after ${after.join(", ")} landed,` : ""} as ${cause.step}, ${cause.noRun ? NO_RUN : `it ${buildFailed(cause, false)}${buildCited(cause)}`}`;
		}
	}
}

/** @param {import("./lander-records.js").Drop["cause"]} cause */
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

/** @param {{files: readonly string[], typecheck?: readonly string[]}} cause */
function buildOwedPass({ files, typecheck }) {
	const failed = [
		...(files.length > 0 ? ["each file above"] : []),
		...(typecheck ? ["the type-check"] : []),
	];
	return failed.length > 0 ? failed.join(" and ") : "the whole suite";
}

/**
 * @param {Pick<import("./lander-records.js").Drop, "sha" | "name" | "cause">} d
 */
function buildDropAcceptance({ sha, name, cause }) {
	return `${short(sha)}'s change${buildOwedClause(cause)} and is pushed to \`${queueBranch(name)}\` again.`;
}

/** @param {import("./lander-records.js").Drop["cause"]} cause */
function buildOwedClause(cause) {
	switch (cause.kind) {
		case "conflict":
			return " merges onto `main`, each file above settled,";
		case "refused":
			return " merges onto `main`";
		case "unrecorded":
			return " merges onto `main`, passes the whole suite there,";
		case "red":
		case "collision":
			return cause.noRun
				? ", merged onto `main`, fires a CI run on the lander's refs that passes the whole suite,"
				: ` passes ${buildOwedPass(cause)} merged onto \`main\`,`;
	}
}

module.exports = {
	buildCauseLine,
	buildDropAcceptance,
	buildDropEvidence,
	buildFileList,
};
