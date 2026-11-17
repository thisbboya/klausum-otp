import { describe, it, expect } from "vitest";
import { randomIndex, timingSafeEqual, newApiKey } from "../src/crypto";

describe("crypto helpers", () => {
  it("timingSafeEqual is correct for equal, different and different-length input", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("randomIndex has no modulo bias (chi-square over 62 buckets)", () => {
    const n = 62, draws = 62000, counts = new Array(n).fill(0);
    for (let i = 0; i < draws; i++) counts[randomIndex(n)]++;
    const exp = draws / n;
    const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
    // df=61; p=0.001 critical ≈ 100.9. Modulo bias would push buckets 0..7 ~25% high → chi ≫ 100.
    expect(chi).toBeLessThan(101);
  });

  it("API keys are kotp_live_ + 32 alphanumerics and unique", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newApiKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^kotp_live_[A-Za-z0-9]{32}$/);
  });
});
