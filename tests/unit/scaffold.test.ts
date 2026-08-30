import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("M1 scaffold", () => {
  it("resolves the @/* path alias", () => {
    expect(typeof cn).toBe("function");
  });

  it("merges class names deterministically", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
