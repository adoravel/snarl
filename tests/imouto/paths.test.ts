/**
 * snarl, a minimal web framework for deno
 * Copyright (c) 2025-2026 kyu.re
 * SPDX-License-Identifier: MPL-2.0
 */

import { assert, assertEquals } from "@std/assert";
import { makeRoutePath, rateRouteSpecificity } from "../../packages/imouto/src/router/paths.ts";
import { createNode, getSegments, insertRoute, matchRoute } from "@july/snarl";

function match(pattern: string, url: string) {
	const root = createNode("");
	insertRoute(root, pattern, "hit");
	const params: Record<string, string> = {};
	const result = matchRoute(root, getSegments(url, false), 0, params);
	return result ? params : null;
}

Deno.test("imouto paths: file conventions map to snarl patterns", () => {
	assertEquals(makeRoutePath("mod.tsx"), "/");
	assertEquals(makeRoutePath("about.tsx"), "/about");
	assertEquals(makeRoutePath("blog/[id].tsx"), "/blog/:id");
	assertEquals(makeRoutePath("blog/[...slug].tsx"), "/blog/*slug");
	assertEquals(makeRoutePath("[owner]/[repo]/tree/[...rest].tsx"), "/:owner/:repo/tree/*rest");
	assertEquals(makeRoutePath("docs\\[...path].tsx"), "/docs/*path");
});

Deno.test("imouto paths: a catch-all under param segments matches any depth", () => {
	const pattern = makeRoutePath("[owner]/[repo]/tree/[...rest].tsx");

	assertEquals(match(pattern, "/a/b/tree/x"), { owner: "a", repo: "b", rest: "x" });
	assertEquals(match(pattern, "/a/b/tree/x/y/z"), { owner: "a", repo: "b", rest: "x/y/z" });
	assertEquals(match(pattern, "/a/b/tree"), { owner: "a", repo: "b", rest: "" });
	assertEquals(match(pattern, "/a/b/blob/x"), null);
});

Deno.test("imouto paths: [id] beats [...slug] in the same directory", () => {
	const id = makeRoutePath("blog/[id].tsx");
	const slug = makeRoutePath("blog/[...slug].tsx");
	const fixed = makeRoutePath("blog/new.tsx");

	assert(rateRouteSpecificity(id) > rateRouteSpecificity(slug));
	assert(rateRouteSpecificity(fixed) > rateRouteSpecificity(id));
	assertEquals(rateRouteSpecificity(slug), rateRouteSpecificity("/blog"));
});
