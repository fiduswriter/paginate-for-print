import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import typescript from "@rollup/plugin-typescript";
import serve from "rollup-plugin-serve";
import livereload from "rollup-plugin-livereload";

const plugins = [
	typescript({
		tsconfig: "./tsconfig.rollup.json",
		exclude: ["src/**/*.test.ts"],
	}),
	nodeResolve({
		extensions: [".cjs", ".mjs", ".js"],
	}),
	commonjs({
		include: ["node_modules/**"],
	}),
	json(),
	serve({
		port: 9090,
		contentBase: "./",
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Service-Worker-Allowed": "/",
		},
	}),
	livereload({
		watch: ["dist", "examples"],
	}),
];

export default [
	{
		input: "./src/polyfill/polyfill.ts",
		output: {
			sourcemap: true,
			name: "PagedPolyfill",
			file: "./dist/paged.polyfill.js",
			format: "umd",
		},
		plugins: plugins,
	},
];
