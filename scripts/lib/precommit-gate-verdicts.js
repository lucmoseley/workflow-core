/*
 * precommit-gate-verdicts.js — the pre-commit gates' verdict wording in Node
 * (#5155). The skip and deletion lines are copies of scripts/lib/
 * precommit-gate.sh's functions of the same name, byte for byte, for a gate
 * whose logic moved into a Node core; precommit-gate-verdicts.test.ts runs both
 * and holds them equal. The direction verdict and its no-baseline line live
 * here alone.
 *
 * A CORE (base §T7): it performs no I/O.
 */

/**
 * The text of each line, newline-terminated, as `echo … >&2` prints them.
 * @param {string[]} lines
 */
const text = (lines) => lines.map((l) => `${l}\n`).join("");

/**
 * The lines `sed 's/^/<prefix>/'` makes of a stream: a final newline ends the
 * last line rather than opening an empty one.
 * @param {string} body
 * @param {string} prefix
 */
const prefixed = (body, prefix) =>
	body
		.replace(/\n$/, "")
		.split("\n")
		.map((l) => `${prefix}${l}`);

/** What `$(…)` keeps of a command's output: every trailing newline cut. */
function substituted(/** @type {string} */ out) {
	let end = out.length;
	while (end > 0 && out[end - 1] === "\n") end--;
	return out.slice(0, end);
}

/**
 * gate_skip.
 * @param {string} label
 * @param {string} what
 */
const skipLine = (label, what) =>
	text([
		`pre-commit: skipped the ${label} check — not readable from the index: ${what}.`,
	]);

/**
 * gate_stage_out's warning when git cannot answer whether `rel` is deleted.
 * @param {string} rel
 */
const deletionUnknownLine = (rel) =>
	text([
		`pre-commit: could not ask git whether ${rel} is deleted by this commit — treating it as merely absent.`,
	]);

/**
 * gate_refuse_deleted, over the deleted paths in the order they were staged out.
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

/**
 * gate_check_deleted's line when WFC_ALLOW_GATE_INPUT_DELETE is set.
 * @param {string[]} deleted
 */
const allowDeleteLine = (deleted) =>
	text([
		`pre-commit: WFC_ALLOW_GATE_INPUT_DELETE is set — allowing this commit to delete ${deleted.join(", ")}.`,
	]);

/**
 * No readable HEAD to compare against. FAILS CLOSED.
 * @param {string} label
 */
const noBaselineLine = (label) =>
	text([
		`pre-commit: no readable HEAD baseline for the ${label} check — refusing.`,
	]);

/**
 * What the comparison wrote to STDERR, replayed under its own heading: a
 * crash's stack trace is apparatus noise, not a finding, and merged into the
 * indented fault list it read as one (mantahostels#2026).
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
 * The verdict on one comparison run: a fault already in HEAD warns and passes,
 * one this commit adds refuses (mantahostels#1688, mantahostels#1753).
 *
 * THE VERDICT IS THE EXIT STATUS, NEVER THE TEXT ON A PASS: a *-new-faults
 * script is free to print on a clean run.
 *
 * EXIT 1 OBLIGES A FAULT LIST ON STDOUT: a 1 with nothing there has named
 * nothing, and takes the same limb as a 2 (mantahostels#2026). That is where an absent
 * script, a syntax error and a require-time throw land — node reports those on
 * stderr and exits 1.
 *
 * FAILS CLOSED. 0 is inherited; everything else is a failure to ANSWER.
 *
 * A COMPLETE LIST is the comparison's half of the contract, unenforced here
 * (mantahostels#2314): a crash mid-list cannot be told from a list printed beside
 * stderr, so a 1 with anything on stdout is read as an answer. lib/fault-diff.js
 * composes the whole list before it writes and routes a throw once running to
 * exit 2; a comparison that streams its list must do the same.
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
