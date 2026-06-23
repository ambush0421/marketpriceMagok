// 남은 미확정 마스킹 거래를 추가로 줄일 수 있는 경로를 분석합니다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data", "processed");
const dashboardPath = path.join(dataDir, "magok-commercial-transactions-dashboard.json");
const analysisPath = path.join(dataDir, "masked-official-matching-analysis.json");
const priceContinuityPath = path.join(dataDir, "masked-price-continuity-candidates.json");
const outPath = path.join(dataDir, "unresolved-masked-recovery-analysis.json");
const docPath = path.join(root, "docs", "ai-output", "20260608-unresolved-masked-recovery-plan.md");

function toNumber(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf8"));
const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
const priceContinuity = fs.existsSync(priceContinuityPath)
  ? JSON.parse(fs.readFileSync(priceContinuityPath, "utf8"))
  : { items: [] };
const unresolvedRecords = dashboard.records.filter((record) => record.is_masked_parcel);
const unresolvedGroups = dashboard.parcel_groups.filter((group) => group.is_masked_parcel);
const unresolvedAnalysisRows = analysis.rows.filter((row) => !row.unique_parcel);
const lowConfidenceUniqueRows = analysis.rows.filter((row) => row.unique_parcel && row.stage === "usage_area_only");

const exactRecords = dashboard.records.filter((record) => !record.original_is_masked_parcel && !record.is_masked_parcel);
const exactByUseAreaBuildYear = groupBy(exactRecords, (record) => [
  record.main_use || "",
  toNumber(record.area_sqm)?.toFixed(2) || "",
  record.build_year || "",
].join("|"));

const priceContinuityCandidates = [];
for (const group of unresolvedGroups) {
  const rows = unresolvedRecords.filter((record) => record.parcel_key === group.parcel_key);
  const first = rows[0];
  const key = [
    first.main_use || "",
    toNumber(first.area_sqm)?.toFixed(2) || "",
    first.build_year || "",
  ].join("|");
  const exactPeers = exactByUseAreaBuildYear.get(key) || [];
  const peerParcels = [...new Set(exactPeers.map((record) => record.parcel))];
  if (peerParcels.length === 1) {
    priceContinuityCandidates.push({
      masked_group: group.parcel_key,
      transaction_count: group.transaction_count,
      candidate_parcel: peerParcels[0],
      exact_peer_count: exactPeers.length,
      masked_median_price: median(rows.map((record) => record.price_manwon)),
      exact_peer_median_price: median(exactPeers.map((record) => record.price_manwon)),
      main_use: first.main_use,
      area_sqm: first.area_sqm,
      build_year: first.build_year,
    });
  }
}

const unresolvedByYear = Object.fromEntries([...groupBy(unresolvedRecords, (record) => record.year).entries()]
  .sort(([a], [b]) => Number(a) - Number(b))
  .map(([year, rows]) => [year, rows.length]));

const unresolvedGroupsByUse = Object.fromEntries([...groupBy(unresolvedGroups, (group) => group.main_use || "용도없음").entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 12)
  .map(([use, rows]) => [use, rows.length]));

const summary = {
  generated_at: new Date().toISOString(),
  unresolved_records: unresolvedRecords.length,
  unresolved_groups: unresolvedGroups.length,
  low_confidence_unique_records: lowConfidenceUniqueRows.length,
  unresolved_analysis_rows: unresolvedAnalysisRows.length,
  no_candidate_rows: unresolvedAnalysisRows.filter((row) => row.candidate_parcel_count === 0).length,
  multi_candidate_rows: unresolvedAnalysisRows.filter((row) => row.candidate_parcel_count > 1).length,
  two_candidate_rows: unresolvedAnalysisRows.filter((row) => row.candidate_parcel_count === 2).length,
  price_continuity_group_candidates: priceContinuityCandidates.length,
  price_continuity_record_candidates: priceContinuityCandidates.reduce((sum, row) => sum + row.transaction_count, 0),
  generated_price_continuity_candidates: priceContinuity.items.length,
  generated_price_continuity_records: priceContinuity.items.reduce((sum, row) => sum + (row.transaction_count || 0), 0),
  applied_price_continuity_records: dashboard.metrics?.recovery_masked_matched_records ?? null,
  applied_official_candidate_set_records: dashboard.metrics?.official_candidate_set_records ?? null,
  unresolved_by_year: unresolvedByYear,
  unresolved_groups_by_use: unresolvedGroupsByUse,
};

const result = {
  summary,
  low_confidence_policy_candidate: lowConfidenceUniqueRows.slice(0, 20),
  price_continuity_candidates: priceContinuityCandidates
    .sort((a, b) => b.transaction_count - a.transaction_count)
    .slice(0, 100),
};

fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

const lines = [
  "# 남은 미확정 마스킹 거래 회수 계획",
  "",
  "## 결론",
  "",
  "남은 미확정 보조그룹은 전부 같은 난이도가 아니다. 공식 후보 유일 매칭으로 고신뢰 후보는 0건까지 줄였고, 층 없는 유일 후보는 후보 라벨로 건물 그룹에 귀속했다. 남은 것은 복수 후보와 후보 없음 거래다.",
  "",
  "## 현재 상태",
  "",
  `- 미확정 레코드: ${summary.unresolved_records.toLocaleString("ko-KR")}건`,
  `- 미확정 보조그룹: ${summary.unresolved_groups.toLocaleString("ko-KR")}개`,
  `- 층 없음 유일 후보, 후보 라벨 귀속 완료: ${summary.low_confidence_unique_records.toLocaleString("ko-KR")}건`,
  `- 복수 후보: ${summary.multi_candidate_rows.toLocaleString("ko-KR")}건`,
  `- 후보 없음: ${summary.no_candidate_rows.toLocaleString("ko-KR")}건`,
  `- 가격 연속성 후보 생성: ${summary.generated_price_continuity_candidates.toLocaleString("ko-KR")}개 / ${summary.generated_price_continuity_records.toLocaleString("ko-KR")}건`,
  `- 가격 연속성 대시보드 적용: ${summary.applied_price_continuity_records.toLocaleString("ko-KR")}건`,
  `- 공식 후보필지세트 대시보드 적용: ${summary.applied_official_candidate_set_records.toLocaleString("ko-KR")}건`,
  "",
  "## 추가로 줄이는 방법",
  "",
  "1. 층 없음 유일 후보 365건은 `후보` 라벨로 건물 그룹에 귀속했다. 층/호실 확정은 하지 않는다.",
  `2. 복수 후보 ${summary.multi_candidate_rows.toLocaleString("ko-KR")}건은 최근 3년 등기소 API 수집값과 가격 연속성을 결합해 후보를 줄인다. 특히 후보 2개인 ${summary.two_candidate_rows.toLocaleString("ko-KR")}건이 1순위다.`,
  `3. 후보 없음 ${summary.no_candidate_rows.toLocaleString("ko-KR")}건은 건축HUB 전유부 면적과 실거래 면적 사이의 미세 오차, 용도명 차이, 집합건물이 아닌 거래 여부를 따로 봐야 한다.`,
  "4. 같은 계약일·같은 금액·같은 면적 묶음 거래는 한 건씩 보지 말고 묶음 단위로 후보 필지를 비교한다.",
  "5. 등기소 API가 풀리면 `분기별 × 금액구간 × 면적구간`으로 최근 3년 전체 건물을 채워 가격/면적/층 패턴 사전을 만든다.",
  "",
  "## 권장 반영 방식",
  "",
  "- `확정`: 등기소 API 또는 등기부 원문으로 지번/건물명이 확인된 거래.",
  "- `추정`: 용도+층+전용면적(+건축년도) 유일 후보. 이미 대시보드에 반영됨.",
  "- `후보`: 층 없음 유일 후보. 대시보드 건물 그룹에는 붙이되 층/호실 확정으로 보지 않는다.",
  "- `미확정`: 복수 후보, 후보 없음, 면적/용도 불일치.",
  "",
  "## 다음 구현",
  "",
  "등기소 API 일별 제한이 풀린 뒤 최근 3년 패턴 사전을 붙이면 후보 2개짜리부터 추가로 줄일 수 있다. 이후 가격 연속성 후보를 별도 패널로 노출한다.",
];

fs.writeFileSync(docPath, `${lines.join("\n")}\n`, "utf8");

console.log(JSON.stringify({
  ok: true,
  outPath: path.relative(root, outPath),
  docPath: path.relative(root, docPath),
  summary,
}, null, 2));
