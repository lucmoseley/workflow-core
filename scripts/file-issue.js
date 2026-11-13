#!/usr/bin/env node
/*
 * file-issue.js — file an issue in one call: validate, create with every
 * label, read the number back, link it under its parent and verify, so
 * create, label and link cannot half-happen unnoticed (#533; spec #528,
 * ruled at #481).
 *
 *   node scripts/file-issue.js --title T --label L [--label L…]
 *     (--parent P | --standalone "<why>") --body-file F|- [--assign-self]
 *     --origin <class> (--fault-signature <file> | --no-fault)
 *     [--distinct-from N[,N…]]
 *     [--size-line-checked N[,N…]]
 *   node scripts/file-issue.js --check "<title>"
 *
 * Every filing names the flow that filed it, `--origin`, from
 * lib/issue-origin.js's fixed list, and is labelled `origin:<class>`; and
 * declares whether it claims to stop a recurring fault: `--fault-signature`
 * names a signature file (lib/fault-signature.js holds its shape), checked
 * against the transcript record that triggered it, and appended to
 * docs/data/outcome-signatures.jsonl for the weekly outcome review (#4796);
 * the create also carries the `fault-signature` label and the line in a body
 * section, so a line lost with its worktree is recovered (#4861).
 *
 * Before every create it lists up to three open issues whose titles most
 * resemble the new one, so a duplicate or its natural parent is noticed
 * (#536), and refuses while any listed issue is neither named in
 * `--distinct-from` nor the `--parent` (#1073). No score cut-off does the
 * refusing: unrelated titles and real duplicates overlap in score. A failed
 * fetch files anyway, saying so.
 * Residual: `--distinct-from` records a claim, never a reading — pasting the
 * refusal's own hint back files unread.
 * A `takes:implement` ticket is refused, rule:size-line printed, while this
 * session already filed an open one, or an open `takes:implement` sibling
 * under the same parent names a source file its body names — until
 * `--size-line-checked` names each (#4450). The same residual holds.
 * `--check` prints the same list and files nothing — "is it ticketed?"
 * answered from the tracker.
 *
 * NO HOOK SEES A gh CALL A SCRIPT MAKES, so this enforces for itself what
 * the guard-issue-create-label core and place-new-issue.sh enforce on the hand
 * spelling: exactly one `takes:` value, the `takes:human` Outside-line tests
 * (lib/takes-label.js), every label known to the tracker — a label GitHub
 * does not know aborts `gh issue create` while it exits 0 — and the family
 * label the parent implies, no second `wayfinder:map` while an open one's
 * Destination is unfilled (lib/issue-gate.js, #717), and no `urgent` an open
 * ancestor already passes down (#3648).
 *
 * ORDER: every other refusal, then the similar-title list's, then
 * rule:size-line's, then create, then link, then (--assign-self, or a map
 * under a session id) claim.
 * A failure after the create exits 1 naming the created issue and the
 * remedy, and deletes nothing: re-running files a duplicate.
 *
 * Unassigned unless --assign-self, which takes claim-issue's path (the
 * arbiter record, then @me) — an assigned issue drops off /wayfinder's
 * frontier (mantahostels#702). A `wayfinder:map` filed where a session id is
 * set takes that path without the flag: the charting session holds its map
 * from the moment it files it, so the parent-claim refusal keeps the loop off
 * the children it is still wiring (#2314, ruled at #2211). Those children
 * stay unassigned, held by the map's claim until it ends.
 *
 * Joins no §N3 family: its exits are the three the spec gives all three
 * tracker scripts — 0 done, 1 retry or finish by hand (a gh read or write
 * did not land), 2 fix the input (a usage error or a refusal).
 *
 * The logic is lib/file-issue-core.js's (#5150); this file wires its
 * production ports, writes both streams and exits with its code.
 * cli-args-exempt: its argv is the core's, parsed there by lib/cli-args.js.
 */

const { fileIssue, FileIssueCrash } = require("./lib/file-issue-core.js");
const { buildHostPorts } = require("./lib/file-issue-host.js");
const { writeFd } = require("./lib/write-fd.js");

/** @param {import("./lib/file-issue-core.js").Outcome} written */
const write = ({ stdout, stderr }) => {
	if (stdout) writeFd(1, stdout);
	if (stderr) writeFd(2, stderr);
};

try {
	const outcome = fileIssue(process.argv.slice(2), buildHostPorts());
	write(outcome);
	process.exitCode = outcome.code;
} catch (e) {
	if (!(e instanceof FileIssueCrash)) throw e;
	write(e.written);
	throw e.cause;
}
