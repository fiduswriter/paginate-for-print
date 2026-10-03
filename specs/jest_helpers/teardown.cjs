const { rimrafSync } = require("rimraf");
const { DIR, DEBUG } = require("./constants.cjs");

module.exports = async function() {
	DEBUG && console.log("Teardown Browser");
	if (!DEBUG) {
		await global.browser.close();
		global.server.close();
	}
	rimrafSync(DIR);
};
