const { escapeRe } = require("./regex-group.js");

/**
 * @param {string} name
 * @param {string} fence
 */
const copyBlockPattern = (name, fence) => {
	const n = escapeRe(name);
	const open = escapeRe(fence);
	const close = fence.replace(/[^`]/g, "");
	return new RegExp(
		`<!-- BEGIN ${n} -->\\n${open}\\n([\\s\\S]*?)\\n${close}\\n<!-- END ${n} -->`,
	);
};

module.exports = { copyBlockPattern };
