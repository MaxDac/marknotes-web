import { describe, expect, it } from "vitest";
import { merge, renderMerge } from "../js/merge";
describe("Android-compatible line merge", () => {
  it("merges non-overlapping changes", () => {
    const chunks = merge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    expect(chunks.some((c) => c.conflict)).toBe(false);
    expect(renderMerge(chunks, [])).toBe("A\nb\nC\n");
  });
  it("preserves line endings, empty content and missing final newline", () => {
    expect(
      renderMerge(
        merge("a\r\nmiddle\r\nb", "A\r\nmiddle\r\nb", "a\r\nmiddle\r\nB"),
        [],
      ),
    ).toBe("A\r\nmiddle\r\nB");
    expect(merge("a\r\nb", "A\r\nb", "a\r\nB").some((c) => c.conflict)).toBe(
      true,
    );
    expect(renderMerge(merge("", "", ""), [])).toBe("");
  });
  it("supports hunk-level mine, theirs, both and neither in order", () => {
    const chunks = merge("a\nb\nc\n", "a\nmine\nc\n", "a\ntheirs\nc\n");
    expect(chunks.filter((c) => c.conflict)).toHaveLength(1);
    expect(renderMerge(chunks, ["mine"])).toBe("a\nmine\nc\n");
    expect(renderMerge(chunks, ["theirs"])).toBe("a\ntheirs\nc\n");
    expect(renderMerge(chunks, ["both"])).toBe("a\nmine\ntheirs\nc\n");
    expect(renderMerge(chunks, ["neither"])).toBe("a\nc\n");
    expect(() => renderMerge(chunks, [])).toThrow("every conflicting");
  });
  it("never auto-resolves differences without a common ancestor", () => {
    const chunks = merge(null, "same\nonly mine\n", "same\n");
    expect(chunks.some((c) => c.conflict)).toBe(true);
    expect(renderMerge(chunks, ["theirs"])).toBe("same\n");
  });
  it("resolves identical edits and handles multiple conflict regions", () => {
    expect(renderMerge(merge("old", "new", "new"), [])).toBe("new");
    expect(
      renderMerge(
        merge("a\nb\nc\nd\ne\n", "A1\nb\nc\nd\nE1\n", "A2\nb\nc\nd\nE2\n"),
        ["mine", "theirs"],
      ),
    ).toBe("A1\nb\nc\nd\nE2\n");
    expect(renderMerge(merge("x", "local", "remote"), ["both"])).toBe(
      "local\nremote",
    );
  });
  it("bounds pathological edit distance while retaining common ends", () => {
    const a = Array.from({ length: 1200 }, (_, i) => `a${i}\n`).join("");
    const b = Array.from({ length: 1200 }, (_, i) => `b${i}\n`).join("");
    expect(renderMerge(merge(null, a, b), ["mine"])).toBe(a);
  });
});
