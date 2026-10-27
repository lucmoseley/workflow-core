// @vitest-environment node
/*
 * The seventeenth refusal (#597): a round option handing the founder an act by
 * placeholder or back-reference instead of its literal text, and its secret
 * ask: a credential the founder supplies without `write-secret.js`, in an
 * option (#1031) or in prose (#1817), or beside a line that leaks it (#2645). Driven through
 * the guard's Stop entry in process; the permission line the refusal prints is
 * then run, in this checkout and in a simulated plugin install — through bash,
 * because the claim is that the line works as the founder would paste it.
 *
 * The guard runs at every `Stop` (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a case and the founder is handed "run the command
 * above" instead of the text to run; break the permission line and the escape
 * the refusal teaches fails when pasted.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardReason } from "./lib/stop-guard-testkit";
import { readProgramLibs } from "./lib-closure-fixture";

const ROOT = path.resolve(__dirname, "..");
const GUARD = path.join(__dirname, "guard-priced-options.js");

let dir: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "founder-act-"));
	sid = `founder-act-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The refusal the guard writes for `message`, or "" where it allows the stop.
 * Interactive unless `job`; `env` is laid over this process's environment.
 */
const stop = (
	message: string,
	{ job = false, env }: { job?: boolean; env?: NodeJS.ProcessEnv } = {},
) => readStopGuardReason(GUARD, { dir, sid, message, job, env });

/** A plugin root under `dir` holding `program` and the lib/ files it requires. */
const installAsPlugin = (program: string) => {
	const plugin = path.join(dir, "plugin");
	fs.mkdirSync(path.join(plugin, "scripts", "lib"), { recursive: true });
	for (const f of [program, ...readProgramLibs(program).map((l) => `lib/${l}`)])
		fs.copyFileSync(
			path.join(ROOT, "scripts", f),
			path.join(plugin, "scripts", f),
		);
	return plugin;
};

/** A well-formed round whose (A) is `a`. */
const round = (a: string, { n = 1 } = {}) =>
	`❓ **Q${n}** — How should it land?\n\nRelation: rivals\n\n` +
	`(A) ${a}\nConfidence: 80% (70% - 90%). It is cheap.\n\n` +
	"(B) Leave it for now.\nConfidence: 20% (10% - 30%). Nothing moves.\n\n➡ (A).";

const REFUSED = "puts a founder act in a question option without the literal";

describe("a founder-act option", () => {
	it.each([
		["a `!` code span", "Run `! git push origin <branch>` and reply done."],
		[
			"a verb addressed to him",
			"You run `git push origin <branch>` and reply done.",
		],
		["paste", "Paste `git push origin …` into this session."],
		["a normal terminal", "Run `git push …` in a normal terminal."],
		["a URL", "Open this URL: `https://github.com/<owner>/settings`."],
		["a surface named his", "Type `git push <remote>` in your terminal."],
		[
			"the other repo's session",
			"Give `/implement <n>` to the other repo's session.",
		],
	])(
		"with %s and a placeholder is refused, naming option and phrase",
		(_cue, a) => {
			const reason = stop(round(a));
			expect(reason).toContain(REFUSED);
			expect(reason).toMatch(
				/Q1 \(A\): placeholder “`[^”]*(<|…|\.\.\.)[^”]*`”/,
			);
		},
	);

	it.each([
		"You paste the two `!` commands above, then I verify.",
		"You run the command from my previous reply.",
		"Paste the line I gave earlier and reply done.",
		"Paste the text above into a workflow-core session.",
	])("with a back-reference is refused: %s", (a) => {
		const reason = stop(round(a));
		expect(reason).toContain(REFUSED);
		expect(reason).toMatch(/Q1 \(A\): back-reference “/);
	});

	/* #1981, from #1952. */
	it.each([
		'You make the edit yourself. Open `~/.claude/hooks/browser-profile-guard.sh` and replace lines 22–23 (the `map=` and `open_right=` lines) with the block in issuecomment-6245050985 on #1952. Reply "applied".',
		'You make the edit yourself. Open `~/.claude/hooks/browser-profile-guard.sh` and replace lines 22–23 with the block in my earlier comment on #1952. Reply "applied".',
		"Paste the code in my comment on #1952 into your terminal.",
		"You apply the patch in #1952 and reply done.",
		"You run the script at https://github.com/o/r/issues/1952#issuecomment-6245050985.",
		"You edit `browser-profile-guard.sh` with the block in issuecomment-6245050985.",
		"You replace lines 22–23 with the block at `https://github.com/o/r/issues/1952#issuecomment-6245050985` yourself.",
		"You apply what I posted at https://github.com/o/r/issues/1952#issuecomment-6245050985.",
		"You make the change in my comment on #1952 yourself.",
		"You apply the patch in issue #1952 and reply done.",
	])("with a pointer to a ticket comment is refused: %s", (a) => {
		expect(stop(round(a))).toMatch(/Q1 \(A\): back-reference “/);
	});

	it("with a prompt named as in an issue passes (rule:founder-deliverable)", () => {
		expect(
			stop(
				round(
					"You paste the prompt from #1447 into a mantahostels session yourself.",
				),
			),
		).toBe("");
	});

	it.each([
		"You run `! git push origin main` and reply done.",
		"You run `! git push origin main`, also posted in issuecomment-6245050985.",
		"Open this URL: `https://github.com/o/r/issues/1952#issuecomment-6245050985`.",
		"Paste `! node scripts/grant-permission.js 'Bash(git status *)'`, then reply done.",
		"You run `! git push origin main`, the same line as the one above.",
		"You paste the permission line I send in my reply to accept.",
	])(
		"with the literal text, or the walk promised on accept, passes: %s",
		(a) => {
			expect(stop(round(a))).toBe("");
		},
	);
});

describe("each cue", () => {
	const cues = [
		["a normal terminal", "Run %s in a normal terminal."],
		["a URL", "Open this URL: %s."],
		["a surface named his", "Type %s in your terminal."],
		["the other repo's session", "Give %s to the other repo's session."],
	];

	it.each(cues)("%s with a back-reference is refused", (_cue, a) => {
		expect(stop(round(a.replace("%s", "the command above")))).toMatch(
			/Q1 \(A\): back-reference “/,
		);
	});

	it.each(cues)("%s with the literal text passes", (_cue, a) => {
		expect(stop(round(a.replace("%s", "`git push origin main`")))).toBe("");
	});

	it("reads git's range syntax as literal, not as an ellipsis", () => {
		expect(
			stop(round("You run `! git diff main...HEAD` and reply done.")),
		).toBe("");
	});

	it("reads a fenced `!` block as the literal line", () => {
		const a =
			"Paste this and reply done:\n```\n! git push origin main\n```\n" +
			"It is the command above, unchanged.";
		expect(stop(round(a))).toBe("");
		expect(stop(round(a.replace("main", "<branch>")))).toContain(REFUSED);
	});
});

describe("a Markdown image in a code span (#936)", () => {
	it("is not a `!` cue, so its placeholder is not read", () => {
		expect(stop(round("Embed `![diagram](<path>)` in the doc."))).toBe("");
	});

	it.each([
		["inline", "Paste the command above, beside `![x](y.png)`."],
		["fenced", "Paste the command above:\n```\n![x](y.png)\n```"],
	])(
		"%s, is not the literal line a back-reference sits beside",
		(_where, a) => {
			expect(stop(round(a))).toMatch(/Q1 \(A\): back-reference “/);
		},
	);
});

describe("an option naming no founder act", () => {
	it.each([
		"I add a `Bash(<tool> *)` rule and finish.",
		"Document the usage as `node x.js <rule> [--project]`.",
		"Rerun the command above myself, then report.",
		"I apply the block in issuecomment-6245050985 myself.",
	])("passes even with a placeholder or back-reference: %s", (a) => {
		expect(stop(round(a))).toBe("");
	});

	it("is not read into by the Relation and status lines trailing the last option", () => {
		const message =
			"❓ **Q1** — Which?\n\nRelation: rivals\n\n" +
			"(A) I do it.\nConfidence: 80% (70% - 90%). Cheap.\n\n" +
			"(B) Leave it.\nConfidence: 20% (10% - 30%). Nothing moves.\n\n" +
			"➡ (A). Or you paste the command above yourself.";
		expect(stop(message)).toBe("");
	});
});

describe("the refusal", () => {
	const reason = () => stop(round("Paste `! <cmd>` and reply done."));

	it("states the whole founder hand-over and asks for the corrected question alone", () => {
		const text = reason();
		expect(text).toMatch(/^A Stop guard refused this turn/);
		for (const part of [
			"Do every step you can first",
			"where to paste it",
			"what he should see",
			"what to send back",
			"at the end of the message",
			"inside the question's option",
			"paste-ready prompt for a fresh session",
		])
			expect(text).toContain(part);
		expect(text).toMatch(
			/RE-SEND ONLY THE CORRECTED QUESTION, not the whole round\.$/,
		);
	});

	it("names every offending option across rounds", () => {
		const text = stop(
			`${round("Paste `! <cmd>`.")}\n\n${round("You run the command above.", { n: 2 })}`,
		);
		expect(text).toContain("Q1 (A): placeholder");
		expect(text).toContain("Q2 (A): back-reference");
	});
});

describe("a secret ask (#1031)", () => {
	const secretRefused = "supply a credential in a question option";

	it.each([
		"Paste your Hugging Face token into `~/.hf.env`, then reply done.",
		"You paste the token here and I write it to `.env`.",
		"Enter the API key in this chat.",
		"Give me the deploy token and I set it up.",
		"Paste your OpenAI key into `.env`.",
		"Paste the token here; write-secret is broken.",
		"Share the token with this session.",
	])("is refused, printing the SECRET paragraph's line: %s", (a) => {
		const text = stop(round(a));
		expect(text).toContain(secretRefused);
		expect(text).toMatch(/Q1 \(A\): “/);
		expect(text).toMatch(/node \S+write-secret\.js AI_GATEWAY_API_KEY$/m);
	});

	it.each([
		"Run `cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN` in a normal terminal; it prints the name, never the value.",
		"I rotate the deploy token.",
		"I'll paste the token into the vendor form myself.",
		"Pick the type of token the vendor issues.",
		"Run the trial, which spends about 10k output tokens.",
		"Adopt Tailwind, so components paste in and the rewrite shrinks to token re-mapping.",
		"Give the token Secrets write access, then re-run the sync.",
		"Send the hand-over, then the rest ranked by how many tokens each costs.",
	])("passes: %s", (a) => {
		expect(stop(round(a))).toBe("");
	});

	it("passes an option pointing at a sibling that carries the route", () => {
		const text = round(
			"Run `cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN` in a normal terminal.",
		).replace(
			"(B) Leave it for now.",
			"(B) Create a new key first, then paste the (A) line with that key.",
		);
		expect(stop(text)).toBe("");
	});

	it("leaves the Confidence line unread", () => {
		const text = round("Run the trial.").replace(
			"It is cheap.",
			"You provide the token budget, so it is cheap.",
		);
		expect(stop(text)).toBe("");
	});

	it("prints the hand-over once beside a placeholder refusal", () => {
		const text = stop(round("Paste `! <cmd>`, then paste your API key here."));
		expect(text).toContain(REFUSED);
		expect(text).toContain(secretRefused);
		expect(text.match(/A SECRET he must supply/g)).toHaveLength(1);
	});

	it("spends the founder-act counter, not a new one", () => {
		const secret = round("Paste your API key here.");
		const placeholder = round("Paste `! <cmd>` and reply done.");
		expect(stop(secret)).toContain(secretRefused);
		expect(stop(placeholder)).toContain(REFUSED);
		expect(stop(secret)).toContain(secretRefused);
		expect(stop(secret)).toBe("");
	});
});

describe("a secret ask in prose (#1817)", () => {
	const proseRefused = "This turn's prose has the founder supply a credential";

	it.each([
		"Open your own terminal, run `nano ~/.hf.env`, type `export HF_TOKEN=` and paste the token straight after it. Then tell me done.",
		"Install Podman first: you run it or supply the password.",
		/* Caught on the warning, not on "put it in": the incident's opening. */
		"Don't paste the key here. Put it in `~/.bfl.env`, then tell me “key added”.",
	])("is refused, printing the SECRET paragraph's line: %s", (message) => {
		const text = stop(message);
		expect(text).toContain(proseRefused);
		expect(text).toMatch(/node \S+write-secret\.js AI_GATEWAY_API_KEY$/m);
		expect(text).toContain("RE-SEND THE CORRECTED MESSAGE.");
		expect(text).not.toContain("RE-SEND ONLY THE CORRECTED QUESTION");
	});

	it("is refused on a background job's lone hand-over (#926)", () => {
		const text = stop(
			"Create the token, then paste the token into `.env`:\n\n" +
				"```\nnano .env\n```\n\nReply done once it is saved.\n\n" +
				"needs input: the token in `.env`",
			{ job: true },
		);
		expect(text).toContain(proseRefused);
	});

	it.each([
		"Run `cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN` in a normal terminal, then paste the token at its hidden prompt.",
		"I can't supply the password, so the kernel half waits.",
		"A model cannot supply the key, so you mark it.",
		"Still waiting on what share of spend thinking tokens carry.",
		"#1530: the config type warnings for seven keys are never printed.",
		"If the classifier refuses my `tmux send-keys` into your sessions, the run is yours.",
		"Run `! rm ~/core-key` and send back the `gh secret set` output.",
		"The prompt for the other session:\n\n```\nPaste the token into .env\n```",
		"> paste your API key here\n\nThat was the old hand-over.",
		"    > paste your API key here\n\nThat was the old hand-over.",
		"The prompt for the other session:\n\n~~~\nPaste the token into .env\n~~~",
	])("passes: %s", (message) => {
		expect(stop(message)).toBe("");
	});

	it("names a prose ask beside an option's, the hand-over printed once", () => {
		const text = stop(
			`Paste your API key into \`.env\` first.\n\n${round("Paste your API key here.")}`,
		);
		expect(text).toContain(proseRefused);
		expect(text).toContain("supply a credential in a question option");
		expect(text.match(/A SECRET he must supply/g)).toHaveLength(1);
		expect(text).toContain("RE-SEND THE CORRECTED MESSAGE.");
		expect(text).not.toContain("RE-SEND ONLY THE CORRECTED QUESTION");
	});

	it("passes prose whose round option carries the route", () => {
		expect(
			stop(
				`Create the key, then paste the key at the prompt.\n\n${round(
					"Run `cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN` in a normal terminal.",
				)}`,
			),
		).toBe("");
	});
});

describe("a write-secret line after `!` (#2554)", () => {
	const bangRefused =
		"a secret's line goes in a normal terminal, never after `!`";
	const bangRoute =
		"`! cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN`";

	it.each([
		[
			"an option",
			round(`Run ${bangRoute}, then paste the token at its prompt.`),
		],
		["prose", `Run ${bangRoute}, then paste the token at its prompt.`],
		[
			"a fenced block",
			"Paste the token at the prompt this opens:\n\n```\n! node scripts/write-secret.js HF_TOKEN\n```",
		],
		[
			"a fenced block whose `!` opens an earlier line",
			"Paste the token at the prompt this opens:\n\n```bash\n! cd /srv/host &&\n  node scripts/write-secret.js HF_TOKEN\n```",
		],
		[
			"a fenced block whose `!` opens a later line",
			"Paste the token at the prompt this opens:\n\n```\n# in the prompt box\n! node scripts/write-secret.js HF_TOKEN\n```",
		],
		[
			"a ~~~ fenced block",
			"Paste the token at the prompt this opens:\n\n~~~\n! node scripts/write-secret.js HF_TOKEN\n~~~",
		],
	])("is no route in %s, and the refusal says why", (_l, message) => {
		const text = stop(message);
		expect(text).toContain(bangRefused);
		expect(text).toMatch(/node \S+write-secret\.js AI_GATEWAY_API_KEY$/m);
	});

	it("says nothing of `!` where the route is also given without it", () => {
		expect(
			stop(
				`Not ${bangRoute}: run \`cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN\` in a normal terminal, then paste the token at its prompt.`,
			),
		).toBe("");
	});

	it("blames no `!` on an option whose own ask names no route", () => {
		const text = stop(
			round("Paste your API key here.").replace(
				"(B) Leave it for now.",
				`(B) Run ${bangRoute} later.`,
			),
		);
		expect(text).toContain("supply a credential in a question option");
		expect(text).not.toContain(bangRefused);
	});

	it("blames `!` on an option that points at a sibling's `!` line", () => {
		const text = stop(
			round("Paste your API key at the prompt the (B) line opens.").replace(
				"(B) Leave it for now.",
				`(B) Run ${bangRoute}.`,
			),
		);
		expect(text).toContain(bangRefused);
		expect(text).toMatch(
			/^Q1 \(A\): “[^\n]*” — its `write-secret\.js` line follows `!`$/m,
		);
	});

	it("credits a ~~~ fenced route given without `!`", () => {
		expect(
			stop(
				"Paste the token at the prompt this opens, in a normal terminal:\n\n~~~\ncd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN\n~~~",
			),
		).toBe("");
	});
});

describe("whether a write-secret line can run as given (#2612)", () => {
	const bangRefused =
		"a secret's line goes in a normal terminal, never after `!`";
	const secretRefused = "supply a credential in a question option";

	it.each([
		[
			"a `!` span just before it",
			"Paste the token after typing `!`: `node scripts/write-secret.js FOO`",
		],
		[
			"a bare `!` just before it",
			"In the prompt box type ! `node scripts/write-secret.js FOO` and paste the token.",
		],
		[
			"a bare mention beside the `!` line",
			"Paste the token at its prompt: `! node scripts/write-secret.js FOO` (`write-secret.js` hides typing)",
		],
		[
			"an emphasised `!` just before it",
			"Paste the token after typing **`!`**: `node scripts/write-secret.js FOO`",
		],
		[
			"a negation in the sentence that does not govern the `!`",
			"Do not wait: type `!`: `node scripts/write-secret.js FOO`, then paste the token.",
		],
		[
			"a `!` span and “then” just before it",
			"Type `!` then `node scripts/write-secret.js FOO` and paste the token.",
		],
		[
			"a `!` span and “followed by” just before it",
			"Type `!` followed by `node scripts/write-secret.js FOO` and paste the token.",
		],
		[
			"a quoted `!` and an en dash just before it",
			'Type "!" – `node scripts/write-secret.js FOO` and paste the token.',
		],
		[
			"a `!` beside a route that is broken too",
			"Paste the token after typing `!`: `echo $K | node scripts/write-secret.js FOO`",
		],
		[
			"a `!` before a broken route beside a runnable one",
			"Paste the token at the prompt `cd /srv && node scripts/write-secret.js FOO` opens. If it hangs, after `!`: `echo sk | node scripts/write-secret.js FOO`",
		],
	])("is no route with %s, and the refusal says why", (_l, message) => {
		const text = stop(message);
		expect(text).toContain(bangRefused);
		expect(text).toMatch(/node \S+write-secret\.js AI_GATEWAY_API_KEY$/m);
	});

	it.each([
		"Paste the token, then run `echo $KEY | node scripts/write-secret.js X`.",
		"Paste the token into k.txt, then run `node scripts/write-secret.js X < k.txt`.",
		"Paste the token, then run `node scripts/write-secret.js X <<< $KEY`.",
		"Paste the token into k.txt, then run `< k.txt node scripts/write-secret.js X`.",
		"Paste the token at the prompt, then run:\n\n```\nread -s KEY; echo $KEY |\n  node scripts/write-secret.js X\n```",
		'Paste the token, then run `printf %s "$KEY" | (cd /srv && node scripts/write-secret.js X)`.',
		"Paste the token into k.txt, then run `exec < k.txt; node scripts/write-secret.js X`.",
		"Paste the token into k.txt, then run `node scripts/write-secret.js X 2>&1 < k.txt`.",
		"Paste the token in place of hf_x, then run `HF_TOKEN=hf_x node scripts/write-secret.js HF_TOKEN`.",
		"Paste the token, then run `node scripts/write-secret.js HF_TOKEN && export HF_TOKEN=hf_x`.",
		"Paste the token, then run `echo hf\\'| node scripts/write-secret.js HF_TOKEN`.",
		"Paste the token at the prompt, then run:\n\n```\nnode scripts/write-secret.js A\necho hf | node scripts/write-secret.js B\n```",
		"Paste the token at the prompt `node --require=./x.js scripts/write-secret.js X` opens.",
		"Paste the token at the prompt, then run:\n\n```\nnode scripts/write-secret.js HF_TOKEN  # hides typing\necho hf >> notes.txt\n```",
		"Paste the token at the prompt, then run:\n\n```\n# first &&\necho hf | tee k.txt\nnode scripts/write-secret.js HF_TOKEN\n```",
		"Paste the token at the prompt `cd /srv/host && node scripts/write-secret.js X` opens; if it hangs, run `echo hf | node scripts/write-secret.js X`.",
		"Paste the token at the prompt `cd /srv/host && node scripts/write-secret.js X` opens; if it hangs, run `echo hf | scripts/write-secret.js X`.",
		"Paste the token at the prompt `node -e'process.stdin.pipe(process.stdout)//'write-secret.js X` opens.",
		"Paste the token at the prompt `node --require=./write-secret.js X` opens.",
		"Paste the token at the prompt `node fake'write-secret.js' X` opens.",
	])(
		"is no route with anything beside the route command, blaming no `!`: %s",
		(message) => {
			const text = stop(message);
			expect(text).toContain("This turn's prose has the founder supply");
			expect(text).toMatch(/node \S+write-secret\.js AI_GATEWAY_API_KEY$/m);
			expect(text).not.toContain(bangRefused);
		},
	);

	it.each([
		"Paste the token at the prompt `write-secret.js` opens.",
		"Paste the token at the prompt `node scripts/write-secret.js` opens.",
		"Paste the token at the prompt `node scripts/write-secret.js HF-TOKEN` opens.",
		"Run `node scripts/write-secret.js HF_TOKEN hf_PASTE_HERE`, then paste the token in place of hf_PASTE_HERE.",
		"Paste the token at the prompt `scripts/write-secret.js HF_TOKEN` opens.",
		'Paste the token at the prompt `node "$(cat dir.txt)/write-secret.js" X` opens.',
	])(
		"is no route in an option that is not the route command alone: %s",
		(a) => {
			const text = stop(round(a));
			expect(text).toContain(secretRefused);
			expect(text).not.toContain(bangRefused);
		},
	);

	it.each([
		"Type `!`, then in a normal terminal run `cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN` and paste the token at its prompt.",
		"In a normal terminal, never after `!`: `cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN`, then paste the token at its prompt.",
		"Never after `!`: `cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN`, then paste the token at its prompt.",
		"Run it without `!`: `node scripts/write-secret.js HF_TOKEN` in a normal terminal, then paste the token at its prompt.",
		"Run `cd '/srv/my host' && node '/srv/my host/scripts/write-secret.js' 'hf_token'` in a normal terminal, then paste the token at its prompt.",
		"Paste the token at the prompt, in a normal terminal:\r\n\r\n```\r\n# in a normal terminal\r\ncd /srv/host &&\r\n  node scripts/write-secret.js HF_TOKEN\r\n```",
		"Run it without a `!`: `node scripts/write-secret.js HF_TOKEN` in a normal terminal, then paste the token at its prompt.",
		"Run `cd /srv/host && node /srv/host/scripts/write-secret.js HF_TOKEN` in a normal terminal; `write-secret.js` hides typing, so paste the token at its prompt.",
	])("credits a runnable route: %s", (message) => {
		expect(stop(message)).toBe("");
	});
});

describe("a credential leaking beside a runnable route (#2645)", () => {
	const route = "`cd /srv/host && node scripts/write-secret.js HF_TOKEN`";

	it.each([
		["an exported credential", "or `export HF_TOKEN=<paste token>` instead."],
		[
			"a credential set on Windows",
			"or `setx HF_TOKEN <paste token>` instead.",
		],
		[
			"a credential ahead of a command",
			"or `HF_TOKEN=<paste token> huggingface-cli login` instead.",
		],
		[
			"a piped route in an indented block",
			"If it hangs:\n\n    echo sk | node scripts/write-secret.js HF_TOKEN\n",
		],
		[
			"a piped route in prose",
			"If it hangs, run echo sk | node scripts/write-secret.js HF_TOKEN instead.",
		],
		[
			"a redirected route in prose",
			"If it hangs, run node scripts/write-secret.js HF_TOKEN < k.txt instead.",
		],
		[
			"`.env` copied into a tracked file",
			"Then `cat .env >> config/settings.json` to share it.",
		],
		["`.env` copied by cp", "Then `cp .env config/.env.json` to share it."],
		[
			"a ```` fence holding a piped line between ``` lines",
			"If it hangs:\n\n````\n```\necho sk | node scripts/write-secret.js HF_TOKEN\n```\n````",
		],
	])("is refused with %s", (_l, tail) => {
		const text = stop(
			`Paste the token at the prompt ${route} opens in a normal terminal. ${tail}`,
		);
		expect(text).toContain("This turn's prose has the founder supply");
	});

	it.each([
		[
			"a route in a ```` fence showing ``` lines",
			"Paste the token at the prompt this opens, in a normal terminal:\n\n````\n```\n````\n\n```\nnode scripts/write-secret.js HF_TOKEN\n```",
		],
		[
			"a PATH exported beside it",
			`Run \`export PATH=$PATH:/opt/bin\`, then paste the token at the prompt ${route} opens.`,
		],
		[
			"`.env` named in prose",
			`Paste the token at the prompt ${route} opens; it lands in .env, which git ignores.`,
		],
		[
			"`.env.example` copied into `.env`",
			`Run \`cp .env.example .env\`, then paste the token at the prompt ${route} opens.`,
		],
		[
			"a `.env` body shown with a placeholder",
			`Paste the token at the prompt ${route} opens; it writes:\n\n\`\`\`\nHF_TOKEN=<paste token>\n\`\`\``,
		],
		[
			"variables whose names only contain a credential word",
			`Run \`export AUTHOR_NAME=luc SKIP_PATCH=1\`, then paste the token at the prompt ${route} opens.`,
		],
		[
			"a credential word inside other names",
			`Run \`export SSH_AUTH_SOCK=/tmp/a PATTERN=x\`, then paste the token at the prompt ${route} opens.`,
		],
		[
			"the route in a fence nested under a list item",
			"Paste the token at the prompt this opens:\n\n10. In a normal terminal:\n\n        ```\n        node scripts/write-secret.js HF_TOKEN\n        ```\n",
		],
		[
			"the route in a table cell",
			`Paste the token at the prompt the line below opens.\n\n| step | line |\n|---|---|\n| 1 | ${route} |`,
		],
	])("credits the route with %s", (_l, message) => {
		expect(stop(message)).toBe("");
	});
});

it.each([
	"Here is the log:\n\n```\nerror\n\nNow paste your API key here in the chat.",
	"```x``` is the old way.\nPaste the token here in chat.",
])(
	"reads a prose ask below a ``` that opens no closed fence (#2645): %s",
	(message) => {
		expect(stop(message)).toContain("This turn's prose has the founder supply");
	},
);

it("reads a prose ask below a fence left unclosed (#2645)", () => {
	expect(
		stop(
			"Here is the log:\n\n```\nerror\n\nNow paste your API key here in the chat.",
		),
	).toContain("This turn's prose has the founder supply");
});

/** The permission line as the refusal prints it, `!` stripped. */
const parsePermissionLine = (reason: string) => {
	const m = reason.match(/^! (node \S+grant-permission\.js '[^']+')$/m);
	if (!m) throw new Error(`no permission line in:\n${reason}`);
	return m[1];
};

describe("the permission line it prints", () => {
	const host = () => {
		const h = path.join(dir, "host");
		fs.mkdirSync(h);
		execFileSync("git", ["init", "-q"], { cwd: h });
		return h;
	};
	const readGranted = (h: string) =>
		JSON.parse(
			fs.readFileSync(path.join(h, ".claude", "settings.local.json"), "utf8"),
		).permissions.allow;

	it("runs as written in this checkout", () => {
		const line = parsePermissionLine(
			stop(round("Paste `! <cmd>` for the permission.")),
		);
		expect(line).toMatch(/^node scripts\/grant-permission\.js /);
		const h = host();
		execFileSync("bash", ["-c", line], {
			cwd: ROOT,
			env: { ...process.env, CLAUDE_PROJECT_DIR: h },
		});
		expect(readGranted(h)).toEqual(["Bash(git status *)"]);
	});

	it("runs as written in a plugin install, spelt at the plugin's path", () => {
		const plugin = installAsPlugin("grant-permission.js");
		const line = parsePermissionLine(
			stop(round("Paste `! <cmd>` for the permission."), {
				env: { WFC_SCRIPT_ROOT: plugin },
			}),
		);
		expect(line).toBe(
			`node ${plugin}/scripts/grant-permission.js 'Bash(git status *)'`,
		);
		const h = host();
		execFileSync("bash", ["-c", line], {
			cwd: h,
			env: { ...process.env, CLAUDE_PROJECT_DIR: h },
		});
		expect(readGranted(h)).toEqual(["Bash(git status *)"]);
	});
});

/** The secret line as the refusal prints it. */
const parseSecretLine = (reason: string) => {
	const m = reason.match(
		/^(cd .+ && node .+write-secret\.js AI_GATEWAY_API_KEY)$/m,
	);
	if (!m) throw new Error(`no secret line in:\n${reason}`);
	return m[1];
};

/** The post-paste check as the refusal prints it. */
const parseCheckLine = (reason: string) => {
	const m = reason.match(/^(grep -cE .*AI_GATEWAY_API_KEY.*\/\.env)$/m);
	if (!m) throw new Error(`no check line in:\n${reason}`);
	return m[1];
};

describe("the secret line it prints", () => {
	/* A git host whose `.env` is ignored, as write-secret.js wants it. */
	const host = (name = "host") => {
		const h = path.join(dir, name);
		fs.mkdirSync(h);
		execFileSync("git", ["init", "-q"], { cwd: h });
		fs.writeFileSync(path.join(h, ".gitignore"), ".env\n");
		return h;
	};
	/* Run from a directory that is not the host, as a new terminal opens. */
	const paste = (line: string) => {
		const elsewhere = path.join(dir, "elsewhere");
		fs.mkdirSync(elsewhere);
		return execFileSync("bash", ["-c", line], {
			cwd: elsewhere,
			input: "s3cret-value\n",
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
		});
	};

	it("runs as written in this checkout, from any directory, at a host path a shell would split", () => {
		const h = host("host dir");
		const reason = stop(round("Paste `! <cmd>` for the key."), {
			env: { CLAUDE_PROJECT_DIR: h },
		});
		const line = parseSecretLine(reason);
		expect(line).toBe(
			`cd '${h}' && node ${ROOT}/scripts/write-secret.js AI_GATEWAY_API_KEY`,
		);
		expect(paste(line)).not.toContain("s3cret-value");
		expect(fs.readFileSync(path.join(h, ".env"), "utf8")).toBe(
			"AI_GATEWAY_API_KEY=s3cret-value\n",
		);
		expect(
			execFileSync("bash", ["-c", parseCheckLine(reason)], {
				encoding: "utf8",
			}),
		).toBe("1\n");
	});

	it("is credited as the route when pasted back, at a host path holding a quote", () => {
		const h = host("o'brien dir");
		const line = parseSecretLine(
			stop(round("Paste `! <cmd>` for the key."), {
				env: { CLAUDE_PROJECT_DIR: h },
			}),
		);
		expect(line).toContain("'\\''");
		expect(
			stop(
				`Run \`${line}\` in a normal terminal, then paste the key at its prompt.`,
			),
		).toBe("");
	});

	it("runs as written in a plugin install, spelt at the plugin's path", () => {
		const plugin = installAsPlugin("write-secret.js");
		const h = host();
		const line = parseSecretLine(
			stop(round("Paste `! <cmd>` for the key."), {
				env: { WFC_SCRIPT_ROOT: plugin, CLAUDE_PROJECT_DIR: h },
			}),
		);
		expect(line).toBe(
			`cd ${h} && node ${plugin}/scripts/write-secret.js AI_GATEWAY_API_KEY`,
		);
		paste(line);
		expect(fs.readFileSync(path.join(h, ".env"), "utf8")).toBe(
			"AI_GATEWAY_API_KEY=s3cret-value\n",
		);
	});
});

describe("its budget", () => {
	const bad = round("Paste `! <cmd>` and reply done.");

	it("stops at its own cap of 3", () => {
		for (let i = 0; i < 3; i++) expect(stop(bad)).toContain(REFUSED);
		expect(stop(bad)).toBe("");
	});

	it("reports beside another shape defect in one block", () => {
		const text = stop(bad.replace(" (70% - 90%)", ""));
		expect(text).toContain(REFUSED);
		expect(text).toContain("bare percentage");
		expect(text.match(/A Stop guard refused this turn/g)).toHaveLength(1);
	});

	it("counts towards the session ceiling and never spends its reserved last block", () => {
		const marked = `${bad}\n\nneeds input: how it lands`;
		const unpriced =
			"❓ **Q2** — Which?\n\nRelation: rivals\n\n(A) x\n\n(B) y\n\n➡ (A).\n\nneeds input: which";
		expect(stop(unpriced, { job: true })).toContain("no Confidence line");
		expect(stop(unpriced, { job: true })).toContain("no Confidence line");
		expect(stop(marked, { job: true })).toContain(REFUSED);
		expect(stop(marked, { job: true })).toContain(REFUSED);
		/* Four blocks spent: the fifth is the filing checks'. */
		expect(stop(marked, { job: true })).toBe("");
		expect(stop("Done.", { job: true })).toContain(
			"carrying neither status marker",
		);
	});
});
