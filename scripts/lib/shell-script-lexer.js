/**
 * @typedef {{text: string, at: number}} ShWord
 * @typedef {{words: ShWord[], prev: ShCommand | null, joined: string,
 *   array: boolean}} ShCommand
 * @typedef {{command: ShCommand, depth: number, cases: number,
 *   pattern: boolean, test: boolean}} ShList
 */

const SH_OPERATOR = /&&|\|\||;;&?|;&|\|&|[;&|]/y;
const SH_REDIRECT = /\d*(?:(<<-?)(?!<)|&>>?|<<<|<>|>>|>&|<&|>\||[<>])(?!\()/y;
const SH_BLANKS = /[ \t]*/y;
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
const SH_ASSIGN = /^([A-Za-z_]\w*)(\[[^\]]*\])?\+?=/;
const SH_ARRAY_OPEN = new RegExp(`${SH_ASSIGN.source}$`);
const SH_DEFINITION = /\(\s*\)/y;

/** @returns {ShCommand} */
const emptyCommand = (/** @type {ShCommand | null} */ prev, joined = "") => ({
	words: [],
	prev,
	joined,
	array: false,
});

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
		this.re = {
			operator: new RegExp(SH_OPERATOR),
			redirect: new RegExp(SH_REDIRECT),
			blanks: new RegExp(SH_BLANKS),
			definition: new RegExp(SH_DEFINITION),
		};
	}

	/** @param {string | null} closer */
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

	/** @param {ShList} state @param {string} c */
	step(state, c) {
		if (c === " " || c === "\t" || c === "\r") this.i++;
		else if (this.code.startsWith("\\\n", this.i)) this.i += 2;
		else if (c === "\n") this.newline(state);
		else if (c === "#") this.toLineEnd();
		else this.token(state, c);
	}

	/** @param {ShList} state @param {string} c */
	token(state, c) {
		if (state.test && /[()<>&|]/.test(c)) this.testOperator(state);
		else if (this.code.startsWith("((", this.i) && isCommandStart(state))
			this.balanced();
		else if (state.pattern && "|()".includes(c)) this.patternEnd(state, c);
		else if (c === "(" || c === ")") this.paren(state, c);
		else if (this.sticky(this.re.redirect)) this.redirect();
		else if (this.sticky(this.re.operator)) this.operator(state);
		else this.addWord(state);
	}

	/** @param {ShList} state */
	operator(state) {
		const op = this.lastMatch?.[0] ?? "";
		this.end(state, op);
		state.pattern = state.cases > 0 && /^;[;&]/.test(op);
	}

	/** @param {ShList} state @param {string} joined */
	end(state, joined) {
		const { command } = state;
		if (command.words.length > 0) this.commands.push(command);
		state.command = emptyCommand(
			command.words.length > 0 ? command : null,
			joined,
		);
	}

	/** @param {ShList} state */
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

	/** @param {ShList} state */
	testOperator(state) {
		const run = this.code.slice(this.i).match(/^[()<>&|]+/)?.[0] ?? "";
		state.command.words.push({ text: run, at: this.i });
		this.i += run.length;
	}

	/** @param {ShList} state @param {string} c */
	patternEnd(state, c) {
		if (c === ")") {
			state.command.words = [];
			state.pattern = false;
		}
		this.i++;
	}

	/** @param {ShList} state @param {string} c */
	paren(state, c) {
		if (
			c === "(" &&
			state.command.words.length === 1 &&
			this.sticky(this.re.definition)
		) {
			state.command.words = [];
			return;
		}
		if (c === "(") state.depth++;
		else if (state.depth > 0) state.depth--;
		this.end(state, c);
		this.i++;
	}

	redirect() {
		const heredoc = this.lastMatch?.[1];
		this.sticky(this.re.blanks);
		const target = this.word();
		if (heredoc !== undefined && target !== null)
			this.heredocs.push({
				delimiter: target.text.replace(/^["']|["']$/g, ""),
				strip: heredoc === "<<-",
			});
	}

	/** @param {ShList} state */
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

	/** @param {RegExp} re */
	sticky(re) {
		re.lastIndex = this.i;
		this.lastMatch = re.exec(this.code);
		if (this.lastMatch === null || this.lastMatch[0] === "") return false;
		this.i = re.lastIndex;
		return true;
	}

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

	/** @returns {ShWord | null} */
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

	/** @param {string} close */
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

	/** @param {string} quote @param {number} from */
	closing(quote, from) {
		const at = this.code.indexOf(quote, from);
		return at === -1 ? this.code.length : at + 1;
	}

	ansiQuote() {
		this.i += 2;
		while (this.i < this.code.length && this.code.charAt(this.i) !== "'")
			this.i += this.code.charAt(this.i) === "\\" ? 2 : 1;
		this.i++;
	}

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

/** @param {ShList} state */
const isCommandStart = (state) =>
	state.command.words.every((w) => SH_RESERVED.has(w.text));

/** @param {string} code @returns {ShCommand[]} */
function shCommands(code) {
	const lexer = new ShLexer(code);
	lexer.list(null);
	return lexer.commands.sort(
		(a, b) => (a.words[0]?.at ?? 0) - (b.words[0]?.at ?? 0),
	);
}

/** @param {string} text @returns {{commands: ShCommand[], end: number}} */
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

/** @param {string} text */
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
