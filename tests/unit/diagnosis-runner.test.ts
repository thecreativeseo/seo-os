import { describe, expect, it } from "vitest";

import { diagnosisRunPayload } from "@/server/jobs/definitions";
import { JOB_NAMES } from "@/server/jobs/queue";
import { resolveDiagnosisRunner } from "@/server/services/diagnosis-runner";

describe("choosing where a diagnosis runs", () => {
  it("runs inline unless told otherwise, so a laptop with no worker still works", () => {
    expect(resolveDiagnosisRunner(undefined)).toBe("inline");
    expect(resolveDiagnosisRunner("")).toBe("inline");
    expect(resolveDiagnosisRunner("inline")).toBe("inline");
  });

  it("accepts queue in any spelling of case and whitespace", () => {
    expect(resolveDiagnosisRunner("queue")).toBe("queue");
    expect(resolveDiagnosisRunner(" QUEUE ")).toBe("queue");
  });

  it("refuses a value it does not know rather than guessing", () => {
    expect(() => resolveDiagnosisRunner("worker")).toThrow(/DIAGNOSIS_RUNNER/);
    expect(() => resolveDiagnosisRunner("true")).toThrow(/DIAGNOSIS_RUNNER/);
  });
});

describe("the diagnosis job payload", () => {
  it("is two uuids and nothing else of consequence", () => {
    expect(
      diagnosisRunPayload.safeParse({
        websiteId: "0b1f3f4e-8f7a-4f0e-9d3b-2c2f9a1e5b77",
        requestId: "6d0c4c1a-2c7e-4b7a-9d3b-2c2f9a1e5b77",
      }).success,
    ).toBe(true);
    expect(diagnosisRunPayload.safeParse({ websiteId: "x", requestId: "y" }).success).toBe(false);
    expect(diagnosisRunPayload.safeParse({}).success).toBe(false);
  });

  it("has a queue of its own", () => {
    expect(JOB_NAMES.DIAGNOSIS_RUN).toBe("diagnosis.run");
  });
});
