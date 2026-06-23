// 가격 연속성으로 미확정 마스킹 그룹의 후보 필지를 안정적으로 산출합니다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data", "processed");
const rawPath = path.join(dataDir, "api-commercial-monthly-raw.json");
const analysisPath = path.join(dataDir, "masked-official-matching-analysis.json");
const outPath = path.join(dataDir, "masked-price-continuity-candidates.json");

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

function normArea(value) {
  const area = toNumber(value);
  return Number.isFinite(area) ? area.toFixed(2) : "";
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

function isMasked(jibun) {
  return !jibun || String(jibun).includes("*");
}

function fallbackKey({ use, area, buildYear }) {
  const areaNumber = toNumber(area);
  return `MASKED|API|${use || "용도없음"}|${Number.isFinite(areaNumber) ? areaNumber : "면적없음"}|${buildYear || "건축년도없음"}`;
}

function maskedOfficialKeyFromRow(row) {
  const [year, month, day] = String(row.deal_date || "").split("-");
  return [
    row.source_month || (year && month ? `${year}${month}` : ""),
    String(row.masked_jibun || ""),
    String(row.use || ""),
    String(row.floor || ""),
    normArea(row.area_sqm),
    String(row.build_year || ""),
    String(toNumber(row.deal_amount_manwon) ?? ""),
    day || "",
  ].join("|");
}

const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
const activeRaw = (raw.items || []).filter((item) => item.cdealType !== "O" && !item.cdealDay && String(item.umdNm || "") === "마곡동");
const exactRows = activeRaw.filter((item) => !isMasked(item.jibun));
const exactByUseAreaYear = groupBy(exactRows, (item) => [
  item.buildingUse || "",
  normArea(item.buildingAr),
  item.buildYear || "",
].join("|"));
const exactByUseArea = groupBy(exactRows, (item) => [
  item.buildingUse || "",
  normArea(item.buildingAr),
].join("|"));
const exactByParcelUseAreaYear = groupBy(exactRows, (item) => [
  item.jibun || "",
  item.buildingUse || "",
  normArea(item.buildingAr),
  item.buildYear || "",
].join("|"));
const exactByParcelUseArea = groupBy(exactRows, (item) => [
  item.jibun || "",
  item.buildingUse || "",
  normArea(item.buildingAr),
].join("|"));

const unresolvedRows = (analysis.rows || []).filter((row) => !row.unique_parcel);
const unresolvedGroups = groupBy(unresolvedRows, (row) => fallbackKey({
  use: row.use,
  area: row.area_sqm,
  buildYear: row.build_year,
}));

const candidates = [];
for (const [maskedGroup, rows] of unresolvedGroups) {
  const first = rows[0];
  const exactPeers = exactByUseAreaYear.get([
    first.use || "",
    normArea(first.area_sqm),
    first.build_year || "",
  ].join("|")) || [];
  const peerParcels = [...new Set(exactPeers.map((item) => item.jibun).filter(Boolean))];
  if (peerParcels.length !== 1) continue;

  const maskedMedian = median(rows.map((row) => toNumber(row.deal_amount_manwon)));
  const exactMedian = median(exactPeers.map((item) => toNumber(item.dealAmount)));
  if (!Number.isFinite(maskedMedian) || !Number.isFinite(exactMedian) || maskedMedian <= 0) continue;
  const diffRatio = Math.abs(maskedMedian - exactMedian) / maskedMedian;
  if (diffRatio > 0.2) continue;

  candidates.push({
    stage: "group_price_continuity",
    masked_group: maskedGroup,
    transaction_count: rows.length,
    candidate_parcel: peerParcels[0],
    exact_peer_count: exactPeers.length,
    masked_median_price: maskedMedian,
    exact_peer_median_price: exactMedian,
    diff_ratio: diffRatio,
    main_use: first.use,
    area_sqm: first.area_sqm,
    build_year: first.build_year || null,
  });
}

for (const [maskedGroup, rows] of unresolvedGroups) {
  if (candidates.some((candidate) => candidate.masked_group === maskedGroup && !candidate.match_key)) continue;
  const first = rows[0];
  const exactPeers = exactByUseArea.get([
    first.use || "",
    normArea(first.area_sqm),
  ].join("|")) || [];
  const peerParcels = [...new Set(exactPeers.map((item) => item.jibun).filter(Boolean))];
  if (peerParcels.length !== 1) continue;

  const maskedMedian = median(rows.map((row) => toNumber(row.deal_amount_manwon)));
  const exactMedian = median(exactPeers.map((item) => toNumber(item.dealAmount)));
  if (!Number.isFinite(maskedMedian) || !Number.isFinite(exactMedian) || maskedMedian <= 0) continue;
  const diffRatio = Math.abs(maskedMedian - exactMedian) / maskedMedian;
  if (diffRatio > 0.15) continue;

  candidates.push({
    stage: "group_price_continuity_area_only",
    masked_group: maskedGroup,
    transaction_count: rows.length,
    candidate_parcel: peerParcels[0],
    exact_peer_count: exactPeers.length,
    masked_median_price: maskedMedian,
    exact_peer_median_price: exactMedian,
    diff_ratio: diffRatio,
    main_use: first.use,
    area_sqm: first.area_sqm,
    build_year: first.build_year || null,
  });
}

for (const row of unresolvedRows) {
  const candidateParcels = Array.isArray(row.candidate_parcels)
    ? row.candidate_parcels.filter(Boolean)
    : [...new Set((row.sample_candidates || []).map((candidate) => candidate.parcel).filter(Boolean))];
  if (candidateParcels.length < 2) continue;

  const buildPeerStats = (index, includeBuildYear) => candidateParcels.map((parcel) => {
    const key = includeBuildYear
      ? [
          parcel,
          row.use || "",
          normArea(row.area_sqm),
          row.build_year || "",
        ].join("|")
      : [
          parcel,
          row.use || "",
          normArea(row.area_sqm),
        ].join("|");
    const peers = index.get(key) || [];
    const peerMedian = median(peers.map((item) => toNumber(item.dealAmount)));
    const dealAmount = toNumber(row.deal_amount_manwon);
    const diffRatio = Number.isFinite(peerMedian) && Number.isFinite(dealAmount) && dealAmount > 0
      ? Math.abs(dealAmount - peerMedian) / dealAmount
      : null;
    return { parcel, peers, peerMedian, diffRatio };
  });

  const chooseWinner = (peerStats, threshold) => {
    const viable = peerStats.filter((stat) => stat.peers.length > 0 && Number.isFinite(stat.diffRatio) && stat.diffRatio <= threshold);
    if (viable.length === 1) return viable[0];
    if (viable.length >= 2) {
      const sorted = [...viable].sort((a, b) => a.diffRatio - b.diffRatio);
      if (sorted[0].diffRatio * 1.5 < sorted[1].diffRatio) return sorted[0];
    }
    return null;
  };

  let stage = "ambiguous_price_continuity";
  const peerStats = buildPeerStats(exactByParcelUseAreaYear, true);
  let winner = null;
  winner = chooseWinner(peerStats, 0.2);
  if (!winner) {
    const areaOnlyPeerStats = buildPeerStats(exactByParcelUseArea, false);
    winner = chooseWinner(areaOnlyPeerStats, 0.15);
    stage = "ambiguous_price_continuity_area_only";
  }
  if (!winner) continue;

  candidates.push({
    stage,
    match_key: maskedOfficialKeyFromRow(row),
    masked_group: fallbackKey({
      use: row.use,
      area: row.area_sqm,
      buildYear: row.build_year,
    }),
    transaction_count: 1,
    candidate_parcel: winner.parcel,
    exact_peer_count: winner.peers.length,
    masked_median_price: toNumber(row.deal_amount_manwon),
    exact_peer_median_price: winner.peerMedian,
    diff_ratio: winner.diffRatio,
    main_use: row.use,
    area_sqm: row.area_sqm,
    build_year: row.build_year || null,
    candidate_parcel_count: candidateParcels.length,
  });
}

const result = {
  generated_at: new Date().toISOString(),
  basis: "국토부 원자료에서 정확 지번 거래와 미확정 마스킹 그룹/복수후보 행의 용도·전용면적·건축년도·가격 중위값을 비교해 20% 이내인 단일 후보 필지만 산출한다.",
  threshold: 0.2,
  group_count: candidates.length,
  record_count: candidates.reduce((sum, row) => sum + row.transaction_count, 0),
  items: candidates.sort((a, b) => b.transaction_count - a.transaction_count),
};

fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify({
  ok: true,
  outPath: path.relative(root, outPath),
  group_count: result.group_count,
  record_count: result.record_count,
}, null, 2));
