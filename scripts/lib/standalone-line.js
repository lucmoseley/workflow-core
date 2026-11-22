/** @param {string | null | undefined} body */
const hasStandaloneLine = (body) =>
	/^[^\S\n\r\u2028\u2029]*Standalone:/m.test(body || "");

/** @param {string} why */
const buildStandaloneLine = (why) => `Standalone: ${why}`;

module.exports = { buildStandaloneLine, hasStandaloneLine };
