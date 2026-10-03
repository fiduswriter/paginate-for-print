const fs = require("fs");
const { TestEnvironment } = require("jest-environment-node");
const { chromium } = require("playwright-core");
const { WS_ENDPOINT_PATH, DEBUG, ORIGIN, PDF_SETTINGS } = require("./constants.cjs");

class PuppeteerEnvironment extends TestEnvironment {
	constructor(config) {
		super(config);
	}

	async setup() {
		DEBUG && console.log("Setup Test Environment.");
		await super.setup();
		const wsEndpoint = fs.readFileSync(WS_ENDPOINT_PATH, "utf8");
		if (!wsEndpoint) {
			throw new Error("wsEndpoint not found");
		}
		this.global.browser = await chromium.connect(wsEndpoint);

		this.global.loadPage = this.loadPage.bind(this);

		this.global.ORIGIN = ORIGIN;
		this.global.DEBUG = DEBUG;
		this.global.PDF_SETTINGS = PDF_SETTINGS;
	}

	async teardown() {
		DEBUG && console.log("Teardown Test Environment.");
		await super.teardown();
	}

	runScript(script) {
		return super.runScript(script);
	}

	handleError(error) {
		console.error(error);
	}

	async loadPage(path) {
		let page = await this.global.browser.newPage();
		let renderedResolve, renderedReject;
		page.rendered = new Promise(function(resolve, reject) {
			renderedResolve = resolve;
			renderedReject = reject;
		});

		page.on("pageerror", (error) => {
			this.handleError(error);
			renderedReject(error);
		});

		page.on("error", (error) => {
			this.handleError(error);
			renderedReject(error);
		});

		page.on("requestfailed", (error) => {
			console.error(
				"REQFAIL",
				error.url(),
				error.failure() && error.failure().errorText,
			);
			this.handleError(error);
			renderedReject(error);
		});

		page.on("console", async (msg) => {
			const args = [];
			for (let i = 0; i < msg.args().length; ++i) {
				args.push(await msg.args()[i].jsonValue());
			}
			if (args.length > 0) {
				// preprend the path
				args[0] = `${path}: ${args[0]}`;
			}
			const type = msg.type();
			let log;
			if (type === "warning") {
				log = console.warn;
			} else if (type === "error") {
				log = console.error;
			} else {
				log = console.log;
			}
			log.apply(this, args);
		});

		await page.exposeFunction("onRendered", (msg, width, height, orientation) => {
			renderedResolve(msg, width, height, orientation);
		});

		await page.addInitScript(() => {
			document.addEventListener("DOMContentLoaded", () => {
				window.PagedPolyfill.on("rendered", (flow) => {
					let msg = "Rendering " + flow.total + " pages took " + flow.performance + " milliseconds.";
					window.onRendered(msg, flow.width, flow.height, flow.orientation);
				});
			});
		});

		await page.goto(ORIGIN + "/specs/" + path, { waitUntil: "networkidle" });

		return page;
	}
}

module.exports = PuppeteerEnvironment;
