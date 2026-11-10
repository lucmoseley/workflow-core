/*
 * shell-script-lexer.js — a whole shell script cut into its simple commands,
 * for lib/code-edges.js's shell reach (#4790): each command's words as
 * written, with their offsets, redirections left out; the commands inside
 * `$(…)`, backticks and `<(…)` as commands of their own; an array's literal
 * elements as a command marked `array`. Comments, heredoc bodies, `case`
 * patterns and `((…))` arithmetic are no commands, and `[[ … ]]` holds its
 * operators as words.
 *
 * Not lib/shell-parse.js, the guard parser: that reads one Bash tool command,
 * fails open on what it cannot read and joins lines around `git` and `gh`;
 * this reads a file, and its caller fails closed on what it cannot.
 *
 * A CORE: it does no I/O and never runs the text.
 */

/**
 * @typedef {{text: string, at: number}} ShWord a word as written, and its
 *   offset in the script
 * @typedef {{words: ShWord[], prev: ShCommand | null, joined: string,
 *   array: boolean}} ShCommand a simple command's words, with the command
 *   before it on its list and the operator joining the two; or an array's
 *   elements, which run only where the array does
 * @typedef {{command: ShCommand, depth: number, cases: number,
 *   pattern: boolean, test: boolean}} ShList one list's state: its open
 *   command, `(` depth and open `case`s; `pattern` inside a `case` before a
 *   pattern's `)`, `test` inside `[[ … ]]`
 */

/* Where a command ends, `(` and `)` aside. */
const SH_OPERATOR = /&&|\|\||;;&?|;&|\|&|[;&|]/y;
/* A redirection's operator; a heredoc's is group 1. */
const SH_REDIRECT = /\d*(?:(<<-?)(?!<)|&>>?|<<<|<>|>>|>&|<&|>\||[<>])(?!\()/y;
/* The gap before a redirection's target. */
const SH_BLANKS = /[ \t]*/y;
/* A word that only opens or closes a compound command, or negates one, so the
 * command proper starts after it. */
const SH_RESERVED = new Set([
	"!",
	"{",
	"}",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"time",
	"esac",
]);
/* A variable's assignment: the name, an element's index, then the value
 * from `=` on. */
const SH_ASSIGN = /^([A-Za-z_]\w*)(\[[^\]]*\])?\+?=/;
/* An array's assignment up to its `(`. */
const SH_ARRAY_OPEN = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=$/;

/** @returns {ShCommand} */
const emptyCommand = (/** @type {ShCommand | null} */ prev, joined = "") => ({
	words: [],
	prev,
	joined,
	array: false,
});

/** A script's commands, read left to right from the cursor `i`. */
class ShLexer {
	/** @param {string} code */
	constructor(code) {
		this.code = code;
		this.i = 0;
		/** @type {ShCommand[]} */
		this.commands = [];
		/** @type {{delimiter: string, strip: boolean}[]} */
		this.heredocs = [];
		/** @type {RegExpExecArray | null} */
		this.lastMatch = null;
	}

	/**
	 * Reads commands on to `closer` at the list's own depth, or the end.
	 * @param {string | null} closer
	 */
	list(closer) {
		/** @type {ShList} */
		const state = {
			command: emptyCommand(null),
			depth: 0,
			cases: 0,
			pattern: false,
			test: false,
		};
		while (this.i < this.code.length) {
			const c = this.code.charAt(this.i);
			if (c === ")" && closer === ")" && state.depth === 0 && !state.pattern) {
				this.i++;
				break;
			}
			this.step(state, c);
		}
		this.end(state, "");
	}

	/**
	 * Reads one token at the cursor into `state`.
	 * @param {ShList} state accumulator: the token's effect on the list
	 * @param {string} c the character at the cursor
	 */
	step(state, c) {
		if (c === " " || c === "\t" || c === "\r") this.i++;
		else if (this.code.startsWith("\\\n", this.i)) this.i += 2;
		else if (c === "\n") this.newline(state);
		else if (c === "#") this.toLineEnd();
		else this.token(state, c);
	}

	/**
	 * Reads one operator, redirection or word at the cursor into `state`.
	 * @param {ShList} state accumulator: the token's effect on the list
	 * @param {string} c the character at the cursor
	 */
	token(state, c) {
		if (state.test && /[()<>&|]/.test(c)) this.testOperator(state);
		else if (this.code.startsWith("((", this.i) && isCommandStart(state))
			this.balanced();
		else if (state.pattern && "|()".includes(c)) this.patternEnd(state, c);
		else if (c === "(" || c === ")") this.paren(state, c);
		else if (this.sticky(SH_REDIRECT)) this.redirect();
		else if (this.sticky(SH_OPERATOR)) this.operator(state);
		else this.addWord(state);
	}

	/** @param {ShList} state accumulator: the command ends; `;;` opens a
	 * `case` pattern */
	operator(state) {
		const op = this.lastMatch?.[0] ?? "";
		this.end(state, op);
		state.pattern = state.cases > 0 && /^;[;&]/.test(op);
	}

	/**
	 * Ends the open command, if it holds a word, and opens the next.
	 * @param {ShList} state accumulator: its command is replaced
	 * @param {string} joined the operator ending it
	 */
	end(state, joined) {
		const { command } = state;
		if (command.words.length > 0) this.commands.push(command);
		state.command = emptyCommand(
			command.words.length > 0 ? command : null,
			joined,
		);
	}

	/** @param {ShList} state accumulator: a line inside `[[ … ]]` goes on */
	newline(state) {
		this.i++;
		if (state.test) return;
		this.end(state, "\n");
		this.skipHeredocs();
	}

	toLineEnd() {
		const eol = this.code.indexOf("\n", this.i);
		this.i = eol === -1 ? this.code.length : eol;
	}

	/** @param {ShList} state accumulator: the operator is a word of the test */
	testOperator(state) {
		const run = this.code.slice(this.i).match(/^[()<>&|]+/)?.[0] ?? "";
		state.command.words.push({ text: run, at: this.i });
		this.i += run.length;
	}

	/**
	 * A `|`, `(` or `)` in a `case` pattern: its `)` ends the pattern, whose
	 * words are no command.
	 * @param {ShList} state accumulator: leaves the pattern at its `)`
	 * @param {string} c
	 */
	patternEnd(state, c) {
		if (c === ")") {
			state.command.words = [];
			state.pattern = false;
		}
		this.i++;
	}

	/**
	 * A subshell's bracket, or `name()`, which defines a function: its name is
	 * no command.
	 * @param {ShList} state accumulator: its depth and command
	 * @param {string} c
	 */
	paren(state, c) {
		const definition = /^\(\s*\)/.exec(this.code.slice(this.i, this.i + 8));
		if (c === "(" && state.command.words.length === 1 && definition) {
			state.command.words = [];
			this.i += definition[0].length;
			return;
		}
		if (c === "(") state.depth++;
		else if (state.depth > 0) state.depth--;
		this.end(state, c);
		this.i++;
	}

	/** A redirection's target, which is no word of the command; a heredoc's
	 * delimiter is kept until its line ends. */
	redirect() {
		const heredoc = this.lastMatch?.[1];
		this.sticky(SH_BLANKS);
		const target = this.word();
		if (heredoc !== undefined && target !== null)
			this.heredocs.push({
				delimiter: target.text.replace(/^["']|["']$/g, ""),
				strip: heredoc === "<<-",
			});
	}

	/** @param {ShList} state accumulator: the command gains the word */
	addWord(state) {
		const word = this.word();
		if (word === null) {
			this.i++;
			return;
		}
		if (state.pattern && word.text === "esac") {
			state.cases--;
			state.pattern = false;
			return;
		}
		if (word.text === "[[") state.test = true;
		if (word.text === "]]") state.test = false;
		state.command.words.push(word);
		if (state.command.words[0]?.text === "case" && word.text === "in") {
			state.cases++;
			state.pattern = true;
			this.end(state, "");
		}
	}

	/**
	 * Matches sticky `re` at the cursor, moving past a non-empty match.
	 * @param {RegExp} re accumulator: its lastIndex moves
	 */
	sticky(re) {
		re.lastIndex = this.i;
		this.lastMatch = re.exec(this.code);
		if (this.lastMatch === null || this.lastMatch[0] === "") return false;
		this.i = re.lastIndex;
		return true;
	}

	/** Moves past the bodies of the heredocs the line just ended opened. */
	skipHeredocs() {
		for (const { delimiter, strip } of this.heredocs) {
			let line = null;
			while (this.i < this.code.length && line !== delimiter) {
				const eol = this.code.indexOf("\n", this.i);
				const stop = eol === -1 ? this.code.length : eol;
				const raw = this.code.slice(this.i, stop);
				line = strip ? raw.replace(/^\t+/, "") : raw;
				this.i = stop + 1;
			}
		}
		this.heredocs = [];
	}

	/**
	 * One word at the cursor: quoted runs, substitutions read as commands of
	 * their own, escapes and bare characters.
	 * @returns {ShWord | null}
	 */
	word() {
		const { code } = this;
		const at = this.i;
		while (this.i < code.length) {
			const c = code.charAt(this.i);
			if ("<>".includes(c) && code.charAt(this.i + 1) === "(") {
				this.i += 2;
				this.list(")");
			} else if (c === "(" && SH_ARRAY_OPEN.test(code.slice(at, this.i)))
				this.elements();
			else if (/[\s;&|()<>]/.test(c)) break;
			else this.part();
		}
		return this.i > at ? { text: code.slice(at, this.i), at } : null;
	}

	/** One quoted run, substitution, escape or character. */
	part() {
		const { code } = this;
		const c = code.charAt(this.i);
		if (c === "'") this.i = this.closing("'", this.i + 1);
		else if (code.startsWith("$'", this.i)) this.ansiQuote();
		else if (c === '"') this.enclosed('"');
		else if (c === "\\") this.i += 2;
		else if (c === "`") this.backtick();
		else if (code.startsWith("$((", this.i)) {
			this.i++;
			this.balanced();
		} else if (code.startsWith("$(", this.i)) {
			this.i += 2;
			this.list(")");
		} else if (code.startsWith("${", this.i)) {
			this.i++;
			this.enclosed("}");
		} else this.i++;
	}

	/**
	 * A `"…"` or `${…}` at the cursor, the substitutions and quotes inside it
	 * read as they open.
	 * @param {string} close
	 */
	enclosed(close) {
		this.i++;
		while (this.i < this.code.length && this.code.charAt(this.i) !== close) {
			const d = this.code.charAt(this.i);
			if (d === "\\") this.i += 2;
			else if (d === "$" || d === "`" || (close === "}" && "'\"".includes(d)))
				this.part();
			else this.i++;
		}
		this.i++;
	}

	/**
	 * The offset after the next `quote` from `from`, or the end.
	 * @param {string} quote
	 * @param {number} from
	 */
	closing(quote, from) {
		const at = this.code.indexOf(quote, from);
		return at === -1 ? this.code.length : at + 1;
	}

	/** A `$'…'` run, whose backslash escapes a quote. */
	ansiQuote() {
		this.i += 2;
		while (this.i < this.code.length && this.code.charAt(this.i) !== "'")
			this.i += this.code.charAt(this.i) === "\\" ? 2 : 1;
		this.i++;
	}

	/** A backtick substitution, its body read as commands at their offsets. */
	backtick() {
		let end = this.i + 1;
		while (end < this.code.length && this.code.charAt(end) !== "`")
			end += this.code.charAt(end) === "\\" ? 2 : 1;
		const inner = new ShLexer(this.code.slice(0, end));
		inner.i = this.i + 1;
		inner.list(null);
		this.commands.push(...inner.commands);
		this.i = end + 1;
	}

	/** An array's elements at its `(`, read as a command of their own. */
	elements() {
		/** @type {ShWord[]} */
		const words = [];
		this.i++;
		while (this.i < this.code.length && this.code.charAt(this.i) !== ")") {
			const c = this.code.charAt(this.i);
			if (/\s|\\/.test(c)) this.i++;
			else if (c === "#") this.toLineEnd();
			else {
				const word = this.word();
				if (word === null) this.i++;
				else words.push(word);
			}
		}
		this.i++;
		if (words.length > 0)
			this.commands.push({ words, prev: null, joined: "", array: true });
	}

	/** A parenthesised run at the cursor that holds no command: arithmetic,
	 * its quotes read whole. */
	balanced() {
		let depth = 0;
		do {
			const c = this.code.charAt(this.i);
			if (c === "(") depth++;
			else if (c === ")") depth--;
			if ("'\"\\".includes(c)) this.part();
			else this.i++;
		} while (depth > 0 && this.i < this.code.length);
	}
}

/**
 * Whether the list's open command holds no word but reserved ones, so a `((`
 * opens arithmetic.
 * @param {ShList} state
 */
const isCommandStart = (state) =>
	state.command.words.every((w) => SH_RESERVED.has(w.text));

/**
 * The simple commands of a shell script, in the order they are written.
 * @param {string} code
 * @returns {ShCommand[]}
 */
function shCommands(code) {
	const lexer = new ShLexer(code);
	lexer.list(null);
	return lexer.commands.sort(
		(a, b) => (a.words[0]?.at ?? 0) - (b.words[0]?.at ?? 0),
	);
}

/**
 * The commands of the `$(…)` that opens `text`, not those of a substitution
 * inside one of their words, and the offset after its `)`.
 * @param {string} text starting `$(`
 * @returns {{commands: ShCommand[], end: number}}
 */
function substitutionAt(text) {
	const lexer = new ShLexer(text);
	lexer.i = 2;
	lexer.list(")");
	const words = lexer.commands.flatMap((c) => c.words);
	const isInside = (/** @type {ShCommand} */ c) => {
		const at = c.words[0]?.at ?? 0;
		return words.some((w) => w.at < at && at < w.at + w.text.length);
	};
	return {
		commands: lexer.commands.filter((c) => !isInside(c)),
		end: lexer.i,
	};
}

/**
 * The offset after the `${…}` that opens `text`.
 * @param {string} text starting `${`
 */
function braceEnd(text) {
	const lexer = new ShLexer(text);
	lexer.part();
	return lexer.i;
}

module.exports = {
	SH_ASSIGN,
	SH_RESERVED,
	braceEnd,
	shCommands,
	substitutionAt,
};
