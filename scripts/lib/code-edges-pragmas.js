const LOADS_BODY = String.raw`code-edges loads: (\S+)(?: (\w+))?`;
const CALLER_BODY = String.raw`code-edges caller: (\w+(?:[ \t]+\w+)*)`;

/** @param {string} marker @param {string} body */
const pragmaLine = (marker, body) =>
	new RegExp(String.raw`^[ \t]*(?:${marker})[ \t]*${body}[ \t]*$`, "gm");

module.exports = { CALLER_BODY, LOADS_BODY, pragmaLine };
