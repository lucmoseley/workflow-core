/*
 * issue-close.js — the guard-issue-close core (#2798, programme #2733): may
 * this `gh issue close` go ahead? Five rules, in this order: a roadmap card's
 * own issue is closed by /card-close (mantahostels#220), a completed close
 * leaves no unmet acceptance criteria (#1640), every close says what is still
 * outstanding (mantahostels#185, #984), a completed close leaves no census
 * row its commits expired (#1913), and none whose commits are unpushed
 * (#3101).
 *
 * A CORE: it does no I/O. gh, the clock, the roadmap file, the tracker, the
 * census read, the landing read and the rule store arrive as ports;
 * lib/issue-close-host.js builds the real ones.
 *
 * THE FIRST VERDICT ENDS THE CALL. A deny stops the walk, and so does a
 * fail-open that lets the whole call through, logged. A fault that leaves the
 * other rules a verdict to reach is logged and the walk goes on.
 *
 * THE TIME BUDGET (docs/agents/guard-authoring.md §The ceiling your guard runs
 * under). The dispatcher's registration runs `onFailure: block`, so an
 * overrun refuses the close. Each close costs up to four external calls — the
 * issue read, the Outstanding open-check, the census read and the landing
 * read — so each gets what is left of the run budget as its own timeout,
 * which the host cuts again to what the dispatcher's budget leaves
 * (lib/hook-deadline.js); a call with too little left is not made but
 * recorded as a fail-open. Only each spawned read is bounded, so CPU work
 * between reads that outlasts the registration's timeout refuses the close.
 *
 * Why: a closed issue is corpus, not a queue — nothing surfaces it again — so
 * residual work parked in one is found only when the founder happens to read
 * the comment.
 *
 * THE OUTSTANDING RULE: every close carries a line beginning
 * `**Outstanding:**` — in the close's own --comment, or else the issue's
 * newest comment; an older marker does not count (#984). It holds the bare
 * word `none`, or items only, each `#N (what is left)` citing an OPEN issue
 * other than this one. DENY, not warn, and this is the distinction
 * mantahostels#103 draws: deny on a structured fact, warn where the hook is
 * inferring. Whether a comment's prose describes unfiled work is inference,
 * and no detector is built on it (mantahostels#185; examples on #1990): an
 * accepted limit and a real escape are written identically, so the prose
 * around the line stays unread. The LINE is a structured fact (#984, spec
 * #958): lib/outstanding-line.js reads its grammar and checks each cited
 * carrier open, and a shape miss or a closed, missing or self-referencing
 * carrier is denied.
 *
 * THE CARD RULE (mantahostels#220): closing a card's own issue by hand does
 * not merely skip a step — /card-close step 1 refuses to run on an issue
 * that is already CLOSED, so a hand close makes the command unusable and the
 * roadmap edit has to happen outside the one thing that sequences it
 * (mantahostels#165). The discriminator, settled at mantahostels#275: a child
 * ticket that merely shares a card-id prefix has a parent, a card's own issue
 * has none. Measured there — 33 of 39 prefixed closed issues had a parent and
 * were all children; all 5 card issues had none. A `wayfinder:*` label was
 * measured and rejected as *the* discriminator: it separates only 26 of the
 * 33, the doc-map-nav-check children carrying `kind:ticket` instead. ON TOP
 * of it, a `wayfinder:map` label exempts (mantahostels#1490): a map is
 * unparented like a card's own issue, so every card-prefixed map read as one.
 * The exemption survives mantahostels#275's measurement because it only has
 * to be true of maps, and a map is never a card's own issue. Known residual:
 * an unparented issue that borrows a card's prefix, carries no
 * `wayfinder:map` label, and is neither that card's issue nor a map, is
 * denied wrongly; the escape is --reason "not planned", or /card-close
 * itself.
 *
 * THE CRITERIA, CENSUS AND LANDING RULES are resolve-ticket.js's refusals,
 * read through lib/ticket-criteria.js (#1640), lib/census-digest.js (#1913,
 * #1876) and lib/unlanded-commits.js (#3101). The census rule stands down
 * where a `**Census:**` line says why, or the close names another repo, whose
 * commits cite this one's tracker; the landing rule where an `**Unlanded:**`
 * line says why.
 *
 * LIMITS
 *  - It matches the parsed command form — a segment whose command word is
 *    `gh`, subcommand pair `issue close` — never a substring, so a grep or a
 *    heredoc mentioning `gh issue close` passes. Its manifest row runs it only
 *    on a command `Bash(gh *)` admits (mantahostels#2127), so `/usr/bin/gh …`
 *    is unjudged.
 *  - A close through the GitHub UI, or through `gh api --method PATCH … -f
 *    state=closed`, is not seen. The api spelling is the known residual, left
 *    alone because the guard-issue-body core already carries the PATCH-shaped
 *    machinery and duplicating it here would put two readers on one endpoint.
 *  - It FAILS OPEN, house style (mantahostels#103 §6): an unparseable
 *    command, a missing or unreachable `gh`, a --comment it cannot wholly
 *    read (a `$` or backtick expansion, say), a census read that faulted or
 *    ran out of budget, an open-check the Outstanding-line parser could not
 *    make, and a run budget spent before a call are all allowed through — and
 *    all RECORDED (mantahostels#147) for check-guard-errors.js to report
 *    under `npm run status`.
 *  - THE RULE IT PRINTS lives in docs/agents/rules/ (mantahostels#1649, spec
 *    mantahostels#1641), spliced into its refusal. An unreadable fragment is
 *    the ONE fault it does not fail open on and does not log; it refuses with
 *    a pointer to the fragment instead.
 *  - It guards the Bash tool, so it binds agent sessions and not the
 *    founder's own terminal (mantahostels#109).
 *  - A `-R`/`--repo` close is judged against the repo it names (#553), and
 *    the card rule stands down where that is not the tracker
 *    `.claude/workflow-core.json` declares, or the origin remote's where it
 *    declares none. No tracker resolving leaves the card rule running. A
 *    `GH_REPO=… gh issue close N` is not seen: the parser strips the
 *    assignment, so that close is still read off this repo's #N.
 *  - A chained `gh issue comment N … && gh issue close N` is judged before
 *    the comment lands: the close carries its own line, or runs in a later
 *    call.
 */

/* The rule readers — ticket-criteria.js, outstanding-line.js,
 * census-digest.js and unlanded-commits.js — are required where a close
 * reaches them, not here: they cost more load than every gh call that closes
 * nothing should pay (#2798's latency gate). */
const {
	deny,
	open,
	ruleOrFallback,
	walkVerdict,
} = require("./guard-verdict.js");
const { ISSUE_VALUE_FLAGS } = require("./gh-issue-ref.js");
const { parseCommand } = require("./shell-parse.js");
const { isGhCommand, literal, scanFlags } = require("./shell-words.js");
const { requiredGroup } = require("./regex-group.js");
const { repoSlug } = require("./workflow-core-config.js");
const { ENTRY_BUDGET_MS } = require("./hook-deadline.js");

/**
 * @typedef {{ refusal: string } | { outOfBudget: true }} RefusalRead
 * @typedef {object} ClosePorts
 * @property {(args: string[], timeoutMs: number) => string} gh gh's stdout;
 *   throws where gh fails, cannot be found or outlasts `timeoutMs`
 * @property {() => number} now the clock, in ms
 * @property {(rel: string) => string | null} readFile a file under the host
 *   root, null where it cannot be read
 * @property {() => string | undefined} tracker the tracker the config
 *   declares, else the origin remote's; undefined where none resolves
 * @property {(n: number, timeoutMs: number) => RefusalRead} census the census
 *   refusal over issue n's expired rows, "" where none is; outOfBudget where
 *   the read passed `timeoutMs`; throws where git, the anchors file or a
 *   formatter cannot answer
 * @property {(n: number, comment: string, timeoutMs: number,
 *   cwd: string | undefined) => RefusalRead} landing the refusal over issue
 *   n's commits, cited on the HEAD of the checkout at `cwd` (the host root
 *   where undefined) or named by sha in `comment`, that the pushed ref lacks,
 *   "" where none is; outOfBudget and throws as census
 * @typedef {import("./kit-context.js").KitContext & ClosePorts} CloseContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

/* The ms clock lets no call end past the dispatcher's entry budget, counted
 * from the core's own start on its injected clock. The 4 s cap and the 1 s
 * floor are carried unmeasured. */
const BUDGET_MS = ENTRY_BUDGET_MS.PreToolUse;
const CALL_MS = 4000;
const MIN_CALL_MS = 1000;

const ROADMAP = "docs/reference-roadmap.html";

const SPACE = "[ \\t\\n\\v\\f\\r]";

/* `<card-id> — <title>`, em dash, the convention /card-close step 2 parses.
 * DELIBERATELY STRICTER than check-issue-card-drift.js, which takes
 * [A-Za-z0-9._-] and an en dash or hyphen too: this one denies, so a title it
 * misreads blocks sanctioned work. The looser shape is recorded instead
 * (mantahostels#220), and a hit means the convention has drifted and this
 * pattern needs widening — with isCardOwnIssue in lib/tracker-ops.js,
 * resolve-ticket's copy. */
const CARD_TITLE_RE = /^([a-z0-9][a-z0-9-]*) — /;
const LOOSE_CARD_TITLE_RE = new RegExp(
	`^${SPACE}*[A-Za-z0-9._-]+${SPACE}+[—–-]${SPACE}`,
);

/* Spares the criteria read on the common body with no criteria heading. */
const CRITERIA_HEADING_RE = new RegExp(
	`(^|\\n)${SPACE}{0,3}#+${SPACE}+acceptance`,
);

/**
 * @typedef {object} Issue the fetched payload, `data` undefined where it did
 *   not parse — every field then reads empty
 * @property {Record<string, unknown> | undefined} data
 * @typedef {object} Run one call's judging
 * @property {Parsed} parsed
 * @property {CloseContext} ctx
 * @property {number} start the clock when the call began
 * @property {string} fetched the repo#number `issue` belongs to: one call can
 *   close two issues, and a cache without its key answers the second close
 *   from the first one's payload
 * @property {Issue | null} issue
 * @typedef {object} Close one `gh issue close`, as scanClose read it
 * @property {string} segment
 * @property {string} issue the number, as written
 * @property {boolean} hasReason
 * @property {string} reason the last --reason value
 * @property {boolean} reasonHidden
 * @property {string} repo the `-R`/`--repo` value, "" where none
 * @property {boolean} repoHidden
 * @property {string} comment the last --comment, as gh takes it
 * @property {boolean} commentHidden
 */

/**
 * @param {string} command
 * @param {CloseContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	/** @type {Run} */
	const run = {
		parsed: parseCommand(command),
		ctx,
		start: ctx.now(),
		fetched: "",
		issue: null,
	};
	return walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx) ?? null;
}

/**
 * What is left of the run budget for the next call, at most CALL_MS.
 * @param {Run} run
 */
const callBudget = (run) =>
	Math.min(CALL_MS, BUDGET_MS - (run.ctx.now() - run.start));

/**
 * One command the call runs: a `gh issue close`, by the command word's
 * basename, is judged.
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	const [head = "", sub, verb] = cmd.words;
	if (!isGhCommand(head)) return;
	if (sub !== "issue" || verb !== "close") return;
	const close = scanClose(run, cmd.segment, cmd.words.slice(3));

	if (abandoned(run, close)) return;

	/* Empty only where gh got no positional argument, or an empty or bare-`#`
	 * one: gh refuses each and closes nothing, so there is no close to judge
	 * and no fault to record. Bash reading an unquoted `#12` as a comment is
	 * the usual route (#547). */
	if (!close.issue) return;
	if (!/^[0-9]+$/.test(close.issue))
		open(
			run.ctx,
			"could not read the issue number from a gh issue close — close allowed unchecked",
		);
	/* Judging it against this repo instead would be a verdict on the wrong
	 * issue. */
	if (close.repoHidden)
		open(
			run.ctx,
			"could not read the --repo value of a gh issue close — close allowed unchecked",
		);

	/* mantahostels#220 runs FIRST, and its verdict is the more useful one where
	 * both apply: this close should not be happening at all, so answering the
	 * Outstanding rule first would send the session to perfect a comment on it
	 * instead. */
	if (!elsewhere(run, close)) judgeCard(run, close);
	/* Before the Outstanding rule: unmet criteria mean the close is premature,
	 * not merely badly worded. */
	const criteriaRead = judgeCriteria(run, close);
	judgeOutstanding(run, close);
	/* After the Outstanding rule: the census read is the slowest call, and
	 * running it first could leave the others no budget. */
	judgeLanding(run, close);
	judgeCensus(run, close);
	/* Reached only where the Outstanding rule passed without a fetch of its own
	 * failing — a failed one ends the call — so this is the outage's one
	 * record. */
	if (!criteriaRead)
		run.ctx.log(
			`could not read ${close.repo}#${close.issue} — acceptance criteria unchecked`,
		);
}

/**
 * Abandoned work owes no disposition. The --reason value is read back, so a
 * `--reason completed` whose --comment says "not planned" is still judged;
 * only where that value cannot be read is the raw command searched for the
 * words, gated on the parsed segment carrying the flag.
 * @param {Run} run
 * @param {Close} close
 */
function abandoned(run, close) {
	if (!close.hasReason) return false;
	return close.reasonHidden
		? /not[\s\S]planned/.test(run.parsed.subject.toLowerCase())
		: /^not[\s\S]planned$/.test(close.reason.toLowerCase());
}

/**
 * The first bare word that reads as anything is the issue. The parser blanked
 * a quoted number, and `gh issue close "#12"` closes #12, so the span is read
 * back (#547). A `"$ISSUE"` reads back unexpanded and fails open. `\#12`
 * reaches gh as `#12` too, bash dropping the `\`.
 * @param {Close} close accumulator: issue is set where still empty
 * @param {string} text
 */
function readIssue(close, text) {
	if (!close.issue) close.issue = text.replace(/^\\/, "").replace(/^#/, "");
}

/**
 * @param {Close} close accumulator: hasReason, reason and reasonHidden are set
 * @param {string} text
 * @param {boolean} known
 */
const readReason = (close, text, known) => {
	close.hasReason = true;
	close.reason = text;
	close.reasonHidden = !known;
};

/**
 * @param {Close} close accumulator: repo is set, and repoHidden where unread
 * @param {string} text
 * @param {boolean} known
 */
const readRepo = (close, text, known) => {
	close.repo = text;
	if (!known) close.repoHidden = true;
};

/**
 * @param {Close} close accumulator: comment and commentHidden are set
 * @param {string} text
 * @param {boolean} known
 */
const readComment = (close, text, known) => {
	close.comment = text;
	close.commentHidden = !known;
};

/** What each value-taking flag sets, its value read back. */
const CLOSE_READS = new Map([
	["-r", readReason],
	["--reason", readReason],
	["-R", readRepo],
	["--repo", readRepo],
	["-c", readComment],
	["--comment", readComment],
]);

/**
 * Read a `gh issue close` invocation's arguments. A --reason with no value
 * left to take still counts as spelled, its value unread.
 * @param {Run} run
 * @param {string} segment
 * @param {string[]} words
 * @returns {Close}
 */
function scanClose(run, segment, words) {
	/** @type {Close} */
	const close = {
		segment,
		issue: "",
		hasReason: false,
		reason: "",
		reasonHidden: false,
		repo: "",
		repoHidden: false,
		comment: "",
		commentHidden: false,
	};
	scanFlags(ISSUE_VALUE_FLAGS.close, words, (kind, name, value) => {
		const { text, known } = literal(value, run.parsed.spans);
		if (kind === "arg") readIssue(close, text);
		else if (kind === "opt") CLOSE_READS.get(name)?.(close, text, known);
		else if (kind === "dangling" && (name === "-r" || name === "--reason")) {
			close.hasReason = true;
			close.reasonHidden = true;
		}
	});
	return close;
}

/**
 * Does this close name a repo other than the tracker, declared or derived
 * from the origin remote? False where it names none, names the tracker, or no
 * tracker resolves.
 * @param {Run} run
 * @param {Close} close
 */
function elsewhere(run, close) {
	if (!close.repo) return false;
	const tracker = run.ctx.tracker();
	if (!tracker) return false;
	return repoSlug(close.repo) !== repoSlug(tracker);
}

/**
 * The issue as GitHub describes it, re-fetched only when the repo#number
 * differs from the last one fetched. Null where GitHub could not be asked,
 * which is a fail-open the caller records rather than a confident answer.
 *
 * ONE request serves every rule: `title`, `parent` and `body` ride the
 * comments' read, so the card and criteria checks cost no extra call.
 * @param {Run} run accumulator: issue and fetched are set to this read's
 * @param {Close} close
 * @returns {Issue | null}
 */
function fetchIssue(run, close) {
	const key = `${close.repo}#${close.issue}`;
	if (run.issue && run.fetched === key) return run.issue;
	run.issue = null;
	run.fetched = "";
	const left = callBudget(run);
	if (left < MIN_CALL_MS) return null;
	let out;
	try {
		out = run.ctx.gh(
			[
				"issue",
				"view",
				close.issue,
				"--json",
				"comments,title,parent,labels,body",
				...(close.repo ? ["--repo", close.repo] : []),
			],
			left,
		);
	} catch {
		return null;
	}
	if (!out) return null;
	/** @type {Record<string, unknown> | undefined} */
	let data;
	try {
		/** @type {unknown} */
		const parsed = JSON.parse(out);
		data = parsed === null ? {} : record(parsed);
	} catch {
		data = undefined;
	}
	run.issue = { data };
	run.fetched = key;
	return run.issue;
}

/**
 * `v` where it is a JSON object, else undefined.
 * @param {unknown} v
 * @returns {Record<string, unknown> | undefined}
 */
const record = (v) =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? /** @type {Record<string, unknown>} */ (v)
		: undefined;

/**
 * A payload field.
 * @param {unknown} v
 */
const field = (v) =>
	v === null || v === undefined || v === false ? "" : String(v);

/**
 * The newest comment's body.
 * @param {Record<string, unknown>} data
 */
const newestComment = (data) =>
	field(
		Array.isArray(data.comments)
			? record(data.comments.at(-1))?.body
			: undefined,
	);

/**
 * Is this issue a roadmap card's own issue whose card is not yet `done`?
 * Denies where it is, logs where it cannot tell, and returns otherwise.
 *
 * A title that does not parse is not "cannot tell": most issues here are not
 * cards, so an absent `<card-id> — ` prefix is the ordinary case and means no.
 * @param {Run} run
 * @param {Close} close
 */
function judgeCard(run, close) {
	const fault = cardFault(run, close);
	if (fault) run.ctx.log(`${fault} — card state unchecked`);
}

/**
 * @param {Run} run
 * @param {Close} close
 * @returns {string} the reason the card went unchecked, "" where it was
 *   checked or is no card
 */
function cardFault(run, close) {
	/* No fault: the Outstanding rule fetches the same payload and records the
	 * outage itself, and one unreachable GitHub should leave one line. */
	const data = fetchIssue(run, close)?.data;
	if (!data) return "";
	const title = field(data.title);
	const m = CARD_TITLE_RE.exec(title);
	/* The 40-character cut is carried unmeasured. */
	if (!m)
		return LOOSE_CARD_TITLE_RE.test(title)
			? `title "${[...title].slice(0, 40).join("")}" looks like a card id this guard will not parse, so it`
			: "";
	const id = requiredGroup(m, 1, CARD_TITLE_RE);
	/* A parent means a child ticket that merely inherited the prefix
	 * (mantahostels#275). */
	if (field(record(data.parent)?.number)) return "";
	/* A map borrows the prefix without being the card's issue, and is
	 * unparented too, so the test above cannot tell it apart
	 * (mantahostels#1490). */
	const labels = Array.isArray(data.labels)
		? data.labels
				.map((/** @type {unknown} */ l) => field(record(l)?.name))
				.join(" ")
		: "";
	if (` ${labels} `.includes(" wayfinder:map ")) return "";
	const roadmap = run.ctx.readFile(ROADMAP);
	if (roadmap === null) return `could not read the roadmap, so card ${id}`;
	/* Exactly one card, or we cannot say which card this is — /card-close step
	 * 2 stops on the same test rather than guessing. Every occurrence counts,
	 * not every line, so a reformatting that joined cards still counts two. */
	const count = roadmap.split(`id:"${id}",`).length - 1;
	if (count !== 1) return `${id} names ${count} cards on the roadmap, so it`;
	/* Fields run id,p,a,kind,state — state lands within ~90 characters of the
	 * id, so a 200-character window reaches it and stops well short of the
	 * next card. */
	const window =
		new RegExp(`id:"${id}",[^\\n]{0,200}`, "u").exec(roadmap)?.[0] ?? "";
	const state = /state:"([a-z]*)"/.exec(window)?.[1] ?? "";
	if (!state) return `card ${id} has no readable state, so it`;
	if (state !== "done") denyCard(run, close, id, state);
	return "";
}

/**
 * @param {Run} run
 * @param {Close} close
 * @param {string} id
 * @param {string} state
 * @returns {never}
 */
function denyCard(run, close, id, state) {
	deny(
		run.ctx,
		close.segment,
		`This closes the issue for roadmap card \`${id}\`, and that card is still \`${state}\`, not \`done\`: @CMD@

Close it with **/card-close ${close.issue}** instead.

${ruleOrFallback(run.ctx, "card-close-by-hand", "A roadmap card's own issue is closed by /card-close, never by hand")}`,
	);
}

/**
 * Denies over unmet criteria (#1640), or returns whether the issue was read:
 * false is the outage judge() records once the Outstanding rule has run.
 * @param {Run} run
 * @param {Close} close
 */
function judgeCriteria(run, close) {
	const issue = fetchIssue(run, close);
	if (!issue) return false;
	const body = field(issue.data?.body);
	if (!CRITERIA_HEADING_RE.test(body.toLowerCase())) return true;
	const { unmetCriteria } = require("./ticket-criteria.js");
	const unmet = unmetCriteria(body)
		.map((i) => i.text)
		.join("\n")
		.replace(/\n+$/, "");
	if (!unmet) return true;
	deny(
		run.ctx,
		close.segment,
		`This closes #${close.issue} over acceptance criteria neither ticked nor waived: @CMD@

${unmet
	.split("\n")
	.map((l) => `  - [ ] ${l}`)
	.join("\n")}

Re-run the close once each is ticked or waived — or, abandoning the issue, with --reason "not planned".

${ruleOrFallback(run.ctx, "ticket-criteria-unticked", "Tick each acceptance criterion this session verified, or annotate it **waived:** <why>, before closing")}`,
	);
}

/**
 * Denies a close whose Outstanding line is missing or refused (#984), or
 * records a fail-open.
 * @param {Run} run
 * @param {Close} close
 */
function judgeOutstanding(run, close) {
	const at = `${close.repo}#${close.issue}`;
	/* An unreadable --comment may carry the line, so the newest comment is no
	 * stand-in for it (#990, the wrong refusal of #1082's close). Logged, not
	 * ended, so a later close in the same call is judged. */
	if (close.commentHidden) {
		run.ctx.log(
			`could not read the --comment of a gh issue close on ${at} — close allowed unchecked`,
		);
		return;
	}
	/* The close's own --comment counts where it carries a live line, as the
	 * parser decides, so one quoted in a fence leaves the newest comment to
	 * judge (#1247). */
	const {
		buildRefusalText,
		hasOutstandingLine,
		judge: judgeLine,
	} = require("./outstanding-line.js");
	let said;
	let from;
	if (hasOutstandingLine(close.comment)) {
		said = close.comment;
		from = "this close's own --comment";
	} else {
		const data = fetchIssue(run, close)?.data;
		if (!data)
			open(
				run.ctx,
				`could not read comments on ${at} — close allowed unchecked`,
			);
		said = newestComment(data);
		from = `#${close.issue}'s newest comment — an older one does not count`;
	}
	const left = callBudget(run);
	if (left < MIN_CALL_MS)
		open(
			run.ctx,
			`no time left in the guard's budget to judge ${at}'s Outstanding line — close allowed unchecked`,
		);
	const verdict = judgeLine(said, {
		grammar: "outstanding",
		self: close.issue,
		tracker: close.repo ? repoSlug(close.repo) : (run.ctx.tracker() ?? null),
		timeoutMs: left,
		log: null,
		gh: (args, { timeout }) => run.ctx.gh(args, timeout),
	});
	if (verdict.ok) {
		for (const line of verdict.unchecked)
			if (line) run.ctx.log(`Outstanding open-check on ${at}: ${line}`);
		return;
	}
	deny(
		run.ctx,
		close.segment,
		`This close does not say what is still outstanding in the form this guard reads: @CMD@

Read: ${from}.
${buildRefusalText(verdict).replace(/\n+$/, "")}

${ruleOrFallback(run.ctx, "close-outstanding", "Every close says what is still outstanding, on a line beginning **Outstanding:**")}

In one call, with the comment checked before anything is written: node ${run.ctx.scriptPath("resolve-ticket.js")} <n> --comment-file <file>. It refuses a comment without a passing **Outstanding:** line, a **Bound:** line, a **Values:** line (**Values:** none where nothing is house or untraced) or a **Practice:** line, and one naming a commit sha without a **Door:** line.`,
	);
}

/**
 * @typedef {object} RefusalRule a completed-close rule whose refusal a
 *   budgeted git read gives, escaped by a marker line in the close's own
 *   --comment or else the newest comment
 * @property {string} reader the reader, as a record names it
 * @property {string} unchecked what goes unchecked where it gives no verdict
 * @property {(at: string) => string} reading what it reads, for issue `at`
 * @property {string} line the escape line's marker
 * @property {(text: string) => boolean} hasLine
 * @property {(ctx: CloseContext, n: number, comment: string, timeoutMs: number) => RefusalRead} read
 *   `comment` the close's own --comment, else the newest comment
 * @property {string} opening the deny's first line, before the command
 * @property {string} remedy what the re-run waits on
 */

/** @type {RefusalRule} */
const CENSUS_RULE = {
	reader: "the census reader",
	unchecked: "census rows unchecked",
	reading: (at) => `${at}'s census rows`,
	line: "a Census line",
	hasLine: (text) => require("./census-digest.js").hasCensusLine(text),
	read: (ctx, n, _comment, ms) => ctx.census(n, ms),
	opening: "This close leaves census rows its commits expired",
	remedy: "each row is re-anchored",
};

/** @type {RefusalRule} */
const LANDING_RULE = {
	reader: "the landing reader",
	unchecked: "landing unchecked",
	reading: (at) => `whether ${at}'s commits landed`,
	line: "an Unlanded line",
	hasLine: (text) => require("./unlanded-commits.js").hasUnlandedLine(text),
	read: (ctx, n, comment, ms) => ctx.landing(n, comment, ms, ctx.cwd),
	opening: "This close reports work that has not landed",
	remedy: "they are pushed",
};

/**
 * @param {Run} run
 * @param {Close} close
 */
const judgeCensus = (run, close) => judgeRefusalRule(run, close, CENSUS_RULE);

/**
 * @param {Run} run
 * @param {Close} close
 */
const judgeLanding = (run, close) => judgeRefusalRule(run, close, LANDING_RULE);

/**
 * Denies a completed close `rule` refuses, or records a fail-open. A close
 * naming another repo owes none: the commits cite this one's tracker.
 * @param {Run} run
 * @param {Close} close
 * @param {RefusalRule} rule
 */
function judgeRefusalRule(run, close, rule) {
	const at = `${close.repo}#${close.issue}`;
	/* The Outstanding rule records an unreadable --comment for the whole
	 * close. */
	if (close.commentHidden) return;
	if (elsewhere(run, close)) return;
	const issue = fetchIssue(run, close);
	const newest = issue?.data ? newestComment(issue.data) : "";
	const left = callBudget(run);
	if (left < MIN_CALL_MS) {
		run.ctx.log(
			`no time left in the guard's budget to read ${rule.reading(at)} — unchecked`,
		);
		return;
	}
	const noVerdict = () =>
		run.ctx.log(`${rule.reader} gave no verdict on ${at} — ${rule.unchecked}`);
	/* Issue 0 is no issue: no reader is asked about it. */
	const n = Number(close.issue);
	if (n < 1) return noVerdict();
	const said = `${close.comment}\n\n${newest}`;
	if (rule.hasLine(said)) return;
	/** @type {RefusalRead} */
	let read;
	try {
		read = rule.read(run.ctx, n, close.comment || newest, left);
	} catch {
		return noVerdict();
	}
	if ("outOfBudget" in read) {
		run.ctx.log(
			`${rule.reader} ran out of the guard's time budget on ${at} — ${rule.unchecked}`,
		);
		return;
	}
	if (!read.refusal) return;
	if (!issue) {
		run.ctx.log(
			`could not read ${at}'s newest comment for ${rule.line} — ${rule.unchecked}`,
		);
		return;
	}
	deny(
		run.ctx,
		close.segment,
		`${rule.opening}: @CMD@

${read.refusal} The close's own --comment, or else the issue's newest comment, carries it.

Re-run the close once ${rule.remedy} or the line is written — or, abandoning the issue, with --reason "not planned".`,
	);
}

module.exports = { field: "command", noun: "command", decide };
