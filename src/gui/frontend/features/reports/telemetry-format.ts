import type { NumericSummary, RateSummary } from "../../../../harness/telemetry-report/types.ts";
import { number, percent } from "./shared.tsx";

export const ratePercent = (rate: RateSummary) => rate.value === undefined ? undefined : rate.value * 100;
export const rateText = (rate: RateSummary) => `${percent(ratePercent(rate))} · ${number(rate.numerator)} / ${number(rate.samples)}`;
export const distribution = (value: NumericSummary, format = number) => `平均 ${format(value.mean)} · P50 ${format(value.p50)} · P95 ${format(value.p95)} · ${number(value.samples)} 个样本`;
