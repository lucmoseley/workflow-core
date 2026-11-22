const { readBodyFile } = require("./body-file.js");
const os = require("node:os");

/** @returns {import("./review-comment.js").ReviewCommentPorts} */
const buildHostPorts = () => ({
	home: os.homedir(),
	readFile: readBodyFile,
});

module.exports = { buildHostPorts };
