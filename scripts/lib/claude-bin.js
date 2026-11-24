/** @param {NodeJS.ProcessEnv} [env] */
const claudeBin = (env = process.env) => env.WFC_CLAUDE_BIN || "claude";

module.exports = { claudeBin };
