export default {
	testMatch: ["**/?(*.)(spec).js?(x)"],
	globalSetup: "./jest_helpers/setup.cjs",
	globalTeardown: "./jest_helpers/teardown.cjs",
	testEnvironment: "./jest_helpers/puppeteer_environment.cjs",
	setupFilesAfterEnv: ["./jest_helpers/setup_tests.cjs"],
	transform: {
		"\\.(js|ts)$": ["babel-jest", { configFile: "./babel-jest.config.json" }]
	},
	moduleNameMapper: {
		"^(\\.{1,2}/.*)\\.js$": "$1"
	}
};
