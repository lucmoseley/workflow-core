const COMMANDS = [
	"wayfinder",
	"to-spec",
	"to-tickets",
	"implement",
	"triage",
	"card-close",
	"code-review",
];

const TAKES_READ = ["wayfinder", "to-spec", "to-tickets", "implement"];

/** @param {string} outputStyle */
const pricedOptionsWhole = (outputStyle) =>
	"\n\nEVERY CHOICE PUT TO THE FOUNDER SHIPS PRICED OPTIONS — each house decision a resolution or mid-session fork turns on. Enumerate the real alternatives (not motives, not diagnoses) and price each on its own line in exactly this shape, with nothing added:\n\n(A) <the option, stated in plain words>\nConfidence: 70% (60% - 80%). <what drives the estimate, and what would move it>\n\n(B) <the next option>\nConfidence: 30% (20% - 40%). <as above>\n\nRelation: <rivals: which options actually conflict, and on what — or: independent, so any combination is takeable>\n\nOptions are ALWAYS lettered (A), (B), (C) — never numbered, never bulleted, never unlabelled — and the letter is what the founder replies with, so it is repeated in full wherever the option is referred to again. A choice put to the founder is put AS a numbered `❓ **Q1**` round, because the lettered priced form is owed inside a round (" +
	outputStyle +
	"); an ordinary question that is NOT a choice between alternatives is asked plainly instead, with one confidence figure and a recommendation, and takes no letters. The `grilling` skill's round shape governs the QUESTIONS you ask; the options inside any one question still take the lettered priced form here. Wherever there is more than one option the `Relation:` line is required, because the lettered shape reads as a ballot — rivals for one slot — and options that could be taken together must say so. THE FIGURES MEAN DIFFERENT THINGS BY RELATION: where the options are rivals for one slot, each figure is the probability that option is the right choice, so the headline figures sum to 100% (as 70% and 30% above) and the `Relation:` line says `rivals`; where options can be combined, each figure is that option's own chance of being worth taking and they need not sum. Then name the recommendation by its letter, every letter it takes where more than one is takeable, and the one assumption that would flip it. NO tables, NO horizontal rules, NO bold or titled option names. Never emit a filler percentage, and where a claim cannot be grounded say it is unknowable or subjective instead of inventing one. THE RULE HAS NO STAKES THRESHOLD: a choice that looks like a formality — a yes/no follow-on, a lopsided binary with one obvious answer — still ships the lettered priced form ((A) yes at ~90% is right; no options at all is not), and the only escape is saying a number is unknowable, never omitting the pricing. Research before you ask, as far as any source could answer it; ask only what research leaves open, naming that gap: `rule:house-decision`.";

const PRICED_OPTIONS_POINTER =
	"\n\nEVERY CHOICE PUT TO THE FOUNDER SHIPS PRICED OPTIONS, in the lettered shape your Core voice output style gives, put as a numbered `❓ **Q1**` round. Research before you ask, and ask only what research leaves open, naming that gap: `rule:house-decision`.";

/** @param {"base" | "local" | "neither" | "both"} state @param {string} standardsBase */
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

/** @param {string} standards @param {string} glossary */
const withGlossary = (standards, glossary) =>
	`${standards} Hand the Standards axis \`${glossary}\` too, for base §G8.`;

const DISPATCH_SHAPE_FALLBACK =
	"Dispatch the review runs as docs/agents/rules/review-dispatch-shape.txt says.";

/** @param {string} reviewType @param {string} sidSuffix @param {string} dispatchShape */
const dispatchText = (reviewType, sidSuffix, dispatchShape) =>
	"Reviewer type `" +
	reviewType +
	"`; Artefact paths `.claude/tmp/review-standards" +
	sidSuffix +
	".md` and `.claude/tmp/review-spec" +
	sidSuffix +
	".md`. " +
	dispatchShape;

const ULTRA =
	"AFTER fixing the findings, before you commit, judge this diff against `docs/effort-guide.md` §The fourth axis; failing its test, the normal case, say NOTHING, and meeting it, follow that section's steps. NEVER START ONE UNASKED.";

const DEVIATIONS_READ_FALLBACK =
	"Fetch the originating issue's `**Deviations:**` comment for the Spec axis, as docs/agents/rules/review-deviations-read.txt says.";

const DISPOSITION_FALLBACK =
	"Give every review finding a destination, as docs/agents/rules/review-finding-destination.txt says.";

/**
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

/** @param {Parameters<typeof codeReviewParts>[0]} host @param {string} pricedOptions */
const codeReviewRules = (host, pricedOptions) =>
	"You invoked /code-review, whose vendored skill file cannot carry project rules. " +
	codeReviewParts(host).join(" ") +
	pricedOptions;

const WAYFINDER_CLAUSES =
	"\n\nA RESOLUTION THAT DISPOSES OF A FINDING WRITES BACK TO THE SOURCE THAT DECLARED IT OPEN — a gap ledger, a `Disposition: worth a ticket` row, a \"no card covers this\" line, a \"parked — revisit as a card\" note. It follows the routes the `roadmap-edit` skill's step 3 gives. Ruled at mantahostels#3205.\n\n### Research artefacts — the dispatch half, which binds however the research was dispatched. The subagent NEVER writes into `docs/research/`. Paste this into its prompt verbatim:\n\n> Artefact: .claude/tmp/research-<name>.md\n>\n> Write your findings to `.claude/tmp/research-<name>.md`, appending each the moment it lands rather than holding them back for your final report. Do NOT write anywhere under `docs/`, and do NOT commit anything. Report the absolute path of the file back to me when you finish. Write the artefact in ASD-STE100 Simplified Technical English.\n\nFrom a throwaway worktree hand the absolute path instead. Posting is the dispatching session's, never the subagent's, and its order is in `docs/agents/issue-tracker.md` §Research artefacts.\n\n**Size a reading agent's job to its context window:** split a large source family across agents, and have each save fetched text to disk and search it rather than read it whole (#1789).\n\n### A charting run is DONE when four things are true, and not one ticket later. The map body is written; every ticket you can specify now exists as a child issue; their blocking edges are wired AND read back (`rule:wayfinder-ops-shapes` carries the shape; wiring one is not evidence it took); and every `wayfinder:research` ticket this run created is resolved and closed. Then nothing further is owed — end the session on `result:`. The one-ticket-per-session rule grants charting an exception for research tickets; SPENDING that exception is not a licence to carry on past it (mantahostels#2564, mantahostels#2577).\n\n**What runs next across sessions belongs to `/pick-next` and the frontier query — never to you, and never to the founder as a question.** Which ticket THIS session resolves is still yours to choose; what is not yours is what runs after it or beside it. Naming the next ticket in order is reporting and is welcome. Asking him which ticket to run, in what order, or in which parallel batch, puts him a scheduling choice.";

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

/** @type {Record<string, string>} */
const CLOSING_STEPS = {
	implement:
		"\n\nBefore starting, read the ticket's parent spec — the sub-issue parent claim-issue.js prints, or the issue a `## Parent` line names — and the resolution comment on each closed blocker (`gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by`). Then run `node scripts/build-state.js <n> --spec <parent>`: it creates or resumes the ticket's build state file, keyed by issue number, and prints its path. Every unit keeps one, a one-slice unit included. Fill `slices` from the acceptance criteria, `standingRules` with each do-not constraint from the spec and from what you learn, `filesTouched` and `next`; it survives compaction where the conversation does not. At each slice boundary rewrite it, and commit citing the ticket. Before ending, rewrite it. The closing /code-review runs over the commits `node scripts/spec-commits.js <n>` lists for the ticket.\n\n**Found that the ticket cannot start yet, because something it waits on has not happened — another issue's work, a release, a scheduled run?** Run `scripts/lib/rule-text.sh blocked-ticket-gate roadmap-gating` then, and do what it says before you release the claim: the refill loop relaunches a ticket released ungated (#5399).",
	triage:
		"\n\nA `kind:spec` whose every ticket has closed gets a whole-spec review before you decide it: run `node scripts/spec-commits.js <n>`, then /code-review over the `git show` it prints, handing the reviewers the touched files at the spec's last commit, not only the diff lines. Record every finding in your triage comment, which ends with the `**Reviewed through:** <40-hex sha>` line the script prints. Fix first, on every pass: the `review-finding-destination` rule /code-review hands you says which findings are FIXED here and which TICKETED, and what a TICKETED line names (#4284, #4492). On a first pass a TICKETED one is filed under the spec while it is open — retag the spec `takes:triage` → `takes:children` yourself; standalone, its body citing the spec, only where the spec had already closed (#897). A spec back at triage whose earlier comment carries a `**Reviewed through:**` line is reviewed over the commits since that sha only: `node scripts/spec-commits.js <n> --since <sha>`. From the second pass on, each TICKETED finding gets a class, picking only where it is filed (#3811). Live: it names a route ordinary use reaches and the wrong behaviour on it; file it under the spec, with the same retag. Corner: it needs an unusual input or state; file it standalone, its body citing the spec. Tidying: it changes no behaviour; file it standalone, one ticket per pass. The first pass that files no live finding closes the spec, naming any open standalone tickets on `**Outstanding:**`. No pass count stops a spec. At a fifth or later pass, counting the earlier `**Reviewed through:**` comments, your triage comment also says whether to redesign rather than patch.",
};

/** @param {string} matched @param {string} claimIssue */
const header = (matched, claimIssue) =>
	"You invoked /" +
	matched +
	", which reads or writes the issue tracker. These project rules override the vendored skill's where they differ. Three the vendored skills get wrong: (1) claim the issue you are WORKING, and only that one: `node scripts/claim-issue.js <n>` before any other work on it — it refuses a live holder, then records the arbiter claim and assigns you (#530). NEVER one you file for later: it is created UNASSIGNED, as a claimed issue leaves /wayfinder's frontier (mantahostels#702). Claim it once you post a round on it (#1066). File with `node scripts/file-issue.js` — create, labels and parent link in one call, each filing naming `--origin <class>` and `--fault-signature <file>` or `--no-fault` (#4796) — adding `--assign-self` only where the session works what it creates (`/to-spec`). Resolve with `node scripts/resolve-ticket.js <n> --comment-file <f>`: comment, close, claim release and map line in one call. Its comment carries a `**Bound:**` line — what you read in full, what you only sampled or cited — and a `**Values:**` line: each house or untraced value it relies on, or `none`; and a `**Practice:**` line: `ran`, `covered`, `skipped` or `none-fits` (mantahostels#1827, #1707, #2325); one naming a commit sha also a `**Door:**` line, two-way or one-way (issue-tracker.md §Every close that names a commit). Off those scripts the arbiter record is yours: a hook makes it only off a literal `gh issue edit <n> --add-assignee @me` or `gh issue close <n>` through the Bash tool; a raw create-time assignment, the web UI, any other script, `gh api`, `--repo` or a shell-variable issue number needs `" +
	claimIssue +
	// bare-citation-ok: `#22 (gloss)` is the citation form's own example.
	"` or `release-issue <n>` by hand (§Claiming). (2) blocking edges and parent links use GitHub's native dependency and sub-issue endpoints, never a text `Blocked by:` line. (3) cite an issue number-first — `#22 (gloss)`, never `[title](url)` or a bare description; `to-tickets`'s \"numbers/titles\" is wrong on the order.";

/** @param {string} takesIssue @param {string} otherTakes @param {string} matched */
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

/** @param {string} rules @param {string} tier @param {number} persistChars */
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
