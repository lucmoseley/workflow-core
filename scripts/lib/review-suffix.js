/** @param {string} s */
const segment = (s) => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** @param {string} sid */
const reviewSuffix = (sid) => `-${segment(sid).slice(0, 8)}`;

module.exports = { reviewSuffix, segment };
