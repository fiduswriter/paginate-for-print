export default {
	testMatch: ["**/?(*.)(test).js"],
	testEnvironment: "jsdom",
	transform: {
		"\\.(js|ts)$": ["babel-jest", { configFile: "./babel-jest.config.json" }]
	},
	moduleNameMapper: {
		"^(\\.{1,2}/.*)\\.js$": "$1",
		"^@chenglou/pretext$":
			"<rootDir>/src/utils/__mocks__/pretext-stub.cjs",
		"^@chenglou/pretext/rich-inline$":
			"<rootDir>/src/utils/__mocks__/pretext-rich-inline-stub.cjs"
	}
};
