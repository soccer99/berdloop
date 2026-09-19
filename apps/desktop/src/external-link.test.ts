import { describe, expect, mock, test } from "bun:test";

/**
 * One markup, two builds. A link to a pull request has to reach the person's
 * own browser from the Tauri window, and must not be interfered with in a
 * plain browser, where the anchor already does the right thing.
 */
const opened: string[] = [];
let tauri = false;

/**
 * `mock.module` replaces the module for the whole run, not just this file, so
 * the stand-in has to carry the rest of `core` with it. Most of the app imports
 * `invoke` from here, and a namespace without it cannot be linked: leaving it
 * out failed whichever unrelated files bun happened to load after this one.
 * `tauri` is false by the time they do, which is what the real `isTauri` says
 * outside a Tauri window anyway.
 */
const core = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({ ...core, isTauri: () => tauri }));
mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    opened.push(url);
  },
}));

const { openExternally } = await import("./external-link");

/** Enough of a click for the handler: where it points, and whether it was stopped. */
function click(href: string) {
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
    currentTarget: { href },
  };
  openExternally(event as never);
  return prevented;
}

describe("an external link", () => {
  test("is handed to the operating system inside the Tauri window", () => {
    tauri = true;
    opened.length = 0;
    expect(click("https://github.com/o/r/pull/7")).toBe(true);
    expect(opened).toEqual(["https://github.com/o/r/pull/7"]);
  });

  test("is left to the browser everywhere else", () => {
    tauri = false;
    opened.length = 0;
    expect(click("https://github.com/o/r/pull/7")).toBe(false);
    expect(opened).toEqual([]);
  });
});
