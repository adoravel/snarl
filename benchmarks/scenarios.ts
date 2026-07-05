import { echoPayloadJson } from "./fixtures.ts";

export interface Scenario {
	name: string;
	path: string;
	method?: "GET" | "POST";
	body?: string;
	headers?: Record<string, string>;
}

export const scenarios: Scenario[] = [
	{ name: "plain text", path: "/plaintext" },
	{ name: "JSON", path: "/json" },
	{ name: "path params", path: "/user/123/todos/456" },
	{ name: "query params", path: "/search?term=benchmark" },
	{
		name: "JSON body",
		path: "/echo",
		method: "POST",
		body: echoPayloadJson,
		headers: { "content-type": "application/json" },
	},
	{ name: "large payload", path: "/json/large" },
	{ name: "404", path: "/this-route-does-not-exist" },
];
