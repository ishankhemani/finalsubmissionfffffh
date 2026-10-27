/**
 * procurementCalcs.test.js — Unit tests for procurement utility functions.
 *
 * Run with: cd frontend && npm test -- --watchAll=false
 */
import {
  calcResidual,
  calcRequirement,
  calcSurplus,
  calcMWh,
  applyBiasCorrection,
  processProcurementPlan,
  applyScenarioOffset,
  parseDemandCSV,
} from "./procurementCalcs";

// ── calcResidual ──────────────────────────────────────────────────────────────

describe("calcResidual", () => {
  test("basic: demand - wind - other", () => {
    expect(calcResidual(10000, 5000, 1000)).toBeCloseTo(4000);
  });

  test("residual is negative when generation exceeds demand", () => {
    expect(calcResidual(3000, 4000, 0)).toBeCloseTo(-1000);
  });

  test("missing demand returns null", () => {
    expect(calcResidual(null, 5000, 0)).toBeNull();
    expect(calcResidual(undefined, 5000, 0)).toBeNull();
    expect(calcResidual(NaN, 5000, 0)).toBeNull();
  });

  test("missing wind is unknown (null), NOT treated as zero", () => {
    expect(calcResidual(10000, null, 1000)).toBeNull();
    expect(calcResidual(10000, undefined, 1000)).toBeNull();
    expect(calcResidual(10000, NaN, 1000)).toBeNull();
  });

  test("missing other treated as zero", () => {
    expect(calcResidual(10000, 5000, null)).toBeCloseTo(5000);
  });

  test("wind present, other missing → residual uses other = 0", () => {
    expect(calcResidual(7500, 2500, null)).toBeCloseTo(5000);
  });

  test("demand and other generation accounted for correctly", () => {
    expect(calcResidual(8000, 3000, 2000)).toBeCloseTo(3000);
  });
});

// ── calcRequirement ───────────────────────────────────────────────────────────

describe("calcRequirement", () => {
  test("positive residual returns that value", () => {
    expect(calcRequirement(4000)).toBeCloseTo(4000);
  });

  test("negative residual (surplus scenario) returns 0", () => {
    expect(calcRequirement(-1000)).toBeCloseTo(0);
  });

  test("zero residual returns 0", () => {
    expect(calcRequirement(0)).toBeCloseTo(0);
  });

  test("null residual returns null", () => {
    expect(calcRequirement(null)).toBeNull();
    expect(calcRequirement(undefined)).toBeNull();
  });
});

// ── calcSurplus ───────────────────────────────────────────────────────────────

describe("calcSurplus", () => {
  test("negative residual (excess generation) returns positive surplus", () => {
    expect(calcSurplus(-2000)).toBeCloseTo(2000);
  });

  test("positive residual (shortfall) returns 0 surplus", () => {
    expect(calcSurplus(5000)).toBeCloseTo(0);
  });

  test("zero residual returns 0", () => {
    expect(calcSurplus(0)).toBeCloseTo(0);
  });

  test("null returns null", () => {
    expect(calcSurplus(null)).toBeNull();
  });
});

// ── calcMWh ───────────────────────────────────────────────────────────────────

describe("calcMWh", () => {
  test("single 30-min interval: 2000 MW × 0.5h = 1000 MWh", () => {
    expect(calcMWh([2000])).toBeCloseTo(1000);
  });

  test("48 intervals of 5000 MW = 48 × 5000 × 0.5 = 120000 MWh", () => {
    const vals = Array(48).fill(5000);
    expect(calcMWh(vals)).toBeCloseTo(120000);
  });

  test("null values count as zero", () => {
    expect(calcMWh([1000, null, 1000])).toBeCloseTo(1000); // (1000+0+1000)×0.5
  });

  test("empty array returns 0", () => {
    expect(calcMWh([])).toBeCloseTo(0);
  });

  test("MW values are NOT confused with MWh — raw sum is halved", () => {
    // 10 intervals of 1000 MW → 10×1000×0.5 = 5000 MWh, NOT 10000 MWh
    const vals = Array(10).fill(1000);
    expect(calcMWh(vals)).toBeCloseTo(5000);
    expect(calcMWh(vals)).not.toBeCloseTo(10000);
  });
});

// ── processProcurementPlan ────────────────────────────────────────────────────

describe("processProcurementPlan", () => {
  const baseIntervals = [
    { time: "T1", demand: 10000, wind: 5000, other: 1000 },
    { time: "T2", demand: 8000,  wind: 3000, other: 1000 },
  ];

  test("calculates per-interval residual correctly (no bias)", () => {
    const { intervals } = processProcurementPlan(baseIntervals, 0);
    expect(intervals[0].residual).toBeCloseTo(4000);  // 10000-5000-1000
    expect(intervals[1].residual).toBeCloseTo(4000);  // 8000-3000-1000
  });

  test("bias correction reduces expected wind and increases residual", () => {
    // bias = +2000 MW means forecaster over-predicts by 2000 MW
    // expectedWind[0] = max(5000-2000, 0) = 3000 → residual = 10000-3000-1000 = 6000
    // expectedWind[1] = max(3000-2000, 0) = 1000 → residual = 8000-1000-1000 = 6000
    const { intervals } = processProcurementPlan(baseIntervals, 2000);
    expect(intervals[0].windExpected).toBeCloseTo(3000);
    expect(intervals[0].residual).toBeCloseTo(6000);
    expect(intervals[1].windExpected).toBeCloseTo(1000);
    expect(intervals[1].residual).toBeCloseTo(6000);
  });

  test("raw windForecast is preserved alongside windExpected", () => {
    const { intervals } = processProcurementPlan(baseIntervals, 1000);
    expect(intervals[0].windForecast).toBeCloseTo(5000);
    expect(intervals[0].windExpected).toBeCloseTo(4000);
  });

  test("bias cannot make expected wind negative (floored at 0)", () => {
    const small = [{ time: "T1", demand: 5000, wind: 500, other: 0 }];
    const { intervals } = processProcurementPlan(small, 2000);
    expect(intervals[0].windExpected).toBeCloseTo(0);
    expect(intervals[0].residual).toBeCloseTo(5000);
  });

  test("positive residual → requirement > 0, surplus = 0", () => {
    const { intervals } = processProcurementPlan(baseIntervals, 0);
    intervals.forEach((row) => {
      expect(row.requirement).toBeGreaterThan(0);
      expect(row.surplus).toBeCloseTo(0);
    });
  });

  test("negative residual → requirement = 0, surplus > 0", () => {
    const surplus = [{ time: "T1", demand: 2000, wind: 6000, other: 0 }];
    const { intervals } = processProcurementPlan(surplus, 0);
    expect(intervals[0].requirement).toBeCloseTo(0);
    expect(intervals[0].surplus).toBeCloseTo(4000);
  });

  test("nComplete counts intervals with both demand and wind", () => {
    const mixed = [
      { time: "T1", demand: 5000, wind: 2000, other: 0 },
      { time: "T2", demand: null, wind: 2000, other: 0 },
      { time: "T3", demand: 5000, wind: null, other: 0 },
    ];
    const { summary } = processProcurementPlan(mixed, 0);
    expect(summary.nComplete).toBe(1);
    expect(summary.nMissingDemand).toBe(1);
    expect(summary.nMissingWind).toBe(1);
  });

  test("summary MWh values are correct (×0.5 per slot)", () => {
    const { summary } = processProcurementPlan(baseIntervals, 0);
    // demand: (10000+8000)×0.5 = 9000
    expect(summary.totalDemandMWh).toBeCloseTo(9000);
    // raw forecast: (5000+3000)×0.5 = 4000
    expect(summary.totalWindForecastMWh).toBeCloseTo(4000);
    // with no bias, expected = forecast
    expect(summary.totalWindExpectedMWh).toBeCloseTo(4000);
  });

  test("missing demand produces null residual, not zero", () => {
    const intervals = [{ time: "T1", demand: null, wind: 5000, other: 0 }];
    const { intervals: result } = processProcurementPlan(intervals, 0);
    expect(result[0].residual).toBeNull();
    expect(result[0].requirement).toBeNull();
    expect(result[0].surplus).toBeNull();
  });

  test("intervals with missing wind are excluded from every energy total", () => {
    const mixed = [
      { time: "T1", demand: 10000, wind: 4000, other: 0 },
      { time: "T2", demand: 10000, wind: null, other: 0 },   // forecast unavailable
    ];
    const { intervals, summary } = processProcurementPlan(mixed, 0);
    expect(intervals[1].residual).toBeNull();
    expect(intervals[1].requirement).toBeNull();
    // only T1 counts: demand 10000×0.5, requirement (10000-4000)×0.5
    expect(summary.totalDemandMWh).toBeCloseTo(5000);
    expect(summary.totalRequirementMWh).toBeCloseTo(3000);
    expect(summary.nMissingWind).toBe(1);
  });

  test("net daily balance keeps the business-facing procurement answer separate from interval decomposition", () => {
    const mixed = [
      { time: "T1", demand: 20000, wind: 15000, other: 0 },
      { time: "T2", demand: 10000, wind: 20000, other: 0 },
      { time: "T3", demand: 15000, wind: 8000, other: 0 },
    ];

    const { summary } = processProcurementPlan(mixed, 0);

    // interval decomposition remains valid and can show both requirement and surplus
    // Energy totals are MWh, so each 30-minute slot contributes × 0.5h
    expect(summary.totalRequirementMWh).toBeCloseTo(6000);
    expect(summary.totalSurplusMWh).toBeCloseTo(5000);

    // but the net position is what a procurement decision should use
    expect(summary.netResidualMWh).toBeCloseTo(1000);
    expect(summary.netRequirementMWh).toBeCloseTo(1000);
    expect(summary.netSurplusMWh).toBeCloseTo(0);
  });

  test("biasApplied is recorded in summary", () => {
    const { summary } = processProcurementPlan(baseIntervals, 1500);
    expect(summary.biasApplied).toBe(1500);
  });
});

// ── applyBiasCorrection ───────────────────────────────────────────────────────

describe("applyBiasCorrection", () => {
  test("positive bias reduces forecast (over-forecast correction)", () => {
    expect(applyBiasCorrection(3000, 2000)).toBeCloseTo(1000);
  });

  test("negative bias increases forecast (under-forecast correction)", () => {
    expect(applyBiasCorrection(3000, -500)).toBeCloseTo(3500);
  });

  test("result is floored at 0 — no negative expected wind", () => {
    expect(applyBiasCorrection(500, 2000)).toBeCloseTo(0);
  });

  test("zero bias returns raw forecast unchanged", () => {
    expect(applyBiasCorrection(5000, 0)).toBeCloseTo(5000);
  });

  test("null forecast returns null", () => {
    expect(applyBiasCorrection(null, 500)).toBeNull();
    expect(applyBiasCorrection(undefined, 500)).toBeNull();
  });
});

// ── applyScenarioOffset ───────────────────────────────────────────────────────

describe("applyScenarioOffset", () => {
  const base = [
    { time: "T1", demand: 10000, wind: 5000, other: 0, windSource: "forecast" },
    { time: "T2", demand: 8000,  wind: 3000, other: 0, windSource: "forecast" },
  ];

  test("negative offset reduces wind (lower wind scenario)", () => {
    const result = applyScenarioOffset(base, -1000, "lower");
    expect(result[0].wind).toBeCloseTo(4000);
    expect(result[1].wind).toBeCloseTo(2000);
  });

  test("positive offset increases wind (upper wind scenario)", () => {
    const result = applyScenarioOffset(base, 500, "upper");
    expect(result[0].wind).toBeCloseTo(5500);
    expect(result[1].wind).toBeCloseTo(3500);
  });

  test("wind cannot go below zero", () => {
    const result = applyScenarioOffset(base, -9999, "lower");
    expect(result[0].wind).toBeCloseTo(0);
  });

  test("null wind values remain null (not calculated from offset)", () => {
    const withNull = [{ time: "T1", demand: 10000, wind: null, other: 0 }];
    const result = applyScenarioOffset(withNull, -500, "lower");
    expect(result[0].wind).toBeNull();
  });

  test("scenario label is applied", () => {
    const result = applyScenarioOffset(base, 0, "central");
    result.forEach((r) => expect(r.windSource).toBe("central"));
  });

  test("uses actual input data — not hardcoded values", () => {
    const custom = [{ time: "T1", demand: 999, wind: 123, other: 0 }];
    const result = applyScenarioOffset(custom, -50, "lower");
    expect(result[0].wind).toBeCloseTo(73);
  });
});

// ── parseDemandCSV ────────────────────────────────────────────────────────────

describe("parseDemandCSV", () => {
  test("parses valid CSV with header", () => {
    const csv = "time,demand,other\n2026-01-01T00:00:00Z,5000,1000\n2026-01-01T00:30:00Z,4800,900";
    const { intervals, errors } = parseDemandCSV(csv);
    expect(errors).toHaveLength(0);
    expect(intervals).toHaveLength(2);
    expect(intervals[0].demand).toBe(5000);
    expect(intervals[0].other).toBe(1000);
  });

  test("parses valid CSV without header", () => {
    const csv = "2026-01-01T00:00:00Z,5000\n2026-01-01T00:30:00Z,4800";
    const { intervals, errors } = parseDemandCSV(csv);
    expect(errors).toHaveLength(0);
    expect(intervals).toHaveLength(2);
  });

  test("rejects negative demand values", () => {
    const csv = "time,demand\n2026-01-01,−500";
    const { errors } = parseDemandCSV(csv);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("reports error for non-numeric demand", () => {
    const csv = "time,demand\n2026-01-01,five_thousand";
    const { errors } = parseDemandCSV(csv);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("parsed intervals have wind set to null (user-entered demand, no wind yet)", () => {
    const csv = "2026-01-01,5000,0";
    const { intervals } = parseDemandCSV(csv);
    expect(intervals[0].wind).toBeNull();
  });
});
