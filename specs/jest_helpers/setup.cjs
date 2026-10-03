const fs = require("fs");
const path = require("path");
const express = require("express");
const { chromium } = require("playwright-core");
const { DIR, WS_ENDPOINT_PATH, DEBUG, PORT, CI } = require("./constants.cjs");

const app = express();

module.exports = async function() {
	DEBUG && console.log("Starting Static Server\n");
	app.use(express.static(path.join(__dirname, "../../")));
	const server = app.listen(PORT);
	global.server = server;
	global.origin = `http://localhost:${PORT}`;

	DEBUG && console.log("Setup Browser");
	let args = CI ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : ["--disable-dev-shm-usage"];
	const browser = await chromium.launchServer({
		headless: !DEBUG,
		args: args
	});
	global.browser = browser;
	fs.mkdirSync(DIR, { recursive: true });
	fs.writeFileSync(WS_ENDPOINT_PATH, browser.wsEndpoint());
};
