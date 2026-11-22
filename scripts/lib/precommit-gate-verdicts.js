/** @param {string[]} lines */
const text = (lines) => lines.map((l) => `${l}\n`).join("");

/**
 * @param {string} body
 * @param {string} prefix
 */
const prefixed = (body, prefix) =>
	body
		.replace(/\n$/, "")
		.split("\n")
		.map((l) => `${prefix}${l}`);

function substituted(/** @type {string} */ out) {
	let end = out.length;
	while (end > 0 && out[end - 1] === "\n") end--;
	return out.slice(0, end);
}

/**
 * @param {string} label
 * @param {string} what
 */
const skipLine = (label, what) =>
	text([
		`pre-commit: skipped the ${label} check — not readable from the index: ${what}.`,
	]);

/** @param {string} rel */
const deletionUnknownLine = (rel) =>
	text([
		`pre-commit: could not ask git whether ${rel} is deleted by this commit — treating it as merely absent.`,
	]);

/**
 * @param {string} label
 * @param {string[]} deleted
 */
const refuseDeletedLines = (label, deleted) =>
	text([
		`pre-commit: the ${label} check reads ${deleted.join(", ")}, and this commit DELETES it — refusing.`,
		"  That is not apparatus missing: the file is a gate's own input, so removing it is the fault, not a reason to skip.",
		"  Keep it: leave the path out of the commit's pathspec, or restore it with 'git checkout HEAD -- <path>' — safe here, a deleted file holding no parallel session's edit.",
		"  Renaming it? git reports a rename as a deletion here, so this fires on one too — move the gate's path list in the same commit, behind the escape.",
		"  Retiring it deliberately? The escape is the founder's to set, never an agent's (#916): an agent stops and asks. The founder runs, from their own terminal, WFC_ALLOW_GATE_INPUT_DELETE=1 git commit -m '…' -- <paths>, retiring the gate reading it in the same commit.",
	]);

/** @param {string[]} deleted */
const allowDeleteLine = (deleted) =>
	text([
		`pre-commit: WFC_ALLOW_GATE_INPUT_DELETE is set — allowing this commit to delete ${deleted.join(", ")}.`,
	]);

/** @param {string} label */
const noBaselineLine = (label) =>
	text([
		`pre-commit: no readable HEAD baseline for the ${label} check — refusing.`,
	]);

/**
 * @param {string} noun
 * @param {string} stderr
 */
const diagnostics = (noun, stderr) =>
	stderr === ""
		? ""
		: text([
				"",
				`pre-commit: the ${noun} comparison also wrote to stderr — diagnostics, not findings:`,
				...prefixed(stderr, "  | "),
			]);

/**
 * @param {string} noun
 * @param {string} ticket
 * @param {{ status: number, stdout: string, stderr: string }} run
 * @returns {{ pass: boolean, text: string }}
 */
function directionVerdict(noun, ticket, run) {
	const found = substituted(run.stdout);
	if (run.status === 0)
		return {
			pass: true,
			text:
				text([
					`pre-commit: every FAIL finding the ${noun} check reported above is already in HEAD, so this commit did not cause one — passing (${ticket}).`,
					"  They still FAIL the scheduled sweeps, which run a clean checkout, and block nothing here only because they are inherited.",
				]) + diagnostics(noun, run.stderr),
		};
	const head =
		run.status === 1 && found !== ""
			? text([
					`pre-commit: the ${noun} fault(s) below are NOT in HEAD — this commit adds them:`,
					...prefixed(found, "  "),
				])
			: text([
					`pre-commit: could not tell inherited ${noun} faults from new ones — refusing.`,
					...(found === "" ? [] : [found]),
				]);
	return { pass: false, text: head + diagnostics(noun, run.stderr) };
}

module.exports = {
	allowDeleteLine,
	deletionUnknownLine,
	directionVerdict,
	noBaselineLine,
	refuseDeletedLines,
	skipLine,
	substituted,
};
