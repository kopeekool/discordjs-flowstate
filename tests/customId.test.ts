import { describe, expect, it } from "vitest";

import {
  decodeCustomId,
  encodeCustomId,
  isFlowstateCustomId,
} from "../src/utils/customId.js";

describe("customId encoding", () => {
  it("roundtrips a customId", () => {
    const encoded = encodeCustomId("onboarding", "abc123", "next");
    expect(encoded).toBe("fs|onboarding|abc123|next");
    const decoded = decodeCustomId(encoded);
    expect(decoded).toEqual({
      flowId: "onboarding",
      executionId: "abc123",
      trigger: "next",
    });
  });

  it("returns null for unrelated customIds", () => {
    expect(decodeCustomId("foo")).toBeNull();
    expect(decodeCustomId("fs|too|few")).toBeNull();
    expect(decodeCustomId("other|onboarding|abc|next")).toBeNull();
  });

  it("rejects components containing the separator", () => {
    expect(() => encodeCustomId("a|b", "x", "y")).toThrow(/must not contain/);
    expect(() => encodeCustomId("a", "x|y", "z")).toThrow(/must not contain/);
  });

  it("rejects ids exceeding the 100-character limit", () => {
    const long = "x".repeat(120);
    expect(() => encodeCustomId(long, "exec", "trigger")).toThrow(
      /exceeds Discord's 100-character limit/,
    );
  });

  it("isFlowstateCustomId fast-path", () => {
    expect(isFlowstateCustomId("fs|x|y|z")).toBe(true);
    expect(isFlowstateCustomId("anything-else")).toBe(false);
  });
});
