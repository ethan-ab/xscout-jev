import { describe, expect, it } from "vitest";
import { computeHeat } from "../src/heat";
import { loadScout } from "../src/profile";

const scout = loadScout("profiles/ai-apps.yaml");

const H = 3600;
describe("computeHeat", () => {
  // Timeline of a real launch: three official accounts within an hour, then coverage.
  const muse = [
    { author: "finkd", createdUtc: 1000 },
    { author: "Muse", createdUtc: 1000 + 46 * 60 },
    { author: "alexandr_wang", createdUtc: 1000 + 55 * 60 },
    { author: "testingcatalog", createdUtc: 1000 + 5 * H },
    { author: "musegramlol", createdUtc: 1000 + 18 * H },
  ];
  it("counts primary accounts, amplifiers and the 6h burst as of a given time", () => {
    expect(computeHeat(scout, muse, 1000 + H)).toMatchObject({ accounts: 3, burst6h: 3, primary: 3, amplifiers: 0, ageHours: 1 });
    expect(computeHeat(scout, muse, 1000 + 20 * H)).toMatchObject({ accounts: 5, burst6h: 4, primary: 3, amplifiers: 1 });
  });
  it("computes velocity only from observed engagement", () => {
    expect(computeHeat(scout, muse, 1000 + H).velocity).toBeNull();
    expect(computeHeat(scout, [{ author: "a", createdUtc: 0, engagement: 900 }], 3 * H).velocity).toBe(300);
  });
});
