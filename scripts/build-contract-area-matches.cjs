// 건축HUB 전유공용면적을 실거래 레코드에 안전 매칭해 계약면적 후보를 만든다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data", "processed");
const dashboardPath = path.join(dataDir, "magok-commercial-transactions-dashboard.json");
const areaPath = path.join(dataDir, "building-hub-area-results.json");
const outputPath = path.join(dataDir, "contract-area-matches.json");

function toNumber(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").replace(/㎡/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function floorKey(value, floorGb) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return "";
  const gb = String(floorGb || "");
  return gb.includes("지하") || gb === "10" ? String(-Math.abs(n)) : String(n);
}

function recordKey(record) {
  return [
    record.source_file,
    record.parcel_key,
    record.year,
    record.month,
    record.contract_day,
    record.floor || "",
    record.area_sqm ?? "",
    record.price_manwon ?? "",
  ].join("|");
}

function roomKey(item, includeFloor = true) {
  return [
    item.parcel,
    includeFloor ? floorKey(item.flrNo, item.flrGbCdNm || item.flrGbCd) : "",
    String(item.dongNm || "").trim(),
    String(item.hoNm || "").trim(),
  ].join("|");
}

function isExclusive(item) {
  return String(item.exposPubuseGbCdNm || "").includes("전유");
}

function isCommon(item) {
  return String(item.exposPubuseGbCdNm || "").includes("공용");
}

function isSharedEachFloor(item) {
  return String(item.flrGbCdNm || "").includes("각층") || String(item.flrGbCd || "") === "40";
}

function areaBasisFromCommon(directCommonArea, sharedCommonArea) {
  if (directCommonArea > 0 || sharedCommonArea > 0) return "exclusive_plus_common";
  return "exclusive_only";
}

function uniqueRounded(values) {
  return [...new Set(values.filter(Number.isFinite).map((value) => round2(value).toFixed(2)))].map(Number);
}

function nearlyEqual(a, b, tolerance = 0.06) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function closestAreaCandidates(rooms, targetArea, tolerance = 0.5) {
  const withDelta = rooms
    .map((room) => ({ room, delta: Math.abs(room.exclusive_area_sqm - targetArea) }))
    .filter((entry) => Number.isFinite(entry.delta) && entry.delta <= tolerance)
    .sort((a, b) => a.delta - b.delta);
  if (!withDelta.length) return [];
  const minDelta = withDelta[0].delta;
  return withDelta.filter((entry) => nearlyEqual(entry.delta, minDelta, 0.001));
}

if (!fs.existsSync(dashboardPath)) throw new Error("dashboard JSON is missing");
if (!fs.existsSync(areaPath)) throw new Error("building-hub-area-results.json is missing");

const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf8"));
const areaRaw = JSON.parse(fs.readFileSync(areaPath, "utf8"));

const rooms = [];
const truncatedParcels = [];
for (const parcelResult of areaRaw.results || []) {
  const parcel = parcelResult.parcel;
  if (parcelResult.fetchedCount < parcelResult.totalCount) truncatedParcels.push(parcel);
  const items = (parcelResult.items || []).map((item) => ({ ...item, parcel }));
  const commonByRoom = new Map();
  const commonByUnit = new Map();

  for (const item of items.filter(isCommon)) {
    const area = toNumber(item.area);
    if (!Number.isFinite(area)) continue;
    const unitKey = roomKey(item, false);
    commonByUnit.set(unitKey, (commonByUnit.get(unitKey) || 0) + area);
    if (isSharedEachFloor(item)) {
      continue;
    } else {
      const key = roomKey(item, true);
      commonByRoom.set(key, (commonByRoom.get(key) || 0) + area);
    }
  }

  for (const item of items.filter(isExclusive)) {
    const exclusiveArea = toNumber(item.area);
    if (!Number.isFinite(exclusiveArea)) continue;
    const directKey = roomKey(item, true);
    const unitKey = roomKey(item, false);
    const hasCommon = commonByRoom.has(directKey) || commonByUnit.has(unitKey);
    if (!hasCommon) continue;
    const directCommonArea = commonByRoom.get(directKey) || 0;
    const totalCommonArea = commonByUnit.get(unitKey) || directCommonArea;
    const sharedCommonArea = Math.max(0, totalCommonArea - directCommonArea);
    const supplyArea = directCommonArea > 0 ? exclusiveArea + directCommonArea : null;
    rooms.push({
      parcel,
      floor: floorKey(item.flrNo, item.flrGbCdNm || item.flrGbCd),
      unit: String(item.hoNm || "").trim(),
      building_name: item.bldNm || "",
      main_use: item.mainPurpsCdNm || "",
      exclusive_area_sqm: round2(exclusiveArea),
      direct_common_area_sqm: round2(directCommonArea),
      shared_common_area_sqm: round2(sharedCommonArea),
      common_area_sqm: round2(totalCommonArea),
      supply_area_sqm: round2(supplyArea),
      contract_area_sqm: round2(exclusiveArea + totalCommonArea),
      area_source: "official_exclusive_common",
      area_basis: areaBasisFromCommon(directCommonArea, sharedCommonArea),
      area_confidence: "official_computed",
    });
  }
}

const roomByParcel = new Map();
for (const room of rooms) {
  if (!roomByParcel.has(room.parcel)) roomByParcel.set(room.parcel, []);
  roomByParcel.get(room.parcel).push(room);
}

const matches = {};
let matched = 0;
let roughMatched = 0;
let ambiguous = 0;
let roughAmbiguous = 0;
let noFloor = 0;

for (const record of dashboard.records || []) {
  if (record.is_masked_parcel || !record.parcel || !Number.isFinite(record.area_sqm)) continue;
  const floor = floorKey(record.floor, "지상");
  if (!floor) {
    noFloor += 1;
    continue;
  }
  const sameFloorRooms = (roomByParcel.get(record.parcel) || []).filter((room) => room.floor === floor);
  const candidates = sameFloorRooms.filter(
    (room) => room.floor === floor && nearlyEqual(room.exclusive_area_sqm, record.area_sqm),
  );
  const contractAreas = uniqueRounded(candidates.map((room) => room.contract_area_sqm));
  if (contractAreas.length === 1) {
    const best = candidates[0];
    matches[recordKey(record)] = {
      contract_area_sqm: contractAreas[0],
      common_area_sqm: round2(contractAreas[0] - record.area_sqm),
      direct_common_area_sqm: best.direct_common_area_sqm,
      shared_common_area_sqm: best.shared_common_area_sqm,
      supply_area_sqm: best.supply_area_sqm,
      matched_room_count: candidates.length,
      matched_unit_sample: best.unit,
      matched_exclusive_area_sqm: best.exclusive_area_sqm,
      exclusive_area_delta_sqm: round2(Math.abs(best.exclusive_area_sqm - record.area_sqm)),
      source: "건축HUB 전유공용면적",
      area_source: best.area_source,
      area_basis: best.area_basis,
      area_confidence: best.area_confidence,
      confidence: candidates.length === 1 ? "high" : "same_area_multi_room",
    };
    matched += 1;
  } else if (candidates.length) {
    ambiguous += 1;
  } else {
    const roughCandidates = closestAreaCandidates(sameFloorRooms, record.area_sqm);
    const roughContractAreas = uniqueRounded(roughCandidates.map((entry) => entry.room.contract_area_sqm));
    if (roughContractAreas.length === 1) {
      const best = roughCandidates[0].room;
      matches[recordKey(record)] = {
        contract_area_sqm: roughContractAreas[0],
        common_area_sqm: round2(roughContractAreas[0] - record.area_sqm),
        direct_common_area_sqm: best.direct_common_area_sqm,
        shared_common_area_sqm: best.shared_common_area_sqm,
        supply_area_sqm: best.supply_area_sqm,
        matched_room_count: roughCandidates.length,
        matched_unit_sample: best.unit,
        matched_exclusive_area_sqm: best.exclusive_area_sqm,
        exclusive_area_delta_sqm: round2(Math.abs(best.exclusive_area_sqm - record.area_sqm)),
        source: "건축HUB 전유공용면적",
        area_source: best.area_source,
        area_basis: best.area_basis,
        area_confidence: best.area_confidence,
        confidence: "rough_floor_area_nearest",
      };
      roughMatched += 1;
    } else if (roughCandidates.length) {
      roughAmbiguous += 1;
    }
  }
}

const result = {
  generated_at: new Date().toISOString(),
  basis: "매물장 areaBasis 기준을 따른다. 전용면적은 실거래 면적과 지번+층+전용면적으로 매칭하고, 공식 공용 근거가 있는 호실만 계약면적을 만든다. 계약면적은 전용+직접공용+각층/기타공용, 공급면적 후보는 전용+직접공용으로 분리 저장한다.",
  source: {
    area_file: path.relative(root, areaPath),
    dashboard_file: path.relative(root, dashboardPath),
  },
  metrics: {
    exact_records: (dashboard.records || []).filter((record) => !record.is_masked_parcel).length,
    room_candidates: rooms.length,
    matched_records: matched,
    rough_matched_records: roughMatched,
    total_matched_records: matched + roughMatched,
    ambiguous_records: ambiguous,
    rough_ambiguous_records: roughAmbiguous,
    skipped_no_floor_records: noFloor,
    truncated_parcels: truncatedParcels.length,
  },
  truncated_parcels: truncatedParcels,
  matches,
};

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify({ output: outputPath, ...result.metrics }, null, 2));
