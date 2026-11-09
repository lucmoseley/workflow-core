/*
 * local-date.js — a time's machine-local calendar date, in a module of its own
 * so the pure overflow budget core and the refill loop, panel and tick take it
 * without loading the morning-review builder (#4491).
 */

/** @param {Date} d @returns {string} its machine-local `YYYY-MM-DD` */
const localDate = (d) =>
	[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-");

module.exports = { localDate };
