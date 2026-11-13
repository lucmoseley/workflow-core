/*
 * tracker-inject-text.js — every string inject-tracker-docs.js hands a tracker
 * command, and how one command's payload is put together from them (#5151).
 *
 * NO REQUIRE, ON PURPOSE. check-context-budget.js and check-injector-margin.js
 * evaluate a revision's copy of this file where its siblings are not beside it
 * (lib/load-text-module.js); a require here breaks both reads.
 *
 * WHAT IT HOLDS IS RULES, NOT DOCUMENTS: prose held here, so a renamed or
 * unreadable document cannot empty the payload. What stays pasted is
 * mantahostels#1870's rule-by-rule call: pasted where the vendored skill's own
 * default is actively wrong; indexed (mantahostels#2499) where a miss is uninformed and has no observable
 * `gh` shape. Every command lands as ONE payload: mantahostels#1869 ruled
 * against splitting one across several hook entries.
 *
 * GROWING THIS SPENDS THE 10,000-CHARACTER BUDGET every command's payload fits
 * inside (lib/hook-limits.js's HOOK_PERSIST_CHARS). Cross it and that
 * command's payload is persisted to a file instead, which sessions seldom open
 * (mantahostels#1870). check-injector-margin.js refuses a commit that crosses
 * it, and inject-tracker-docs.test.ts asserts every command under it.
 */

/* Commands that read or write the tracker. `card-close` is project-owned
 * (.claude/skills/card-close/); the rest are vendored skills. `code-review` is
 * here for the disposition rule and the standards pointer (mantahostels#185,
 * mantahostels#1011). */
const COMMANDS = [
	"wayfinder",
	"to-spec",
	"to-tickets",
	"implement",
	"triage",
	"card-close",
	"code-review",
];

/* The commands whose first argument names an issue whose `takes:` label is
 * read (#1164). /triage and /card-close open any issue, and /code-review takes
 * none. */
const TAKES_READ = ["wayfinder", "to-spec", "to-tickets", "implement"];

/** Every one of these commands can put a choice to the founder, and the
 * vendored skills defer to `grilling`, which fixes the shape of the QUESTION
 * and says nothing about the OPTIONS inside one. mantahostels#1503 scoped the
 * lettered form to a round, so this routes a real choice INTO one. Do not
 * reword the lettered shape: it is the founder's own, and the wording is the
 * requirement. The opening scope is #1752's, the sum-to-100 sentence answers
 * #38, and the no-stakes-threshold sentence mantahostels#570. It points at the
 * host's declared output style (#448).
 * @param {string} outputStyle */
const pricedOptionsWhole = (outputStyle) =>
	"\n\nEVERY CHOICE PUT TO THE FOUNDER SHIPS PRICED OPTIONS — each house decision a resolution or mid-session fork turns on. Enumerate the real alternatives (not motives, not diagnoses) and price each on its own line in exactly this shape, with nothing added:\n\n(A) <the option, stated in plain words>\nConfidence: 70% (60% - 80%). <what drives the estimate, and what would move it>\n\n(B) <the next option>\nConfidence: 30% (20% - 40%). <as above>\n\nRelation: <rivals: which options actually conflict, and on what — or: independent, so any combination is takeable>\n\nOptions are ALWAYS lettered (A), (B), (C) — never numbered, never bulleted, never unlabelled — and the letter is what the founder replies with, so it is repeated in full wherever the option is referred to again. A choice put to the founder is put AS a numbered `❓ **Q1**` round, because the lettered priced form is owed inside a round (" +
	outputStyle +
	"); an ordinary question that is NOT a choice between alternatives is asked plainly instead, with one confidence figure and a recommendation, and takes no letters. The `grilling` skill's round shape governs the QUESTIONS you ask; the options inside any one question still take the lettered priced form here. Wherever there is more than one option the `Relation:` line is required, because the lettered shape reads as a ballot — rivals for one slot — and options that could be taken together must say so. THE FIGURES MEAN DIFFERENT THINGS BY RELATION: where the options are rivals for one slot, each figure is the probability that option is the right choice, so the headline figures sum to 100% (as 70% and 30% above) and the `Relation:` line says `rivals`; where options can be combined, each figure is that option's own chance of being worth taking and they need not sum. Then name the recommendation by its letter, every letter it takes where more than one is takeable, and the one assumption that would flip it. NO tables, NO horizontal rules, NO bold or titled option names. Never emit a filler percentage, and where a claim cannot be grounded say it is unknowable or subjective instead of inventing one. THE RULE HAS NO STAKES THRESHOLD: a choice that looks like a formality — a yes/no follow-on, a lopsided binary with one obvious answer — still ships the lettered priced form ((A) yes at ~90% is right; no options at all is not), and the only escape is saying a number is unknowable, never omitting the pricing. Research before you ask, as far as any source could answer it; ask only what research leaves open, naming that gap: `rule:house-decision`.";

/* Core voice carries the shape itself, so a session it loads into gets this
 * pointer rather than a second copy (#2039). */
const PRICED_OPTIONS_POINTER =
	"\n\nEVERY CHOICE PUT TO THE FOUNDER SHIPS PRICED OPTIONS, in the lettered shape your Core voice output style gives, put as a numbered `❓ **Q1**` round. Research before you ask, and ask only what research leaves open, naming that gap: `rule:house-decision`.";

/** The Standards axis has no repo-specific rules unless it is handed the paths
 * (mantahostels#992), in four states (#886, #965). concision-backstop.sh
 * carries the same four texts for the sessions neither command reaches, and
 * its test fails where the two differ (#2097). They shorten
 * docs/agents/rules/review-standards-axis*.txt rather than print them (base
 * §G11).
 * @param {"base" | "local" | "neither" | "both"} state
 * @param {string} standardsBase */
function standardsText(state, standardsBase) {
	if (state === "base")
		return (
			"Hand the Standards axis the base `" +
			standardsBase +
			"` in its prompt; its §0 routes the paths. No local `docs/code-standards.md` exists, so its report opens `No local standards file: the base applies unchanged.`, or `Base unreadable: <path>` if its Read of the base is refused. Cite a breach by its rule id; never restate a rule tooling enforces."
		);
	if (state === "local")
		return (
			"The standards base `" +
			standardsBase +
			'` is absent: hand the Standards axis only the local `docs/code-standards.md` in its prompt, never raising a smell its "Smells not raised" (or "Suppressions") names. It reviews against that file and the smell baseline, and its report opens `No standards base: ' +
			standardsBase +
			" is absent.` Cite a breach by its rule id; never restate a rule tooling enforces."
		);
	if (state === "neither")
		return (
			"This repo has neither the standards base `" +
			standardsBase +
			"` nor a local `docs/code-standards.md`: hand the Standards axis neither. Tell it in its prompt to review against the smell baseline and any other standards source the skill's step 3 found, its report opening `No standards base or local file: " +
			standardsBase +
			" and docs/code-standards.md are absent.`"
		);
	return (
		"Hand the Standards axis, in its prompt, base `" +
		standardsBase +
		'` and local `docs/code-standards.md`. Base §0 routes the paths; a local change binds only via its changes table, cited "§X2 (base), excepted by local row 2", and no local "Smells not raised" (or "Suppressions") smell is raised. A refused base Read opens the report `Base unreadable: <path>`. Cite a breach by its rule id; never restate a rule tooling enforces.'
	);
}

/** Base §G8 binds names to the host's glossary terms, so the axis gets the
 * glossary where one exists (#1373).
 * @param {string} standards @param {string} glossary */
const withGlossary = (standards, glossary) =>
	`${standards} Hand the Standards axis \`${glossary}\` too, for base §G8.`;

/* What stands in for docs/agents/rules/review-dispatch-shape.txt where it
 * cannot be read (#3514). */
const DISPATCH_SHAPE_FALLBACK =
	"Dispatch the review runs as docs/agents/rules/review-dispatch-shape.txt says.";

/** The two review-axis Artefact paths are suffixed with THIS session's id so
 * concurrent /code-review dispatches land on different files
 * (mantahostels#2220): a Write the SUBAGENT makes expands no environment
 * variable (mantahostels#2088). The shape rule names the subagent type and
 * paths as "named above", so they lead.
 * @param {string} reviewType @param {string} sidSuffix @param {string} dispatchShape */
const dispatchText = (reviewType, sidSuffix, dispatchShape) =>
	"Reviewer type `" +
	reviewType +
	"`; Artefact paths `.claude/tmp/review-standards" +
	sidSuffix +
	".md` and `.claude/tmp/review-spec" +
	sidSuffix +
	".md`. " +
	dispatchShape;

/* The ultrareview axis (mantahostels#834; ask-then-run, #1572, #1623): a
 * pointer to the guide's steps. Not folded into the dispatch text, which
 * concision-backstop.sh's nag restates before a review, where this line has
 * nothing to say. */
const ULTRA =
	"AFTER fixing the findings, before you commit, judge this diff against `docs/effort-guide.md` §The fourth axis; failing its test, the normal case, say NOTHING, and meeting it, follow that section's steps. NEVER START ONE UNASKED.";

/* The deviations record (mantahostels#1242), the half the REVIEWER needs:
 * re-classify, not suppress (mantahostels#1163). */
const DEVIATIONS_READ_FALLBACK =
	"Fetch the originating issue's `**Deviations:**` comment for the Spec axis, as docs/agents/rules/review-deviations-read.txt says.";

/* The disposition rule (mantahostels#185): the code-review skill ends at
 * "aggregate the findings" and names no destination for one. */
const DISPOSITION_FALLBACK =
	"Give every review finding a destination, as docs/agents/rules/review-finding-destination.txt says.";

/**
 * /code-review's rules part by part, in payload order: the one composition the
 * hook sends and both injector checkers measure. `fragment` answers a rule
 * fragment's text, or "" where it cannot be read, its fallback then standing in.
 * @param {{standardsState: "base" | "local" | "neither" | "both", standardsBase: string, glossary: string | null, reviewType: string, sidSuffix: string, fragment: (id: string) => string}} host
 */
function codeReviewParts({
	standardsState,
	standardsBase,
	glossary,
	reviewType,
	sidSuffix,
	fragment,
}) {
	const standards = standardsText(standardsState, standardsBase);
	return [
		glossary === null ? standards : withGlossary(standards, glossary),
		dispatchText(
			reviewType,
			sidSuffix,
			fragment("review-dispatch-shape") || DISPATCH_SHAPE_FALLBACK,
		),
		fragment("review-deviations-read") || DEVIATIONS_READ_FALLBACK,
		ULTRA,
		fragment("review-finding-destination") || DISPOSITION_FALLBACK,
	];
}

/** /code-review takes the priced-options rule ALONE, not the tracker index: it
 * files an issue only where a finding needs one. These reach a TYPED
 * /code-review only; one loaded through the Skill tool takes the same rules
 * from lib/review-rules.js (mantahostels#3451). Keep the two in step.
 * @param {Parameters<typeof codeReviewParts>[0]} host @param {string} pricedOptions */
const codeReviewRules = (host, pricedOptions) =>
	"You invoked /code-review, whose vendored skill file cannot carry project rules. " +
	codeReviewParts(host).join(" ") +
	pricedOptions;

/* /wayfinder's own clauses: the write-back rule for a disposed finding
 * (mantahostels#3205), the research-dispatch clause (mantahostels#918) — to
 * /wayfinder ALONE, /implement indexing `rule:research-artefact-scratch`
 * instead (mantahostels#2499) — and the charting terminal condition
 * (mantahostels#2585, ruled at mantahostels#2577 §1-2). It cannot
 * live in the wayfinder SKILL.md, whose doc-map §A route is Vendored. */
const WAYFINDER_CLAUSES =
	"\n\nA RESOLUTION THAT DISPOSES OF A FINDING WRITES BACK TO THE SOURCE THAT DECLARED IT OPEN — a gap ledger, a `Disposition: worth a ticket` row, a \"no card covers this\" line, a \"parked — revisit as a card\" note. An editable source has its declaring line edited in place or deleted; a generated one at its generator's input; an aged `docs/doc-map-classes.json` `role` declaration is cleared there; a file that merely mentions the area takes nothing. Ruled at mantahostels#3205.\n\n### Research artefacts — the dispatch half, which binds however the research was dispatched. The subagent NEVER writes into `docs/research/`. Paste this into its prompt verbatim:\n\n> Artefact: .claude/tmp/research-<name>.md\n>\n> Write your findings to `.claude/tmp/research-<name>.md`, appending each the moment it lands rather than holding them back for your final report. Do NOT write anywhere under `docs/`, and do NOT commit anything. Report the absolute path of the file back to me when you finish. Write the artefact in ASD-STE100 Simplified Technical English.\n\nFrom a throwaway worktree hand the absolute path instead. Posting is the dispatching session's, never the subagent's, and its order is in `docs/agents/issue-tracker.md` §Research artefacts.\n\n**Size a reading agent's job to its context window:** split a large source family across agents, and have each save fetched text to disk and search it rather than read it whole (#1789).\n\n### A charting run is DONE when four things are true, and not one ticket later. The map body is written; every ticket you can specify now exists as a child issue; their blocking edges are wired AND read back (`rule:wayfinder-ops-shapes` carries the shape; wiring one is not evidence it took); and every `wayfinder:research` ticket this run created is resolved and closed. Then nothing further is owed — end the session on `result:`. The one-ticket-per-session rule grants charting an exception for research tickets; SPENDING that exception is not a licence to carry on past it (mantahostels#2564, mantahostels#2577).\n\n**What runs next across sessions belongs to `/pick-next` and the frontier query — never to you, and never to the founder as a question.** Which ticket THIS session resolves is still yours to choose; what is not yours is what runs after it or beside it. Naming the next ticket in order is reporting and is welcome. Asking him which ticket to run, in what order, or in which parallel batch, puts him a scheduling choice.";

/* THE RESIDUE INDEX (mantahostels#2499, spec mantahostels#2457 §T4). A tracker
 * rule WITH an observable `gh` Bash shape belongs in lib/tracker-rules.js,
 * printed at the call that engages it (mantahostels#2497). What is left is
 * named here: an id and the moment it binds, one line each, NEVER the rule's
 * content.
 *
 * EACH LINE'S `rule:<id>` SPAN IS LITERAL: check-guard-registry.js's
 * readIndexedRuleIds() scans this file's text for it to know an id is
 * reachable (mantahostels#2496). */
const NEVER_ACT_LINE =
	"**Never act on a trigger from memory or inference** — fetch the id below at the moment named, not before, with `scripts/lib/rule-text.sh <id> [<id>…]` (one call resolves several).";
/** @type {Record<string, string>} */
const INDEX_LINES = {
	"roadmap-gating":
		"- `rule:roadmap-gating` — gating or closing an issue tied to a roadmap card's timing",
	"card-close-route":
		"- `rule:card-close-route` — closing an issue that carries a roadmap card",
	"issue-title-card-id":
		"- `rule:issue-title-card-id` — naming a new issue that carries a roadmap card",
	"decisions-search-first":
		"- `rule:decisions-search-first` — calling a figure, term or card unsourced, undefined or undesigned",
	"research-artefact-scratch":
		"- `rule:research-artefact-scratch` — dispatching a research subagent or posting its artefact outside /wayfinder",
	"wayfinder-ops-shapes":
		"- `rule:wayfinder-ops-shapes` — a map, child ticket, blocking edge, frontier query, claim or resolve step, or a map left with nothing to resolve",
	"kind-label-vocabulary":
		"- `rule:kind-label-vocabulary` — applying or reading a `kind:` label",
	"spec-only-contract":
		"- `rule:spec-only-contract` — writing, amending or reading a spec, or lifting one filed under a `kind:brief` up to its map with `node scripts/promote-spec.js <brief>`",
	"size-line":
		"- `rule:size-line` — filing a spec's tickets: how many build units, which chunks may run in parallel, and how the quiz step presents them",
	"takes-label-nuances":
		"- `rule:takes-label-nuances` — applying, removing or reading `takes:children` or `takes:human`",
	"waiting-external-vocabulary":
		"- `rule:waiting-external-vocabulary` — reading `waiting:external` (a label edit has the tracker-rules guard print it)",
};

/* Each command's index, in printed order. */
/** @type {Record<string, string[]>} */
const INDEX = {
	"card-close": ["issue-title-card-id"],
	"to-spec": [
		"kind-label-vocabulary",
		"issue-title-card-id",
		"spec-only-contract",
	],
	implement: [
		"roadmap-gating",
		"card-close-route",
		"decisions-search-first",
		"research-artefact-scratch",
	],
	triage: [
		"roadmap-gating",
		"kind-label-vocabulary",
		"takes-label-nuances",
		"waiting-external-vocabulary",
	],
	wayfinder: [
		"roadmap-gating",
		"decisions-search-first",
		"wayfinder-ops-shapes",
		"waiting-external-vocabulary",
	],
	"to-tickets": [
		"kind-label-vocabulary",
		"issue-title-card-id",
		"decisions-search-first",
		"spec-only-contract",
		"size-line",
	],
};

/* Two acts stay guard-enforced and so out of the index: a raw `gh issue edit
 * --body` and a close naming no outstanding work. THE EMPTY-RESULT LINE IS
 * PASTED, NOT INDEXED (#523): an empty result can arrive on the very first
 * `gh` call, before a fetched fragment could reach the session. It shortens
 * docs/agents/rules/gh-cli-limits.txt's opening sentence (base §G11). */
const GH_EMPTY_RESULT_RULE =
	"ONE RULE IS PASTED, BECAUSE IT BINDS AT THE FIRST `gh` CALL: run `gh` in the foreground, and re-run an empty result once before believing it — the tracker-rules guard names the known causes on each call that meets one.";

const TRACKER_FRAME =
	"THE TRACKER RULES ARE NOT BELOW — `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md` are their home, which the vendored skills carry none of. " +
	GH_EMPTY_RESULT_RULE +
	" Below is this command's index: every remaining rule with no `gh` shape a guard can catch it on, so it is named here instead of routed there. " +
	NEVER_ACT_LINE;

/** @param {string} matched */
const trackerIndex = (matched) => {
	const ids = INDEX[matched];
	return ids
		? `\n\n${TRACKER_FRAME}${ids.map((id) => `\n${INDEX_LINES[id]}`).join("")}`
		: "";
};

/* /implement's opening steps (#893, #4410), and /triage's whole-spec review
 * (#892), ride along here because the vendored skill file cannot carry them.
 * /triage's finding classes restate docs/agents/issue-tracker.md §Every close
 * says what is still outstanding; "fifth" is #3811's ruling and is untraced. */
/** @type {Record<string, string>} */
const CLOSING_STEPS = {
	implement:
		"\n\nBefore starting, read the ticket's parent spec — the sub-issue parent claim-issue.js prints, or the issue a `## Parent` line names — and the resolution comment on each closed blocker (`gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by`). Then run `node scripts/build-state.js <n> --spec <parent>`: it creates or resumes the ticket's build state file, keyed by issue number, and prints its path. Every unit keeps one, a one-slice unit included. Fill `slices` from the acceptance criteria, `standingRules` with each do-not constraint from the spec and from what you learn, `filesTouched` and `next`; it survives compaction where the conversation does not. At each slice boundary rewrite it, and commit citing the ticket. Before ending, rewrite it. The closing /code-review runs over the commits `node scripts/spec-commits.js <n>` lists for the ticket.",
	triage:
		"\n\nA `kind:spec` whose every ticket has closed gets a whole-spec review before you decide it: run `node scripts/spec-commits.js <n>`, then /code-review over the `git show` it prints, handing the reviewers the touched files at the spec's last commit, not only the diff lines. Record every finding in your triage comment, which ends with the `**Reviewed through:** <40-hex sha>` line the script prints. Fix first, on every pass: the `review-finding-destination` rule /code-review hands you says which findings are FIXED here and which TICKETED, and what a TICKETED line names (#4284, #4492). On a first pass a TICKETED one is filed under the spec while it is open — retag the spec `takes:triage` → `takes:children` yourself; standalone, its body citing the spec, only where the spec had already closed (#897). A spec back at triage whose earlier comment carries a `**Reviewed through:**` line is reviewed over the commits since that sha only: `node scripts/spec-commits.js <n> --since <sha>`. From the second pass on, each TICKETED finding gets a class, picking only where it is filed (#3811). Live: it names a route ordinary use reaches and the wrong behaviour on it; file it under the spec, with the same retag. Corner: it needs an unusual input or state; file it standalone, its body citing the spec. Tidying: it changes no behaviour; file it standalone, one ticket per pass. The first pass that files no live finding closes the spec, naming any open standalone tickets on `**Outstanding:**`. No pass count stops a spec. At a fifth or later pass, counting the earlier `**Reviewed through:**` comments, your triage comment also says whether to redesign rather than patch.",
};

/** It names the `**Bound:**`, `**Values:**` and `**Practice:**` resolution
 * lines because every command it reaches can resolve a ticket (#1801).
 * @param {string} matched
 * @param {string} claimIssue the arbiter's `claim-issue <n>` command line */
const header = (matched, claimIssue) =>
	"You invoked /" +
	matched +
	", which reads or writes the issue tracker. These project rules override the vendored skill's where they differ. Three the vendored skills get wrong: (1) claim the issue you are WORKING, and only that one: `node scripts/claim-issue.js <n>` before any other work on it — it refuses a live holder, then records the arbiter claim and assigns you (#530). NEVER one you file for later: it is created UNASSIGNED, as a claimed issue leaves /wayfinder's frontier (mantahostels#702). Claim it once you post a round on it (#1066). File with `node scripts/file-issue.js` — create, labels and parent link in one call, each filing naming `--origin <class>` and `--fault-signature <file>` or `--no-fault` (#4796) — adding `--assign-self` only where the session works what it creates (`/to-spec`). Resolve with `node scripts/resolve-ticket.js <n> --comment-file <f>`: comment, close, claim release and map line in one call. Its comment carries a `**Bound:**` line — what you read in full, what you only sampled or cited — and a `**Values:**` line: each house or untraced value it relies on, or `none`; and a `**Practice:**` line: `ran`, `covered`, `skipped` or `none-fits` (mantahostels#1827, #1707, #2325); one naming a commit sha also a `**Door:**` line, two-way or one-way (issue-tracker.md §Every close that names a commit). Off those scripts the arbiter record is yours: a hook makes it only off a literal `gh issue edit <n> --add-assignee @me` or `gh issue close <n>` through the Bash tool; a raw create-time assignment, the web UI, any other script, `gh api`, `--repo` or a shell-variable issue number needs `" +
	claimIssue +
	// bare-citation-ok: `#22 (gloss)` is the citation form's own example.
	"` or `release-issue <n>` by hand (§Claiming). (2) blocking edges and parent links use GitHub's native dependency and sub-issue endpoints, never a text `Blocked by:` line. (3) cite an issue number-first — `#22 (gloss)`, never `[title](url)` or a bare description; `to-tickets`'s \"numbers/titles\" is wrong on the order.";

/** A command typed on an issue whose `takes:` label names another (#1164). A
 * `takes:` value that is itself a command names that command, so the label
 * vocabulary (lib/takes-label.js) is never copied here.
 * @param {string} takesIssue @param {string} otherTakes @param {string} matched */
function takesLine(takesIssue, otherTakes, matched) {
	if (otherTakes === "") return "";
	if (COMMANDS.includes(otherTakes))
		return (
			"#" +
			takesIssue +
			" is `takes:" +
			otherTakes +
			"`, not `takes:" +
			matched +
			"`. Confirm with the founder, or switch to /" +
			otherTakes +
			", first.\n\n"
		);
	return (
		"#" +
		takesIssue +
		" is `takes:" +
		otherTakes +
		"`, not `takes:" +
		matched +
		"`. Confirm with the founder first.\n\n"
	);
}

/**
 * A tracker command's whole payload: every command but /code-review.
 * @param {{matched: string, takesIssue: string, otherTakes: string, pricedOptions: string, claimIssue: string}} parts
 */
const trackerContext = ({
	matched,
	takesIssue,
	otherTakes,
	pricedOptions,
	claimIssue,
}) =>
	takesLine(takesIssue, otherTakes, matched) +
	header(matched, claimIssue) +
	(matched === "wayfinder" ? WAYFINDER_CLAUSES : "") +
	trackerIndex(matched) +
	(CLOSING_STEPS[matched] ?? "") +
	pricedOptions;

/**
 * /code-review's payload: its rules and the review tier a declared sensitive
 * path owes (#1697). Where the whole would cross the persistence threshold the
 * tier leads, so it lands in the preview (#1746).
 * @param {string} rules @param {string} tier @param {number} persistChars
 */
function codeReviewContext(rules, tier, persistChars) {
	if (tier === "") return rules;
	if (rules.length + 2 + tier.length < persistChars)
		return `${rules}\n\n${tier}`;
	return `${tier}\n\n${rules}`;
}

module.exports = {
	COMMANDS,
	TAKES_READ,
	PRICED_OPTIONS_POINTER,
	WAYFINDER_CLAUSES,
	INDEX,
	INDEX_LINES,
	CLOSING_STEPS,
	pricedOptionsWhole,
	codeReviewParts,
	codeReviewRules,
	trackerIndex,
	header,
	takesLine,
	trackerContext,
	codeReviewContext,
};
