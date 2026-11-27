const SCRATCH_DIR = ".claude/tmp/";

/** @param {string} rel */
const isScratch = (rel) => rel.startsWith(SCRATCH_DIR);

module.exports = { SCRATCH_DIR, isScratch };
