# Goals

Fitness goals for 마곡동 실거래 dashboard

## North Stars

- A local HTML dashboard shows Magok-dong commercial transaction price changes by parcel or masked parcel group within 10 seconds.
- Source coverage and missing-year warnings are visible so decisions do not confuse partial data with a complete 10-year history.

## Anti Stars

- A dashboard that hides masked parcel data quality issues.
- A pretty chart with no source-period, KPI, or CTA.
- Untested HTML artifacts that cannot be opened locally.

## Directives

### 1. Establish baseline

Get all dashboard generation and local rendering checks passing.

**Steer:** increase

### 2. Preserve source truth

Keep all CSV-derived outputs traceable to source files, row counts, year coverage, and masked parcel counts.

**Steer:** increase

### 3. Improve decision value

Surface the highest-moving parcel groups, 거래금액/면적 단가, 거래량, and missing-year collection gap for fast follow-up.

**Steer:** increase

### 4. Drive unresolved masked groups to zero

Reduce unresolved masked parcel groups and records to 0 using only official-data evidence tiers.

**Steer:** decrease

## Gates

| ID | Check | Weight | Description |
|----|-------|--------|-------------|
| unresolved-masked-zero | `node scripts/check-unresolved-masked-zero.cjs` | 10 | 미확정 마스킹 보조그룹과 레코드를 0건으로 줄인다 |
