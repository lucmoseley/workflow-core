/*
 * unchecked-rm.js — guard-rm-unchecked.js's core (#2801): refuse, once per
 * command, an `rm` Claude Code's built-in removal check cannot resolve,
 * naming the two spellings that never meet it (#2436).
 *
 * WHY A REFUSAL. That check denies before any allow entry is read, so no
 * `permissions.allow` line clears it, and in away mode or a headless session
 * nobody answers its prompt: the call is denied or the session stalls (#2360).
 *
 * THE THREE LIMBS, each a shape the harness's own denial text names (census on
 * #2436):
 *
 *   var-slash   a target opening on a variable followed by `/` — `$T/*`,
 *               `"$S/$f"`, `${D}/x` — where any variable in it is one the
 *               command never assigned a value the walker resolves; a `$(…)`
 *               value counts as unassigned, and the harness denies that too
 *               ("when $T is unset or empty it becomes /").
 *   cd-glob     a relative glob target after a `cd` in the same command ("the
 *               relative glob target cannot be statically resolved").
 *   shell       an `rm` anywhere in a command that also runs `bash`/`sh`/`zsh`
 *               on a `-c` script or a script named by a variable ("passes a
 *               shell -c script that runs rm, and Claude Code could not check
 *               the script"). Here the check refuses even a literal target.
 *
 * REFUSE-ONCE, NOT DENY: an inference (#2436), so on #1728's precedent a
 * re-send of the same command goes through. The once is keyed on the command's hash,
 * per (agent, session), at the latch path lib/guard-entry.js's latchPath
 * names.
 *
 * WHAT IT LEAVES ALONE (#2436): a bare `rm -rf $T`, a
 * loop's `rm "$f"` and a literal-assigned `$R/$S/a`.
 *
 * LIMITS
 *  - The harness's trigger for the shell limb is unpublished and probes did not
 *    pin it, so this limb over-fires by design, refusing once even
 *    `bash -c 'rm -rf "$x"'`.
 *  - A command substitution as the target (`rm $(…)`) and a target removing a
 *    workspace directory (the cwd or a parent), the harness's other two
 *    reasons, are not read.
 *  - It fails open, on the record, where the latch cannot be keyed or written:
 *    a refusal no re-send can clear would wedge the command.
 */

const crypto = require("node:crypto");
const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { literal, unwrap } = require("./shell-words.js");

/* A target opening on a variable, then a slash. */
const VAR_SLASH = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\//;
/* Each variable a target names. */
const VAR_NAME = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
/* An `rm` command inside a `-c` script: at its start or after a blank, `;`,
 * `&`, `|` or `(`, then a blank. Bash's `[[:space:]]`, spelt out. */
const RM_IN_SCRIPT = /(^|[ \t\n\v\f\r;&|(])rm[ \t\n\v\f\r]/;
/* An `export`/`declare`'s `NAME=value` word. */
const DECLARATION = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * @typedef {object} RmPorts
 * @property {() => boolean} isLatchWritable whether the markers directory the
 *   latch is written to can be written
 * @typedef {import("./kit-context.js").KitContext & RmPorts} RmContext
 * @typedef {object} Scan what the walk has caught so far: the first target
 *   each limb caught, as the refusal quotes it, and what it has seen
 * @property {string} varSlash
 * @property {string} cdGlob
 * @property {string} shellRun
 * @property {boolean} rmSeen
 * @property {boolean} cdSeen
 * @property {Set<string>} declared names an `export`/`declare`/`readonly`
 *   gave a literal value, which the walk's own harvest reads only off a
 *   command's leading assignments
 */

/**
 * A text as a command substitution reads it back: trailing newlines gone.
 * @param {string} s
 */
const chomp = (s) => s.replace(/\n+$/, "");

/**
 * @param {string} command
 * @param {RmContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const subject = chomp(command);
	const reason = reasonFor(scan(subject, ctx));
	if (reason === null) return null;
	const name = `rm-unchecked.${crypto.createHash("sha1").update(subject).digest("hex").slice(0, 16)}`;
	if (ctx.key === null) {
		ctx.log("latch path unresolved — an unchecked rm allowed unrefused");
		return null;
	}
	if (ctx.readLatch(name) !== null) return null;
	if (!ctx.isLatchWritable()) {
		ctx.log("latch directory unwritable — an unchecked rm allowed unrefused");
		return null;
	}
	/* The kit writes the latch after the refusal is out (mantahostels#2261). */
	return {
		deny: refusalText(reason, ctx),
		latchWrites: [{ name, text: "" }],
	};
}

/**
 * Walk every command `subject` runs, recording what each limb catches.
 * @param {string} subject
 * @param {RmContext} ctx
 * @returns {Scan}
 */
function scan(subject, ctx) {
	const parsed = parseCommand(subject);
	/** @type {Scan} */
	const seen = {
		varSlash: "",
		cdGlob: "",
		shellRun: "",
		rmSeen: false,
		cdSeen: false,
		declared: new Set(),
	};
	/** @param {string} w */
	const lit = (w) => {
		const r = literal(w, parsed.spans);
		return { text: chomp(r.text), known: r.known };
	};
	walkCommands(
		parsed,
		({ words, assigned }) => {
			const run = unwrap(words, parsed.spans).words;
			if (run.length === 0) return;
			const head = lit(run[0] ?? "");
			if (!head.known) return;
			const args = run.slice(1);
			switch (head.text.slice(head.text.lastIndexOf("/") + 1)) {
				case "rm":
					return judgeRm(args, seen, lit, assigned);
				case "cd":
					seen.cdSeen = true;
					return;
				case "bash":
				case "sh":
				case "zsh":
				case "dash":
					if (!seen.shellRun) judgeShell(args, seen, lit);
					return;
				case "export":
				case "declare":
				case "typeset":
				case "readonly":
				case "local":
					return judgeDeclare(args, seen, lit);
			}
		},
		ctx,
	);
	return seen;
}

/**
 * One `rm`'s words after the command word: the first var-slash and cd-glob
 * targets, options skipped up to a `--`.
 * @param {string[]} args masked
 * @param {Scan} seen accumulator: rmSeen, varSlash and cdGlob are set here
 * @param {(w: string) => { text: string, known: boolean }} lit
 * @param {(name: string) => boolean} assigned
 */
function judgeRm(args, seen, lit, assigned) {
	seen.rmSeen = true;
	let opts = true;
	for (const word of args) {
		if (opts) {
			if (word === "--") {
				opts = false;
				continue;
			}
			if (word.startsWith("-")) continue;
		}
		const { text } = lit(word);
		if (
			!seen.varSlash &&
			VAR_SLASH.test(text) &&
			!allAssigned(text, seen, assigned)
		)
			seen.varSlash = text;
		if (
			seen.cdSeen &&
			!seen.cdGlob &&
			!text.startsWith("/") &&
			!text.startsWith("$") &&
			/[*?[]/.test(text)
		)
			seen.cdGlob = text;
	}
}

/**
 * Whether every `$NAME` in `text` is one the command assigned a resolvable
 * value, or declared one.
 * @param {string} text
 * @param {Scan} seen
 * @param {(name: string) => boolean} assigned
 */
function allAssigned(text, seen, assigned) {
	for (const m of text.matchAll(VAR_NAME)) {
		const name = m[1] ?? "";
		if (!assigned(name) && !seen.declared.has(name)) return false;
	}
	return true;
}

/**
 * One shell interpreter's words after the command word: the `-c` script, or
 * the script file where it is named by a variable. Only the first positional
 * word is read.
 * @param {string[]} args masked
 * @param {Scan} seen accumulator: shellRun and rmSeen are set through readScript
 * @param {(w: string) => { text: string, known: boolean }} lit
 */
function judgeShell(args, seen, lit) {
	let dashC = false;
	for (let i = 0; i < args.length; i++) {
		const kind = shellWord(args[i] ?? "");
		if (kind === "value") i++;
		else if (kind === "c") dashC = true;
		else if (kind === "script")
			return readScript(lit(args[i] ?? "").text, dashC, seen);
	}
}

/**
 * How a shell reads one word ahead of its script: a `-o`/`+o`, which takes a
 * value; a short-flag run carrying `c`; any other flag; or the script.
 * @param {string} a masked
 * @returns {"value" | "c" | "flag" | "script"}
 */
function shellWord(a) {
	if (a === "-o" || a === "+o") return "value";
	if (a.startsWith("--")) return "flag";
	if (a.startsWith("-") && a.includes("c")) return "c";
	return a.startsWith("-") || a.startsWith("+") ? "flag" : "script";
}

/**
 * A shell's script word: a `-c` script, which may run an `rm` itself, or a
 * file named by a variable.
 * @param {string} text the word as read
 * @param {boolean} dashC
 * @param {Scan} seen accumulator: shellRun and rmSeen are set here
 */
function readScript(text, dashC, seen) {
	if (dashC) {
		seen.shellRun = "-c";
		if (RM_IN_SCRIPT.test(text)) seen.rmSeen = true;
	} else if (text.includes("$")) seen.shellRun = text;
}

/**
 * The names an `export`/`declare`/`typeset`/`readonly`/`local` gives a value
 * read in full.
 * @param {string[]} args masked
 * @param {Scan} seen accumulator: each name a quoted literal declares joins declared
 * @param {(w: string) => { text: string, known: boolean }} lit
 */
function judgeDeclare(args, seen, lit) {
	for (const word of args) {
		const m = DECLARATION.exec(word);
		if (m && lit(m[2] ?? "").known) seen.declared.add(m[1] ?? "");
	}
}

/**
 * The refusal's reason clause, the first limb caught in priority order; null
 * where none was.
 * @param {Scan} seen
 */
function reasonFor({ varSlash, cdGlob, shellRun, rmSeen }) {
	if (varSlash)
		return `its target \`${varSlash}\` opens on a variable, and holds one this command never sets, so the check reads it as \`/\` when that variable is empty`;
	if (cdGlob)
		return `its target \`${cdGlob}\` is a relative glob after a \`cd\`, which the check cannot resolve`;
	if (rmSeen && shellRun)
		return `it runs \`rm\` beside a shell running \`${shellRun}\`, a script the check cannot read, so it refuses every \`rm\` in the command, a literal one included`;
	return null;
}

/**
 * The refusal: the reason, then the rule, core paths spelled at the plugin
 * root; a CMD placeholder anywhere in it reads as nothing.
 * @param {string} reason
 * @param {RmContext} ctx
 */
function refusalText(reason, ctx) {
	const rule = ruleOrFallback(
		ctx,
		"rm-unchecked",
		"An rm Claude Code cannot check is a permission prompt no allow entry clears",
	);
	const text = `Refused once: Claude Code's built-in removal check would prompt on this command — ${reason}. Re-send it unchanged and it goes through to that check.\n\n${rule}`;
	/* No segment: the reason already quotes the target that tripped the check. */
	return denyText(ctx, "", text);
}

module.exports = { decide };
