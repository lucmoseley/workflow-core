const REAL_PROC = "/proc";

const procRoot = () => process.env.WFC_PROC || REAL_PROC;

const meminfoPath = () => process.env.WFC_MEMINFO || `${REAL_PROC}/meminfo`;

module.exports = { procRoot, REAL_PROC, meminfoPath };
