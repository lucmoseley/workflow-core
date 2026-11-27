const { readBodyFile } = require("./body-file.js");

function buildHostPorts() {
	return { readFile: readBodyFile };
}

module.exports = { buildHostPorts };
