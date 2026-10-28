/*
 * file-claim.js — the dispatcher core that refuses a write to a file another
 * live session is holding (mantahostels#113), and hands a session the claim
 * rules before its first mistake rather than only in the refusal that follows
 * one (mantahostels#1646, spec mantahostels#1762). Its production port is
 * lib/file-claim-host.js.
 *
 * THIN BY DESIGN. Every verdict is the arbiter's — scripts/session-arbiter.js
 * and its store under scripts/lib/ — mantahostels#102 having ruled one named
 * subsystem with thin guards over it rather than independent guards, divergent
 * attribution logic being a demonstrated failure. This core builds the
 * arbiter's `check` argv off the payload, reads its answer, and chooses which
 * rules to hand over.
 *
 * It watches Write, Edit and NotebookEdit alike, or a session simply reaches
 * for the tool the guard does not watch. NotebookEdit names its target
 * `notebook_path`; reading `file_path` alone once matched the tool and then
 * allowed every write through it unchecked.
 *
 * THE ARBITER'S ARGV is `check <file> <session> <anchor> <anchor length>
 * <new ids>`:
 *  - THE EDIT ANCHOR (mantahostels#970): an Edit's old_string, which on
 *    docs/doc-map.md places the write inside one `### B<n>` entry or one §A
 *    register row, so two sessions on two entries never contend. Resolving it
 *    is the arbiter's; this core forwards it. A Write or NotebookEdit carries
 *    none, and the arbiter claims the file entire. TRUNCATED at 8,000
 *    characters, because it crosses an execve boundary and Linux caps one
 *    argument at 128 KB. Its ORIGINAL LENGTH rides beside it, because
 *    truncation loses the anchor's end, and the end is what says whether the
 *    write crosses into the next entry: told the length, the arbiter claims
 *    the whole file on a truncated anchor rather than the entry its prefix
 *    happens to sit in.
 *  - THE ENTRY IDS THIS WRITE INTRODUCES (mantahostels#1424): every
 *    `### B<n>` heading at a line's start in new_string and absent from the
 *    UNTRUNCATED old_string, so an Edit that only re-types a heading it quotes
 *    introduces nothing. Unique, at most 64, comma-joined. The arbiter warns
 *    where the session holds no claim on one, and never refuses on it. A Write
 *    carries `content`, not new_string, and a whole-file claim has nothing
 *    per-entry to say.
 *  - The session is the payload's `session_id`, else CLAUDE_CODE_SESSION_ID,
 *    else empty: the arbiter takes no claim for an unidentifiable session, and
 *    a placeholder would mint a lock nothing can ever release.
 *
 * THE ANSWER. A note — exactly `{ hookSpecificOutput: { hookEventName:
 * "PreToolUse", additionalContext } }` — rides ahead of the rules in one
 * envelope (mantahostels#2369), spending the same ceiling. A DENIAL displaces
 * the rules: a refusal carries a permissionDecision, and the rules defer
 * unlatched to the next write. Any other shape is relayed as far as a
 * dispatcher part can carry it — its denial, else its additionalContext — the
 * rules again deferred, and every field it cannot carry is named in the error
 * log (mantahostels#2387): a future arbiter field is dropped on the record,
 * never in silence. Output that is not JSON is logged and the write allowed.
 *
 * THE TIER TEST IS THIS CORE'S, AND CHOOSES ONLY WHETHER TO SPEAK. The arbiter
 * stays the authority on what is claimed and refused (mantahostels#102); a
 * prefix drifted out of step here costs a hint not given, never a wrong
 * verdict. It refuses on docs/, .claude/, CLAUDE.md and AGENTS.md; scripts/ is
 * a detect-only tier (mantahostels#287) never denied on; everything further
 * out is left to git (mantahostels#103). ONE HOLE: .claude/tmp/, the sanctioned
 * scratch directory (mantahostels#2089, mantahostels#2103), which
 * arbiter-core.js's EXEMPT list drops from both tiers and this core keeps the
 * claim rules off — throwaway bytes carry no claim to release and no debt to
 * own.
 *
 * THE RULES, in each call's PRIORITY ORDER. What priority means here is
 * SURVIVAL, not importance (mantahostels#2386): the ids arrive in one
 * envelope, so their order inside it is invisible, and all it decides is which
 * the 4,000-byte ceiling keeps — the rest defer, unlatched, to the next write.
 *  - claim-bash-route LEADS the claim cluster: the injection stops at the
 *    first id that does not fit rather than skipping to a smaller one, and
 *    nothing anywhere reprints claim-bash-route.
 *  - denied-edit-debt is LAST: a refusal reprints it in full with the real
 *    path, so it costs nothing on the deny tier.
 *  - A path-tied rule leads the docs arm on its own path, in a host with every
 *    module it names on (#2302): roadmap-edit on docs/reference-roadmap.html
 *    (#2021; nothing here tells a hand edit from the roadmap-edit loop's own,
 *    and with roadmap off check-gate-switches.js refuses a commit of it,
 *    #2301), manual-sync on docs/operating-manual.md (#2233).
 *  - doc-authority-class leads on a docs/doc-map-classes.json `derived` or
 *    `generated-only` path whose classQualifier is blank (#2016). A host with
 *    no register, a path it does not list, or a qualifier leaving part of the
 *    file hand-edited skips it.
 *  - writing-for-agents leads on a skill file, a CLAUDE.md or an AGENTS.md
 *    anywhere in the repo (#2030) — on its own outside both tiers.
 *  - A Write CREATING scripts/guard-*.sh or guard-*.js leads with
 *    guard-authoring, the pointer to the surfaces a new guard owes (#1011).
 *
 * LIMITS
 *  - It FAILS OPEN on an arbiter that times out, exits non-zero or answers
 *    what is not JSON (mantahostels#103 §6): a fail-closed bug would halt every
 *    concurrent session on their most-used files. Each is logged, through the
 *    dispatcher's guard-error log, which check-guard-errors.js reports.
 *    A store fault in the rule injection fails CLOSED, as the kit's injection
 *    does (mantahostels#1646), and the row's `closed` policy refuses on a throw
 *    of this core's own.
 *  - A file written by a Bash heredoc or by a script is invisible to it — the
 *    arbiter's `claim` command is what scripts call for themselves
 *    (mantahostels#99's signal 3); lib/claimed-bash-write.js warns on the Bash
 *    route.
 *  - On docs/doc-map.md alone a claim is per REGION (mantahostels#848,
 *    mantahostels#970, mantahostels#1402, mantahostels#1685); the arbiter falls
 *    back to the whole file, and says so, where it cannot place an anchor.
 *  - THE NOTE SPENDS THE CEILING. Each arm's first envelope is nearly full, so
 *    a note of a few hundred bytes drops file-claim to the next write —
 *    mantahostels#2334's whole-file notice on docs/doc-map.md already does on
 *    the deny arm. It defers unlatched and arrives whole next time.
 *  - A REFUSAL still displaces the cluster whole; denied-edit-debt is
 *    reprinted in it, the other three are not.
 *  - The entry ids are read off tool writes only: a `sed -i`, a heredoc or a
 *    script appending an entry is never warned about.
 */

const { caught } = require("./caught.js");
const { ruleModule } = require("./rule-gates.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { trimEndRun } = require("./trim-run.js");

/** The anchor's argv share, below Linux's 128 KB single-argument cap. */
const ANCHOR_MAX = 8000;

/** Far above any real entry-adding edit, short of blowing the argv cap. */
const NEW_IDS_MAX = 64;

const CLASSES = "docs/doc-map-classes.json";

/**
 * @typedef {{ ok: true, stdout: string } | { ok: false, why: string,
 *   stdout: string }} ArbiterAnswer `why` is "timed out" or "exited <code>"
 * @typedef {import("./guard-dispatch.js").CoreContext & {
 *   arbiterCheck: (args: string[]) => ArbiterAnswer,
 * }} FileClaimContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

/**
 * Every `### B<n>` id at a line's start in `text`, in order.
 * @param {string} text
 */
const entryIds = (text) =>
	text.split("\n").flatMap((line) => {
		const m = /^### (B[0-9]+)/.exec(line);
		return m ? [m[1]] : [];
	});

/**
 * The anchor, its original length, and the ids the write introduces, off an
 * Edit's strings; a field that is present but not a string is logged and
 * forwarded as nothing.
 * @param {string} file
 * @param {FileClaimContext} ctx
 */
function editFields(file, ctx) {
	const { old_string: old, new_string: neu } = ctx.input;
	let anchor = "";
	let anchorLen = "0";
	if (typeof old === "string") {
		anchor = old.slice(0, ANCHOR_MAX);
		anchorLen = String(old.length);
	} else if (old != null) {
		anchorLen = "";
		ctx.log(
			`old_string on ${file} is not a string — anchor dropped, whole file claimed`,
		);
	}
	let newIds = "";
	if ((neu != null && typeof neu !== "string") || anchorLen === "")
		ctx.log(
			`new_string on ${file} could not be read — entry ids dropped, allocation unchecked`,
		);
	else {
		const had = new Set(entryIds(typeof old === "string" ? old : ""));
		newIds = [
			...new Set(
				entryIds(typeof neu === "string" ? neu : "").filter(
					(id) => !had.has(id),
				),
			),
		]
			.sort()
			.slice(0, NEW_IDS_MAX)
			.join(",");
	}
	return { anchor, anchorLen, newIds };
}

/**
 * What a hook object the arbiter printed can be relayed as: its denial, else
 * its context; every field a dispatcher part cannot carry named in the log.
 * @param {Record<string, unknown>} out
 * @param {FileClaimContext} ctx
 * @returns {Decision}
 */
function relay(out, ctx) {
	const hso = /** @type {Record<string, unknown>} */ (
		out.hookSpecificOutput && typeof out.hookSpecificOutput === "object"
			? out.hookSpecificOutput
			: {}
	);
	const dropped = Object.keys(out).filter((k) => k !== "hookSpecificOutput");
	const reason = hso.permissionDecisionReason;
	const said = hso.additionalContext;
	const denies =
		hso.permissionDecision === "deny" && typeof reason === "string";
	for (const k of Object.keys(hso))
		if (
			![
				"hookEventName",
				"permissionDecision",
				"permissionDecisionReason",
			].includes(k) &&
			!(k === "additionalContext" && !denies)
		)
			dropped.push(`hookSpecificOutput.${k}`);
	if (hso.permissionDecision !== undefined && !denies)
		dropped.push("hookSpecificOutput.permissionDecision");
	if (dropped.length > 0)
		ctx.log(
			`arbiter answered fields a dispatcher part cannot carry — dropped: ${dropped.join(", ")}`,
		);
	if (denies) return { deny: ctx.corePaths(reason) };
	return typeof said === "string" && said
		? { context: ctx.corePaths(said) }
		: null;
}

/**
 * The arbiter's answer, parsed: a note to carry with the rules, or the
 * decision that displaces them.
 * @param {string} stdout
 * @param {FileClaimContext} ctx
 * @returns {{ note: string } | { decision: Decision }}
 */
function readAnswer(stdout, ctx) {
	if (!stdout.trim()) return { note: "" };
	let out;
	try {
		out = JSON.parse(stdout);
	} catch {
		ctx.log(
			"arbiter answered output that is not JSON — write allowed unchecked",
		);
		return { decision: null };
	}
	if (!out || typeof out !== "object" || Array.isArray(out)) {
		ctx.log(
			"arbiter answered output that is not a hook object — write allowed unchecked",
		);
		return { decision: null };
	}
	const hso = out.hookSpecificOutput;
	const isNote =
		Object.keys(out).join() === "hookSpecificOutput" &&
		hso &&
		typeof hso === "object" &&
		Object.keys(hso).sort().join() === "additionalContext,hookEventName" &&
		hso.hookEventName === "PreToolUse" &&
		typeof hso.additionalContext === "string";
	if (isNote) return { note: ctx.corePaths(hso.additionalContext) };
	return { decision: relay(out, ctx) };
}

/**
 * The register's class for `rel`, where its qualifier is blank; "" where the
 * host has no register, does not list the path, or cannot be read (logged).
 * @param {string} rel
 * @param {FileClaimContext} ctx
 */
function readAuthorityClass(rel, ctx) {
	try {
		const text = ctx.readText(CLASSES);
		if (text === null) return "";
		const reg = JSON.parse(text);
		if (!reg || typeof reg !== "object" || Array.isArray(reg))
			throw new Error("the register is not a JSON object");
		const row = reg[rel];
		if (row == null) return "";
		if (typeof row !== "object")
			throw new Error(`its ${rel} row is not an object`);
		const q = row.classQualifier ?? "";
		if (typeof q !== "string" && q !== false)
			throw new Error(`its ${rel} classQualifier is not a string`);
		/* A blank qualifier is no qualifier, as lib/doc-map.js's buildSidecarClassText reads it. */
		if (q && !/^\s*$/.test(q)) return "";
		return typeof row.class === "string" ? row.class : "";
	} catch (e) {
		ctx.log(
			`could not read ${ctx.root}/${CLASSES} — authority class of ${rel} unchecked: ${caught(e).message}`,
		);
		return "";
	}
}

/**
 * The arbiter's answer for this write: a note to carry with the rules, or the
 * decision that ends the call.
 * @param {string} file
 * @param {FileClaimContext} ctx
 * @returns {{ note: string } | { decision: Decision }}
 */
function arbiterAnswer(file, ctx) {
	const { anchor, anchorLen, newIds } = editFields(file, ctx);
	const session = ctx.session || ctx.env.CLAUDE_CODE_SESSION_ID || "";
	const arb = ctx.arbiterCheck([
		"check",
		file,
		session,
		anchor,
		anchorLen,
		newIds,
	]);
	if (arb.ok) return readAnswer(arb.stdout, ctx);
	/* The arbiter catches its own exceptions and exits 0, so any other end is a
	 * fault it never saw: a hang killed at the port's bound, an OOM kill, a node
	 * that would not start. Whatever it printed first is still said. */
	ctx.log(`arbiter ${arb.why} on ${file} — write allowed unchecked`);
	const said = readAnswer(arb.stdout, ctx);
	if ("decision" in said) return said;
	return { decision: said.note ? { context: said.note } : null };
}

/**
 * The docs arm's injection: the deny tier's cluster, led by whichever
 * path-tied, class or agent-doc rule this path keeps.
 * @param {string} rel
 * @param {boolean} agentDoc
 * @param {string} note
 * @param {FileClaimContext} ctx
 * @returns {Decision}
 */
function docsRules(rel, agentDoc, note, ctx) {
	const cls = readAuthorityClass(rel, ctx);
	return {
		prelude: note,
		skip: [
			...(agentDoc ? [] : ["writing-for-agents"]),
			...(rel === "docs/reference-roadmap.html" ? [] : ["roadmap-edit"]),
			...ruleModule(ctx, "roadmap", ["roadmap-edit"]),
			...(rel === "docs/operating-manual.md" ? [] : ["manual-sync"]),
			...ruleModule(ctx, "governance", ["manual-sync"]),
			...ruleModule(ctx, "roadmap", ["manual-sync"]),
			...(cls === "derived" || cls === "generated-only"
				? []
				: ["doc-authority-class"]),
		],
		injectRules: [
			"writing-for-agents",
			"roadmap-edit",
			"manual-sync",
			"doc-authority-class",
			"claim-bash-route",
			"file-claim",
			"claim-release",
			"denied-edit-debt",
		],
	};
}

/**
 * The scripts arm's injection. A script writing a tracked doc raises no Write
 * hook, so the script rule's one live trigger is the script being WRITTEN.
 * @param {string} rel
 * @param {boolean} agentDoc
 * @param {boolean} creating
 * @param {string} note
 * @returns {Decision}
 */
function scriptRules(rel, agentDoc, creating, note) {
	if (
		creating &&
		/^scripts\/guard-[^/]+\.(?:sh|js)$/.test(rel) &&
		!JS_TEST_FILE.test(rel)
	)
		return {
			prelude: note,
			injectRules: [
				"guard-authoring",
				"script-self-claim",
				"claim-bash-route",
				"file-claim",
				"claim-release",
				"denied-edit-debt",
			],
		};
	/* The adopter templates of CLAUDE.md and AGENTS.md live here. */
	return {
		prelude: note,
		skip: agentDoc ? [] : ["writing-for-agents"],
		injectRules: [
			"writing-for-agents",
			"script-self-claim",
			"claim-bash-route",
			"file-claim",
			"claim-release",
			"denied-edit-debt",
		],
	};
}

/**
 * @param {string} file
 * @param {FileClaimContext} ctx
 * @returns {Decision}
 */
function decide(file, ctx) {
	/* Read before the arbiter runs, so nothing it does to the path can answer
	 * for it. An Edit cannot create a file. */
	const creating = ctx.tool === "Write" && !ctx.exists(file);
	const answer = arbiterAnswer(file, ctx);
	if ("decision" in answer) return answer.decision;
	const { note } = answer;
	/* A root spelled with a trailing slash once made every strip a no-op. */
	const root = trimEndRun(ctx.root, "/");
	const rel = (
		file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
	).replace(/^\.\//, "");
	const agentDoc =
		/^\.(?:claude|agents)\/skills\//.test(rel) ||
		/(?:^|\/)(?:CLAUDE|AGENTS)\.md$/.test(rel);
	if (rel.startsWith(".claude/tmp/")) return note ? { context: note } : null;
	if (/^(?:docs|\.claude)\//.test(rel) || /^(?:CLAUDE|AGENTS)\.md$/.test(rel))
		return docsRules(rel, agentDoc, note, ctx);
	if (rel.startsWith("scripts/"))
		return scriptRules(rel, agentDoc, creating, note);
	/* A vendored skill under .agents/, or a nested CLAUDE.md: the one rule,
	 * with the note riding it. */
	if (agentDoc) return { prelude: note, injectRules: ["writing-for-agents"] };
	return note ? { context: note } : null;
}

module.exports = {
	field: ["file_path", "notebook_path"],
	noun: "write",
	decide,
};
