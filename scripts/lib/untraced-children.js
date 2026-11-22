// #4982
function untraceChildren() {
	process.env.WFC_READ_AUDIT_UNTRACED = "1";
}

module.exports = { untraceChildren };
