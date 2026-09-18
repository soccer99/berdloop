import { describe, expect, test } from "bun:test";
import { legacyPrompts } from "./task-storage";

describe("legacyPrompts", () => {
  test("reads the prompts an older build kept", () => {
    expect(legacyPrompts('{"a":"Do the thing"}')).toEqual({
      a: "Do the thing",
    });
  });

  test("ignores storage that is missing, damaged or the wrong shape", () => {
    expect(legacyPrompts(null)).toEqual({});
    expect(legacyPrompts("not json")).toEqual({});
    expect(legacyPrompts("null")).toEqual({});
    expect(legacyPrompts("[1,2]")).toEqual({});
    expect(legacyPrompts('{"a":7,"b":"kept"}')).toEqual({ b: "kept" });
  });
});
