/*
 * JavaScript source with its comments removed, for the lexical checks that
 * must not count a header's mention of `process.argv` or `ctx.has("--x")` as
 * a read.
 *
 * A string literal is kept, so a `/*` or `//` inside it opens no comment. A
 * regex literal holding a quote can still mislead it.
 */

const STRING_OR_COMMENT =
	/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** @param {string} source */
const stripComments = (source) =>
	source.replace(STRING_OR_COMMENT, (_, literal) => literal ?? "");

module.exports = { stripComments };
