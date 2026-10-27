#!/usr/bin/env node
/*
 * guard-priced-options.js — Stop hook. Blocks a session that ends a turn having
 * put a question to the founder whose options are not in the lettered priced
 * form the guard-registry rule in `.claude/output-styles/core-voice.md`
 * requires. That rule is the text of record, and
 * scripts/priced-options-copies.test.ts fails when the style and
 * scripts/inject-tracker-docs.sh's pasted copy stop agreeing with each other or
 * with the regexes below (#51).
 *
 * Why writing the rule down keeps losing, and why the fix is a Stop hook rather
 * than PreToolUse: mantahostels#802.
 *
 * It carries a second, unrelated refusal on the same seam: in a background job,
 * a question round must also carry a `needs input:` line, or the job is filed
 * Completed while it waits on the founder (mantahostels#785). The style's rule states
 * both.
 *
 * THAT SECOND REFUSAL RESTS ON A CONTRACT OUTSIDE THIS REPO, and nothing here
 * can check it: the marker's meaning lives in the background-job harness, not
 * in any file or config the repo owns. If the harness stops privileging the
 * phrase, this blocks for nothing — so a session told the job was mislabelled
 * despite the marker should suspect this, not its own wording. WHAT THE
 * HARNESS SIDE ACTUALLY DOES (mantahostels#85):
 * the classifier reads only the LAST 4000 CHARACTERS of the outgoing message,
 * and it is a model reading that tail rather than a regex over the marker — so
 * the marker is necessary and not sufficient. A marker line ending in a
 * first-person promise of further work ("I'll then build the gate…") has been
 * observed to file the job Working regardless. Put the marker on its own line,
 * ending on the question, with nothing trailing it. Its other
 * residual: the marker is matched anywhere in the message, so a fenced example
 * or a pasted-back block reason satisfies it. Both accepted at mantahostels#785, the second
 * being evasion a session can only work on itself.
 *
 * SCOPE IS SELF-LIMITING, AND THE WRITTEN RULE NOW MATCHES IT (mantahostels#1503). Only
 * blocks opened by the `❓ **Qn**` round marker are examined, which nothing but
 * a grilling round emits. An ordinary reply containing a question carries no
 * marker and is never read. THE EVASION THAT OPENS: a real choice put WITHOUT
 * the marker is exempt here and unlettered under the rule, so this guard never
 * sees a session downgrading a decision into a plain question — mantahostels#872's
 * shape. IT IS NOT UNWATCHED (#199): scripts/guard-jev-advisory.js reads
 * exactly those messages, **Advisory** and permanently so, and speaks without
 * ever refusing. A BACKGROUND JOB IS NARROWER STILL: mantahostels#2583's
 * thirteenth refusal binds the round to the `needs input:` marker rather
 * than the marker to the round, a lone founder hand-over (#926) and a pointer
 * to a round still unanswered (#924) excepted; in a foreground session that
 * advisory reader is the whole of the cover.
 *
 * A THIRD REFUSAL, ON THE SAME MISLABEL AND OUTSIDE THE ROUND MARKER (mantahostels#822): in
 * a background job, a message claiming `result:` while still asking the founder
 * for approval. Matching is lexical over a fixed phrase list: no intent is
 * inferred, so recall is partial, and a message that genuinely finished while
 * offering optional follow-up is blocked with it. IT FORKS (mantahostels#2445): where every
 * offer in the message is about the NEXT ticket rather than the delivered task,
 * the refusal leads with dropping the offer instead of switching marker, a
 * finished session that merely nominates the next ticket having been pushed into
 * filing itself blocked over a choice that is `/pick-next`'s.
 *
 * A FOURTH REFUSAL, ON THE SAME MISLABEL AGAIN (mantahostels#85): a background job whose
 * `needs input:` line is trailed by work it promises to do next, or pushed past
 * the tail the classifier reads.
 *
 * A FIFTH REFUSAL, ON THE FORMAT ITSELF (mantahostels#1037): a question offering two or more
 * options and saying nothing about how they relate. The lettered shape is a
 * ballot — rivals for one slot — so a session holding partly-independent
 * improvements renders them as candidates and the founder has to ask whether
 * they conflict at all. The block demands a `Relation:` line, and
 * NOTHING BUT ITS PRESENCE IS CHECKED (mantahostels#1807) — the founder took
 * presence-only over a parser fix at mantahostels#1505. THE RESIDUAL IS THE WHOLE CONTENT: any line opening
 * `Relation:` and carrying anything at all passes, one answering nothing
 * included — a bare `Relation:` with nothing after it still blocks, the regex
 * requiring a non-empty tail. Accepted. It is evaded outright by splitting the
 * combinable options across separate `❓ **Qn**` blocks, which nothing here
 * compares.
 *
 * A SIXTH REFUSAL, ON A MISSING MARKER (mantahostels#1200): a background job
 * that finishes carrying neither `result:` nor `needs input:` is filed on
 * nothing and sits where it stopped, work committed and job never closed. Three
 * markers satisfy it, the third being `waiting:` — the hand-off turn CLAUDE.md
 * §Conventions requires while a subagent or background Bash job runs, which is
 * neither finished nor waiting on a human and needs no status write, something
 * running being what wakes the session. Residuals, shared with the others: the
 * marker is matched anywhere in the message, so a fenced example satisfies it.
 *
 * A SEVENTH REFUSAL, ON THE MISLABEL THE SIXTH LET THROUGH (mantahostels#1210): a
 * `result:` that is not the message's last line, a report below it filing a
 * finished job Working. Last-line, not distance.
 * A distance limb survives beside it for the marker whose own line overruns the
 * window. ITS RESIDUAL IS THE SAME INFERENCE THE FOURTH CARRIES: the classifier
 * is a model in the harness and cannot be read from here, so "last line" is a
 * best guess at where it acts. A second residual is its own: a `needs input:` or
 * `waiting:` below the marker switches the check off, so a report quoting the
 * block text back evades it entirely.
 *
 * AN EIGHTH REFUSAL, ON THE ONE THING NO WORDING CAN FAKE (mantahostels#1253): the seven
 * above all read the message the session wrote. This one reads an artefact the
 * session cannot type — a certificate in `.test-pass-markers.jsonl`,
 * written only by a `npm run test -- --full=<cause>` that went green — or by a bare
 * `npm run test` whose narrowing escalated to the whole suite (mantahostels#3208). In a
 * background job, a
 * `result:` from a session that COMMITTED is blocked where no set of such
 * certificates attests its own last commit, or a later commit up to HEAD that
 * contains it (#814, ADR-0009). It blocks at most once, the cap being the honest escape on
 * a machine still under docs/environment.md §6's rung AFTER the suite's own
 * reap (scripts/pretest-reap.js, mantahostels#1840) — and on a `main` gone red in files this
 * session never touched, where no run of its own can ever mint a certificate. The
 * refusal names both, and says neither makes the job blocked (mantahostels#1842).
 * THE FIRST ESCAPE HAS A RESIDUAL (mantahostels#1843): a shortfall held by
 * LIVE neighbours is reaped by nothing, so there — and only there — a pre-run
 * headroom read predicts what the suite will get.
 *
 * ITS THRESHOLD IS ATTESTATION ALONE. A certificate taken over a dirty tree, or naming
 * foreign files, counts toward it (mantahostels#1253). THREE RESIDUALS ARE STRUCTURAL: a certificate
 * attests a run over the WORKING TREE, with HEAD as it stood when the run finished
 * stamped on it, not the sha exactly; a `result:` written before the commit is
 * not attested, since the commit it would be judged on does not exist yet; and a
 * session that pushes without committing in-session is invisible to it. The
 * commit judged is the newest its commit ledger names that HEAD contains, over
 * the paths its own commits carry, so a neighbour's unattested commit refuses
 * nothing here and is left to the push gate (#1502, `lib/session-verdict.js`).
 *
 * A NINTH REFUSAL, ON THE PRICES THEMSELVES (mantahostels#1344): a message recommending the
 * option it priced LOWER than another in the same question, saying nothing
 * about why. One price per option is the written rule, and it assumes every
 * option in a question is priced on one axis. IT NEVER FORBIDS THE DIVERGENCE —
 * an asymmetric cost the price does not capture is a real reason — it demands
 * only a `Why not (X):` line naming the option passed over. Unlike the first
 * five it reads the WHOLE message, not a `❓ **Qn**` block, and finds the
 * recommendation by the word rather than by the `➡` arrow.
 *
 * A TENTH REFUSAL: a bold or titled option name, which invites the founder to
 * reply with the title where the format turns on him replying with a letter.
 * It reads the TITLE SLOT alone — bold later in the option is prose, an
 * identifier glossed the way CLAUDE.md requires. THE RESIDUAL THAT OPENS: a title one word in — the shape
 * `(A) The **No expiry** option` — is a titled name and passes. Deliberate.
 *
 * AN ELEVENTH REFUSAL, ON THE MARKER ITSELF (mantahostels#2013): the fourth, sixth and
 * seventh all ask whether a status marker is present, placed last and untrailed.
 * None asked whether it SAYS anything, and a bare `needs input:` passed all
 * three while filing the job Completed — the classifier being a model reading
 * prose, an empty marker is a dangling fragment to it and the strongest signal
 * left in the tail is whatever sat above, a recommendation reading as a
 * delivered conclusion. Only the marker LATEST in the message is judged, an
 * earlier one being a likely quotation. Its residual is the fourth's inference,
 * inherited whole: the classifier is not observable from this repo, so what
 * counts as saying something is a guess at where it acts.
 *
 * A TWELFTH REFUSAL, ON THE ONE MARKER THAT ASSERTS A FACT (mantahostels#2487): `waiting:`
 * says something is running that will wake this session. mantahostels#2485 closes the same
 * hole at the entrance, by
 * denying a foreground suite launch; this closes it at the exit, and reaches
 * three stalls that one cannot — a job backgrounded with `&` or `nohup`, one
 * launched from inside a script, and a `waiting:` written with nothing launched
 * at all. The evidence is the session's own transcript: every
 * `run_in_background` Bash call, every Bash call its `timeout` moved to the
 * background (#1012), every `Agent` call and every `Skill` call that forked
 * into the background (#1166) is a launch the transcript records,
 * settled later by a `<task-notification>` naming its id, so a launch with no
 * settlement is still out (`lib/pending-tasks.js`). IT REFUSES ONLY ON A
 * POSITIVE READING — a transcript it parsed, holding no unsettled launch. Every
 * other outcome allows the stop, so an unrecognised launch or settlement
 * spelling costs a missed refusal and never a dead turn.
 *
 * A FOURTEENTH REFUSAL, ON WHAT THE FIGURES MEAN (#38): a round whose
 * `Relation:` line declares its options rivals while their headline figures sum
 * outside 100 ± 5. Rivals' figures are one probability split.
 * Lexical on the relation line: a partly-conflicting set naming a combinable
 * pair is not read, and a rival set described without the words `RIVALS`
 * matches is never summed. Shape tier.
 *
 * A FIFTEENTH REFUSAL, THE PLACEMENT mantahostels#1210 CHECKS FOR `result:` (#228):
 * a `needs input:` that is not BELOW the round it announces, last — above it,
 * a model reading the tail takes the round's closing recommendations as the
 * conclusion.
 *
 * A SIXTEENTH REFUSAL, ON A CHOICE THE SESSION COULD HAVE SEPARATED ITSELF
 * (#488, ruled at #472, specified at #486): a round whose `Relation:` declares
 * rivals and whose top two, by headline figure, sit close, on its first send,
 * whatever `Checked:` or `Unmeasured:` line it carries (#1061). THIS HEADER
 * OWNS THE CLOSENESS RULE (#472's captured fact; repo machinery, so no §B entry): a pair is close when the top
 * option's band low is at or below the runner-up's band high, or when their
 * figures sit `CLOSE_GAP` (25) points apart or fewer whatever the bands say —
 * the second test is what stops narrowed bands passing a close pair.
 * Options declared unknowable or subjective drop out, and fewer than two
 * priced rivals is never close. A THIRD TEST, NO LIKELY OPTION (ruled at #2228,
 * re-ruled at #2519, specified at #2260): a round of any shape — rivals, yes/no or combinable, whatever its
 * `Relation:` says — whose highest headline figure is `LOW_TOP` (65) or less
 * is refused the same way, on the same counter; an unknowable or subjective
 * option carries no figure, so a block with none priced is unread, and a
 * question both tests catch gets one line naming both
 * (`lib/close-rivals.js`'s `caughtBy`). Its re-send meets the research ladder
 * while either test still catches it (#2328). REFUSED ONCE, WHATEVER ITS LINE (#1061,
 * reversing #671's first-sight pass on an escape line): the refusal record
 * holding its round number, the same question passes on its next send, line or none, changed or
 * not — save one still caught, which the research ladder holds (below; #2006). The refusal names the pair, or the top option, and asks for the deciding fact, not
 * which line clears it. A founder message after the refusal — its turn
 * interrupted, so the record outlived it — retires the record (#660), and the
 * number is refused afresh. Where the shape limb is silent that turn, it
 * names a refused question's shape faults, and refuses its re-send on them
 * until they are fixed, as the under-researched limb does (#1742). Its own
 * counter, outside the session ceiling and
 * the shape reserve (#1067). RESIDUALS: a plain
 * question with no round marker is unread, as for every shape limb; a rival
 * set described without the words `RIVALS` matches is unread; NEITHER
 * escape's content is judged here — `audit-escape-lines.js` judges the ones
 * that passed, by model and in batch, after the fact (#671), so a second send
 * with a hollow line passes; a record that will not READ passes every close
 * question as already refused, logged; a passed question is refused again
 * and logged twice where the transcript cannot say at its re-send, and logged
 * twice where the record will not read at its re-send or write at its pass;
 * new text under a passed number is neither judged nor logged, as for the
 * under-researched limb; and the per-limb cap is the escape for a session
 * that cannot satisfy it.
 *
 * RE-PRICING IS NOT A CHECK (#489, ruled at #472 limb A). Each refusal of that
 * limb replaces a per-session record in the markers directory
 * (`.close-rivals-record-`, swept with the counters): every question it
 * refused, by round number, with each priced option's letter, figure and band,
 * the citations its option lines carry (#2010) and the time it was refused.
 * At a later Stop, a question of the same number whose figures or bands
 * differ from the record's, with no tool call in the transcript since that
 * time, is refused again — still caught or not, escape
 * line or not — on the same counter. A question re-priced that way keeps its
 * recorded figures, so re-sending the new ones is still a re-price. A recorded
 * question stays recorded through every refused turn, re-sent or not — the
 * refusal asks for the corrected question alone — since it is already
 * refused (#1061). A
 * Stop let through marks each question passed: it reached the founder, so
 * once anything starts a new turn a round reusing its number is a new
 * question. Until then the record holds it, since another Stop hook may
 * refuse the turn, so the re-send is neither refused nor logged again
 * (#1844) — nor is one the under-researched-round limb passed, re-priced
 * into this limb's tests (#1949). An unreadable record, or a transcript that cannot count the tool
 * calls since a refusal, passes, logged; a record that cannot be WRITTEN outlives its question until the
 * founder next speaks.
 *
 * EVERY CLOSE-CHECK DECISION IS LOGGED (#1101), to the durable store
 * `lib/close-check-log.js` describes, at the Stop that decides it: a refusal when
 * its block is sent, a pass only when the turn is let through, so a question
 * re-sent through several blocked turns is one line. A failed write is
 * logged and changes no decision.
 *
 * A STILL-CAUGHT RE-SEND CLIMBS THE RESEARCH LADDER (#2006): a question that limb refused,
 * re-sent with its top two still close or its top option still priced 65 or
 * less (`caughtBy`, #2328), is refused while any rung shows no
 * qualifying tool call since that first refusal — past rulings (a `gh`
 * search of closed issues on a corpus tracker), the web (WebSearch or
 * WebFetch), a fresh subagent (Agent). `lib/research-ladder.js` owns the
 * call shapes and the refusal. Its own counter, outside the ceiling
 * (#1067), cap 3; a re-send the spent cap lets through is logged as
 * `passed-after-refusal` with the rungs it lacked. It writes no record: its
 * question keeps the close-rivals limb's, and the time of its first refusal.
 * RESIDUALS: content is never judged, so one empty search per rung passes;
 * and a transcript that cannot say passes, logged.
 *
 * AN UNDER-RESEARCHED ROUND IS SENT BACK (#1710, ruled at #1684): a question
 * the close-rivals limb did not judge, in a message sent after fewer than 10
 * tool calls on the main chain since the founder's last message
 * (`lib/tool-calls-since.js`'s count), printing `rule:house-decision`. No
 * line clears it: a refused question passes on any later send with a tool
 * call since its refusal, and a re-send with none is refused again. Where the
 * shape limb is silent that turn — the ceiling, its reserve or its own cap
 * spent — this limb names a refused question's shape faults, and refuses its
 * re-send on them until they are fixed (#1730). A question both limbs catch
 * is the close-rivals limb's alone, save one this limb passed in a turn
 * another Stop hook refused, which the close-rivals limb leaves alone however
 * the re-send is priced (#1949). One this limb refused and the close-rivals
 * limb then takes still logs its pass here, so the refusal is paired in the
 * reading (#2076); and where neither the close-rivals limb's refusal nor the
 * research-ladder limb's goes out on it — a cap spent, or either limb's rule
 * passing it — this limb's own rule holds it, so a bare re-send
 * re-priced into the close-rivals limb's tests, close or low-top, cannot
 * clear it (#2244). Its own record (`.round-check-record-`, retired when the
 * founder speaks after it, and holding a passed question while another Stop
 * hook refuses its turn, so the re-send is neither refused nor logged again,
 * #1799); its own log, which `lib/round-check.js` describes. RESIDUALS: a
 * founder `!` command or slash command restarts the count, where #1684's
 * extractor skipped both;
 * a record that will not read passes, logged, and so does a transcript, save
 * a re-send still misshapen; a passed question is logged twice where the
 * transcript cannot say at its re-send or the record will not write at its
 * pass; a record that will not read at the re-send leaves a pass re-priced
 * into the close-rivals limb's tests, close or low-top, to that limb, which
 * refuses it save at its cap; and a re-send after another hook's block is
 * matched by round number, so new text under a passed number is neither
 * judged nor logged.
 *
 * A SEVENTEENTH REFUSAL, ON A FOUNDER ACT HANDED OVER WITHOUT ITS TEXT (#597,
 * spec #525): a round option naming something the founder must paste, type,
 * run, click, open, apply or edit — a `!` code span, one of those verbs
 * addressed to him, `paste` or `yourself` alone, or a surface named as his —
 * that gives him a placeholder (an angle-bracketed token or an ellipsis inside
 * a code span) or a back-reference ("the command above", "the line I gave
 * earlier", or, per #1981, a ticket comment's id or "the block in my comment
 * on #N" or "the patch in #N") where the literal text belongs. The refusal
 * prints `rule:founder-handover`, which owns the four-part
 * hand-over; this header owns the cues. A back-reference beside a literal `!`
 * line passes, the text being there. Precision measured on #597.
 * RESIDUALS: a text named as from an issue, not a comment ("the
 * line from #699"), is refused where the option only describes it; a
 * `yourself` inside a quoted example cues the act; a round discussing
 * placeholder syntax inside a `!` span is refused, the cue and the placeholder
 * being one token; an act cued only by a verb the list lacks ("you merge
 * it") is unread; where-to-paste, what-to-see, what-to-send-back, the
 * three-line placement and end-of-message position are rule-only. Shape tier,
 * its own counter.
 *
 * ITS SECOND CUE, A SECRET ASK (#1031): a round option having the founder
 * paste, enter, type, supply, provide, give, hand, send or share an API
 * key, token, credential, password or secret, naming no `write-secret.js` in a
 * code span of its own or of an option it names. A route line after `!` is no
 * route: no hidden prompt shows there (#2554). Same counter, same printing of
 * the rule, once. The cue is `lib/secret-ask.js`'s.
 *
 * AND IN PROSE (#1817): the same cue over the whole message outside its round options,
 * fenced blocks, `>` quotes and inline code, passing where any code span in
 * the message carries the route and no line of it, code or prose, feeds the
 * route by a pipe or redirect, exports a credential variable or moves `.env`
 * (#2645). Measured before #2645, so a floor: over 53,409 ending messages
 * (`node scripts/measure-secret-ask.js --until 2026-10-15`): 22 flags — 5
 * real asks, the incident's opening among them; 3 into a vendor's or the
 * system's own prompt; 14 false, about 1.3 a week
 * machine-wide. Each flag's verdict is on #1817. Read only at a #926
 * hand-over's reach, it caught 1 of the 5, with 4 false. RESIDUALS: a
 * runnable `write-secret.js` route anywhere in the message clears its whole
 * prose, where an option clears only on its own route or one it names; a
 * credential pasted into a vendor's own prompt or dashboard (`gh auth login`,
 * a sudo password), never touching the chat, is refused too; so is a warning
 * not to paste one ("don't paste the key here") where nothing is asked — the
 * same words that catch an improvised hand-over, the incident's among them —
 * and a
 * noun sense the exclusions miss ("send the rescored keys", "the key check");
 * an ask by a verb the list lacks ("drop the key in `.env`") is unread.
 *
 * AN EIGHTEENTH, ON A "YOU OR ME?" ROUND NAMING NO BLOCK (#598, #478 go 3): a
 * round with one option led by the founder ("You", "Founder", or the name the
 * host's config declares, whole or first) and another led by the agent ("I",
 * "I'll", "Me", "Let me", "The agent", "This session"), and no `Blocked:` line
 * with text after the colon. An agent option that drops the act ("I revert",
 * "I leave it") is not a rival actor, and a round whose `Relation:` line calls
 * its options combinable is unread. The founder-act refusal still reads such a
 * round's options. Precision measured on #598. RESIDUALS: the `Blocked:`
 * line's presence is all that is checked (mantahostels#1505), so a named
 * preference passes; the two options' remaining text is never compared, so a
 * "You X" against "I Y" pair of unrelated acts is refused; a lead the lists
 * lack ("We", "Either of us") is unread. Shape tier, its own counter.
 *
 * A REFUSAL RETRACTS NOTHING ALREADY FILED: a Stop block buys the session
 * another turn; it does not unfile the job.
 *
 * THE APPARATUS THE EVIDENCE-READING LIMBS DEPEND ON FAILS SILENT AND IS
 * REPORTED ELSEWHERE: an unreadable write
 * ledger, a git that will not answer, and a missing or unparseable marker store
 * all allow the stop and write a line to the arbiter's fail-open log, which
 * `npm run check:guard-errors` prints under `npm run status`. ONE LIMB
 * REFUSES INSTEAD, EXCEPTING IT FROM THE NEXT PARAGRAPH: the standing-round
 * pointer (#924) keeps the round owed, logged (`pointsAtStandingRound`).
 *
 * EVERY FAILURE PATH IS SILENT AND EXITS 0 — breaking a session is worse than
 * missing one.
 *
 * BAR ONE: A LIB THAT WILL NOT LOAD BLOCKS THE STOP, ONCE A TURN (#2645): a
 * top-level `require` that throws leaves every limb above unrun, and the
 * registration's `|| true` would swallow the crash. So
 * `lib/load-failure-stop.js` blocks with the error, and lets the re-stop
 * through on the payload's `stop_hook_active`. A payload it cannot read
 * allows. RESIDUALS: a turn another Stop hook already blocked carries
 * `stop_hook_active` too, so passes; a syntax error in this file, or that lib
 * itself missing, throws before the handler exists, and fails open.
 *
 * THE BLOCK BUDGETS ARE SPLIT PER DEFECT, NOT SHARED (mantahostels#2544). On one
 * shared counter, three cosmetic corrections to a round's shape — or three
 * `waiting:`-on-nothing refusals in a session's first few minutes — would
 * silence the guard for the rest of the session, and the turn that decides how
 * the job is FILED is the last one, by construction in that silent tail.
 *
 * SO EVERY CHECK THAT DECIDES THE FILING carries its own counter —
 * `completedWhileWaiting`, `needsInputUndercut`, `needsInputMisplaced`,
 * `resultMisplaced`, `unmarkedStop`, `missingNeedsInput`, `emptyStatusMarker`
 * and `waitingUnverified`. `MAX_BLOCKS` stays 3: mantahostels#844's loop-trap
 * bound is real, and the fix is separating budgets, not enlarging one.
 *
 * WHY NOT A RESERVED FINAL BLOCK, which mantahostels#2544 offered as the alternative
 * mechanism: no Stop knows it is the last one — every turn's end looks
 * identical to the hook — so a block held back "for the final turn" can only be
 * held back for ever or spent on the first turn that asks, which is what a
 * per-defect counter already does. AND NOT mantahostels#2544's OTHER OFFER, a raised `max`
 * on the missing-marker counter alone: with the budgets split, that counter is
 * now spent only by repeats of the one defect it refuses, and a session
 * repeating it after three corrections is the loop mantahostels#844's bound exists for.
 *
 * ONE BLOCK PER FAULT WOULD BUY THE FOUNDER A ROUND TRIP EACH, and split
 * budgets bound no total across limbs (mantahostels#2786). So `judge` reports
 * EVERY defect the turn earned in ONE block, charging every counter that contributed;
 * and `SESSION_PREFIX` caps the whole guard at `SESSION_MAX`
 * (lib/priced-options-limbs.js) blocks a session,
 * whatever mix of limbs spends them. The green-suite evidence limb stays
 * outside both — it is an evidence question, not a shape one, and its `max: 1`
 * is already the escape. The close-rivals and under-researched limbs are
 * batched but sit outside the ceiling (#1067): each one's cap of 3 already
 * bounds the loop.
 *
 * THE CEILING BOUNDS WHAT THE PARAGRAPHS ABOVE PROMISE: the per-limb
 * figure is still 3, but every limb but the three outside it goes dark
 * together once the ceiling is spent, so a session paying 5 blocks on round
 * shape reaches its filing turn with no filing limb able to refuse.
 *
 * SO THE CEILING IS RESERVED BY STAKE TIER (mantahostels#3420, built at mantahostels#3430): the shape
 * tier stops one block short of it, leaving the last block to the checks that
 * file the job. Not the held-back final block rejected above — no turn is
 * waited for; a shape-only turn at `SESSION_MAX - 1` is simply let through.
 *
 * Reading the outgoing message out of the transcript lives in
 * `lib/hook-message.js`, shared with guard-selection-sum.js (mantahostels#844); the
 * prologue and epilogue around `judge()` — payload read, breadcrumb, fail-open,
 * drain — live in `lib/stop-guard.js`, shared with all three siblings (mantahostels#1798).
 *
 * IMPLICIT:  reads the session's ending message at every Stop and blocks the turn where a question to the founder is not in the lettered priced form, naming the fault to the founder and sending the correction on the model-only limb; where its top two rivals sit close or its top option is priced 65 or less, once per question whatever `Checked:` or `Unmeasured:` line it carries (#1061), and, re-sent still caught by either, until each research-ladder rung shows a tool call (#2006), past the session ceiling (#1067); where it is sent under 10 tool calls after the founder's last message (#1710), past the ceiling too; where an option hands the founder an act by placeholder or back-reference rather than its literal text, or has him supply a credential by any route but `write-secret.js`, in an option (#1031) or in prose (#1817); where one option has the founder perform an act and another has the agent, and no `Blocked:` line says what stops the agent; where its recommendation names an option the same message priced below another, unexplained; and, in a background job, where a `result:` names a commit no green suite run attests and a push still owes one (#2933), where a status marker carries nothing after its colon, where a `waiting:` rests on nothing the transcript shows still running, or where a `needs input:` puts its decision as prose rather than as a lettered priced round, a lone founder hand-over (#926) or a `Qn` pointer to a round still unanswered (#924) excepted; and, once a turn, where a lib of its own will not load (#2645).
 * JUSTIFIED: fail-safe — the rule was written down and kept losing (mantahostels#802), and the turn ending is the last moment the defect can still be fixed.
 * DEFEAT:    the format block clears by rewriting the question, never by a switch — the close-rivals block (#488) by sending the corrected question a second time (#1061) and, where the shape limb is silent, a fixed shape (#1742), or by its own cap of 3, its research-ladder block (#2006) by a qualifying tool call on each rung, a re-send no test still catches or its own cap of 3, and its re-price refusal (#489) by a tool call or the refused figures, the under-researched block (#1710) by any tool call before the re-send and, where the shape limb is silent, a fixed shape (#1730), or its own cap of 3, the founder-act block (#597) by the literal text, a secret ask's `write-secret.js` line (#1031), or its own cap of 3, the actor-only block (#598) by acting instead, a `Blocked:` line or its own cap of 3 — or, past `SESSION_MAX` blocks in one session, by the ceiling going quiet on every shape and filing limb at once, the close-rivals, research-ladder and under-researched limbs excepted (mantahostels#2786, #1067), shape limbs one block sooner (mantahostels#3430). The evidence block (mantahostels#1253) clears by stopping a second time — `max: 1` — which is the deliberate escape for the two cases a session cannot fix: a machine still under the one-suite rung AFTER the suite's own reap of finished sessions (scripts/pretest-reap.js; mantahostels#1843 — a pre-run headroom read is not that case), and a `main` red in files it never touched (mantahostels#1842). The load-failure block (#2645) clears by stopping again.
 */

/* Armed before every other `require` (#2645, `lib/load-failure-stop.js`). */
const disarmLoadFailure =
	require.main === module
		? require("./lib/load-failure-stop").armLoadFailureStop(
				"the lettered priced round, the founder hand-over, a credential " +
					"asked by any route but `write-secret.js`, the status marker",
			)
		: () => {
				/* required, not run: nothing armed */
			};

const hookMessage = require("./lib/hook-message");
const hookBlock = require("./lib/hook-block");
const {
	groupByPrefix,
	isLive,
	liveGroups,
	ceilingPlan,
	blockOn,
	limbCounter,
} = require("./lib/priced-options-ceiling");
const stopGuard = require("./lib/stop-guard");
const { parseStatus } = require("./lib/status-marker");
const { INVENTORY } = require("./lib/inventory-format");
/** @typedef {import("./lib/status-marker").StatusReading} StatusReading */
const { requiredGroup } = require("./lib/regex-group");
const {
	OPTION_LABEL_PREFIX,
	OPTION_LABEL,
	PRICED,
	CONFIDENCE_ANY,
	RELATION_LINE,
	COMBINABLE,
	splitQuestions,
	optionSpans,
	parseOptionBody,
	parseRelationLine,
	isRivalSet,
} = require("./lib/round-marker");
const {
	CODE_SPAN,
	CLAUSE_REACH,
	hasSecretRoute,
	hasBangSecretRoute,
	ROUTE_SHAPE,
	withoutConfidence,
	askPhrase,
	proseAsk,
} = require("./lib/secret-ask");
const {
	readOutputStylePath,
	resolveKey,
} = require("./lib/workflow-core-config");
const { failOpenLogger } = require("./lib/fail-open-logger");

const {
	SESSION_PREFIX,
	SHAPE_PREFIX,
	NEEDS_INPUT_ROUND_PREFIX,
	FOUNDER_ACT_PREFIX,
	ACTOR_ONLY_PREFIX,
	COMPLETED_WHILE_WAITING_PREFIX,
	NEEDS_INPUT_UNDERCUT_PREFIX,
	NEEDS_INPUT_MISPLACED_PREFIX,
	RESULT_MISPLACED_PREFIX,
	UNMARKED_STOP_PREFIX,
	MISSING_NEEDS_INPUT_PREFIX,
	EMPTY_MARKER_PREFIX,
	WAITING_UNVERIFIED_PREFIX,
	GREEN_SUITE_PREFIX,
	CLOSE_RIVALS_PREFIX,
	ROUND_CHECK_PREFIX,
	RESEARCH_LADDER_PREFIX,
} = require("./lib/priced-options-limbs");
const { closeRivalsTurn } = require("./lib/close-rivals");
const { readRoundRecord, roundCheckTurn } = require("./lib/round-check");
const { passedNumbers } = require("./lib/refusal-limb");

/* The title slot only: bold that opens the option, right after its letter.
 * Bold LATER in the option is prose. */
const OPTION_TITLE_BOLD = /^\s{0,3}\([A-Z]\)\s+\*\*/;
/* Long enough to carry the letter, the bold run and the word after it, which is
 * what tells the session which phrase was read as a title. */
const OPENER_CHARS = 40;

/* The escape the rule allows: a figure declared ungroundable is not priced.
 * `formatReason` names these words to the session, so the refusal and the
 * pattern share one list (#1008). */
const UNPRICEABLE_WORDS = [
	"unknowable",
	"ungroundable",
	"unquantifiable",
	"not quantifiable",
	"subjective",
];
const UNPRICEABLE = new RegExp(`\\b(${UNPRICEABLE_WORDS.join("|")})\\b`, "i");

/*
 * How much of the tail the job-status classifier is given — measured at mantahostels#85.
 */
const CLASSIFIER_TAIL_CHARS = 4000;

/*
 * First-person promises to carry on working, in the span the marker governs.
 * Deliberately narrow — a verb of work, not any first-person future — because
 * "I can't proceed" and "I'd expect" are not offers to continue.
 */
const FORWARD_WORK =
	/\bI(?:'ll|'d| will| can| could)\s+(?:then\s+|also\s+)?(build|write|draft|set|apply|implement|create|add|make|run|do|open|file|commit|push|start|wire|land|finish|carry)\b/i;

/**
 * The refusal a decorated-only marker earns, naming the decoration. Callers
 * reach it only once the turn carries no bare marker they would accept.
 * @param {StatusReading} status the message's status reading
 * @param {string[]} [names] the markers the caller would accept bare
 * @returns {string} the block reason, or '' where no decorated marker is found
 */
function decoratedMarker(
	status,
	names = ["result:", "waiting:", "needs input:"],
) {
	const { decorated } = status;
	if (!decorated || !names.includes(decorated.name)) return "";
	const { name, lead } = decorated;
	return (
		"This turn ends a background job on a decorated status marker — `" +
		name +
		"` led by `" +
		lead +
		"` — and no bare one. The job-status classifier files a decorated " +
		"marker less reliably than a bare one, so the job may be filed as if it " +
		"carried none. Rewrite the same marker bare, with no backtick, bold, " +
		"italic or quote around it, as the last line:\n\n" +
		name +
		" <what the marker is for>"
	);
}

/* Approval-seeking constructions. Each entry's gist is what the block names
 * back, so it must read as the phrase found.
 * `ready to` is first-person only — "the branch is ready to merge" is a claim
 * about the work, not an offer awaiting a founder. */
const APPROVAL_SEEKING = [
	{ gist: "say the word", re: /\bsay the word\b/i },
	{ gist: "shall i", re: /\bshall I\b/i },
	{ gist: "want me to", re: /\bwant me to\b/i },
	{ gist: "would you like me to", re: /\bwould you like me to\b/i },
	{ gist: "let me know if", re: /\blet me know if\b/i },
	{
		gist: "i'll \u2026 if you",
		re: /\bI(?:'ll|'d| will| can| could)\b[^.\n]{0,80}\bif you\b/i,
	},
	{
		gist: "pending approval",
		re: /\b(?:pending|awaiting|subject to)\s+(?:your\s+)?(?:approval|sign-?off|the go-ahead)\b/i,
	},
	{
		gist: "i'm ready to",
		re: /\b(?:I(?:'m| am)|we(?:'re| are))\s+ready to\b/i,
	},
	{ gist: "if you'd like", re: /\bif you(?:'d| would)? like\b/i },
];

/* Hand-priced figures round; a split of 33/33/33 is still one split. */
const SUM_SLACK = 5;

/* Shapes the rule bans outright inside a question block. */
const TABLE_ROW = /^\s{0,3}\|.*\|/;
const HORIZONTAL_RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const NUMBERED_ITEM = /^\s{0,3}\d+[.)]\s+\S/;
/* The recommendation line. The founder replies with a letter, so the
 * recommendation names one. */
const RECOMMENDATION = /^\s{0,3}\u27a1/u;
const NAMES_A_LETTER = /\([A-Z]\)/;
const BULLET_ITEM = /^\s{0,3}[-*+]\s+\S/;

/**
 * @typedef {{ letter: string, confidence: number | null }} Option
 * @typedef {{ letter: string, confidence: number }} PricedOption
 */

/** @type {(o: Option) => o is PricedOption} */
const isPriced = (o) => o.confidence !== null;

/**
 * A block with fewer than two lettered options.
 * @param {string[]} lines
 * @returns {string[]}
 */
function unletteredDefects(lines) {
	const body = lines.join("\n");
	/* Are there options here at all, just in the wrong shape? Counting the
	 * wrong shapes separates "you listed choices as a bullet list" from "you
	 * asked an open question and offered nothing", which need different
	 * fixes. */
	const numbered = lines.filter((l) => NUMBERED_ITEM.test(l)).length;
	const bulleted = lines.filter((l) => BULLET_ITEM.test(l)).length;
	if (numbered >= 2 || bulleted >= 2) {
		return [
			"its options are listed as a " +
				(numbered >= 2 ? "numbered" : "bulleted") +
				" list instead of lettered (A)/(B)/(C) options, so none of them is priced",
		];
	}
	if (!UNPRICEABLE.test(body)) {
		return [
			"it offers no lettered options at all. A question put to the founder " +
				"enumerates its answers as priced options — a yes/no is (A) yes and " +
				"(B) no, both priced. Obviousness is not an exemption and there is no " +
				"stakes threshold",
		];
	}
	return [];
}

/**
 * The letters of options with no Confidence line, and of those whose line
 * carries no band.
 * @param {{ letter: string, span: string }[]} labelled
 */
function unpricedLetters(labelled) {
	const unpriced = [];
	const unbanded = [];
	for (const { letter, span } of labelled) {
		if (PRICED.test(span)) continue;
		if (CONFIDENCE_ANY.test(span)) unbanded.push(letter);
		else if (!UNPRICEABLE.test(span)) unpriced.push(letter);
	}
	return { unpriced, unbanded };
}

/**
 * @param {{ letter: string, span: string }[]} labelled
 * @returns {string[]}
 */
function pricingDefects(labelled) {
	/** @type {string[]} */
	const defects = [];
	const { unpriced, unbanded } = unpricedLetters(labelled);
	if (unpriced.length > 0) {
		defects.push(
			"option" +
				(unpriced.length > 1 ? "s " : " ") +
				unpriced.map((l) => `(${l})`).join(", ") +
				" carr" +
				(unpriced.length > 1 ? "y" : "ies") +
				" no Confidence line",
		);
	}
	if (unbanded.length > 0) {
		defects.push(
			"option" +
				(unbanded.length > 1 ? "s " : " ") +
				unbanded.map((l) => `(${l})`).join(", ") +
				" give" +
				(unbanded.length > 1 ? "" : "s") +
				" a bare percentage with no error band in brackets",
		);
	}
	return defects;
}

/**
 * @param {{ letter: string, line: string }[]} labelled
 * @returns {string[]}
 */
function boldTitleDefects(labelled) {
	/* A bold TITLE is banned; bold inside the option's prose is not a title and
	 * is left alone. The header's tenth refusal carries the residual. */
	const bolded = labelled.filter((o) => OPTION_TITLE_BOLD.test(o.line));
	if (bolded.length === 0) return [];
	return [
		"option" +
			(bolded.length > 1 ? "s " : " ") +
			bolded.map((o) => `(${o.letter})`).join(", ") +
			" give" +
			(bolded.length > 1 ? "" : "s") +
			" the option a bold or titled name, which this guard bans — " +
			bolded
				.map(
					(o) =>
						`(${o.letter}) opens \`${o.line.slice(0, OPENER_CHARS).trim()}…\``,
				)
				.join("; ") +
			". Only bold in the title slot is read; bold later is prose",
	];
}

/**
 * The defects only meaningful once there are letters to name: the
 * recommendation, the relation line, and rivals' figures.
 * @param {string[]} lines
 * @param {{ span: string }[]} labelled
 * @returns {string[]}
 */
function letteredDefects(lines, labelled) {
	/** @type {string[]} */
	const defects = [];
	const rec = lines.filter((l) => RECOMMENDATION.test(l));
	if (rec.length > 0 && !rec.some((l) => NAMES_A_LETTER.test(l))) {
		defects.push(
			"its recommendation does not name an option by its letter, which is what " +
				"the founder replies with",
		);
	}

	const declared = lines.some((l) => RELATION_LINE.test(l));
	if (!declared) {
		defects.push(
			"it states no relation between its options. Lettered options read as " +
				"rivals for one slot, so a set that could be taken together is " +
				"answered by picking one of them. Add a line of its own, opening " +
				"`Relation:`, saying which pairs actually conflict and on what \u2014 " +
				"or that the options are independent",
		);
	}

	const sum = rivalFigureSum(lines, labelled);
	if (sum !== null && Math.abs(sum - 100) > SUM_SLACK) {
		defects.push(
			`its \`Relation:\` line declares the options rivals, but their figures sum to ${sum}%. ` +
				"Rivals' figures are the probability each option is the right choice, so " +
				"they sum to 100% — re-derive them as one split, or, where two options " +
				"can in fact be taken together, say so on the `Relation:` line",
		);
	}
	return defects;
}

/**
 * Rivals' figures are one probability split (#38). Read only where every
 * option carries a figure and the relation line declares rivals without
 * also naming a combinable pair, so a partly-conflicting set passes.
 * @param {string[]} lines
 * @param {{ span: string }[]} labelled
 * @returns {number | null} the figures' sum, or null where it is not read
 */
function rivalFigureSum(lines, labelled) {
	const figures = labelled.map((o) => {
		const m = o.span.match(CONFIDENCE_FIGURE);
		return m ? Number(m[1]) : null;
	});
	if (!isRivalSet(lines) || !figures.every((f) => f !== null)) return null;
	return figures.reduce((a, f) => a + Number(f), 0);
}

/**
 * Layouts the format bans: a table, a horizontal rule.
 * @param {string[]} lines
 * @returns {string[]}
 */
function layoutDefects(lines) {
	/** @type {string[]} */
	const defects = [];
	if (lines.some((l) => TABLE_ROW.test(l))) {
		defects.push("it lays the options out as a table, which the format bans");
	}
	if (lines.some((l) => HORIZONTAL_RULE.test(l))) {
		defects.push(
			"it separates the options with a horizontal rule, which the format bans",
		);
	}
	return defects;
}

/**
 * Judge one question block.
 * @param {{number: string, lines: string[]}} block
 * @returns {string[]} one plain-language defect per entry; empty means it passes
 */
function defectsIn(block) {
	const lines = block.lines;
	const labelled = optionSpans(lines);
	const lettered = labelled.length >= 2;
	return [
		...(lettered ? pricingDefects(labelled) : unletteredDefects(lines)),
		...boldTitleDefects(labelled),
		...(lettered ? letteredDefects(lines, labelled) : []),
		...layoutDefects(lines),
	];
}

/* A pasteable `!` command's opening, which every pattern reading one is built
 * from (#936); `![` opens a Markdown image, not a command. */
const BANG = /!\s*[^\s`[]/.source;
/* The same, first in a fenced block. */
const FENCED_BANG = String.raw`\x60{3}[^\n]*\n\s*${BANG}`;

/* The founder-act limb's cues (#597). An option names a founder act where it
 * hands him a `!` line, addresses a paste/type/run/click/open verb to him, or
 * names a surface as his. A bare imperative ("(A) Run the suite") is not a cue:
 * lettered options are written as imperatives the agent performs. */
const FOUNDER_ACT_CUES = [
	new RegExp(String.raw`\x60${BANG}[^\x60]*\x60|${FENCED_BANG}`),
	/\byou(?:'d| would| will|'ll| can| could)?\s+(?:then\s+|just\s+)?(?:paste|type|run|click|open|apply|edit)\b/i,
	/\bpaste\b/i,
	/\byourself\b/i,
	/\b(?:in|from)\s+a\s+(?:normal|separate|regular|plain)\s+terminal\b/i,
	/\bopen\s+(?:this|that|the)\s+(?:URL|link)\b/i,
	/\b(?:in|from|into)\s+your\s+(?:own\s+)?(?:terminal|shell|browser|session|dashboard)\b/i,
	/\bother repo(?:sitory)?'s session\b/i,
];
/* A placeholder inside a code span: an angle-bracketed token, or an ellipsis
 * standing alone — `main...HEAD` is git's range syntax, not a gap. */
const PLACEHOLDER = /<[A-Za-z][^<>\n]*>|(?<!\S)\.\.\.|…/;
/* A pasteable `!` line, inline or first in a fenced block. */
const BANG_LINE = new RegExp(String.raw`^\x60${BANG}|^${FENCED_BANG}`);
const HANDED_NOUNS = [
	"command",
	"line",
	"prompt",
	"step",
	"text",
	"snippet",
	"one-liner",
];
const nounGroup = (/** @type {string[]} */ nouns) => `(?:${nouns.join("|")})s?`;
/* From noun to back-reference word, `CLAUSE_REACH` apart. */
const HANDED_TEXT = nounGroup(HANDED_NOUNS);
/* Nouns read only beside a ticket (#1981): "the patch above" stays unread. */
const POINTED_NOUNS = ["block", "code", "patch", "diff", "script"];
const TICKET_HELD_TEXT = nounGroup([...HANDED_NOUNS, ...POINTED_NOUNS]);
const ISSUE_HELD_TEXT = nounGroup(
	[...HANDED_NOUNS, ...POINTED_NOUNS].filter((noun) => noun !== "prompt"),
);
const BACK_REFERENCE = new RegExp(
	[
		String.raw`\b${HANDED_TEXT}\b[^.\n\x60]{0,${CLAUSE_REACH}}?\b(?:above|earlier|previous(?:ly)?|as before|I (?:gave|posted|sent))\b`,
		String.raw`\b(?:above|earlier|previous|prior)\s+(?:\w+\s+)?${HANDED_TEXT}\b`,
		/* A ticket standing for the text (#1981): a comment's bare id — in a
		 * URL it follows a `#`, a link the founder opens being literal — or the
		 * text named as sitting in a comment, or in an issue or its URL. A
		 * prompt in an issue passes (`rule:founder-deliverable`). */
		String.raw`(?<![#\w-])issuecomment-\d+`,
		String.raw`\b${TICKET_HELD_TEXT}\s+(?:in|at|from|on)\s+(?:(?:my|the|that|this|your)\s+)?(?:\S+\s+)?comment\b`,
		String.raw`\b(?:in|from|at)\s+my\s+(?:\w+\s+)?comment\s+on\b`,
		String.raw`\b(?:${ISSUE_HELD_TEXT}|I (?:gave|posted|sent|wrote))\s+(?:in|at|from|on)\s+\x60?(?:(?:issue\s+)?#\d+|https?://\S*/(?:issues|pull)/\d+)`,
	].join("|"),
	"i",
);

/** Any `(X)` option letter, mid-prose included. */
const LETTER_REF = /\(([A-Z])\)/g;

/**
 * The phrase in which an option has the founder supply a credential without
 * routing it through `write-secret.js`, or undefined. An option naming a
 * sibling that carries the route ("paste the (A) line with that key") routes
 * through it. Its Confidence line is not read: "about 10k tokens" there is the
 * estimate, not an ask. `bang` says whether the option, or a sibling it names,
 * gives the route after `!` instead (#2554).
 * @param {string} body an option's `parseOptionBody`
 * @param {Map<string, string>} siblings every option body in the round, by letter
 * @returns {{ phrase: string, bang: boolean } | undefined}
 */
function secretAsk(body, siblings) {
	const text = withoutConfidence(body);
	const read = [
		text,
		...[...text.matchAll(LETTER_REF)]
			.slice(1)
			.map((m) => siblings.get(requiredGroup(m, 1, LETTER_REF)) ?? ""),
	];
	if (read.some(hasSecretRoute)) return;
	const phrase = askPhrase(text);
	if (!phrase) return;
	return { phrase, bang: read.some(hasBangSecretRoute) };
}

/**
 * A flagged phrase as a refusal quotes it: 80 characters, chosen, being the
 * phrase and a little context.
 * @param {string} phrase
 */
const quoted = (phrase) => `“${phrase.replace(/\s+/g, " ").slice(0, 80)}”`;

/**
 * @param {string} number
 * @param {string} letter
 * @param {string} phrase
 * @param {string} [kind] what the phrase is, where the refusal names several
 */
const buildFlaggedLine = (number, letter, phrase, kind) =>
	`Q${number} (${letter}): ${kind ? `${kind} ` : ""}${quoted(phrase)}`;

/**
 * @param {string} number
 * @param {string} letter
 * @param {{ phrase: string, bang: boolean }} secret
 */
const secretFlag = (number, letter, secret) =>
	buildFlaggedLine(number, letter, secret.phrase) +
	(secret.bang ? " — its `write-secret.js` line follows `!`" : "");

/**
 * The flagged line for an option handing the founder an act with a
 * placeholder or a back-reference where the literal text belongs, or
 * undefined.
 * @param {string} number
 * @param {string} letter
 * @param {string} span the option's `parseOptionBody`
 * @returns {string | undefined}
 */
function handedTextFlag(number, letter, span) {
	if (!FOUNDER_ACT_CUES.some((cue) => cue.test(span))) return;
	const codes = span.match(CODE_SPAN) ?? [];
	const placeholder = codes.find((code) => PLACEHOLDER.test(code));
	/* A back-reference beside the literal line is not "in place of" it. */
	const literal = codes.some((code) => BANG_LINE.test(code));
	const phrase =
		placeholder ?? (literal ? undefined : span.match(BACK_REFERENCE)?.[0]);
	if (!phrase) return;
	return buildFlaggedLine(
		number,
		letter,
		phrase,
		placeholder ? "placeholder" : "back-reference",
	);
}

/**
 * @param {string[]} flagged
 * @param {string[]} secrets
 * @param {string | undefined} prose the message's own secret ask outside any option
 * @param {boolean} bang whether a refused ask hands over `write-secret.js` after `!`
 * @returns {string}
 */
function buildFounderActReason(flagged, secrets, prose, bang) {
	/** @type {string[]} */
	const leads = [];
	if (flagged.length > 0)
		leads.push(
			"This turn puts a founder act in a question option without the literal " +
				"text he would paste, type, run, click or open:\n\n" +
				flagged.join("\n"),
		);
	if (secrets.length > 0)
		leads.push(
			"This turn has the founder supply a credential in a question option by " +
				"a route other than `write-secret.js`, so its value can land in the " +
				"chat, a command line or this session's log — follow the SECRET " +
				"paragraph below:\n\n" +
				secrets.join("\n"),
		);
	if (prose)
		leads.push(
			"This turn's prose has the founder supply a credential, and no code " +
				"span in it is the `write-secret.js` route alone — `" +
				ROUTE_SHAPE +
				"`, " +
				"nothing beside it, and no line anywhere piping into it, exporting " +
				"a credential or copying `.env` — so its value can " +
				"land in the chat, a command line or this session's log — follow " +
				"the SECRET paragraph below:\n\n" +
				`${quoted(prose)}\n\n` +
				"Where that sentence asks for no credential, reword it so it does " +
				"not read as one.",
		);
	if (bang)
		leads.push(
			"A `write-secret.js` line after `!` runs on a stdin that is no " +
				"terminal, so no hidden prompt can show (#2554): a secret's line " +
				"goes in a normal terminal, never after `!`.",
		);
	return (
		leads.join("\n\n") +
		"\n\n" +
		readHandoverRule() +
		(prose
			? "\n\nRE-SEND THE CORRECTED MESSAGE."
			: "\n\nRE-SEND ONLY THE CORRECTED QUESTION, not the whole round.")
	);
}

/**
 * THE FOUNDER-ACT REFUSAL (#597): a round option that hands the founder
 * something to do, carrying a placeholder or a back-reference where the
 * literal text belongs — or has him supply a credential by any route but
 * `write-secret.js` (#1031), in an option or in the prose (#1817).
 * @param {string} message the outgoing assistant message
 * @returns {string} the block reason, or '' if nothing is owed
 */
function founderActRefusal(message) {
	/** @type {string[]} */
	const flagged = [];
	/** @type {string[]} */
	const secrets = [];
	let bang = false;
	for (const block of splitQuestions(message)) {
		const options = optionSpans(block.lines);
		const bodies = new Map(
			options.map((o) => [o.letter, parseOptionBody(o.span)]),
		);
		for (const option of options) {
			const span = parseOptionBody(option.span);
			const secret = secretAsk(span, bodies);
			if (secret) {
				secrets.push(secretFlag(block.number, option.letter, secret));
				bang ||= secret.bang;
			}
			const handed = handedTextFlag(block.number, option.letter, span);
			if (handed) flagged.push(handed);
		}
	}
	const prose = proseAsk(message);
	if (flagged.length === 0 && secrets.length === 0 && !prose) return "";
	if (prose) bang ||= hasBangSecretRoute(message);
	return buildFounderActReason(flagged, secrets, prose, bang);
}

/**
 * `rule:house-decision` (#1683), which the close-rivals and
 * under-researched-round refusals print. Read here rather than in their libs:
 * check-guard-registry.test.ts copies every lib into a fixture holding no such
 * fragment.
 * @returns {string}
 */
function readHouseDecisionRule() {
	try {
		return require("./lib/rule-text").readRuleText("house-decision");
	} catch (e) {
		/* A missing fragment costs the rule's text, never the refusal (#1705). */
		failOpenLogger("guard-priced-options house-decision")?.(
			`rule-text house-decision unreadable: ${e} — short fallback printed`,
		);
		return (
			"Only a house decision reaches the founder: ask only what research " +
			"leaves open, and name that gap. " +
			require("./lib/rule-text").rulePointer("house-decision")
		);
	}
}

/**
 * `rule:founder-handover`, which both founder refusals print. Its permission
 * line resolves through the script-path helper, so it runs in an install as
 * well as here, and its secret line's paths are spelt absolute (#643).
 * @returns {string}
 */
function readHandoverRule() {
	try {
		return require("./lib/rule-text").readRuleText("founder-handover");
	} catch (e) {
		/* A missing fragment costs the long form, never the refusal (#597). */
		failOpenLogger("guard-priced-options founder-hand-over")?.(
			`rule-text founder-handover unreadable: ${e} — short fallback printed`,
		);
		return (
			"Give the founder the exact literal text of each step, where to paste " +
			"it and what he should see. Where nothing stops you, act and report " +
			"rather than asking who does it; where something does, name it on a " +
			"line of its own: `Blocked: <the refusal you hit, quoted, or the act " +
			"only a person can do>`."
		);
	}
}

/* The actor-only limb's leads (#598, #478 go 3), read at the head of an
 * option's text. The founder's are extended at run time by the name the
 * config declares. */
const FOUNDER_LEADS = ["You", "Founder"];
const AGENT_LEAD =
	/^(?:I(?:'ll|'d|'m)?|Me|Let me|The agent|This session)(?![\w'])/;
/* An agent option that drops the act rather than performs it: "I revert it"
 * against "You commit it" is a choice of outcome, not of actor (#598). */
const AGENT_ABANDONS =
	/^(?:I(?:'ll|'d)?|Let me)\s+(?:revert|discard|undo|drop|leave|stop|skip|defer|abandon|file)\b/;
/* Read like the `Relation:` line, bold on the label optional; the tail must
 * be non-empty, so a bare `**Blocked:**` does not count. */
const BLOCKED_LINE =
	/^\s{0,3}(?:\*\*)?Blocked(?:\*\*)?:(?:\*\*)?\s*(?!\*\*\s*$)\S/i;

/** @param {string} s */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The trackers a past-rulings search must reach, for the research-ladder
 * limb (#2006); null where the config will not read, which lets any tracker
 * count.
 * @returns {string[] | null}
 */
function corpusTrackers() {
	try {
		const corpus = resolveKey("corpus");
		return Array.isArray(corpus) ? corpus : null;
	} catch (e) {
		/* An unreadable config costs the corpus check, never the limb (#2006). */
		failOpenLogger("guard-priced-options research-ladder")?.(
			`corpus unreadable: ${e} — any tracker counts`,
		);
		return null;
	}
}

/**
 * The founder-actor lead: "You", "Founder", or the founder the host's config
 * declares, whole or by first name.
 * @returns {RegExp}
 */
function buildFounderLead() {
	const names = [...FOUNDER_LEADS];
	try {
		const declared = resolveKey("founder");
		if (typeof declared === "string" && declared.trim()) {
			names.push(declared.trim());
			names.push(declared.trim().replace(/\s.*$/s, ""));
		}
	} catch (e) {
		/* An unreadable config costs the name, never the limb (#598). */
		failOpenLogger("guard-priced-options actor-only")?.(
			`founder name unreadable: ${e} — You/Founder only`,
		);
	}
	return new RegExp(`^(?:${names.map(escapeRegExp).join("|")})(?![\\w])`);
}

/**
 * THE ACTOR-ONLY REFUSAL (#598): a round offering one option the founder
 * performs and another the agent performs, with no `Blocked:` line saying
 * what stops the agent acting.
 * @param {string} message the outgoing assistant message
 * @param {{ruleShown?: boolean}} [opts] where the founder-act refusal already
 *   prints the hand-over, it is not printed twice in the one block.
 * @returns {string} the block reason, or '' if nothing is owed
 */
function actorOnlyRound(message, { ruleShown = false } = {}) {
	/** @type {string[]} */
	const flagged = [];
	const founder = buildFounderLead();
	for (const block of splitQuestions(message)) {
		if (block.lines.some((l) => BLOCKED_LINE.test(l))) continue;
		/* Options declared combinable are not rivals for who acts. */
		if (COMBINABLE.test(parseRelationLine(block.lines))) continue;
		const leads = optionSpans(block.lines).map((option) => ({
			letter: option.letter,
			/* The text after the label, leading emphasis stripped. */
			head: option.line
				.replace(OPTION_LABEL_PREFIX, "")
				.replace(/^[*_]+/, "")
				/* A typographic apostrophe reads as the straight one. */
				.replace(/\u2019/g, "'"),
		}));
		if (leads.length < 2) continue;
		const theirs = leads.find((o) => founder.test(o.head));
		const ours = leads.find(
			(o) => AGENT_LEAD.test(o.head) && !AGENT_ABANDONS.test(o.head),
		);
		if (!theirs || !ours) continue;
		/* 60 characters, chosen: the lead and what it offers. */
		const quote = (/** @type {{letter: string, head: string}} */ o) =>
			`(${o.letter}) “${o.head.replace(/\s+/g, " ").slice(0, 60)}”`;
		flagged.push(`Q${block.number}: ${quote(theirs)} against ${quote(ours)}`);
	}
	if (flagged.length === 0) return "";
	return (
		"This turn asks the founder who performs an act — one option has him do " +
		"it, another has you do it — and says nothing about what stops you:\n\n" +
		flagged.join("\n") +
		"\n\nWhere nothing stops you, do not ask: act, then report what you " +
		"did. Where something does, keep the question and add the `Blocked:` " +
		"line the founder hand-over in this block states." +
		(ruleShown ? "" : `\n\n${readHandoverRule()}`) +
		"\n\nRE-SEND ONLY THE CORRECTED QUESTION, not the whole round."
	);
}

/* THE BLOCK DOES NOT PRINT THE ROUND TEMPLATE (mantahostels#1807): a Stop block's
 * `reason` renders in the founder's own transcript, so a refusal carrying a
 * round marker, lettered options and priced lines would read to him as a question
 * addressed to him. IT IS NOT THE WHOLE SHAPE: the `Relation:` line is written
 * out only in `scripts/inject-tracker-docs.sh`, which runs on the named skill
 * paths alone, so each defect states its own fix rather than relying on the
 * pointer to carry it. The file is the host's declared output style, else
 * core-voice.md (#448), read only when a block is written. */
const shapePointer = () => `\`${readOutputStylePath()}\``;

/* The #924 pointer, as both `needs input:` refusals teach it (#1018). A
 * refused turn's rounds never stand (`standingRounds`), so it names an
 * earlier turn. */
const STANDING_ROUND_POINTER =
	"where a round you posted in an earlier turn still stands — the founder " +
	"has not replied since, and no Stop hook sent that turn back — point at it " +
	"by number instead of re-printing it: " +
	`\`needs input: Q1 above — <the decision> ${INVENTORY.refsTail}\` (#924).`;

/**
 * @param {StatusReading} status the message's status reading
 * @param {number} count how many question blocks it carries
 * @returns {string} the block reason, or '' if the marker is not owed
 */
function missingNeedsInput(status, count) {
	if (status.last["needs input:"]) return "";
	const decorated = decoratedMarker(status, ["needs input:"]);
	if (decorated) return decorated;

	return (
		"This turn ends on " +
		count +
		" question(s) to the founder, so nothing but a human will wake this " +
		"session. The job-status classifier reads this message text alone, so a " +
		"round that ends by recommending an answer is filed Completed and the " +
		"founder is never told you are waiting. Two shapes pass.\n\n" +
		"First, re-send every round in one message with the marker below them, " +
		"as that message's last line:\n\n" +
		"<every round, in full>\n\n" +
		INVENTORY.needsInputLine +
		"\n\n" +
		"A marker sent alone, with the rounds left in this refused turn, has no " +
		"round above it and is refused again.\n\n" +
		`Second, ${STANDING_ROUND_POINTER}\n\n` +
		"A grilling round is human-in-the-loop, so you may not answer it yourself " +
		"and the marker is always owed."
	);
}

/* What marks an offer as reaching past the delivered task: a ticket number, one
 * of the seven commands that OPEN a ticket (`docs/agents/triage-labels.md`
 * §`takes:`, plus `/pick-next` and `/card-close`, which act on one), or the next
 * unit of work in as many words. `/research` and `/grilling` are deliberately
 * absent — neither opens a ticket.
 *
 * Each limb is anchored at a left boundary, so a PATH is not a command: without
 * it `\b` closes on the following slash and `docs/research/…`, `.claude/skills/
 * pick-next/…` and `docs/agents/triage-labels.md` all read as commands, putting
 * the commonest sentence shape in this repo on the wrong branch.
 *
 * KNOWN COLLISION: an all-digit CSS hex — `mantahostels#333` — reads as a ticket number.
 * Left as is; a styling report that also offers further work pays a reworded
 * sentence for it. */
const FURTHER_WORK_OFFER =
	/(?:^|[\s(["'])#\d{1,5}\b|(?:^|[\s(["'])\/(?:implement|wayfinder|to-spec|to-tickets|triage|pick-next|card-close)\b|\bnext (?:ticket|issue|card|task|command)\b/i;

/* Sentence-ish spans: a run ending at `.`/`!`/`?` or a line break. An offer and
 * the ticket it names have to sit in the SAME span, or a `result:` line citing
 * the closed ticket would arm this against an unrelated offer below it.
 *
 * That precision is bought with recall: an offer whose ticket sits in the NEXT
 * sentence, or on the next line, is missed and falls to the refusal below. */
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * The gists of the approval-seeking phrases this message uses, where EVERY one
 * of them is about work beyond what the session delivered (mantahostels#2445).
 *
 * Empty where the message carries no offer, and empty where it carries one the
 * founder may really be blocked on: a bare ask sharing its message with a
 * next-ticket offer keeps the refusal below, whose advice is right for it. The
 * gists come from the matching spans alone, so the blocking ask is never quoted
 * back as evidence of further work.
 *
 * @param {string} message the outgoing assistant message
 * @returns {string[]} the gists, or [] where the further-work branch is wrong
 */
function furtherWorkGists(message) {
	const gists = new Set();
	for (const span of message.split(SENTENCE_SPLIT)) {
		const offers = APPROVAL_SEEKING.filter((p) => p.re.test(span));
		if (offers.length === 0) continue;
		if (!FURTHER_WORK_OFFER.test(span)) return [];
		for (const offer of offers) gists.add(offer.gist);
	}
	return [...gists];
}

/**
 * The mislabel one step wider than a question round (mantahostels#822): a background job
 * that writes `result:` while still offering to do the thing it recommended.
 *
 * Two escapes have always been open — switch to `needs input:`, or drop the
 * offer. Where the offer is about work beyond the delivered task, `furtherWorkGists`
 * leads with the deletion instead. Its own refusal text carries a further-work
 * token in the sentence naming the gists, so a session pasting the block back
 * re-enters on the branch that emitted it rather than on the other one.
 *
 * @param {string} message the outgoing assistant message
 * @param {StatusReading} status its status reading
 * @returns {string} the block reason, or '' if nothing is owed
 */
function completedWhileWaiting(message, status) {
	if (!status.last["result:"]) return "";

	const found = APPROVAL_SEEKING.filter((p) => p.re.test(message)).map(
		(p) => p.gist,
	);
	if (found.length === 0) return "";

	const furtherWork = furtherWorkGists(message);
	if (furtherWork.length > 0) {
		return (
			"This turn writes `result:` and offers to take on the next ticket — " +
			furtherWork.map((g) => `"${g}"`).join(", ") +
			". The delivered task is done, so the founder is not blocked: what to " +
			"pick up next is `/pick-next`'s call, not a decision this session puts " +
			"to him. Do NOT switch to `needs input:` — that files a finished job as " +
			"blocked. Name the next task as a statement and delete the " +
			"approval-seeking phrase, keeping the `result:` line as the last line:\n\n" +
			"Next: <the ticket and its command>.\n\n" +
			INVENTORY.resultLine +
			"\n\n" +
			"Switch to `needs input:`, dropping the `result:` line, only if the " +
			"DELIVERED task is itself blocked on his decision."
		);
	}

	return (
		"This turn writes `result:` and still asks the founder for approval — " +
		found.map((g) => `"${g}"`).join(", ") +
		". The job-status classifier reads this message text alone, so `result:` " +
		"files the job Completed and a Completed job gets abandoned with its work " +
		"undone. Pick one:\n\n" +
		INVENTORY.needsInputLine +
		"\n\n" +
		"and drop the `result:` line — or, if the work really is done and the " +
		"offer is optional follow-up nobody need answer, say so without the " +
		"approval-seeking phrase."
	);
}

/**
 * The mislabel the marker alone did not prevent (mantahostels#85): the classifier is a model
 * reading the tail, not a regex over the marker, so a marker trailed by a promise
 * of further work still reads as a session running.
 *
 * THE CAUSE IS INFERRED. The classifier lives in the background-job harness and
 * nothing in this repo can see it. A session still filed Working with a clean
 * marker should suspect the classifier, not go looking for more of its own
 * wording to change.
 *
 * @param {StatusReading} status the message's status reading
 * @returns {string} the block reason, or '' if nothing is owed
 */
function needsInputUndercut(status) {
	const m = status.last["needs input:"];
	if (!m) return "";

	/* ANYTHING BELOW THE MARKER IS `needsInputMisplaced`'S, WHOLE (#228). Both
	 * faults this limb reads — a marker pushed out of the window, and one
	 * trailed by a promise of work — are, once the marker must be last, just
	 * the marker not being last. Leaving either armed here would charge two
	 * counters against `SESSION_MAX` for one defect, which is exactly what
	 * mantahostels#2544 split the budgets to prevent. What survives is the marker's OWN
	 * line: a promise on it, and a line long enough to overrun the window. */
	if (m.below.trim()) return "";

	const { fromEnd } = m;
	if (fromEnd > CLASSIFIER_TAIL_CHARS) {
		return (
			"This turn's `needs input:` line is " +
			fromEnd +
			" characters from the end, and the job-status classifier is given only " +
			"the last " +
			CLASSIFIER_TAIL_CHARS +
			", so it cannot see the marker at all. Keep the marker's own line " +
			`short, naming the decision and its \`${INVENTORY.refsTail}\` tail, nothing ` +
			"else, and put what it " +
			"summarises above it."
		);
	}

	const found = FORWARD_WORK.exec(m.line);
	if (!found) return "";

	return (
		'This turn writes `needs input:` and then promises to keep working — "' +
		found[0] +
		'". The job-status classifier reads this message text alone and takes the ' +
		"strongest signal in it, so a marker trailed by work you are about to do " +
		"reads as a session still running and the job stays Working while it " +
		"waits on the founder. State the promise above the marker, in the past or " +
		"conditional, and end on the marker asking only for the decision:\n\n" +
		INVENTORY.needsInputLine
	);
}

/**
 * `needs input:` must be the message's last line, with nothing below it — the
 * placement check mantahostels#1210 gave `result:` and this marker never had (#228).
 *
 * PRESENCE INSIDE THE CLASSIFIER'S WINDOW IS NECESSARY AND NOT SUFFICIENT, so
 * the distance limb in `needsInputUndercut` was never enough: the classifier is
 * a model reading the tail, and a marker it can SEE still loses to the round
 * below it, whose closing recommendation reads as a delivered conclusion.
 *
 * THREE RESIDUALS. The fourth refusal's, inherited whole: the classifier lives
 * in the background-job harness and cannot be read from here, so "last line" is
 * a best guess at where it acts. `resultMisplaced`'s stand-down, mirrored: a
 * `result:` or `waiting:` below the real marker switches this limb off, so a
 * message quoting one of those back evades it. And a fenced `needs input:`
 * template below the real marker is itself the governing match, so the refusal
 * measures from the fence and blames the wrong marker.
 *
 * @param {StatusReading} status the message's status reading
 * @returns {string} the block reason, or '' if nothing is owed
 */
function needsInputMisplaced(status) {
	const m = status.last["needs input:"];
	if (!m) return "";

	/* A `result:` or `waiting:` below it means this marker is not the governing
	 * one — an earlier quotation, or a block reason pasted back. The later
	 * marker's placement belongs to `resultMisplaced` (mantahostels#1210) and
	 * `waitingUnverified`, not here. */
	if (status.hasLaterMarker("needs input:")) return "";

	const below = m.below;
	if (!below.trim()) return "";

	return (
		"This turn writes `needs input:` and then keeps going — " +
		below.trim().length +
		" characters sit below it. The job-status classifier reads this message " +
		"text alone and takes the strongest signal in it, so a marker with the " +
		"round written underneath reads as a delivered conclusion and the job is " +
		"filed Completed while it waits on the founder. Put the round above and " +
		"end on the marker, as the last line:\n\n" +
		INVENTORY.needsInputLine
	);
}

/**
 * The sixth refusal takes the marker anywhere in the message; the classifier
 * does not, so a report written below the marker buries it and the finished job
 * is filed Working (mantahostels#1210).
 *
 * @param {StatusReading} status the message's status reading
 * @returns {string} the block reason, or '' if nothing is owed
 */
function resultMisplaced(status) {
	const m = status.last["result:"];
	if (!m) return "";

	/* A `needs input:` or `waiting:` below it means the `result:` above is a
	 * quoted example — a fenced template, or a block reason pasted back. The
	 * marker governing the message is the later one, whose placement belongs to
	 * `needsInputUndercut` (mantahostels#85) and `unmarkedStop` (mantahostels#1200), not here. */
	if (status.hasLaterMarker("result:")) return "";

	const below = m.below;
	if (below.trim()) {
		return (
			"This turn writes `result:` and then keeps going — " +
			below.trim().length +
			" characters of report sit below it. The job-status classifier reads " +
			"this message text alone and takes the strongest signal in it, so a " +
			"marker with the work written underneath reads as a session still " +
			"running and the job stays Working with nobody told it finished. Move " +
			"everything above the marker and end on it, as the last line:\n\n" +
			INVENTORY.resultLine
		);
	}

	const { fromEnd } = m;
	if (fromEnd > CLASSIFIER_TAIL_CHARS) {
		return (
			"This turn's `result:` line is " +
			fromEnd +
			" characters from the end, and the job-status classifier is given only " +
			"the last " +
			CLASSIFIER_TAIL_CHARS +
			", so it cannot see the marker at all. Keep the marker's own line short " +
			"and put what it summarises above it:\n\n" +
			INVENTORY.resultLine
		);
	}

	return "";
}

/**
 * The mislabel every other check here misses (mantahostels#1200): not a wrong label but no
 * label at all. Only reached where the turn puts no question to the founder —
 * a question round is `missingNeedsInput`'s, and firing both would name the same
 * omission twice.
 *
 * A turn whose only marker is decorated is told that instead (mantahostels#3426), on this
 * limb's counter — and under a question round, on `missingNeedsInput`'s.
 * @param {StatusReading} status the message's status reading
 * @returns {string} the block reason, or '' if nothing is owed
 */
function unmarkedStop(status) {
	if (status.governing) return "";

	const decorated = decoratedMarker(status);
	if (decorated) return decorated;

	return (
		"This turn ends a background job carrying neither status marker. The " +
		"job-status classifier reads this message text alone and files the job on " +
		"the marker it finds, so a turn with none leaves the job sitting where it " +
		"stopped — its work committed and nobody told it finished. End on " +
		"whichever of these three is true, as the last line:\n\n" +
		INVENTORY.resultLine +
		"\n" +
		INVENTORY.needsInputLine +
		"\n" +
		"waiting: <what will wake this session — a subagent or background job>"
	);
}

/* The fail-open log's second field, which check-guard-errors.js groups on. */
const FAIL_OPEN_WHERE = "guard-priced-options green-suite";

/**
 * The refusal that reads an artefact instead of the message (mantahostels#1253): a
 * background job writing `result:` on a commit no certificate attests.
 * Whether it is attested, and what it owes, are `lib/session-verdict.js`'s.
 *
 * @param {StatusReading} status the message's status reading
 * @param {string} sessionId whose commit ledger names the commit
 * @returns {string} the block reason, or '' if nothing is owed
 */
function resultWithoutGreenSuite(status, sessionId) {
	if (!status.last["result:"]) return "";

	/* Required here, not at the top: a Stop hook must cost a missed check when a
	 * library will not load, never a dead turn (mantahostels#1253). A store that
	 * will not load has nothing to log with, so that one fail-open is silent. */
	const log = failOpenLogger(FAIL_OPEN_WHERE);
	if (!log) return "";
	let verdict;
	try {
		verdict = require("./lib/session-verdict").sessionVerdict(sessionId, {
			log,
		});
	} catch (e) {
		log(`could not read the evidence: ${e}`);
		return "";
	}
	if (verdict.state === "unjudged") {
		log(`${verdict.why} — result: allowed unchecked`);
		return "";
	}
	if (verdict.state === "attested" || verdict.state === "skipped") return "";
	return greenSuiteRefusal(verdict);
}

/**
 * An owed verdict as this gate prints it. The two "not yours to fix"
 * exemptions are this gate's own policy (mantahostels#1842), set between the
 * verdict's reap clause, which qualifies the first, and its commands.
 *
 * ORDER IS LOAD-BEARING (mantahostels#2194, mantahostels#2206): the exemptions
 * sit ABOVE the commands, and `Otherwise` marks the branch back to them.
 * `-- --full=push-gate` appears ONCE, below the narrowed default, for the one
 * case the default cannot attest — `push-gate` (#182) because this fires
 * exactly where a session volunteered `result:` without the gate having asked
 * for a whole-suite run. Residual: the count case is lexical on
 * `npm run test -- --full=push-gate`, so an imperative respelled in prose
 * would pass it.
 *
 * @param {{own: string, text: import("./lib/session-verdict").OwedText}} verdict
 */
function greenSuiteRefusal({ own, text }) {
	return (
		"This turn writes `result:` on commit " +
		require("./lib/test-pass-marker").shortSha(own) +
		", and " +
		text.unattested +
		" Since mantahostels#910 " +
		"no CI run is keyed to a push either — so `result:` here asserts work is " +
		"delivered on the strength of nothing having been run. " +
		text.reap +
		"TWO REASONS THE SUITE CANNOT GO " +
		"GREEN ARE NOT YOURS TO FIX: the machine is STILL under " +
		"docs/environment.md §6's rung AFTER that reap — a shortfall held by LIVE " +
		"neighbours is reaped by nothing — or `main` is already red in " +
		"files this session never edited and did not break. Neither makes the job " +
		"blocked — a job nothing waits on is finished (mantahostels#1842). Where one of them " +
		"holds, say which, name the failing files and whose work they are, write " +
		"`result:` and stop again. Otherwise, run the narrowed default " +
		"first:\n\n" +
		text.run +
		"ONE PLACE IT CANNOT CLEAR: a red `main` you are about " +
		"to claim under the second escape above, whose failing files you cannot " +
		"name without seeing them. There, run the whole suite:\n\nnpm run test -- --full=push-gate\n\n" +
		"then end the turn again. This blocks once a session." +
		text.red
	);
}

/* A recommendation written in prose. The existing check reads the grilling
 * round's `➡` arrow; this reads the word instead (mantahostels#1344). */
const RECOMMENDS_IN_PROSE = /\brecommend(?:s|ation|ations|ing|ed)?\b/i;

/* An option reference inside a recommendation: `(A)`, `1(A)`, `**2(B)**`. The
 * leading digits are the question number where a message puts more than one
 * question, which is how a letter is attributed to its own group. */
const OPTION_REF = /(\d+)?\s*\*{0,2}\(([A-Z])\)/g;

const CONFIDENCE_FIGURE = /Confidence:\s*(\d{1,3})\s*%/;

/* The reconciling line this refusal demands. It must name a letter, so it
 * cannot be satisfied by a bare "on balance" sentence. */
const WHY_NOT_LINE = /\bwhy not\s*\*{0,2}\(([A-Z])\)/gi;

/**
 * Every option letter the message accounts for with a `Why not (X)` line. ALL
 * of them, not the first: a message answering two questions writes one such
 * line per question.
 * @param {string} message
 * @returns {Set<string>}
 */
function explainedLetters(message) {
	const out = new Set();
	WHY_NOT_LINE.lastIndex = 0;
	for (let m = WHY_NOT_LINE.exec(message); m; m = WHY_NOT_LINE.exec(message))
		out.add(requiredGroup(m, 1, WHY_NOT_LINE).toUpperCase());
	return out;
}

/**
 * Every question's run of lettered options, in order. A new run starts wherever
 * a letter does not advance on the one before it, which is what a second
 * question asking (A)/(B)/(C) again looks like — and equally what a
 * recommendation restating the option it names looks like.
 * @param {string} message
 * @returns {Option[][]}
 */
function optionGroups(message) {
	const lines = message.split("\n");
	/** @type {{ letter: string, at: number }[]} */
	const found = [];
	lines.forEach((line, i) => {
		const m = line.match(OPTION_LABEL);
		if (m) found.push({ letter: requiredGroup(m, 1, OPTION_LABEL), at: i });
	});

	/** @type {Option[][]} */
	const groups = [];
	/* Starts as an empty run rather than null so the push below needs no cast:
	 * the first option finds no `prev` and opens a fresh run either way. */
	/** @type {Option[]} */
	let current = [];
	found.forEach((opt, k) => {
		const prev = current.length > 0 ? current.at(-1) : null;
		if (!prev || opt.letter <= prev.letter) {
			current = [];
			groups.push(current);
		}
		const next = found[k + 1];
		const to = next ? next.at : lines.length;
		const span = lines.slice(opt.at, to).join("\n");
		const fig = span.match(CONFIDENCE_FIGURE);
		current.push({
			letter: opt.letter,
			confidence: fig ? Number(fig[1]) : null,
		});
	});
	/* An unpriced run is that restatement, and is dropped: left in, it made
	 * every letter in the message ambiguous and switched this refusal off. One
	 * priced option is enough to keep a run — a question may honestly leave a
	 * figure unstated, and dropping it would renumber the questions after it. */
	return groups.filter((g) => g.some((o) => o.confidence !== null));
}

/**
 * @typedef {{ qn: number | null, letters: Set<string>, group: Option[] }} PickedQuestion
 * @typedef {{ label: string, picked: PricedOption, top: PricedOption, others: number }} PriceFault
 */

/**
 * @param {string} message
 * @returns {string[]}
 */
function parseRecommendationLines(message) {
	/* `My recommendation:` above the option restated in full is one
	 * recommendation, so the line below is read with it — but only where the
	 * line above announces itself with a colon and the line below opens with an
	 * option label, which is what keeps a sentence merely containing the word
	 * from dragging in whatever follows it. */
	const lines = message.split("\n");
	/** @type {string[]} */
	const recLines = [];
	lines.forEach((line, i) => {
		if (!RECOMMENDS_IN_PROSE.test(line) && !RECOMMENDATION.test(line)) return;
		OPTION_REF.lastIndex = 0;
		if (OPTION_REF.test(line)) {
			recLines.push(line);
			return;
		}
		if (!line.trim().endsWith(":")) return;
		const next = lines.slice(i + 1).find((l) => l.trim());
		if (next && OPTION_LABEL.test(next)) recLines.push(next);
	});
	return recLines;
}

/**
 * @param {number | null} qn the digits in front of the letter
 * @param {Option[][]} groups
 * @returns {number | null}
 */
function questionIndex(qn, groups) {
	/* With one question a bare letter is unambiguous; with more than one
	 * only an explicit number attributes it. */
	if (qn) return qn - 1;
	if (groups.length === 1) return 0;
	return null;
}

/**
 * The letters the recommendation lines name, by question.
 * @param {string[]} recLines
 * @param {Option[][]} groups
 * @returns {Map<number, PickedQuestion>}
 */
function pickedLetters(recLines, groups) {
	/* Letters are aggregated per question, not judged one at a time: a
	 * recommendation may legitimately name several options together (mantahostels#1037 lets
	 * independent options combine), and taking the top-priced one among them
	 * passes nothing over. */
	/** @type {Map<number, PickedQuestion>} */
	const picked = new Map();
	for (const line of recLines) {
		OPTION_REF.lastIndex = 0;
		for (let m = OPTION_REF.exec(line); m; m = OPTION_REF.exec(line)) {
			const qn = m[1] ? Number(m[1]) : null;
			const index = questionIndex(qn, groups);
			const group = index === null ? undefined : groups[index];
			if (index === null || group === undefined) continue;
			const seen = picked.get(index) ?? { qn, letters: new Set(), group };
			picked.set(index, seen);
			seen.letters.add(requiredGroup(m, 2, OPTION_REF));
		}
	}
	return picked;
}

/**
 * The question's recommendation passing over a higher-priced option with
 * nothing saying why, or null.
 * @param {PickedQuestion} question
 * @param {Set<string>} explained
 * @returns {PriceFault | null}
 */
function priceFault({ qn, letters, group }, explained) {
	const priced = group.filter(isPriced);
	if (priced.length < 2) return null;

	const chosen = priced.filter((o) => letters.has(o.letter));
	if (chosen.length === 0) return null;
	const best = chosen.reduce((a, b) => (b.confidence > a.confidence ? b : a));

	/* EVERY option priced above the one recommended has to be accounted for,
	 * not merely the highest (mantahostels#1344). */
	const unexplained = priced.filter(
		(o) => o.confidence > best.confidence && !explained.has(o.letter),
	);
	if (unexplained.length === 0) return null;

	const top = unexplained.reduce((a, b) =>
		b.confidence > a.confidence ? b : a,
	);
	return {
		label: `${qn ? `Q${qn} ` : ""}(${best.letter})`,
		picked: best,
		top,
		others: unexplained.length - 1,
	};
}

/**
 * The ninth refusal's block reason for its first fault.
 * @param {PriceFault} f
 * @returns {string}
 */
function buildBelowPriceReason(f) {
	return (
		"This turn recommends " +
		f.label +
		", priced " +
		f.picked.confidence +
		"%, over (" +
		f.top.letter +
		"), which the same message priced " +
		f.top.confidence +
		"%" +
		(f.others ? ` (and ${f.others} other(s) priced above it)` : "") +
		" — and says nothing about why the lower figure wins. The founder can " +
		"only read one price per option as answering one question, so a " +
		"recommendation that goes the other way reads as a contradiction (mantahostels#1344).\n\n" +
		"Before rewriting, check the likelier fault: that the two figures price " +
		"DIFFERENT propositions. Pricing (" +
		f.top.letter +
		") on *is this right* while recommending " +
		f.label +
		" on *should we act now* is exactly the defect this exists to catch. If " +
		"that is what happened, re-price every option in that question on one " +
		"stated axis and let the recommendation follow.\n\n" +
		"Otherwise, keep the recommendation and add a line naming what you passed " +
		"over:\n\n" +
		"**Why not (" +
		f.top.letter +
		"):** <the cost or risk the price does not capture>\n\n" +
		"Then end the turn again."
	);
}

/**
 * A NINTH REFUSAL (mantahostels#1344): a recommendation naming the option its own message
 * priced lower than another in the same question, with nothing saying why.
 *
 * RESIDUALS, all lexical like the eight above, and all of them UNDER-fire.
 * A letter is attributed to its question by the digits in front of it, so a
 * message with two questions that writes a bare "(C)" is skipped rather than
 * guessed at. A restatement is told from a question by carrying no price at
 * all, so one that repeats its Confidence line reads as a phantom question,
 * switching that arm off and renumbering every later letter.
 * The `Why not (A):` line is read for the letter and never for truth, so an
 * empty reason passes, and it is matched message-wide rather than per question,
 * so one question's line accounts for another's. `RECOMMENDS_IN_PROSE` matches
 * the word anywhere on the line, so a negated sentence, or this block reason
 * pasted back, reads as a recommendation. And two options priced equally are
 * not a divergence, so a recommendation can still rest on a figure that was
 * never the reason.
 * @param {string} message
 * @returns {string} the block reason, or ''
 */
function recommendationBelowPrice(message) {
	const groups = optionGroups(message);
	if (groups.length === 0) return "";

	const recLines = parseRecommendationLines(message);
	if (recLines.length === 0) return "";

	const picked = pickedLetters(recLines, groups);
	const explained = explainedLetters(message);
	/** @type {PriceFault[]} */
	const faults = [];
	for (const question of picked.values()) {
		const fault = priceFault(question, explained);
		if (fault) faults.push(fault);
	}
	const [f] = faults;
	if (!f) return "";

	return buildBelowPriceReason(f);
}

/** The line each owed marker is taught as, tail included (#2374).
 * @type {Partial<Record<import("./lib/status-marker").MarkerName, string>>} */
const TAUGHT_LINE = {
	"needs input:": INVENTORY.needsInputLine,
	"result:": INVENTORY.resultLine,
};

/**
 * The mislabel that defeated the marker itself (mantahostels#2013): every other check here
 * asks whether a marker is present, in the right place and untrailed, and none
 * asks whether it says anything. The classifier is a model reading prose, not a
 * regex, so a bare `needs input:` is not a status line to it — it is a dangling
 * fragment, and the strongest signal left in the tail is whatever sat above it.
 * A round ending in a recommendation therefore files Completed with the marker
 * present and every existing check passing.
 *
 * THE CAUSE IS INFERRED, on the same terms as `needsInputUndercut`: the
 * classifier is not observable from this repo.
 *
 * @param {StatusReading} status the message's status reading
 * @returns {string} the block reason, or '' if nothing is owed
 */
function emptyStatusMarker(status) {
	if (!status.governing) return "";
	const { name, payload } = status.governing;

	if (!payload.trim()) {
		return (
			"This turn ends on a bare `" +
			name +
			"` carrying nothing after the colon. The job-status classifier is a " +
			"model reading the message text, not a regex over the marker, so an " +
			"empty marker is a dangling fragment to it and the strongest signal " +
			"left is whatever sits above — a recommendation reads as a delivered " +
			"conclusion and the job files Completed while it waits on the " +
			"founder. Say what the marker is for, on the marker's own line:\n\n" +
			(TAUGHT_LINE[name] ?? `${name} <what will wake this session>`)
		);
	}
	return "";
}

/* A pasteable `!` line, bare, inline-coded or inside a fence. */
const HANDOVER_BANG = new RegExp(String.raw`^\s{0,3}\x60?${BANG}`);
const FENCE = /^\s{0,3}```/;
/* What `rule:founder-handover`'s third step asks for — what to send back, or
 * what the session then checks (#926). Lexical, so a send-back phrased
 * otherwise is refused and the session rewords it. The 30- and 40-character
 * reaches are chosen, not measured, on `BACK_REFERENCE`'s terms. */
const SEND_BACK = new RegExp(
	[
		String.raw`\b(?:send|paste)\b[^.\n]{0,30}\bback\b`,
		String.raw`\b(?:reply|tell me|let me know)\b`,
		String.raw`\bonce (?:it|that|the \w+) (?:prints|shows|lands|returns|finishes)\b`,
		String.raw`\b(?:I['’]ll|I will|I then|then I)\b[^.\n]{0,40}?\b(?:check|verify|confirm|read|re-?run|finish|commit|close)\b`,
	].join("|"),
	"i",
);

/**
 * Whether a message ends in a founder hand-over: at least one literal act — a
 * `!` line, or a fenced block of literal text — with a send-back line after
 * the last of them. Lines inside a fence are never read as the send-back.
 *
 * TWO RESIDUALS. Any fenced block counts as an act, so quoted output followed
 * by "let me know" passes. And nothing bounds the prose between the last act
 * and the send-back, so a decision put in unlettered prose there passes too —
 * `needsInputWithoutRound` voids the exemption on a letter, never on prose.
 *
 * @param {string} message the outgoing assistant message
 * @returns {boolean}
 */
function isFounderHandover(message) {
	let inFence = false;
	let lastAct = -1;
	let lastSendBack = -1;
	const lines = String(message).split("\n");
	for (const [at, line] of lines.entries()) {
		if (FENCE.test(line)) {
			if (inFence) lastAct = at;
			inFence = !inFence;
		} else if (inFence) continue;
		else if (HANDOVER_BANG.test(line)) lastAct = at;
		else if (SEND_BACK.test(line)) lastSendBack = at;
	}
	return lastAct >= 0 && lastSendBack > lastAct;
}

/**
 * A THIRTEENTH REFUSAL, ON THE SCOPE THE OTHER TWELVE INHERIT (mantahostels#2583): a
 * background job ending on `needs input:` with no round at all. The founder
 * reversed for background jobs the half of mantahostels#1503 that scoped the lettered
 * priced form TO the round.
 *
 * A FOREGROUND REPLY KEEPS THE PLAIN FORM: he is in the terminal and can ask
 * again.
 *
 * FOUR RESIDUALS. The marker is matched anywhere in the message, so a fenced
 * example arms this. A session evading it by dropping the marker too ends
 * carrying nothing — `unmarkedStop`'s to refuse, and only while that limb's own
 * budget is unspent. `splitQuestions` reads no fences, so the `❓ **Q1**` line
 * in this limb's OWN block text, pasted back or quoted in an example, satisfies
 * it with the decision still in prose. And sitting outside `reviewParts()` costs a
 * message tripping both this and mantahostels#85 two sequential refusals rather than one
 * joined reason, accepted for the separate counter.
 *
 * ONE EXEMPTION (#926): a message whose only pending item is one founder act,
 * handed over in `isFounderHandover`'s shape, passes. Any `(A)`-style letter
 * voids it, on its own line, in a bullet or mid-prose, so a real decision
 * written beside a `!` line is still refused.
 *
 * AND ONE POINTER (#924): a marker naming `Q<n>`, where every round it names
 * still stands in the transcript (`pointsAtStandingRound`), passes.
 *
 * @param {string} message the outgoing assistant message
 * @param {StatusReading} status its status reading
 * @param {string} [transcript] the session's transcript path
 * @returns {string} the block reason, or '' if nothing is owed
 */
function needsInputWithoutRound(message, status, transcript) {
	if (splitQuestions(message).length > 0) return "";

	const marker = status.governing;
	if (marker?.name !== "needs input:") return "";

	if (!NAMES_A_LETTER.test(message) && isFounderHandover(message)) return "";
	if (pointsAtStandingRound(marker.payload, transcript)) return "";

	return (
		"This turn ends a background job on `needs input:` with no `\u2753 **Qn**` " +
		"round above it. The founder opens the job at exactly this text, and a " +
		"decision put as prose is one he cannot answer with a letter. Put it as a " +
		"round instead:\n\n" +
		"\u2753 **Q1** \u2014 <the decision, in one line>\n\n" +
		"Relation: <how the options relate \u2014 rivals for one slot, or combinable>\n\n" +
		"(A) <option>\n" +
		"Confidence: 70% (60% - 80%). <what drives it, one clause>\n\n" +
		"(B) <option>\n" +
		"Confidence: 30% (20% - 40%). <what drives it, one clause>\n\n" +
		"Then one recommendation, then the `needs input:` line last, naming the " +
		"decision and the issue the round is posted on, nothing else:\n\n" +
		INVENTORY.needsInputLine +
		"\n\nA yes/no is lettered too \u2014 (A) do it, (B) do " +
		"not \u2014 the round has no exemption for an obvious choice.\n\n" +
		"Two exceptions. First, a single founder act is not a decision: hand it over " +
		"instead \u2014 its literal `!` line or fenced text, then what to send back \u2014 with no " +
		"round and no lettered options (#926).\n\n" +
		`Second, ${STANDING_ROUND_POINTER}\n\n` +
		"If you are not blocked on a decision at all, the marker is the wrong one: " +
		"`result:` where nothing waits on the founder, `waiting:` where something " +
		"you launched will wake this session."
	);
}

/* The fail-open log's second field for the standing-round reader (#924),
 * which fails closed. */
const FAIL_LOG_STANDING = "guard-priced-options standing-round";
/* A round named by number on the marker's own line: `Q1 above`. */
const NAMED_ROUND = /\bQ(\d+)\b/g;

/**
 * Whether a `needs input:` payload points at rounds still standing (#924):
 * it names at least one `Q<n>`, and every one it names was opened in the
 * assistant's text since the founder last spoke, in a turn no Stop hook sent
 * back (`lib/tool-calls-since.js`).
 *
 * IT FAILS CLOSED, LOGGED — unlike `waitingUnverified`, which fails open. A
 * missed pointer costs a re-printed round; a pointer let through wrongly ends
 * the job on a round the founder already answered or never saw.
 *
 * RESIDUAL: a `❓ **Qn**` line quoted in an earlier message, fenced or not,
 * counts as posted.
 *
 * @param {string} payload the governing marker's text after its colon
 * @param {string} [transcript] the session's transcript path
 * @returns {boolean}
 */
function pointsAtStandingRound(payload, transcript) {
	const named = [...payload.matchAll(NAMED_ROUND)].map((m) =>
		requiredGroup(m, 1, NAMED_ROUND),
	);
	if (named.length === 0 || !transcript) return false;
	const log = failOpenLogger(FAIL_LOG_STANDING);
	let rounds;
	try {
		rounds = require("./lib/tool-calls-since").standingRounds(transcript);
	} catch (e) {
		log?.(`transcript would not be read at ${transcript}: ${e} — refused`);
		return false;
	}
	if (rounds === null) {
		log?.(`transcript parsed to no records at ${transcript} — refused`);
		return false;
	}
	return named.every((n) => rounds.includes(n));
}

/* The fail-open log's second field for the waiting-verification limb, which
 * check-guard-errors.js groups on. */
const FAIL_OPEN_WAITING = "guard-priced-options waiting";

/**
 * The refusal that reads an artefact rather than the wording (mantahostels#2487): a
 * background job ending on `waiting:` with nothing running to wake it.
 *
 * An unreadable transcript, one that parsed to nothing, and any failure of the
 * apparatus all allow the stop and write the reason to the fail-open log. The
 * asymmetry is `lib/pending-tasks.js`'s and is explained there.
 *
 * @param {StatusReading} status the message's status reading
 * @param {string} [transcript] the session's transcript path; with none the
 *   limb has no evidence and so says nothing.
 * @returns {string} the block reason, or '' if nothing is owed
 */
function waitingUnverified(status, transcript) {
	if (!transcript) return "";

	if (status.governing?.name !== "waiting:") return "";

	/* Required here rather than at the top, on `resultWithoutGreenSuite`'s terms:
	 * a library that will not load costs a missed check, never a dead turn.
	 *
	 * THE STORE LOADS FIRST, and in its own `try`, so that a `pending-tasks`
	 * that will not load is REPORTED rather than silent. */
	const log = failOpenLogger(FAIL_OPEN_WAITING);
	if (!log) return "";

	let readPendingTasks;
	try {
		({ readPendingTasks } = require("./lib/pending-tasks"));
	} catch (e) {
		log(`lib/pending-tasks would not load: ${e}`);
		return "";
	}

	let seen;
	try {
		seen = readPendingTasks(transcript);
	} catch (e) {
		log(`transcript would not be read at ${transcript}: ${e}`);
		return "";
	}
	/* A transcript that parsed to nothing is an apparatus failure, not a session
	 * with nothing running: the turn being stopped is itself in that file. */
	if (!seen.records) {
		log(`transcript parsed to no records at ${transcript}`);
		return "";
	}
	if (seen.pending.length > 0) return "";

	/* THE FINISHED-JOB CASE LEADS (mantahostels#3432): nearly every refusal here holds a
	 * settled launch — a backgrounded `gh` call whose notification landed while
	 * the turn was being written — and the way out there is to keep working. */
	const finishedLead =
		seen.launches.length > 0
			? "Every one of the " +
				seen.launches.length +
				" launch(es) in this session's transcript has already reported, so no " +
				"`waiting:` hand-off is owed: the job has finished. Read its output " +
				"file or the subagent's report, and carry on with the work in this " +
				"same turn. End on a status marker only once the work is done or " +
				"blocked on the founder.\n\n"
			: "";

	return (
		"This turn ends a background job on `waiting:`, and nothing this session " +
		"launched is still running. " +
		finishedLead +
		"That marker means a subagent or a background " +
		"Bash job will wake the session with its own notification; with none out, " +
		"the job is filed busy and sits there for ever, because no notification " +
		"is coming and the founder is never told.\n\n" +
		"Three launches this cannot see, and each is a real stall rather than a " +
		"miscount: a job backgrounded with `&` or `nohup` inside an ordinary " +
		"Bash call, one started from inside a script, and a wait loop the founder " +
		"is running elsewhere. None of them wakes this session either — a " +
		"`run_in_background: true` Bash call, a Bash call its `timeout` moved to " +
		"the background, or an `Agent` call is what does.\n\n" +
		"So end on what is true instead:\n\n" +
		INVENTORY.resultLine +
		"\n" +
		INVENTORY.needsInputLine +
		"\n\n" +
		"Or relaunch the work through the background route and keep `waiting:`."
	);
}

/**
 * The refusal a defective round earns, listing the questions that broke the
 * form.
 * @param {number} count how many question blocks the turn carries
 * @param {string[]} bad one line per defective block
 * @returns {string}
 */
function formatReason(count, bad) {
	const pointer = shapePointer();
	return (
		"This turn puts " +
		count +
		" question(s) to the founder and " +
		bad.length +
		" of them break the priced-options format that " +
		pointer +
		" requires and `scripts/inject-tracker-docs.sh` pasted into this session " +
		"at start. Defective:\n\n" +
		bad.join("\n") +
		"\n\nThe lettered priced form is written out in " +
		pointer +
		" — read it there; each defect above states its own fix. Every option the " +
		"founder is asked to choose between is lettered and priced; the grilling " +
		"skill's round template governs WHICH questions you ask, this governs the " +
		"options INSIDE each one, and they compose — the round marker and the " +
		"recommendation arrow both stay.\n\n" +
		"RE-SEND ONLY THE CORRECTED QUESTION, not the whole round: the founder has " +
		"already read the rest. End the turn with the mandatory `needs input:` " +
		"line enumerating EVERY open question in the round, a few words each, " +
		`then its \`${INVENTORY.refsTail}\` tail.\n\n` +
		"The only escape is declaring a figure genuinely ungroundable: in place " +
		"of the option's figure, write one of these words and say why — " +
		UNPRICEABLE_WORDS.map((w) => `\`${w}\``).join(", ") +
		". Omitting the price is never the escape, and neither is a figure you " +
		"made up to satisfy this check."
	);
}

/**
 * THE ONE BACKGROUND-JOB GATE: the message's status reading in a background
 * job, null elsewhere, so every status limb runs behind it. Interactive
 * sessions are skipped: they have no status line to mislabel, and the marker
 * would be noise in the founder's own terminal. CLAUDE_JOB_DIR is set only in a
 * background job and reaches a hook's environment.
 * @param {string} message the outgoing assistant message
 * @returns {StatusReading | null}
 */
function jobStatus(message) {
	return process.env.CLAUDE_JOB_DIR ? parseStatus(message) : null;
}

/**
 * The shape refusal over every round in the message, or '' where all pass.
 * @param {ReturnType<typeof splitQuestions>} blocks
 * @returns {string}
 */
function buildShapeReason(blocks) {
	const bad = [];
	for (const block of blocks) {
		const defects = defectsIn(block);
		if (defects.length > 0)
			bad.push(`Q${block.number}: ${defects.join("; ")}.`);
	}
	return bad.length > 0 ? formatReason(blocks.length, bad) : "";
}

/**
 * Every refusal this turn earns, each tagged with the counter that pays for it
 * (mantahostels#2544). Order is the order the reasons are read in, and a bucket-deciding
 * limb never shares a prefix with a cosmetic one.
 * @param {string} message the outgoing assistant message
 * @param {{transcript?: string, verdicts?: Part[]}} [evidence]
 *   what the limbs reading more than the message need, and the verdicts of
 *   the limbs judged before it
 * @param {StatusReading | null} [status] the message's `jobStatus`, passed by
 *   a caller that reads it too
 * @returns {Part[]} only the parts carrying a reason
 */
function reviewParts(message, evidence = {}, status = jobStatus(message)) {
	/** @type {Part[]} */
	const parts = [];
	/** @type {(prefix: string, reason: string) => void} */
	const push = (prefix, reason) => {
		if (reason) parts.push({ prefix, reason });
	};

	const blocks = splitQuestions(message);
	/* Read with no round too: a secret ask in prose needs none (#1817). */
	const founderAct = founderActRefusal(message);
	if (blocks.length > 0) {
		push(SHAPE_PREFIX, buildShapeReason(blocks));
		for (const { prefix, reason } of evidence.verdicts ?? [])
			push(prefix, reason);
		push(FOUNDER_ACT_PREFIX, founderAct);
		push(
			ACTOR_ONLY_PREFIX,
			actorOnlyRound(message, { ruleShown: Boolean(founderAct) }),
		);
	} else push(FOUNDER_ACT_PREFIX, founderAct);

	if (status) {
		if (blocks.length > 0)
			push(
				MISSING_NEEDS_INPUT_PREFIX,
				missingNeedsInput(status, blocks.length),
			);
		else push(UNMARKED_STOP_PREFIX, unmarkedStop(status));
		push(
			COMPLETED_WHILE_WAITING_PREFIX,
			completedWhileWaiting(message, status),
		);
		push(EMPTY_MARKER_PREFIX, emptyStatusMarker(status));
		push(
			WAITING_UNVERIFIED_PREFIX,
			waitingUnverified(status, evidence.transcript),
		);
		push(NEEDS_INPUT_UNDERCUT_PREFIX, needsInputUndercut(status));
		push(NEEDS_INPUT_MISPLACED_PREFIX, needsInputMisplaced(status));
		push(RESULT_MISPLACED_PREFIX, resultMisplaced(status));
	}
	push(SHAPE_PREFIX, recommendationBelowPrice(message));
	return parts;
}

/** @typedef {import("./lib/priced-options-ceiling").Part} Part */

/**
 * The whole of this guard's judgement on one turn; `lib/stop-guard.js` owns
 * everything around it.
 * @param {{sessionId: string, message: string,
 *   payload?: {transcript_path?: string}|null}} ctx
 */
function judge({ sessionId, message, payload }) {
	const transcript = hookMessage.transcriptPath(payload, sessionId);
	const status = jobStatus(message);
	const unlettered = status
		? needsInputWithoutRound(message, status, transcript)
		: "";
	/** @param {Part[]} verdicts */
	const partsWith = (verdicts) => {
		const parts = reviewParts(message, { transcript, verdicts }, status);
		if (unlettered)
			parts.push({ prefix: NEEDS_INPUT_ROUND_PREFIX, reason: unlettered });
		return parts;
	};

	/** @type {(max: number) => boolean} */
	const ceilingAt = (max) =>
		hookBlock.capSpent({ prefix: SESSION_PREFIX, sessionId, max });

	/* Whether the shape limb speaks this turn, which no verdict moves, both
	 * limbs sitting outside the ceiling. Where it is silent, the close-rivals
	 * and round-check limbs hold the shape of the questions they refuse
	 * (#1730, #1742). */
	const shapeHeard = ceilingPlan(
		liveGroups(groupByPrefix(partsWith([])), sessionId),
		ceilingAt,
	).blocking.some((group) => group.prefix === SHAPE_PREFIX);
	const silencedShape = shapeHeard ? null : defectsIn;
	/* A block refusing on a limb at its last must not promise to refuse the
	 * re-send (#1808). */
	/** @param {string} prefix */
	const isLastRefusal = (prefix) =>
		hookBlock.isLastBlock(limbCounter(prefix, sessionId));
	const roundRecord = readRoundRecord(sessionId, transcript);
	const close = closeRivalsTurn(message, {
		sessionId,
		transcript,
		houseDecision: readHouseDecisionRule,
		silencedShape,
		isLastRefusal: isLastRefusal(CLOSE_RIVALS_PREFIX),
		isLastLadder: isLastRefusal(RESEARCH_LADDER_PREFIX),
		corpus: corpusTrackers,
		roundPasses: passedNumbers(roundRecord),
	});
	/** @param {{ prefix: string, refusing: string[] }} limbTurn */
	const refusingOf = (limbTurn) =>
		isLive(limbTurn.prefix, sessionId) ? limbTurn.refusing : [];
	const roundCheck = roundCheckTurn(message, {
		sessionId,
		transcript,
		stored: roundRecord,
		houseDecision: readHouseDecisionRule,
		closeJudged: close.rounds,
		rivalLimbsRefusing: [...refusingOf(close), ...refusingOf(close.ladder)],
		silencedShape,
		isLastRefusal: isLastRefusal(ROUND_CHECK_PREFIX),
	});
	const parts = partsWith([close, close.ladder, roundCheck]);

	/* ONE BLOCK PER TURN, CARRYING EVERY DEFECT THE TURN EARNED (mantahostels#2786,
	 * reversing mantahostels#2544's serialisation). mantahostels#2544 emitted the first group and
	 * returned, so a reply with a shape defect AND a filing defect heard only
	 * the shape one and paid a whole round trip for the rest.
	 *
	 * mantahostels#2544's objection was that a session told two things at once fixes one of
	 * them, leaving the other counter charged for a turn nobody acted on. That
	 * holds, and is paid for: each counter still has three, and the session
	 * ceiling below is what actually bounds the loop. Reporting a defect and
	 * then not charging for it is the worse trade — the founder pays the round
	 * trip either way. */
	const live = liveGroups(groupByPrefix(parts), sessionId);
	const afterBatch = () => {
		const unattested = status ? resultWithoutGreenSuite(status, sessionId) : "";
		return unattested
			? liveGroups(
					[{ prefix: GREEN_SUITE_PREFIX, reasons: [unattested] }],
					sessionId,
				)
			: [];
	};
	if (
		blockOn(ceilingPlan(live, ceilingAt, afterBatch), {
			sessionId,
			recorders: [close, close.ladder, roundCheck],
		})
	)
		return;

	close.onPassed(!isLive(close.prefix, sessionId));
	roundCheck.onPassed(
		!isLive(roundCheck.prefix, sessionId),
		hookBlock.readCount(roundCheck.prefix, sessionId),
	);
}

if (require.main === module) {
	disarmLoadFailure();
	stopGuard.onMessage({ review: judge });
}
