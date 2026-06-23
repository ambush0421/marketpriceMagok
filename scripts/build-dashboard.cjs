// 마곡동 실거래 API/CSV를 지번별 가격 변화 대시보드 산출물로 변환한다.
const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const root = path.resolve(__dirname, "..");
const csvDir = root;
const dataDir = path.join(root, "data", "processed");
const docsDir = path.join(root, "docs", "ai-output");
const decoder = new TextDecoder("windows-949");
const SQM_PER_PYEONG = 3.305785;
const buildingOverridePath = path.join(dataDir, "building-name-overrides.json");
const apiRawPath = path.join(dataDir, "api-commercial-monthly-raw.json");
const contractAreaMatchesPath = path.join(dataDir, "contract-area-matches.json");
const buildingHubAreaPath = path.join(dataDir, "building-hub-area-results.json");
const buildingHubTitlePath = path.join(dataDir, "building-hub-title-results.json");
const maskedOfficialAnalysisPath = path.join(dataDir, "masked-official-matching-analysis.json");
const priceContinuityCandidatesPath = path.join(dataDir, "masked-price-continuity-candidates.json");
const buildingOverrides = fs.existsSync(buildingOverridePath)
  ? JSON.parse(fs.readFileSync(buildingOverridePath, "utf8"))
  : {};
const contractAreaMatches = fs.existsSync(contractAreaMatchesPath)
  ? JSON.parse(fs.readFileSync(contractAreaMatchesPath, "utf8"))
  : null;
const maskedOfficialMatches = fs.existsSync(maskedOfficialAnalysisPath)
  ? buildMaskedOfficialMatchMap(JSON.parse(fs.readFileSync(maskedOfficialAnalysisPath, "utf8")))
  : new Map();
const recoveryMaskedMatches = fs.existsSync(priceContinuityCandidatesPath)
  ? buildRecoveryMaskedMatchMap(JSON.parse(fs.readFileSync(priceContinuityCandidatesPath, "utf8")))
  : new Map();
const buildingTitleIndex = fs.existsSync(buildingHubTitlePath)
  ? buildBuildingTitleIndex(JSON.parse(fs.readFileSync(buildingHubTitlePath, "utf8")))
  : new Map();

const csvFiles = fs
  .readdirSync(csvDir)
  .filter((name) => name.toLowerCase().endsWith(".csv"))
  .sort();

function signedFloor(item) {
  const floorNo = Math.abs(toNumber(item.flrNo) || 0);
  const floorName = String(item.flrGbCdNm || "");
  const floorCode = String(item.flrGbCd || "");
  return floorName.includes("지하") || floorCode === "10" ? -floorNo : floorNo;
}

function compactName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()·ㆍ\-_]/g, "");
}

function buildBuildingTitleIndex(data) {
  const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
  const index = new Map();
  for (const result of results) {
    const parcel = String(result.parcel || "").trim();
    if (!parcel) continue;
    const names = [...new Set([
      ...(Array.isArray(result.names) ? result.names : []),
      ...(Array.isArray(result.title_items) ? result.title_items.map((item) => item.building_name) : []),
    ].map((name) => String(name || "").trim()).filter(Boolean))];
    index.set(`PARCEL|${parcel}`, {
      parcel,
      names,
      road: result.road || "",
      title_items: result.title_items || [],
    });
  }
  return index;
}

function isAreaExclusive(item) {
  const code = String(item.exposPubuseGbCd || "").trim();
  const name = String(item.exposPubuseGbCdNm || "").trim();
  return code === "1" || code === "01" || name.includes("전유");
}

function isAreaCommon(item) {
  const code = String(item.exposPubuseGbCd || "").trim();
  const name = String(item.exposPubuseGbCdNm || "").trim();
  return code === "2" || code === "02" || name.includes("공용");
}

function areaRoomKey(item) {
  return `${signedFloor(item)}|${String(item.dongNm || "").trim()}|${String(item.hoNm || "").trim()}`;
}

function areaUnitKey(item) {
  return `${String(item.dongNm || "").trim()}|${String(item.hoNm || "").trim()}`;
}

function buildProbableBuildingAreaIndex() {
  if (!fs.existsSync(buildingHubAreaPath)) return new Map();
  const data = JSON.parse(fs.readFileSync(buildingHubAreaPath, "utf8"));
  const results = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
  const index = new Map();

  for (const result of results) {
    const items = result.items || [];
    if (!items.length) continue;
    const exclusiveRoomKeys = new Set(items.filter(isAreaExclusive).map(areaRoomKey));
    const commonByRoom = new Map();
    const sharedCommonByUnit = new Map();
    for (const item of items.filter(isAreaCommon)) {
      const area = toNumber(item.area) || 0;
      const floorName = String(item.flrGbCdNm || "");
      const roomKey = areaRoomKey(item);
      if (floorName.includes("각층") || !exclusiveRoomKeys.has(roomKey)) {
        const key = areaUnitKey(item);
        sharedCommonByUnit.set(key, (sharedCommonByUnit.get(key) || 0) + area);
      } else {
        commonByRoom.set(roomKey, (commonByRoom.get(roomKey) || 0) + area);
      }
    }

    for (const item of items.filter(isAreaExclusive)) {
      const floor = signedFloor(item);
      const exclusiveArea = toNumber(item.area);
      if (!Number.isFinite(exclusiveArea)) continue;
      const directCommonArea = commonByRoom.get(areaRoomKey(item)) || 0;
      const sharedCommonArea = sharedCommonByUnit.get(areaUnitKey(item)) || 0;
      const usageCategory = isRetailUse({ main_use: `${item.mainPurpsCdNm || ""} ${item.etcPurps || ""}` })
        ? "상가"
        : isOfficeUse({ main_use: `${item.mainPurpsCdNm || ""} ${item.etcPurps || ""}` })
          ? "업무"
          : "기타";
      const room = {
        parcel: result.parcel,
        road: item.newPlatPlc || "",
        building_name: item.bldNm || "",
        floor,
        unit: String(item.hoNm || "").trim(),
        usage_category: usageCategory,
        exclusive_area_sqm: exclusiveArea,
        common_area_sqm: directCommonArea + sharedCommonArea,
        direct_common_area_sqm: directCommonArea,
        shared_common_area_sqm: sharedCommonArea,
        contract_area_sqm: exclusiveArea + directCommonArea + sharedCommonArea,
      };
      const key = `${usageCategory}|${floor}|${exclusiveArea.toFixed(2)}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(room);
    }
  }
  return index;
}

const probableBuildingAreaIndex = buildProbableBuildingAreaIndex();

function inferProbableBuildingMatch(item, area) {
  if (!String(item.jibun || "").includes("*")) return null;
  if (String(item.umdNm || "") !== "마곡동") return null;
  if (String(item.buildYear || "") !== "2019") return null;
  if (String(item.buildingUse || "") !== "업무") return null;
  const floor = Number(item.floor);
  if (![5, 6, 8, 9].includes(floor)) return null;
  if (!Number.isFinite(area)) return null;

  const candidates = probableBuildingAreaIndex.get(`업무|${floor}|${area.toFixed(2)}`) || [];
  if (!candidates.length) return null;
  const candidateParcels = [...new Set(candidates.map((room) => room.parcel))];
  if (candidateParcels.length !== 1 || candidateParcels[0] !== "798-14") return null;
  const contractAreas = [...new Set(candidates.map((room) => Number(room.contract_area_sqm.toFixed(2))))];
  if (contractAreas.length !== 1) return null;
  const directCommonAreas = [...new Set(candidates.map((room) => Number(room.direct_common_area_sqm.toFixed(2))))];
  const sharedCommonAreas = [...new Set(candidates.map((room) => Number(room.shared_common_area_sqm.toFixed(2))))];
  const commonAreas = [...new Set(candidates.map((room) => Number(room.common_area_sqm.toFixed(2))))];

  return {
    parcel_key: "PARCEL|798-14",
    parcel_label: "798-14 추정",
    parcel: "798-14",
    road: candidates[0].road || "서울특별시 강서구 마곡중앙1로 20 (마곡동)",
    building_name: candidates[0].building_name || "마곡 M시그니처",
    building_name_status: "추정",
    building_name_source: "지번 마스킹 자료를 층·전용면적·건축년도·용도로 마곡동 전체 전유공용면적 후보군과 대조",
    match_confidence: candidates.length === 1 ? "probable_unique_building_unique_room" : "probable_unique_building_same_area_rooms",
    matched_room_count: candidates.length,
    matched_unit_sample: candidates.slice(0, 4).map((room) => room.unit).join(", "),
    common_area_sqm: commonAreas.length === 1 ? commonAreas[0] : null,
    direct_common_area_sqm: directCommonAreas.length === 1 ? directCommonAreas[0] : null,
    shared_common_area_sqm: sharedCommonAreas.length === 1 ? sharedCommonAreas[0] : null,
    contract_area_sqm: contractAreas[0],
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function toNumber(value) {
  const raw = String(value ?? "");
  if (!raw || raw.trim() === "-" || raw.trim() === "") return null;
  const normalized = raw.replace(/,/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedAmount(value) {
  const parsed = toNumber(value);
  return Number.isFinite(parsed) ? String(parsed) : "";
}

function maskedOfficialKeyFromParts({ sourceMonth, dealYear, dealMonth, dealDay, maskedJibun, use, floor, area, buildYear, amount }) {
  const month = sourceMonth || (dealYear && dealMonth ? `${dealYear}${String(dealMonth).padStart(2, "0")}` : "");
  const day = dealDay ? String(Number(dealDay) || dealDay).padStart(2, "0") : "";
  return [
    month,
    String(maskedJibun || ""),
    String(use || ""),
    String(floor || ""),
    Number.isFinite(toNumber(area)) ? toNumber(area).toFixed(2) : "",
    String(buildYear || ""),
    normalizedAmount(amount),
    day,
  ].join("|");
}

function buildMaskedOfficialMatchMap(data) {
  const map = new Map();
  for (const row of data.rows || []) {
    if (!["usage_floor_area_year", "usage_floor_area", "usage_area_only", "usage_floor_area_tolerance_005", "usage_area_tolerance_005", "usage_floor_area_tolerance_010", "usage_area_tolerance_010", "usage_floor_area_sum_tolerance_050", "usage_area_sum_tolerance_050", "all_usage_floor_area_sum_tolerance_005pct", "all_usage_area_sum_tolerance_005pct", "usage_floor_contract_area_tolerance_005", "usage_contract_area_tolerance_005", "usage_floor_half_share_area_tolerance_005", "all_usage_floor_area_tolerance_005", "all_usage_area_tolerance_005", "usage_title_total_area_tolerance_001pct", "all_usage_title_total_area_tolerance_001pct", "all_usage_title_total_area_tolerance_002pct", "all_usage_deal_bundle_title_total_area_tolerance_002pct"].includes(row.stage)) continue;
    const sample = (row.sample_candidates || [])[0] || {};
    const candidateParcels = Array.isArray(row.candidate_parcels)
      ? row.candidate_parcels.filter(Boolean)
      : [...new Set((row.sample_candidates || []).map((candidate) => candidate.parcel).filter(Boolean))];
    if (!row.unique_parcel && candidateParcels.length < 2) continue;
    const key = maskedOfficialKeyFromParts({
      sourceMonth: row.source_month,
      maskedJibun: row.masked_jibun,
      use: row.use,
      floor: row.floor,
      area: row.area_sqm,
      buildYear: row.build_year,
      amount: row.deal_amount_manwon,
      dealDay: String(row.deal_date || "").slice(8, 10),
    });
    if (!row.unique_parcel) {
      const parcelSet = candidateParcels.join("+");
      map.set(key, {
        parcel: candidateParcels.join(", "),
        parcel_key: `CANDIDATE_SET|${parcelSet}|${row.use || "용도없음"}|${row.area_sqm || "면적없음"}|${row.build_year || "건축년도없음"}`,
        parcel_label: `후보필지 ${candidateParcels.length}개: ${candidateParcels.join(", ")}`,
        building_name: [...new Set((row.sample_candidates || []).map((candidate) => candidate.building_name).filter(Boolean))].slice(0, 3).join(" / ") || "공식 후보필지 세트",
        road: "",
        stage: row.stage,
        candidate_room_count: row.candidate_room_count,
        candidate_parcel_count: row.candidate_parcel_count,
        unit_sample: (row.sample_candidates || []).slice(0, 5).map((candidate) => candidate.unit).filter(Boolean).join(", "),
        confidence_level: "candidate",
      });
      continue;
    }
    map.set(key, {
      parcel: row.unique_parcel,
      parcel_key: `PARCEL|${row.unique_parcel}`,
      parcel_label: `${row.unique_parcel} 추정`,
      building_name: sample.building_name || "확인필요",
      road: sample.road || "",
      stage: row.stage,
      candidate_room_count: row.candidate_room_count,
      candidate_parcel_count: row.candidate_parcel_count,
      unit_sample: (row.sample_candidates || []).slice(0, 5).map((candidate) => candidate.unit).filter(Boolean).join(", "),
      confidence_level: row.stage === "usage_area_only" || row.stage.includes("tolerance") ? "candidate" : "probable",
    });
  }
  return map;
}

function buildRecoveryMaskedMatchMap(data) {
  const map = new Map();
  for (const row of data.items || []) {
    const maskedMedian = toNumber(row.masked_median_price);
    const exactMedian = toNumber(row.exact_peer_median_price);
    if (!Number.isFinite(maskedMedian) || !Number.isFinite(exactMedian) || maskedMedian <= 0) continue;
    const diffRatio = Math.abs(maskedMedian - exactMedian) / maskedMedian;
    if (diffRatio > 0.2) continue;
    const match = {
      parcel: row.candidate_parcel,
      parcel_key: `PARCEL|${row.candidate_parcel}`,
      parcel_label: `${row.candidate_parcel} 가격연속 후보`,
      confidence_level: "candidate",
      stage: row.stage || "price_continuity",
      exact_peer_count: row.exact_peer_count,
      masked_median_price: maskedMedian,
      exact_peer_median_price: exactMedian,
      diff_ratio: diffRatio,
    };
    if (row.match_key) map.set(row.match_key, match);
    if (!row.match_key && row.masked_group) map.set(row.masked_group, match);
  }
  return map;
}

function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function percentile(values, ratio) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const index = (nums.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return nums[lower];
  return nums[lower] + (nums[upper] - nums[lower]) * (index - lower);
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function sum(values) {
  return values.filter((value) => Number.isFinite(value)).reduce((total, value) => total + value, 0);
}

function formatMillionWon(value) {
  if (!Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString("ko-KR");
}

function formatUnit(value) {
  if (!Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString("ko-KR");
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value && value !== "-"))];
}

function parseRoadFromOverride(override) {
  if (!override) return "";
  if (override.road) return override.road;
  const note = String(override.note || "");
  const roadFromNote = note
    .split(",")
    .map((part) => part.trim())
    .find((part) => /(?:로|길)\s*\d/.test(part));
  return roadFromNote || "";
}

function buildSearchText(parts) {
  const raw = parts
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part) => part !== null && part !== undefined && part !== "")
    .join(" ");
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function floorSortValue(floor) {
  const raw = String(floor || "").trim();
  if (!raw || raw === "층정보 없음") return 999;
  const normalized = raw.replace(/지하|B/gi, "-").replace(/[^0-9-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 999;
}

function areaBandFromPyeong(pyeong) {
  if (!Number.isFinite(pyeong)) return { label: "면적 미확인", order: 99 };
  if (pyeong < 10) return { label: "10평 미만", order: 10 };
  if (pyeong < 30) return { label: "10평 이상~30평 미만", order: 30 };
  if (pyeong < 50) return { label: "30평 이상~50평 미만", order: 50 };
  if (pyeong < 100) return { label: "50평 이상~100평 미만", order: 100 };
  return { label: "100평 이상", order: 120 };
}

function strictAreaBandFromPyeong(pyeong) {
  if (!Number.isFinite(pyeong)) return "면적 미확인";
  if (pyeong < 10) return "10평 미만";
  if (pyeong < 30) return "10~30평";
  if (pyeong < 50) return "30~50평";
  if (pyeong < 100) return "50~100평";
  return "100평 이상";
}

function isOfficeUse(record) {
  return String(record.main_use || "").includes("업무");
}

function isRetailUse(record) {
  return /근린생활|판매/.test(String(record.main_use || ""));
}

function reliabilityLabel({ transactionCount = 0, exactCount = 0, buildingCount = 0, isMasked = false }) {
  if (isMasked) return "C 보조";
  if (exactCount >= 30 && buildingCount >= 5) return "A 기준";
  if (transactionCount >= 10 || exactCount >= 10) return "B 참고";
  if (transactionCount >= 3) return "C 보조";
  return "D 확인";
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

const records = [];
const sourceFiles = [];
let activeSourceMode = "csv";
let apiSource = null;

for (const fileName of csvFiles) {
  const filePath = path.join(csvDir, fileName);
  const text = decoder.decode(fs.readFileSync(filePath));
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const periodLine = lines.find((line) => line.includes("계약일자"));
  const headerIndex = lines.findIndex((line) => line.startsWith('"NO","시군구"'));
  if (headerIndex === -1) continue;

  const headers = parseCsvLine(lines[headerIndex]);
  const year = Number((periodLine || "").match(/20\d{2}/)?.[0]);
  let rowCount = 0;

  for (const line of lines.slice(headerIndex + 1)) {
    const values = parseCsvLine(line);
    if (values.length < headers.length || !values[0]) continue;
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
    const area = toNumber(row["전용/연면적(㎡)"]);
    const exclusivePyeong = area ? area / SQM_PER_PYEONG : null;
    const contractArea = toNumber(row["계약면적(㎡)"]);
    const contractPyeong = contractArea ? contractArea / SQM_PER_PYEONG : null;
    const price = toNumber(row["거래금액(만원)"]);
    const contractMonth = row["계약년월"] || "";
    const contractYear = Number(contractMonth.slice(0, 4)) || year;
    const parcelRaw = row["지번"] || "";
    const isMaskedParcel = parcelRaw.includes("*") || parcelRaw === "";
    const parcelKey = isMaskedParcel
      ? `MASKED|${row["도로명"] || "도로명없음"}|${row["건축물주용도"] || "용도없음"}|${area || "면적없음"}`
      : `PARCEL|${parcelRaw}`;
    const buildingOverride = buildingOverrides[parcelKey];
    const buildingName = buildingOverride?.building_name || row["건물명"] || row["단지명"] || row["건축물명"] || "확인필요";
    const buildingNameStatus = buildingOverride?.status || (buildingName === "확인필요" ? "확인필요" : "CSV");
    const buildingNameSource = buildingOverride?.source || "";
    const road = row["도로명"] || parseRoadFromOverride(buildingOverride);
    const parcelLabel = isMaskedParcel
      ? `${parcelRaw || "지번없음"} · ${road || "도로명없음"} · ${row["건축물주용도"] || "용도없음"} · ${area || "-"}㎡`
      : parcelRaw;

    records.push({
      source_file: fileName,
      year: contractYear,
      month: contractMonth ? `${contractMonth.slice(0, 4)}-${contractMonth.slice(4, 6)}` : "",
      sigungu: row["시군구"],
      type: row["유형"],
      parcel: parcelRaw,
      road,
      zoning: row["용도지역"],
      main_use: row["건축물주용도"],
      road_condition: row["도로조건"],
      building_name: buildingName,
      building_name_status: buildingNameStatus,
      building_name_source: buildingNameSource,
      area_sqm: area,
      exclusive_pyeong: exclusivePyeong,
      contract_area_sqm: contractArea,
      contract_pyeong: contractPyeong,
      supply_area_sqm: null,
      supply_pyeong: null,
      direct_common_area_sqm: null,
      shared_common_area_sqm: null,
      land_area_sqm: toNumber(row["대지면적(㎡)"]),
      price_manwon: price,
      price_per_sqm_manwon: price && area ? price / area : null,
      exclusive_ppyeong_manwon: price && exclusivePyeong ? price / exclusivePyeong : null,
      supply_ppyeong_manwon: null,
      contract_ppyeong_manwon: price && contractPyeong ? price / contractPyeong : null,
      floor: row["층"],
      buyer: row["매수"],
      seller: row["매도"],
      contract_day: Number(row["계약일"]) || null,
      share_type: row["지분구분"],
      build_year: Number(row["건축년도"]) || null,
      cancel_date: row["해제사유발생일"],
      transaction_type: row["거래유형"],
      broker_location: row["중개사소재지"],
      parcel_key: parcelKey,
      parcel_label: parcelLabel,
      is_masked_parcel: isMaskedParcel,
    });
    rowCount += 1;
  }

  sourceFiles.push({
    file: fileName,
    period: (periodLine || "").replace(/^"|"$/g, ""),
    rows: rowCount,
    year,
  });
}

function normalizeApiItem(item, index) {
  const area = toNumber(item.buildingAr);
  const exclusivePyeong = area ? area / SQM_PER_PYEONG : null;
  const price = toNumber(item.dealAmount);
  const dealYear = Number(item.dealYear);
  const dealMonth = String(item.dealMonth || "").padStart(2, "0");
  const contractMonth = dealYear && dealMonth ? `${dealYear}${dealMonth}` : item.source_month || "";
  const parcelRaw = item.jibun || "";
  const isMaskedParcel = parcelRaw.includes("*") || parcelRaw === "";
  const mainUse = item.buildingUse || "용도없음";
  const areaLabel = area || "면적없음";
  const probableMatch = inferProbableBuildingMatch(item, area);
  const maskedFallbackKey = isMaskedParcel
    ? `MASKED|API|${mainUse}|${areaLabel}|${item.buildYear || "건축년도없음"}`
    : "";
  const officialMaskedMatch = isMaskedParcel
    ? maskedOfficialMatches.get(maskedOfficialKeyFromParts({
        sourceMonth: item.source_month,
        dealYear,
        dealMonth,
        dealDay: item.dealDay,
        maskedJibun: parcelRaw,
        use: mainUse,
        floor: item.floor,
        area,
        buildYear: item.buildYear,
        amount: item.dealAmount,
      }))
    : null;
  const officialMaskedMatchIsCandidateSet = Boolean(officialMaskedMatch?.parcel_key?.startsWith("CANDIDATE_SET|"));
  const recoveryMaskedMatch = (!officialMaskedMatch || officialMaskedMatchIsCandidateSet) && isMaskedParcel
    ? recoveryMaskedMatches.get(maskedOfficialKeyFromParts({
        sourceMonth: item.source_month,
        dealYear,
        dealMonth,
        dealDay: item.dealDay,
        maskedJibun: parcelRaw,
        use: mainUse,
        floor: item.floor,
        area,
        buildYear: item.buildYear,
        amount: item.dealAmount,
      })) || recoveryMaskedMatches.get(maskedFallbackKey)
    : null;
  const effectiveOfficialMaskedMatch = recoveryMaskedMatch && officialMaskedMatchIsCandidateSet ? null : officialMaskedMatch;
  const parcelKey = effectiveOfficialMaskedMatch?.parcel_key || recoveryMaskedMatch?.parcel_key || probableMatch?.parcel_key || (isMaskedParcel
    ? maskedFallbackKey
    : `PARCEL|${parcelRaw}`);
  const buildingOverride = buildingOverrides[parcelKey];
  const officialTitle = buildingTitleIndex.get(parcelKey);
  let buildingName = effectiveOfficialMaskedMatch?.building_name || probableMatch?.building_name || buildingOverride?.building_name || officialTitle?.names?.[0] || "확인필요";
  const titleNames = officialTitle?.names || [];
  const titleNameMatched = titleNames.some((name) => compactName(name) === compactName(buildingName));
  const singleOfficialCandidate = Boolean(effectiveOfficialMaskedMatch && effectiveOfficialMaskedMatch.candidate_parcel_count === 1 && !parcelKey.startsWith("CANDIDATE_SET|"));
  const officialTitleConfirmed = Boolean(titleNames.length && (titleNameMatched || titleNames.length === 1) && !parcelKey.startsWith("CANDIDATE_SET|"));
  if (officialTitleConfirmed && titleNames.length === 1) buildingName = titleNames[0];
  let buildingNameStatus = effectiveOfficialMaskedMatch
    ? effectiveOfficialMaskedMatch.confidence_level === "candidate" ? "후보" : "추정"
    : recoveryMaskedMatch
      ? "후보"
    : probableMatch?.building_name_status || buildingOverride?.status || "확인필요";
  if (officialTitleConfirmed) buildingNameStatus = "확인됨";
  let buildingNameSource = effectiveOfficialMaskedMatch
    ? `국토부 마스킹 실거래를 건축HUB 전유부 후보군과 대조: ${effectiveOfficialMaskedMatch.stage}, 후보필지 ${effectiveOfficialMaskedMatch.candidate_parcel_count}개`
    : recoveryMaskedMatch
      ? `가격연속 후보: 정확 지번 동일 용도·면적·건축년도 중위가 ${Math.round(recoveryMaskedMatch.diff_ratio * 1000) / 10}% 이내`
    : probableMatch?.building_name_source || buildingOverride?.source || "";
  if (officialTitleConfirmed) {
    buildingNameSource = [buildingNameSource, "국토교통부 건축HUB 표제부 건물명 확인"].filter(Boolean).join(" / ");
  }
  const road = effectiveOfficialMaskedMatch?.road || probableMatch?.road || parseRoadFromOverride(buildingOverride);
  const parcelLabel = effectiveOfficialMaskedMatch?.parcel_label || recoveryMaskedMatch?.parcel_label || probableMatch?.parcel_label || (isMaskedParcel
    ? `${parcelRaw || "지번없음"} · API · ${mainUse} · ${area || "-"}㎡`
    : parcelRaw);
  const contractArea = probableMatch?.contract_area_sqm ?? null;
  const contractPyeong = contractArea ? contractArea / SQM_PER_PYEONG : null;
  const supplyArea = probableMatch?.direct_common_area_sqm
    ? area + probableMatch.direct_common_area_sqm
    : null;
  const supplyPyeong = supplyArea ? supplyArea / SQM_PER_PYEONG : null;

  return {
    source_file: `API:${item.source_month || contractMonth || index}`,
    source_kind: "public-api",
    year: dealYear,
    month: contractMonth ? `${contractMonth.slice(0, 4)}-${contractMonth.slice(4, 6)}` : "",
    sigungu: `서울특별시 ${item.sggNm || "강서구"} ${item.umdNm || "마곡동"}`,
    type: item.buildingType || "",
    parcel: effectiveOfficialMaskedMatch?.parcel || recoveryMaskedMatch?.parcel || probableMatch?.parcel || parcelRaw,
    road,
    zoning: item.landUse || "",
    main_use: mainUse,
    road_condition: "",
    building_name: buildingName,
    building_name_status: buildingNameStatus,
    building_name_source: buildingNameSource,
    official_title_confirmed: officialTitleConfirmed,
    official_single_candidate_match: singleOfficialCandidate,
    masked_match_stage: effectiveOfficialMaskedMatch?.stage || recoveryMaskedMatch?.stage || probableMatch?.match_confidence || "",
    area_sqm: area,
    exclusive_pyeong: exclusivePyeong,
    contract_area_sqm: contractArea,
    contract_pyeong: contractPyeong,
    supply_area_sqm: supplyArea,
    supply_pyeong: supplyPyeong,
    direct_common_area_sqm: probableMatch?.direct_common_area_sqm ?? null,
    shared_common_area_sqm: probableMatch?.shared_common_area_sqm ?? null,
    land_area_sqm: toNumber(item.plottageAr),
    price_manwon: price,
    price_per_sqm_manwon: price && area ? price / area : null,
    exclusive_ppyeong_manwon: price && exclusivePyeong ? price / exclusivePyeong : null,
    supply_ppyeong_manwon: price && supplyPyeong ? price / supplyPyeong : null,
    contract_ppyeong_manwon: price && contractPyeong ? price / contractPyeong : null,
    floor: item.floor || "",
    buyer: item.buyerGbn || "",
    seller: item.slerGbn || "",
    contract_day: Number(item.dealDay) || null,
    share_type: item.shareDealingType || "",
    build_year: Number(item.buildYear) || null,
    cancel_date: item.cdealDay || "",
    transaction_type: item.dealingGbn || "",
    broker_location: item.estateAgentSggNm || "",
    parcel_key: parcelKey,
    parcel_label: parcelLabel,
    is_masked_parcel: isMaskedParcel && !effectiveOfficialMaskedMatch && !recoveryMaskedMatch && !probableMatch,
    original_is_masked_parcel: isMaskedParcel,
    official_masked_match_key: effectiveOfficialMaskedMatch?.parcel_key || "",
    recovery_masked_match_key: recoveryMaskedMatch?.parcel_key || "",
    probable_parcel_key: effectiveOfficialMaskedMatch?.parcel_key || probableMatch?.parcel_key || "",
    building_match_confidence: effectiveOfficialMaskedMatch
      ? `official_${effectiveOfficialMaskedMatch.confidence_level}_${effectiveOfficialMaskedMatch.stage}`
      : recoveryMaskedMatch
        ? `recovery_candidate_${recoveryMaskedMatch.stage}`
      : probableMatch?.match_confidence || "",
    building_match_note: effectiveOfficialMaskedMatch
      ? `마스킹 지번 ${parcelRaw}를 ${effectiveOfficialMaskedMatch.unit_sample || "전유부 후보"} 공식 후보군 유일 필지와 대조`
      : recoveryMaskedMatch
        ? `마스킹 그룹 ${maskedFallbackKey}를 가격연속 후보 ${recoveryMaskedMatch.parcel}와 대조`
      : probableMatch
      ? `마스킹 지번 ${parcelRaw}를 ${probableMatch.matched_unit_sample || "호실 후보"} 전유면적과 대조`
      : "",
    contract_area_source: probableMatch ? "건축HUB 전유공용면적 추정 매칭" : undefined,
    contract_area_confidence: probableMatch?.match_confidence || undefined,
    area_source: probableMatch ? "probable_masked_exclusive_common" : undefined,
    area_basis: probableMatch ? "exclusive_plus_common" : undefined,
    area_confidence: probableMatch?.match_confidence || undefined,
    contract_area_matched_room_count: probableMatch?.matched_room_count,
    contract_area_matched_unit_sample: probableMatch?.matched_unit_sample || "",
    contract_area_matched_exclusive_area_sqm: probableMatch?.matched_exclusive_area_sqm,
    contract_area_exclusive_delta_sqm: probableMatch?.exclusive_area_delta_sqm,
  };
}

if (fs.existsSync(apiRawPath)) {
  const rawApi = JSON.parse(fs.readFileSync(apiRawPath, "utf8"));
  const activeItems = (rawApi.items || []).filter((item) => item.cdealType !== "O" && !item.cdealDay);
  records.splice(0, records.length, ...activeItems.map(normalizeApiItem).filter((record) => record.year && record.month));
  activeSourceMode = "public-api";
  apiSource = {
    file: path.relative(root, apiRawPath),
    generated_at: rawApi.generated_at,
    raw_rows: rawApi.row_count,
    active_rows: records.length,
    canceled_rows: (rawApi.items || []).length - activeItems.length,
    target: rawApi.target,
    monthly_counts: rawApi.monthly_counts,
  };
}

if (contractAreaMatches?.matches) {
  for (const record of records) {
    const match = contractAreaMatches.matches[recordKey(record)];
    if (!match || !Number.isFinite(match.contract_area_sqm)) continue;
    const contractPyeong = match.contract_area_sqm / SQM_PER_PYEONG;
    record.common_area_sqm = match.common_area_sqm;
    record.direct_common_area_sqm = match.direct_common_area_sqm;
    record.shared_common_area_sqm = match.shared_common_area_sqm;
    record.supply_area_sqm = match.supply_area_sqm;
    record.contract_area_sqm = match.contract_area_sqm;
    record.supply_pyeong = Number.isFinite(match.supply_area_sqm) ? match.supply_area_sqm / SQM_PER_PYEONG : null;
    record.contract_pyeong = contractPyeong;
    record.supply_ppyeong_manwon = record.price_manwon && record.supply_pyeong ? record.price_manwon / record.supply_pyeong : null;
    record.contract_ppyeong_manwon = record.price_manwon && contractPyeong ? record.price_manwon / contractPyeong : null;
    record.contract_area_source = match.source;
    record.contract_area_confidence = match.confidence;
    record.area_source = match.area_source;
    record.area_basis = match.area_basis;
    record.area_confidence = match.area_confidence;
    record.contract_area_matched_room_count = match.matched_room_count;
    record.contract_area_matched_unit_sample = match.matched_unit_sample || "";
    record.contract_area_matched_exclusive_area_sqm = match.matched_exclusive_area_sqm;
    record.contract_area_exclusive_delta_sqm = match.exclusive_area_delta_sqm;
  }
}

const bulkDealMap = new Map();
for (const record of records) {
  if (!record.parcel_key || !record.month || !record.contract_day) continue;
  const key = `${record.parcel_key}|${record.month}|${record.contract_day}`;
  if (!bulkDealMap.has(key)) bulkDealMap.set(key, []);
  bulkDealMap.get(key).push(record);
}

for (const [key, groupRows] of bulkDealMap.entries()) {
  const distinctFloors = new Set(groupRows.map((row) => floorSortValue(row.floor)).filter((floor) => Number.isFinite(floor) && floor !== 999));
  const totalAreaSqm = sum(groupRows.map((row) => row.area_sqm));
  const totalPriceManwon = sum(groupRows.map((row) => row.price_manwon));
  const isBulkBuildingDeal = groupRows.length >= 5 && distinctFloors.size >= 3 && totalAreaSqm >= 1000;
  if (!isBulkBuildingDeal) continue;
  for (const record of groupRows) {
    record.bulk_deal_key = key;
    record.bulk_deal_candidate = true;
    record.bulk_deal_record_count = groupRows.length;
    record.bulk_deal_floor_count = distinctFloors.size;
    record.bulk_deal_total_area_sqm = totalAreaSqm;
    record.bulk_deal_total_price_manwon = totalPriceManwon;
  }
}

function analysisExclusionReasons(record) {
  const reasons = [];
  if (String(record.parcel_key || "").startsWith("CANDIDATE_SET|")) reasons.push("복수 후보필지");
  if (String(record.share_type || "").includes("지분")) reasons.push("지분거래");
  if (!Number.isFinite(record.price_manwon) || record.price_manwon <= 0) reasons.push("거래금액 없음");
  if (!Number.isFinite(record.area_sqm) || record.area_sqm <= 0) reasons.push("면적 없음");
  if (Number.isFinite(record.area_sqm) && record.area_sqm > 1000) reasons.push("대형/일괄거래 후보");
  if (record.bulk_deal_candidate) reasons.push("일괄/통건물 거래 후보");
  if (Number.isFinite(record.exclusive_ppyeong_manwon) && record.exclusive_ppyeong_manwon < 900) reasons.push("저단가 검토");
  return reasons;
}

for (const record of records) {
  record.analysis_exclusion_reasons = analysisExclusionReasons(record);
  record.analysis_eligible = record.analysis_exclusion_reasons.length === 0;
}

const analysisRecords = records.filter((record) => record.analysis_eligible);

function refinementUseCategory(record) {
  if (isRetailUse(record)) return "근린생활시설";
  if (isOfficeUse(record)) return "업무시설";
  return "기타";
}

function buildIqrStats(rows) {
  const values = rows.map((row) => row.exclusive_ppyeong_manwon).filter(Number.isFinite);
  if (values.length < 10) return null;
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr <= 0) return null;
  return {
    count: values.length,
    q1,
    q3,
    lower: Math.max(0, q1 - iqr * 1.5),
    upper: q3 + iqr * 1.5,
  };
}

const refinementCohortMap = new Map();
for (const record of analysisRecords) {
  const band = strictAreaBandFromPyeong(record.exclusive_pyeong);
  const key = `${refinementUseCategory(record)}|${band}`;
  if (!refinementCohortMap.has(key)) refinementCohortMap.set(key, []);
  refinementCohortMap.get(key).push(record);
}

const refinementCohortStats = new Map(
  [...refinementCohortMap.entries()].map(([key, rows]) => [key, buildIqrStats(rows)])
);

function annotateRefinement(record) {
  if (record.analysis_eligible === false) {
    record.refinement_tier = "제외";
    record.refinement_score = 0;
    record.refinement_reasons = record.analysis_exclusion_reasons || ["기준값 산식 제외"];
    record.refinement_outlier_candidate = false;
    return;
  }
  const band = strictAreaBandFromPyeong(record.exclusive_pyeong);
  const cohortKey = `${refinementUseCategory(record)}|${band}`;
  const stats = refinementCohortStats.get(cohortKey);
  const reasons = [];
  let score = 100;
  const value = record.exclusive_ppyeong_manwon;
  const outlier = Boolean(stats && Number.isFinite(value) && (value < stats.lower || value > stats.upper));
  const stage = String(record.masked_match_stage || "");
  const officialSingleConfirmed = Boolean(record.official_title_confirmed && record.official_single_candidate_match && !String(record.parcel_key || "").startsWith("CANDIDATE_SET|"));
  const strongOfficialSingle = officialSingleConfirmed && /usage_floor_area_year|usage_floor_area$|usage_floor_area_tolerance_005/.test(stage);
  if (outlier) {
    score -= 30;
    reasons.push("IQR 이상치 후보");
  }
  if (record.is_masked_parcel || record.probable_parcel_key || String(record.parcel_key || "").startsWith("CANDIDATE_SET|")) {
    if (strongOfficialSingle) {
      record.refinement_promotion = "공식 표제부+단일 후보+층면적 매칭";
    } else if (officialSingleConfirmed) {
      score -= 8;
      record.refinement_promotion = "공식 표제부+단일 후보";
      reasons.push("단일 후보 약식매칭");
    } else {
      score -= 18;
      reasons.push("마스킹/추정 귀속");
    }
  }
  if (record.building_name_status !== "확인됨") {
    score -= 12;
    reasons.push("건물명 미확인");
  }
  if (!Number.isFinite(record.contract_area_sqm)) {
    score -= 5;
    reasons.push("계약면적 미매칭");
  }
  const cohortCount = stats?.count || (refinementCohortMap.get(cohortKey) || []).length;
  if (cohortCount < 10) {
    score -= 10;
    reasons.push("코호트 표본 10건 미만");
  }
  record.refinement_score = Math.max(0, score);
  record.refinement_outlier_candidate = outlier;
  record.refinement_cohort_key = cohortKey;
  record.refinement_cohort_count = cohortCount;
  record.refinement_reasons = reasons;
  record.refinement_tier = record.refinement_score >= 90
    ? "A 기준"
    : record.refinement_score >= 75
      ? "B 참고"
      : record.refinement_score >= 55
        ? "C 보조"
        : "D 확인";
}

for (const record of records) annotateRefinement(record);

const refinementSummary = {
  total_records: records.length,
  analysis_records: analysisRecords.length,
  refined_benchmark_records: records.filter((record) => ["A 기준", "B 참고"].includes(record.refinement_tier) && !record.refinement_outlier_candidate).length,
  outlier_candidate_records: records.filter((record) => record.refinement_outlier_candidate).length,
  tier_counts: ["A 기준", "B 참고", "C 보조", "D 확인", "제외"].map((tier) => ({
    tier,
    count: records.filter((record) => record.refinement_tier === tier).length,
  })),
  cohort_count: refinementCohortStats.size,
  cohort_stats: [...refinementCohortStats.entries()].map(([key, stats]) => ({
    key,
    count: stats?.count || (refinementCohortMap.get(key) || []).length,
    lower: stats?.lower ?? null,
    upper: stats?.upper ?? null,
  })),
};

const years = [...new Set(records.map((record) => record.year).filter(Boolean))].sort((a, b) => a - b);
const desiredYears = Array.from({ length: 10 }, (_, index) => 2026 - index).reverse();
const missingYears = desiredYears.filter((year) => !years.includes(year));
const grouped = new Map();

for (const record of analysisRecords) {
  if (!grouped.has(record.parcel_key)) {
    grouped.set(record.parcel_key, {
      parcel_key: record.parcel_key,
      parcel_label: record.parcel_label,
      parcel: record.parcel,
      road: record.road,
      building_name: record.building_name,
      building_name_status: record.building_name_status,
      building_name_source: record.building_name_source,
      main_use: record.main_use,
      zoning: record.zoning,
      is_masked_parcel: record.is_masked_parcel,
      rows: [],
    });
  }
  grouped.get(record.parcel_key).rows.push(record);
}

const yearly = [];
for (const group of grouped.values()) {
  const byYear = new Map();
  for (const record of group.rows) {
    if (!byYear.has(record.year)) byYear.set(record.year, []);
    byYear.get(record.year).push(record);
  }
  for (const [year, rows] of byYear) {
    yearly.push({
      parcel_key: group.parcel_key,
      parcel_label: group.parcel_label,
      parcel: group.parcel,
      road: group.road,
      building_name: group.building_name,
      main_use: group.main_use,
      zoning: group.zoning,
      is_masked_parcel: group.is_masked_parcel,
      year,
      count: rows.length,
      avg_price_manwon: average(rows.map((row) => row.price_manwon)),
      median_price_manwon: median(rows.map((row) => row.price_manwon)),
      avg_ppsqm_manwon: average(rows.map((row) => row.price_per_sqm_manwon)),
      median_ppsqm_manwon: median(rows.map((row) => row.price_per_sqm_manwon)),
      median_exclusive_ppyeong_manwon: median(rows.map((row) => row.exclusive_ppyeong_manwon)),
      median_supply_ppyeong_manwon: median(rows.map((row) => row.supply_ppyeong_manwon)),
      median_contract_ppyeong_manwon: median(rows.map((row) => row.contract_ppyeong_manwon)),
      avg_area_sqm: average(rows.map((row) => row.area_sqm)),
    });
  }
}

const groupSummaries = [...grouped.values()].map((group) => {
  const rows = group.rows;
  const firstYear = Math.min(...rows.map((row) => row.year));
  const lastYear = Math.max(...rows.map((row) => row.year));
  const firstRows = rows.filter((row) => row.year === firstYear);
  const lastRows = rows.filter((row) => row.year === lastYear);
  const firstMedian = median(firstRows.map((row) => row.price_per_sqm_manwon));
  const lastMedian = median(lastRows.map((row) => row.price_per_sqm_manwon));
  const changePct = firstMedian && lastMedian ? ((lastMedian - firstMedian) / firstMedian) * 100 : null;
  return {
    parcel_key: group.parcel_key,
    parcel_label: group.parcel_label,
    parcel: group.parcel,
      road: group.road,
      building_name: uniqueValues(rows.map((row) => row.building_name))[0] || "확인필요",
      building_names: uniqueValues(rows.map((row) => row.building_name)),
    building_name_status: rows.some((row) => row.building_name_status === "확인됨")
      ? "확인됨"
      : uniqueValues(rows.map((row) => row.building_name_status))[0] || "확인필요",
    building_name_source: uniqueValues(rows.map((row) => row.building_name_source))[0] || "",
    main_use: group.main_use,
    zoning: group.zoning,
    is_masked_parcel: rows.every((row) => row.is_masked_parcel),
    probable_masked_count: rows.filter((row) => row.probable_parcel_key).length,
    transaction_count: rows.length,
    observed_years: [...new Set(rows.map((row) => row.year))].sort((a, b) => a - b),
    first_year: firstYear,
    last_year: lastYear,
    first_median_ppsqm_manwon: firstMedian,
    last_median_ppsqm_manwon: lastMedian,
    ppsqm_change_pct: changePct,
    median_price_manwon: median(rows.map((row) => row.price_manwon)),
    avg_price_manwon: average(rows.map((row) => row.price_manwon)),
    median_ppsqm_manwon: median(rows.map((row) => row.price_per_sqm_manwon)),
    median_exclusive_ppyeong_manwon: median(rows.map((row) => row.exclusive_ppyeong_manwon)),
      median_supply_ppyeong_manwon: median(rows.map((row) => row.supply_ppyeong_manwon)),
      median_contract_ppyeong_manwon: median(rows.map((row) => row.contract_ppyeong_manwon)),
      contract_area_status: rows.some((row) => Number.isFinite(row.contract_area_sqm)) ? "계약면적 있음" : "계약면적 없음",
      search_text: buildSearchText([
        group.parcel_key,
        group.parcel_label,
        group.parcel,
        group.road,
        uniqueValues(rows.map((row) => row.building_name)),
        uniqueValues(rows.map((row) => row.building_name_source)),
        group.main_use,
        group.zoning,
      ]),
  };
});

const topGroups = groupSummaries
  .filter((group) => group.transaction_count >= 3)
  .sort((a, b) => Math.abs(b.ppsqm_change_pct || 0) - Math.abs(a.ppsqm_change_pct || 0))
  .slice(0, 20);

const exactGroups = groupSummaries.filter((group) => !group.is_masked_parcel);
const maskedGroups = groupSummaries.filter((group) => group.is_masked_parcel);
const officialMaskedMatchedRecords = records.filter((record) => record.official_masked_match_key).length;
const recoveryMaskedMatchedRecords = records.filter((record) => record.recovery_masked_match_key).length;
const officialCandidateSetRecords = records.filter((record) => String(record.official_masked_match_key || "").startsWith("CANDIDATE_SET|")).length;
const unresolvedHighConfidenceMaskedRecords = (() => {
  if (!fs.existsSync(maskedOfficialAnalysisPath)) return null;
  const analysis = JSON.parse(fs.readFileSync(maskedOfficialAnalysisPath, "utf8"));
  const highConfidence = analysis.summary?.high_confidence_unique_rows ?? 0;
  return Math.max(0, highConfidence - officialMaskedMatchedRecords);
})();
const yearSummary = years.map((year) => {
  const rows = analysisRecords.filter((record) => record.year === year);
  return {
    year,
    count: rows.length,
    median_price_manwon: median(rows.map((row) => row.price_manwon)),
    avg_price_manwon: average(rows.map((row) => row.price_manwon)),
    median_ppsqm_manwon: median(rows.map((row) => row.price_per_sqm_manwon)),
    median_exclusive_ppyeong_manwon: median(rows.map((row) => row.exclusive_ppyeong_manwon)),
    median_supply_ppyeong_manwon: median(rows.map((row) => row.supply_ppyeong_manwon)),
    median_contract_ppyeong_manwon: median(rows.map((row) => row.contract_ppyeong_manwon)),
    masked_count: rows.filter((row) => row.is_masked_parcel).length,
  };
});

const buildingFloorUseMap = new Map();
for (const record of records) {
  const floorLabel = record.floor && record.floor.trim() !== "" ? record.floor.trim() : "층정보 없음";
  const useLabel = record.main_use && record.main_use.trim() !== "" ? record.main_use.trim() : "용도 없음";
  const key = `${record.parcel_key}|${floorLabel}|${useLabel}`;
  if (!buildingFloorUseMap.has(key)) {
    buildingFloorUseMap.set(key, {
      parcel_key: record.parcel_key,
      parcel_label: record.parcel_label,
      parcel: record.parcel,
      road: record.road,
      building_name: record.building_name,
      building_name_status: record.building_name_status,
      building_name_source: record.building_name_source,
      is_masked_parcel: record.is_masked_parcel,
      floor: floorLabel,
      business_type: useLabel,
      rows: [],
    });
  }
  buildingFloorUseMap.get(key).rows.push(record);
}

const buildingFloorUseSummary = [...buildingFloorUseMap.values()]
  .map((group) => ({
    parcel_key: group.parcel_key,
    parcel_label: group.parcel_label,
    parcel: group.parcel,
    road: group.road,
    building_name: group.building_name,
    building_name_status: group.building_name_status,
    building_name_source: group.building_name_source,
    is_masked_parcel: group.is_masked_parcel,
    floor: group.floor,
    business_type: group.business_type,
    transaction_count: group.rows.length,
    observed_years: [...new Set(group.rows.map((row) => row.year))].sort((a, b) => a - b),
    total_price_manwon: sum(group.rows.map((row) => row.price_manwon)),
    avg_price_manwon: average(group.rows.map((row) => row.price_manwon)),
    median_price_manwon: median(group.rows.map((row) => row.price_manwon)),
    min_price_manwon: Math.min(...group.rows.map((row) => row.price_manwon).filter(Number.isFinite)),
    max_price_manwon: Math.max(...group.rows.map((row) => row.price_manwon).filter(Number.isFinite)),
    avg_area_sqm: average(group.rows.map((row) => row.area_sqm)),
    avg_exclusive_ppyeong_manwon: average(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
    median_exclusive_ppyeong_manwon: median(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
  }))
  .sort((a, b) => b.transaction_count - a.transaction_count || b.avg_price_manwon - a.avg_price_manwon);

const officeRows = analysisRecords.filter(isOfficeUse);
const officeAreaBandMap = new Map();
for (const record of officeRows) {
  const band = areaBandFromPyeong(record.exclusive_pyeong);
  if (!officeAreaBandMap.has(band.label)) {
    officeAreaBandMap.set(band.label, {
      band_label: band.label,
      band_order: band.order,
      rows: [],
    });
  }
  officeAreaBandMap.get(band.label).rows.push(record);
}

const sameDayFloorMap = new Map();
for (const record of officeRows.filter((row) => !row.is_masked_parcel && row.month && row.contract_day && row.floor)) {
  const key = `${record.parcel_key}|${record.month}|${record.contract_day}|${record.floor}`;
  if (!sameDayFloorMap.has(key)) {
    sameDayFloorMap.set(key, {
      parcel_key: record.parcel_key,
      parcel_label: record.parcel_label,
      road: record.road,
      building_name: record.building_name,
      building_name_status: record.building_name_status,
      floor: record.floor,
      contract_date: `${record.month}-${String(record.contract_day).padStart(2, "0")}`,
      rows: [],
    });
  }
  sameDayFloorMap.get(key).rows.push(record);
}

const officeSameDayFloorSummary = [...sameDayFloorMap.values()]
  .filter((group) => group.rows.length >= 2)
  .map((group) => {
    const totalPrice = sum(group.rows.map((row) => row.price_manwon));
    const totalExclusiveArea = sum(group.rows.map((row) => row.area_sqm));
    const totalSupplyArea = sum(group.rows.map((row) => row.supply_area_sqm));
    const totalContractArea = sum(group.rows.map((row) => row.contract_area_sqm));
    const totalExclusivePyeong = sum(group.rows.map((row) => row.exclusive_pyeong));
    const totalSupplyPyeong = sum(group.rows.map((row) => row.supply_pyeong));
    const totalContractPyeong = sum(group.rows.map((row) => row.contract_pyeong));
    const exclusiveAreas = group.rows.map((row) => row.exclusive_pyeong).filter(Number.isFinite);
    const bundleAreaBand = areaBandFromPyeong(totalExclusivePyeong);
    return {
      parcel_key: group.parcel_key,
      parcel_label: group.parcel_label,
      building_name: group.building_name,
      building_name_status: group.building_name_status,
      road: group.rows[0]?.road || "",
      floor: group.floor,
      contract_date: group.contract_date,
      area_bands: uniqueValues(group.rows.map((row) => areaBandFromPyeong(row.exclusive_pyeong).label)),
      bundle_area_band: bundleAreaBand.label,
      bundle_area_band_order: bundleAreaBand.order,
      transaction_count: group.rows.length,
      total_price_manwon: totalPrice,
      total_exclusive_area_sqm: totalExclusiveArea,
      total_supply_area_sqm: totalSupplyArea,
      total_contract_area_sqm: totalContractArea,
      total_exclusive_pyeong: totalExclusivePyeong,
      total_supply_pyeong: totalSupplyPyeong,
      total_contract_pyeong: totalContractPyeong,
      area_range_pyeong: exclusiveAreas.length ? [Math.min(...exclusiveAreas), Math.max(...exclusiveAreas)] : [],
      unit_area_summary_pyeong: uniqueValues(group.rows.map((row) => Number.isFinite(row.exclusive_pyeong) ? `${row.exclusive_pyeong.toFixed(1)}평` : "")),
      avg_price_manwon: average(group.rows.map((row) => row.price_manwon)),
      median_price_manwon: median(group.rows.map((row) => row.price_manwon)),
      bundle_exclusive_ppyeong_manwon: totalPrice && totalExclusivePyeong ? totalPrice / totalExclusivePyeong : null,
      bundle_supply_ppyeong_manwon: totalPrice && totalSupplyPyeong ? totalPrice / totalSupplyPyeong : null,
      bundle_contract_ppyeong_manwon: totalPrice && totalContractPyeong ? totalPrice / totalContractPyeong : null,
      avg_exclusive_ppyeong_manwon: average(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
      median_exclusive_ppyeong_manwon: median(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
      median_supply_ppyeong_manwon: median(group.rows.map((row) => row.supply_ppyeong_manwon)),
      median_contract_ppyeong_manwon: median(group.rows.map((row) => row.contract_ppyeong_manwon)),
    };
  })
  .sort((a, b) => b.contract_date.localeCompare(a.contract_date) || b.transaction_count - a.transaction_count)
  .slice(0, 80);

const officeAreaBandSummary = [...officeAreaBandMap.values()]
  .map((group) => {
    const sameDayGroupCount = [...sameDayFloorMap.values()]
      .filter((sameDayGroup) => {
        if (sameDayGroup.rows.length < 2) return false;
        const rowBandMatched = sameDayGroup.rows.some((row) => areaBandFromPyeong(row.exclusive_pyeong).label === group.band_label);
        const bundleBandMatched = areaBandFromPyeong(sum(sameDayGroup.rows.map((row) => row.exclusive_pyeong))).label === group.band_label;
        return rowBandMatched || bundleBandMatched;
      }).length;
    return {
      band_label: group.band_label,
      band_order: group.band_order,
      transaction_count: group.rows.length,
      exact_count: group.rows.filter((row) => !row.is_masked_parcel).length,
      masked_count: group.rows.filter((row) => row.is_masked_parcel).length,
      building_count: new Set(group.rows.filter((row) => !row.is_masked_parcel).map((row) => row.parcel_key)).size,
      observed_years: [...new Set(group.rows.map((row) => row.year))].sort((a, b) => a - b),
      avg_area_pyeong: average(group.rows.map((row) => row.exclusive_pyeong)),
      avg_price_manwon: average(group.rows.map((row) => row.price_manwon)),
      median_price_manwon: median(group.rows.map((row) => row.price_manwon)),
      avg_exclusive_ppyeong_manwon: average(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
      median_exclusive_ppyeong_manwon: median(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
      p25_exclusive_ppyeong_manwon: percentile(group.rows.map((row) => row.exclusive_ppyeong_manwon), 0.25),
      p75_exclusive_ppyeong_manwon: percentile(group.rows.map((row) => row.exclusive_ppyeong_manwon), 0.75),
      median_supply_ppyeong_manwon: median(group.rows.map((row) => row.supply_ppyeong_manwon)),
      median_contract_ppyeong_manwon: median(group.rows.map((row) => row.contract_ppyeong_manwon)),
      contract_matched_count: group.rows.filter((row) => Number.isFinite(row.contract_area_sqm)).length,
      same_day_floor_group_count: sameDayGroupCount,
      reliability: reliabilityLabel({
        transactionCount: group.rows.length,
        exactCount: group.rows.filter((row) => !row.is_masked_parcel).length,
        buildingCount: new Set(group.rows.filter((row) => !row.is_masked_parcel).map((row) => row.parcel_key)).size,
      }),
    };
  })
  .sort((a, b) => a.band_order - b.band_order);

const officeBandYearMap = new Map();
const officeBandMonthMap = new Map();
const officeBandBuildingMap = new Map();
for (const record of officeRows) {
  const band = areaBandFromPyeong(record.exclusive_pyeong);
  const yearKey = `${band.label}|${record.year}`;
  if (!officeBandYearMap.has(yearKey)) {
    officeBandYearMap.set(yearKey, {
      band_label: band.label,
      band_order: band.order,
      year: record.year,
      rows: [],
    });
  }
  officeBandYearMap.get(yearKey).rows.push(record);

  if (record.month) {
    const monthKey = `${band.label}|${record.month}`;
    if (!officeBandMonthMap.has(monthKey)) {
      officeBandMonthMap.set(monthKey, {
        band_label: band.label,
        band_order: band.order,
        month: record.month,
        rows: [],
      });
    }
    officeBandMonthMap.get(monthKey).rows.push(record);
  }

  const buildingKey = `${band.label}|${record.parcel_key}`;
  if (!officeBandBuildingMap.has(buildingKey)) {
    officeBandBuildingMap.set(buildingKey, {
      band_label: band.label,
      band_order: band.order,
      parcel_key: record.parcel_key,
      parcel_label: record.parcel_label,
      building_name: record.building_name,
      building_name_status: record.building_name_status,
      is_masked_parcel: record.is_masked_parcel,
      rows: [],
    });
  }
  officeBandBuildingMap.get(buildingKey).rows.push(record);
}

function officeTrendRow(group) {
  return {
    band_label: group.band_label,
    band_order: group.band_order,
    year: group.year,
    month: group.month,
    transaction_count: group.rows.length,
    exact_count: group.rows.filter((row) => !row.is_masked_parcel).length,
    building_count: new Set(group.rows.filter((row) => !row.is_masked_parcel).map((row) => row.parcel_key)).size,
    avg_area_pyeong: average(group.rows.map((row) => row.exclusive_pyeong)),
    avg_price_manwon: average(group.rows.map((row) => row.price_manwon)),
    median_price_manwon: median(group.rows.map((row) => row.price_manwon)),
    avg_exclusive_ppyeong_manwon: average(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
    median_exclusive_ppyeong_manwon: median(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
    median_supply_ppyeong_manwon: median(group.rows.map((row) => row.supply_ppyeong_manwon)),
    median_contract_ppyeong_manwon: median(group.rows.map((row) => row.contract_ppyeong_manwon)),
  };
}

const officeAreaBandYearSeries = [...officeBandYearMap.values()]
  .map(officeTrendRow)
  .sort((a, b) => a.band_order - b.band_order || a.year - b.year);

const officeAreaBandMonthSeries = [...officeBandMonthMap.values()]
  .map(officeTrendRow)
  .sort((a, b) => a.band_order - b.band_order || a.month.localeCompare(b.month));

const officeAreaBandBuildingSummary = [...officeBandBuildingMap.values()]
  .map((group) => ({
    band_label: group.band_label,
    band_order: group.band_order,
    parcel_key: group.parcel_key,
    parcel_label: group.parcel_label,
    building_name: group.building_name,
    building_name_status: group.building_name_status,
    is_masked_parcel: group.is_masked_parcel,
    transaction_count: group.rows.length,
    observed_years: [...new Set(group.rows.map((row) => row.year))].sort((a, b) => a - b),
    observed_months: [...new Set(group.rows.map((row) => row.month).filter(Boolean))].sort(),
    avg_area_pyeong: average(group.rows.map((row) => row.exclusive_pyeong)),
    avg_price_manwon: average(group.rows.map((row) => row.price_manwon)),
    median_price_manwon: median(group.rows.map((row) => row.price_manwon)),
    avg_exclusive_ppyeong_manwon: average(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
    median_exclusive_ppyeong_manwon: median(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
    p25_exclusive_ppyeong_manwon: percentile(group.rows.map((row) => row.exclusive_ppyeong_manwon), 0.25),
    p75_exclusive_ppyeong_manwon: percentile(group.rows.map((row) => row.exclusive_ppyeong_manwon), 0.75),
    median_supply_ppyeong_manwon: median(group.rows.map((row) => row.supply_ppyeong_manwon)),
    median_contract_ppyeong_manwon: median(group.rows.map((row) => row.contract_ppyeong_manwon)),
    contract_matched_count: group.rows.filter((row) => Number.isFinite(row.contract_area_sqm)).length,
    reliability: reliabilityLabel({
      transactionCount: group.rows.length,
      exactCount: group.is_masked_parcel ? 0 : group.rows.length,
      buildingCount: group.is_masked_parcel ? 0 : 1,
      isMasked: group.is_masked_parcel,
    }),
  }))
  .sort((a, b) => a.band_order - b.band_order || b.transaction_count - a.transaction_count || (b.median_exclusive_ppyeong_manwon || 0) - (a.median_exclusive_ppyeong_manwon || 0));

const retailFloorMap = new Map();
for (const record of analysisRecords.filter((row) => isRetailUse(row) && !row.is_masked_parcel)) {
  const floorLabel = record.floor && record.floor.trim() !== "" ? record.floor.trim() : "층정보 없음";
  const key = `${record.parcel_key}|${floorLabel}`;
  if (!retailFloorMap.has(key)) {
    retailFloorMap.set(key, {
      parcel_key: record.parcel_key,
      parcel_label: record.parcel_label,
      building_name: record.building_name,
      building_name_status: record.building_name_status,
      road: record.road,
      floor: floorLabel,
      floor_order: floorSortValue(floorLabel),
      rows: [],
    });
  }
  retailFloorMap.get(key).rows.push(record);
}

const retailFloorSummary = [...retailFloorMap.values()]
  .map((group) => ({
    parcel_key: group.parcel_key,
    parcel_label: group.parcel_label,
    building_name: group.building_name,
    building_name_status: group.building_name_status,
    road: group.road,
    floor: group.floor,
    road: group.road,
    floor_order: group.floor_order,
    transaction_count: group.rows.length,
    main_uses: uniqueValues(group.rows.map((row) => row.main_use)),
    observed_years: [...new Set(group.rows.map((row) => row.year))].sort((a, b) => a - b),
    avg_price_manwon: average(group.rows.map((row) => row.price_manwon)),
    median_price_manwon: median(group.rows.map((row) => row.price_manwon)),
    avg_exclusive_ppyeong_manwon: average(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
    median_exclusive_ppyeong_manwon: median(group.rows.map((row) => row.exclusive_ppyeong_manwon)),
    median_supply_ppyeong_manwon: median(group.rows.map((row) => row.supply_ppyeong_manwon)),
    median_contract_ppyeong_manwon: median(group.rows.map((row) => row.contract_ppyeong_manwon)),
    contract_matched_count: group.rows.filter((row) => Number.isFinite(row.contract_area_sqm)).length,
  }))
  .sort((a, b) => a.parcel_label.localeCompare(b.parcel_label, "ko") || a.floor_order - b.floor_order);

const retailByBuildingMap = new Map();
for (const floorGroup of retailFloorSummary) {
  if (!retailByBuildingMap.has(floorGroup.parcel_key)) {
    retailByBuildingMap.set(floorGroup.parcel_key, {
      parcel_key: floorGroup.parcel_key,
      parcel_label: floorGroup.parcel_label,
      building_name: floorGroup.building_name,
      building_name_status: floorGroup.building_name_status,
      road: floorGroup.road,
      floors: [],
    });
  }
  retailByBuildingMap.get(floorGroup.parcel_key).floors.push(floorGroup);
}

const retailBuildingFloorSummary = [...retailByBuildingMap.values()]
  .map((group) => {
    const floors = group.floors.sort((a, b) => a.floor_order - b.floor_order);
    const firstFloor = floors.find((floor) => floor.floor_order === 1);
    return {
      parcel_key: group.parcel_key,
      parcel_label: group.parcel_label,
      building_name: group.building_name,
      building_name_status: group.building_name_status,
      road: group.road,
      transaction_count: sum(floors.map((floor) => floor.transaction_count)),
      floor_count: floors.length,
      first_floor_median_exclusive_ppyeong_manwon: firstFloor?.median_exclusive_ppyeong_manwon ?? null,
      first_floor_transaction_count: firstFloor?.transaction_count ?? 0,
      main_uses: uniqueValues(floors.flatMap((floor) => floor.main_uses)),
      observed_years: [...new Set(floors.flatMap((floor) => floor.observed_years))].sort((a, b) => a - b),
      floors,
    };
  })
  .sort((a, b) => b.transaction_count - a.transaction_count || a.parcel_label.localeCompare(b.parcel_label, "ko"));

const yearlyRowsByGroup = new Map();
for (const row of yearly) {
  if (!yearlyRowsByGroup.has(row.parcel_key)) yearlyRowsByGroup.set(row.parcel_key, []);
  yearlyRowsByGroup.get(row.parcel_key).push(row);
}

const buildingAmountSeries = groupSummaries
  .map((group) => {
    const seriesRows = (yearlyRowsByGroup.get(group.parcel_key) || []).sort((a, b) => a.year - b.year);
    return {
      parcel_key: group.parcel_key,
      parcel_label: group.parcel_label,
      parcel: group.parcel,
      road: group.road,
      building_name: group.building_name,
      building_name_status: group.building_name_status,
      building_name_source: group.building_name_source,
      is_masked_parcel: group.is_masked_parcel,
      transaction_count: group.transaction_count,
      observed_years: group.observed_years,
      median_price_manwon: group.median_price_manwon,
      avg_price_manwon: group.avg_price_manwon,
      search_text: group.search_text,
      points: seriesRows.map((row) => ({
        year: row.year,
        count: row.count,
        avg_price_manwon: row.avg_price_manwon,
        median_price_manwon: row.median_price_manwon,
        avg_ppsqm_manwon: row.avg_ppsqm_manwon,
        median_ppsqm_manwon: row.median_ppsqm_manwon,
        median_exclusive_ppyeong_manwon: row.median_exclusive_ppyeong_manwon,
      })),
    };
  })
  .sort((a, b) => b.transaction_count - a.transaction_count || (b.avg_price_manwon || 0) - (a.avg_price_manwon || 0));

const months = [...new Set(records.map((record) => record.month).filter(Boolean))].sort();

function monthlyGraphReliability(group, rows) {
  const reasons = [];
  let score = 100;
  const analysisRows = rows.filter((row) => row.analysis_eligible !== false);
  const exactRows = analysisRows.filter((row) => !row.is_masked_parcel && !row.probable_parcel_key);
  if (group.is_masked_parcel || exactRows.length !== analysisRows.length) {
    score -= 35;
    reasons.push("마스킹/추정 귀속 포함");
  }
  if (group.building_name_status !== "확인됨") {
    score -= 20;
    reasons.push("건물명 미확인");
  }
  if (/오피스텔/.test(String(group.building_name || ""))) {
    score -= 100;
    reasons.push("오피스텔 명칭 포함");
  }
  if (analysisRows.length < 2) {
    score -= 20;
    reasons.push("기준값 거래 2건 미만");
  }
  const useCategories = uniqueValues(analysisRows.map((row) => isRetailUse(row) ? "retail" : isOfficeUse(row) ? "office" : "other"));
  if (useCategories.length > 1) {
    score -= 12;
    reasons.push("용도 혼재");
  }
  const areaBands = uniqueValues(analysisRows.map((row) => strictAreaBandFromPyeong(row.exclusive_pyeong)));
  if (areaBands.length > 2 || areaBands.includes("면적 미확인")) {
    score -= 8;
    reasons.push("평형 혼재");
  }
  const floorGroups = uniqueValues(analysisRows.map((row) => {
    const floor = floorSortValue(row.floor);
    if (floor === 999) return "층정보 없음";
    if (floor < 0) return "지하";
    if (floor <= 2) return "저층";
    return "상층";
  }));
  if (floorGroups.length > 2 || floorGroups.includes("층정보 없음")) {
    score -= 5;
    reasons.push("층 구간 혼재");
  }
  return {
    score: Math.max(0, score),
    passed: score >= 95,
    reasons,
    analysis_count: analysisRows.length,
    use_categories: useCategories,
    area_bands: areaBands,
    floor_groups: floorGroups,
  };
}

const monthlyRowsByGroup = new Map();
for (const group of grouped.values()) {
  const byMonth = new Map();
  const reliableRows = group.rows.filter((record) => record.analysis_eligible !== false);
  for (const record of reliableRows) {
    if (!record.month) continue;
    if (!byMonth.has(record.month)) byMonth.set(record.month, []);
    byMonth.get(record.month).push(record);
  }
  const points = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, rows]) => ({
      month,
      count: rows.length,
      total_price_manwon: sum(rows.map((row) => row.price_manwon)),
      avg_price_manwon: average(rows.map((row) => row.price_manwon)),
      median_price_manwon: median(rows.map((row) => row.price_manwon)),
      avg_exclusive_ppyeong_manwon: average(rows.map((row) => row.exclusive_ppyeong_manwon)),
      median_exclusive_ppyeong_manwon: median(rows.map((row) => row.exclusive_ppyeong_manwon)),
    }));
  monthlyRowsByGroup.set(group.parcel_key, points);
}

const buildingMonthlySeries = groupSummaries
  .map((group) => {
    const groupRows = grouped.get(group.parcel_key)?.rows || [];
    const reliability = monthlyGraphReliability(group, groupRows);
    const points = monthlyRowsByGroup.get(group.parcel_key) || [];
    return {
      parcel_key: group.parcel_key,
      parcel_label: group.parcel_label,
      parcel: group.parcel,
      road: group.road,
      building_name: group.building_name,
      building_name_status: group.building_name_status,
      building_name_source: group.building_name_source,
      search_text: group.search_text,
      is_masked_parcel: group.is_masked_parcel,
      transaction_count: reliability.analysis_count,
      observed_months: points.map((point) => point.month),
      monthly_graph_reliability_score: reliability.score,
      monthly_graph_reliability_passed: reliability.passed,
      monthly_graph_reliability_reasons: reliability.reasons,
      monthly_graph_use_categories: reliability.use_categories,
      monthly_graph_area_bands: reliability.area_bands,
      monthly_graph_floor_groups: reliability.floor_groups,
      points,
    };
  })
  .sort((a, b) => b.transaction_count - a.transaction_count);

const methodology = {
  version: "2026-06-08-researched-prd",
  audience: ["공인중개사", "상업용 부동산 투자자", "내부 후보지 검토자"],
  official_references: [
    {
      title: "공공데이터포털 국토교통부_상업업무용 부동산 매매 실거래가 자료",
      url: "https://www.data.go.kr/data/15126463/openapi.do",
      basis: "부동산 거래신고 등에 관한 법률에 따라 신고된 자료이며 법정동 코드와 계약년월로 조회한다. 개인정보보호를 위해 일반건축물 지번은 일부만 제공될 수 있다.",
    },
    {
      title: "국토교통부 실거래가 공개시스템 조건별 자료제공 유의사항",
      url: "https://rt.molit.go.kr/pt/xls/xls.do",
      basis: "공개 자료는 법적 효력이 없고 참고용이며, 신고정보가 실시간 변경·해제되어 제공시점에 따라 건수와 내용이 달라질 수 있다. 자료는 계약일 기준이다.",
    },
    {
      title: "한국부동산원 상업용부동산 임대동향조사",
      url: "https://www.reb.or.kr/reb/cm/cntnts/cntntsView.do?cntntsId=1049&mi=10335&statId=S237220284",
      basis: "오피스는 1~2층 로비·매장 성격을 제외하기 위해 3층~최고층 기준, 매장용은 1층 기준을 사용하므로 직접 비교에 유의한다.",
    },
  ],
  formulas: {
    exclusive_ppyeong_manwon: "거래금액(만원) / (전용 또는 연면적㎡ / 3.305785)",
    supply_ppyeong_manwon: "거래금액(만원) / ((전용면적㎡ + 직접공용면적㎡) / 3.305785), 직접공용면적이 있는 거래만 산출",
    contract_ppyeong_manwon: "거래금액(만원) / ((전용면적㎡ + 직접공용면적㎡ + 각층/기타공용면적㎡) / 3.305785), 단 건축HUB 전유공용면적이 지번·층·전용면적으로 안전 매칭된 거래만 산출",
    preferred_statistic: "기준값은 중위값을 우선 사용하고 평균은 참고값으로 병기한다. 표본 분산 확인을 위해 25~75% 전용평당가 범위를 같이 본다.",
    refinement_method: "정제 기준값은 기준값 산식 반영 거래를 용도+전용평형 코호트로 나눈 뒤 IQR 1.5배 이상치 후보를 격리하고 A/B 등급 거래만 우선 사용한다.",
  },
  segmentation_rules: {
    office: "건축물주용도에 업무가 포함된 거래. 면적대별·건물별 기준값을 보되, 1~2층은 상가/로비 성격이 섞일 수 있어 개별 거래내역에서 층 확인이 필요하다.",
    retail: "건축물주용도에 근린생활 또는 판매가 포함된 거래. 1층과 상층 가격 차이를 별도로 보며 업무시설 평균과 직접 비교하지 않는다.",
    masked: "마스킹 지번은 개별 건물 기준값이 아니라 보조그룹 기준값이다.",
  },
  reliability_rules: [
    "A 기준: 정확 지번 또는 공식 표제부+단일 후보+층면적 매칭이 확인된 시장 기준값",
    "B 참고: 공식 단일 후보이나 약식 매칭이거나 일부 보완점이 남은 참고 기준값",
    "C 보조: 미확정 후보, 이상치 후보, 표본 부족 등으로 보조 확인이 필요한 값",
    "D 확인: 표본 1~2건으로 개별 거래 확인이 먼저 필요한 값",
  ],
  exclusions: ["해제 거래는 원자료에는 보존하지만 평균, 중위값, 변동 분석에서는 제외한다.", "복수 후보필지(CANDIDATE_SET)는 특정 건물 거래로 확정하지 않고 원자료 확인용으로만 보존하며 기준값 산식에서는 제외한다.", "계약면적 후보가 복수이거나 층·전용면적 매칭이 불안정하면 계약평당가를 표시하지 않는다.", "계약면적은 전용+직접공용+각층/기타공용으로 보고, 공급면적 후보는 전용+직접공용으로 별도 표시한다.", "IQR 이상치 후보는 삭제하지 않고 정제 기준값에서 격리한다."],
};

const payload = {
  generated_at: new Date().toISOString(),
  methodology,
  source: {
    system: "국토교통부 실거래가 공개시스템",
    query: "상업업무용(매매), 서울특별시 강서구 마곡동, 공공데이터 API 월단위",
    mode: activeSourceMode,
    api: apiSource,
    contract_area_match: contractAreaMatches
      ? {
          generated_at: contractAreaMatches.generated_at,
          basis: contractAreaMatches.basis,
          metrics: contractAreaMatches.metrics,
          truncated_parcels: contractAreaMatches.truncated_parcels,
        }
      : null,
    files: sourceFiles,
    total_records: records.length,
    available_years: years,
    requested_years: desiredYears,
    missing_years: missingYears,
    available_months: months,
    note: "공공데이터 API 원자료를 우선 사용한다. 해제 거래와 복수 후보필지(CANDIDATE_SET)는 원자료에는 보존하되 대시보드 평균/변동 분석에서는 제외한다. 2023년 이전 공개 지번은 일부 마스킹되어 보조 그룹 기준으로 표시한다.",
  },
  metrics: {
    total_records: records.length,
    analysis_records: analysisRecords.length,
    analysis_excluded_records: records.length - analysisRecords.length,
    share_dealing_excluded_records: records.filter((record) => String(record.share_type || "").includes("지분")).length,
    bulk_deal_excluded_records: records.filter((record) => record.bulk_deal_candidate).length,
    candidate_set_excluded_records: records.filter((record) => record.analysis_exclusion_reasons.includes("복수 후보필지")).length,
    exact_parcel_records: records.filter((record) => !record.is_masked_parcel).length,
    masked_parcel_records: records.filter((record) => record.is_masked_parcel).length,
    official_masked_matched_records: officialMaskedMatchedRecords,
    official_candidate_set_records: officialCandidateSetRecords,
    recovery_masked_matched_records: recoveryMaskedMatchedRecords,
    unresolved_high_confidence_masked_records: unresolvedHighConfidenceMaskedRecords,
    exact_parcel_groups: exactGroups.length,
    masked_parcel_groups: maskedGroups.length,
    building_name_enriched_groups: groupSummaries.filter((group) => group.building_name_status === "확인됨").length,
    contract_area_matched_records: records.filter((record) => Number.isFinite(record.contract_area_sqm)).length,
    source_file_count: sourceFiles.length,
  },
  refinement_summary: refinementSummary,
  year_summary: yearSummary,
  parcel_groups: groupSummaries.sort((a, b) => b.transaction_count - a.transaction_count),
  top_movers: topGroups,
  yearly,
  building_floor_use_summary: buildingFloorUseSummary,
  office_area_band_summary: officeAreaBandSummary,
  office_same_day_floor_summary: officeSameDayFloorSummary,
  office_area_band_year_series: officeAreaBandYearSeries,
  office_area_band_month_series: officeAreaBandMonthSeries,
  office_area_band_building_summary: officeAreaBandBuildingSummary,
  retail_building_floor_summary: retailBuildingFloorSummary,
  building_amount_series: buildingAmountSeries,
  building_monthly_series: buildingMonthlySeries,
  records,
};

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "magok-commercial-transactions-dashboard.json"), JSON.stringify(payload, null, 2), "utf8");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const selectedGroups = payload.parcel_groups
  .filter((group) => group.transaction_count >= 8)
  .slice(0, 24)
  .map((group) => group.parcel_key);

const compactPayload = {
  methodology: payload.methodology,
  source: payload.source,
  metrics: payload.metrics,
  refinementSummary: payload.refinement_summary,
  yearSummary: payload.year_summary,
  parcelGroups: payload.parcel_groups,
  buildingFloorUseSummary: payload.building_floor_use_summary,
  officeAreaBandSummary: payload.office_area_band_summary,
  officeSameDayFloorSummary: payload.office_same_day_floor_summary,
  officeAreaBandYearSeries: payload.office_area_band_year_series,
  officeAreaBandMonthSeries: payload.office_area_band_month_series,
  officeAreaBandBuildingSummary: payload.office_area_band_building_summary,
  retailBuildingFloorSummary: payload.retail_building_floor_summary,
  buildingAmountSeries: payload.building_amount_series,
  buildingMonthlySeries: payload.building_monthly_series,
  topMovers: payload.top_movers,
  yearly: payload.yearly,
  records: payload.records.map((record) => ({
    parcel_key: record.parcel_key,
    month: record.month,
    year: record.year,
    contract_day: record.contract_day,
    parcel_label: record.parcel_label,
    parcel: record.parcel,
    road: record.road,
    building_name: record.building_name,
    building_name_status: record.building_name_status,
    building_name_source: record.building_name_source,
    official_title_confirmed: record.official_title_confirmed,
    official_single_candidate_match: record.official_single_candidate_match,
    masked_match_stage: record.masked_match_stage,
    is_masked_parcel: record.is_masked_parcel,
    probable_parcel_key: record.probable_parcel_key,
    building_match_confidence: record.building_match_confidence,
    building_match_note: record.building_match_note,
    main_use: record.main_use,
    floor: record.floor,
    area_sqm: record.area_sqm,
    exclusive_pyeong: record.exclusive_pyeong,
    common_area_sqm: record.common_area_sqm,
    direct_common_area_sqm: record.direct_common_area_sqm,
    shared_common_area_sqm: record.shared_common_area_sqm,
    supply_area_sqm: record.supply_area_sqm,
    supply_pyeong: record.supply_pyeong,
    contract_area_sqm: record.contract_area_sqm,
    contract_pyeong: record.contract_pyeong,
    price_manwon: record.price_manwon,
    price_per_sqm_manwon: record.price_per_sqm_manwon,
    exclusive_ppyeong_manwon: record.exclusive_ppyeong_manwon,
    supply_ppyeong_manwon: record.supply_ppyeong_manwon,
    contract_ppyeong_manwon: record.contract_ppyeong_manwon,
    contract_area_source: record.contract_area_source,
    contract_area_confidence: record.contract_area_confidence,
    area_source: record.area_source,
    area_basis: record.area_basis,
    area_confidence: record.area_confidence,
    transaction_type: record.transaction_type,
    broker_location: record.broker_location,
    share_type: record.share_type,
    bulk_deal_candidate: record.bulk_deal_candidate,
    bulk_deal_record_count: record.bulk_deal_record_count,
    bulk_deal_floor_count: record.bulk_deal_floor_count,
    bulk_deal_total_area_sqm: record.bulk_deal_total_area_sqm,
    bulk_deal_total_price_manwon: record.bulk_deal_total_price_manwon,
    analysis_eligible: record.analysis_eligible,
    analysis_exclusion_reasons: record.analysis_exclusion_reasons,
    refinement_tier: record.refinement_tier,
    refinement_score: record.refinement_score,
    refinement_reasons: record.refinement_reasons,
    refinement_promotion: record.refinement_promotion,
    refinement_outlier_candidate: record.refinement_outlier_candidate,
    refinement_cohort_key: record.refinement_cohort_key,
    refinement_cohort_count: record.refinement_cohort_count,
  })),
  selectedGroups,
};

const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>마곡동 상가·업무시설 실거래 찾기</title>
  <style>
    :root {
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #647083;
      --line: #dbe1ea;
      --brand: #156f78;
      --brand-2: #b3482f;
      --gold: #b8871b;
      --green: #2f7d4f;
      --shadow: 0 10px 28px rgba(30, 40, 60, 0.08);
      --soft: #edf7f5;
      --cream: #fffaf2;
      --accent: #e66b3d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Malgun Gothic", Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.5;
    }
    header {
      padding: 18px clamp(18px, 4vw, 56px) 14px;
      background: #ffffff;
      border-bottom: 1px solid #dce8e6;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 3.4vw, 46px);
      letter-spacing: 0;
      line-height: 1.08;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 18px;
    }
    p { margin: 0; }
    main {
      display: flex;
      flex-direction: column;
      padding: 20px clamp(14px, 3vw, 42px) 38px;
      max-width: 1480px;
      margin: 0 auto;
    }
    #consumerHero { order: 1; }
    .toolbar { order: 2; }
    #buildingDetailSection { order: 3; }
    .dashboard-intent { order: 4; }
    .workflow-steps { order: 5; }
    #dashboardUseMode { order: 6; }
    .kpis { order: 7; }
    #plainGuideBoard { order: 8; }
    #aggregateTrendSection { order: 9; }
    #dataRefinementBoard { order: 10; }
    #userDetailAnalysisPack { order: 11; }
    #secondaryDashboardPack { order: 12; }
    #pyeongDashboardSection { order: 13; }
    .data-note { order: 20; }
    .consumer-hero {
      position: relative;
      min-height: clamp(360px, 46vw, 540px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 320px);
      align-items: end;
      gap: 22px;
      overflow: hidden;
      margin: 2px 0 18px;
      padding: clamp(24px, 5vw, 58px);
      border-radius: 8px;
      background-image: linear-gradient(90deg, rgba(9, 28, 31, 0.86) 0%, rgba(12, 43, 48, 0.62) 48%, rgba(12, 43, 48, 0.18) 100%), url("magok-commercial-hero.png");
      background-size: cover;
      background-position: center;
      color: #fff;
      box-shadow: 0 22px 55px rgba(17, 24, 39, 0.2);
    }
    .consumer-hero-content {
      max-width: 780px;
      display: grid;
      gap: 16px;
      align-self: center;
    }
    .consumer-hero .eyebrow {
      width: fit-content;
      padding: 7px 10px;
      border: 1px solid rgba(255, 255, 255, 0.46);
      border-radius: 8px;
      color: #dff8f4;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
      background: rgba(255, 255, 255, 0.1);
    }
    .consumer-hero h2 {
      margin: 0;
      color: #fff;
      font-size: clamp(34px, 5vw, 70px);
      line-height: 1.04;
      letter-spacing: 0;
      text-wrap: balance;
    }
    .consumer-hero p {
      max-width: 680px;
      color: rgba(255, 255, 255, 0.88);
      font-size: clamp(16px, 1.4vw, 20px);
      line-height: 1.7;
    }
    .consumer-hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 4px;
    }
    .hero-button, .hero-link {
      display: inline-flex;
      min-height: 48px;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      padding: 0 18px;
      font-weight: 900;
      text-decoration: none;
    }
    .hero-button {
      background: #ffb24a;
      color: #111827;
      box-shadow: 0 10px 24px rgba(255, 178, 74, 0.28);
    }
    .hero-link {
      border: 1px solid rgba(255, 255, 255, 0.42);
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
    }
    .consumer-hero-mini {
      align-self: end;
      justify-self: end;
      width: min(100%, 310px);
      padding: 18px;
      border: 1px solid rgba(255, 255, 255, 0.34);
      border-radius: 8px;
      background: rgba(7, 25, 28, 0.52);
      backdrop-filter: blur(10px);
      display: grid;
      gap: 4px;
    }
    .consumer-hero-mini span, .consumer-hero-mini small {
      color: rgba(255, 255, 255, 0.72);
      font-weight: 800;
    }
    .consumer-hero-mini strong {
      color: #fff;
      font-size: 34px;
      line-height: 1;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(360px, 1.8fr) repeat(3, minmax(140px, 0.45fr));
      gap: 10px;
      margin: 0 0 18px;
      align-items: end;
      padding: 16px;
      border: 1px solid #b8d8d3;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 16px 42px rgba(17, 24, 39, 0.12);
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
      font-weight: 700;
    }
    input, select {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      background: #fff;
      color: var(--ink);
    }
    .search-field input {
      min-height: 58px;
      font-size: 19px;
      font-weight: 800;
      border-color: #7fbdb5;
      background: #fafffe;
      box-shadow: inset 0 0 0 1px rgba(21, 111, 120, 0.08);
    }
    .search-field input:focus {
      outline: 3px solid rgba(21, 111, 120, 0.16);
      border-color: var(--brand);
    }
    .search-field {
      position: relative;
    }
    .search-suggestions {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      z-index: 20;
      display: none;
      max-height: 320px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 14px 30px rgba(30, 40, 60, 0.16);
    }
    .search-suggestions.open {
      display: block;
    }
    .suggestion-item {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 10px;
      border: 0;
      border-bottom: 1px solid #edf1f5;
      padding: 9px 10px;
      background: #fff;
      color: var(--ink);
      text-align: left;
      cursor: pointer;
    }
    .suggestion-item:last-child { border-bottom: 0; }
    .suggestion-item.active,
    .suggestion-item:hover {
      background: #eef8f7;
    }
    .suggestion-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 800;
    }
    .suggestion-meta {
      grid-column: 1 / -1;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .suggestion-score {
      color: var(--brand);
      font-size: 12px;
      font-weight: 800;
    }
    .kpis {
      margin: 4px 0 14px;
    }
    .kpi-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 14px;
      padding: 10px 14px;
      border: 1px solid #dce7f1;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.78);
      color: #5c6b82;
      font-size: 13px;
      font-weight: 800;
      box-shadow: 0 10px 24px rgba(33, 51, 84, 0.06);
    }
    .kpi-strip span {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .kpi-strip span + span::before {
      content: "";
      width: 4px;
      height: 4px;
      border-radius: 999px;
      background: #b8c5d6;
      margin-right: 6px;
    }
    .kpi-strip strong {
      color: #0d2238;
      font-size: 14px;
    }
    .kpi-strip [hidden] { display: none; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.7fr);
      gap: 14px;
      align-items: start;
    }
    section { padding: 16px; }
    .chart-wrap {
      width: 100%;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: linear-gradient(#fff, #fbfcfd);
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      margin-top: 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      margin-right: 5px;
      vertical-align: -1px;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13px;
      line-height: 1.35;
      font-variant-numeric: tabular-nums;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 10px;
      text-align: right;
      vertical-align: middle;
      white-space: nowrap;
    }
    th:first-child, td:first-child,
    th:nth-child(2), td:nth-child(2) {
      text-align: left;
      white-space: normal;
      min-width: 110px;
    }
    td:first-child {
      font-weight: 700;
      color: #172033;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      background: #f7f9fb;
      position: sticky;
      top: 0;
      z-index: 2;
      box-shadow: inset 0 -1px 0 var(--line);
    }
    tbody tr:nth-child(even) {
      background: #fbfcfe;
    }
    tbody tr:hover {
      background: #f3f8f8;
    }
    td .muted {
      font-weight: 500;
      font-size: 12px;
      line-height: 1.35;
    }
    .table-scroll {
      max-height: 560px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      background: #eef5f6;
      color: var(--brand);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .graph-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 10px;
      max-height: 980px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
    }
    .graph-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 10px;
      min-height: 210px;
      cursor: pointer;
    }
    .graph-card:hover,
    tr.clickable:hover {
      outline: 2px solid rgba(21, 111, 120, 0.22);
      background: #f4faf9;
    }
    .graph-card.selected,
    tr.selected {
      outline: 2px solid var(--brand);
      background: #eef8f7;
    }
    .graph-card h3 {
      margin: 0 0 3px;
      font-size: 13px;
      line-height: 1.35;
      word-break: keep-all;
    }
    .graph-meta {
      color: var(--muted);
      font-size: 11px;
      min-height: 32px;
    }
    .graph-card svg {
      margin-top: 8px;
      border-top: 1px solid var(--line);
    }
    .detail-panel {
      display: grid;
      grid-template-columns: minmax(320px, 0.9fr) minmax(0, 1.1fr);
      gap: 14px;
      align-items: start;
    }
    .detail-title {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .detail-title h2 { margin: 0; }
    .detail-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0 0 10px;
    }
    .detail-tab {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 10px;
      background: #fff;
      color: var(--ink);
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
    }
    .detail-tab.active {
      border-color: var(--brand);
      background: #eef8f7;
      color: var(--brand);
    }
    .detail-chart {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
    }
    .detail-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(90px, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .detail-stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: #fbfcfd;
    }
    .detail-stat span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }
    .detail-stat strong {
      display: block;
      margin-top: 5px;
      font-size: 16px;
    }
    .detail-subsection {
      margin-top: 14px;
    }
    .detail-subsection h3 {
      margin: 0 0 6px;
      font-size: 16px;
    }
    .commercial-report {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      border: 1px solid #bfd8d4;
      border-radius: 8px;
      background: linear-gradient(135deg, #f7fbfa 0%, #fffaf2 100%);
      padding: 14px;
      margin: 0 0 14px;
    }
    .commercial-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 8px;
    }
    .commercial-summary div {
      border: 1px solid #d7e6e3;
      border-radius: 8px;
      background: #fff;
      padding: 10px 11px;
    }
    .commercial-summary span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .commercial-summary strong {
      display: block;
      margin-top: 4px;
      font-size: 16px;
      color: #0f5f67;
    }
    .commercial-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
      min-width: 260px;
    }
    .commercial-status {
      flex-basis: 100%;
      color: var(--muted);
      font-size: 12px;
      text-align: right;
      min-height: 16px;
    }
    .building-result-shell { border: 0; background: #eef4fb; box-shadow: none; padding: 0; overflow: visible; }
    .building-result-topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 48px; padding: 0 2px 12px; color: #516079; font-size: 13px; font-weight: 800; }
    .building-result-topbar strong { color: #06172e; font-size: 16px; }
    .building-profile-card { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; gap: 26px; align-items: center; padding: 24px 26px; border: 1px solid #d9e4f2; border-radius: 8px; background: linear-gradient(180deg, #f7faff 0%, #f1f6fd 100%); box-shadow: 0 16px 34px rgba(33, 51, 84, 0.08); }
    .building-profile-card img { width: 150px; height: 92px; object-fit: cover; border-radius: 6px; box-shadow: 0 10px 24px rgba(18, 36, 68, 0.16); }
    .building-profile-copy { display: grid; gap: 10px; min-width: 0; }
    .building-profile-copy h2 { margin: 0; color: #06172e; font-size: clamp(25px, 2.2vw, 34px); line-height: 1.12; letter-spacing: 0; }
    .building-profile-copy p { color: #516079; font-weight: 800; }
    .building-profile-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .building-profile-chips span { display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border-radius: 999px; background: #ffffff; border: 1px solid #d7e2f1; color: #33405c; font-size: 12px; font-weight: 900; }
    .building-profile-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .building-profile-actions .button { min-height: 40px; }
    .building-view-tabs { display: flex; flex-wrap: wrap; gap: 28px; align-items: center; padding: 16px 8px 10px; border-bottom: 1px solid #d3dfed; }
    .building-view-tabs .detail-tab { border: 0; border-radius: 0; padding: 0 0 10px; background: transparent; color: #06172e; font-size: 14px; font-weight: 1000; }
    .building-view-tabs .detail-tab.active { background: transparent; color: #6136ff; box-shadow: inset 0 -3px 0 #6136ff; }
    .commercial-report { display: block; border: 0; background: transparent; padding: 14px 0 0; margin: 0; }
    .commercial-summary { grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 14px; }
    .commercial-summary div { min-height: 112px; display: grid; align-content: center; gap: 6px; border: 1px solid #d9e4f2; border-radius: 8px; background: #fff; padding: 18px 20px 18px 78px; position: relative; box-shadow: 0 12px 28px rgba(33, 51, 84, 0.08); }
    .commercial-summary div::before { content: attr(data-icon); position: absolute; left: 20px; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; display: grid; place-items: center; border-radius: 8px; color: #fff; background: #6d40ff; font-size: 24px; font-weight: 1000; }
    .commercial-summary div:nth-child(2)::before { background: #35b9a5; }
    .commercial-summary div:nth-child(3)::before { background: #5b8ff0; }
    .commercial-summary div:nth-child(4)::before { background: #ffad69; }
    .commercial-summary span { color: #17213a; font-size: 13px; }
    .commercial-summary strong { margin: 0; color: #07162d; font-size: 28px; line-height: 1; }
    .commercial-summary small { color: #516079; font-size: 12px; font-weight: 800; }
    .commercial-actions { justify-content: flex-end; min-width: 0; margin-top: 10px; }
    .building-result-grid { display: grid; grid-template-columns: 300px minmax(0, 1fr) 360px; gap: 14px; margin-top: 14px; align-items: stretch; }
    .building-side-card, .building-chart-card, .building-recent-card, .building-mini-card { border: 1px solid #d9e4f2; border-radius: 8px; background: #fff; box-shadow: 0 12px 28px rgba(33, 51, 84, 0.08); }
    .building-side-card, .building-recent-card, .building-mini-card { padding: 18px; }
    .building-side-card h3, .building-chart-card h3, .building-recent-card h3, .building-mini-card h3 { margin: 0 0 12px; color: #06172e; font-size: 18px; }
    .building-map-preview { height: 196px; display: grid; place-items: center; border: 1px solid #d7e2f1; border-radius: 7px; background: linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px) 0 0 / 42px 42px, linear-gradient(0deg, rgba(255,255,255,.4) 1px, transparent 1px) 0 0 / 42px 42px, linear-gradient(135deg, #e8f2e6, #eef4ff 55%, #fff3dd); color: #6136ff; font-weight: 1000; text-align: center; margin-bottom: 14px; }
    .building-info-list { display: grid; gap: 10px; margin: 0; }
    .building-info-row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; color: #17213a; font-size: 13px; }
    .building-info-row dt { color: #516079; font-weight: 900; }
    .building-info-row dd { margin: 0; font-weight: 800; word-break: keep-all; }
    .building-chart-card { padding: 18px 18px 14px; min-width: 0; }
    .building-chart-card .detail-chart { border: 0; background: transparent; }
    .building-chart-card svg { width: 100%; height: auto; }
    .building-recent-card .table-scroll { max-height: 338px; }
    .building-recent-card table th, .building-recent-card table td { padding: 9px 8px; font-size: 12px; white-space: nowrap; }
    .detail-stats { grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 8px; margin: 12px 0 0; }
    .detail-stat { background: #f8faff; border-color: #d7e2f1; }
    .detail-stat strong { color: #06172e; }
    .building-lower-grid { display: grid; grid-template-columns: 1fr 1fr 1.25fr; gap: 14px; margin-top: 14px; }
    .mini-compare { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; }
    .mini-price-box { border: 1px solid #d7e2f1; border-radius: 8px; padding: 14px; background: #fbfdff; }
    .mini-price-box span { color: #6136ff; font-size: 12px; font-weight: 900; }
    .mini-price-box strong { display: block; margin-top: 9px; font-size: 24px; color: #06172e; }
    .mini-vs { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; background: #eee8ff; color: #31168a; font-weight: 1000; }
    .bar-list { display: grid; gap: 10px; }
    .bar-row { display: grid; grid-template-columns: 70px 1fr 72px; gap: 10px; align-items: center; font-size: 12px; font-weight: 900; color: #17213a; }
    .bar-track { height: 12px; border-radius: 999px; background: #eef2fb; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #a98bff, #6136ff); }
    tr.clickable { cursor: pointer; }
    .warn {
      border-left: 4px solid var(--gold);
      background: #fff9ec;
      padding: 9px 12px;
      border-radius: 6px;
      color: #5e4615;
      margin-top: 10px;
      max-height: 76px;
      overflow: auto;
      font-size: 13px;
      line-height: 1.45;
    }
    .muted { color: var(--muted); }
    .cta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-top: 14px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f8fbfb;
    }
    .data-note {
      margin: 0 0 14px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      color: var(--muted);
      font-size: 13px;
    }
    .methodology {
      margin: 0 0 14px;
      background: #ffffff;
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .methodology h2 {
      margin: 0 0 10px;
      font-size: 18px;
    }
    .method-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
    }
    .method-box {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fbfcfd;
    }
    .method-box h3 {
      margin: 0 0 8px;
      font-size: 13px;
    }
    .method-box ul {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
    }
    .button {
      border: 0;
      background: var(--brand);
      color: #fff;
      border-radius: 8px;
      padding: 11px 14px;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 8px 18px rgba(21, 111, 120, 0.18);
    }
    .button.secondary { background: var(--accent); box-shadow: 0 8px 18px rgba(230, 107, 61, 0.16); }
    .button:hover { transform: translateY(-1px); }
    .analysis-band {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
      margin-top: 14px;
      align-items: start;
    }
    .pyeong-dashboard {
      margin-top: 14px;
      background: #ffffff;
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .compact-disclosure > summary {
      min-height: 46px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      cursor: pointer;
      font-weight: 900;
      list-style: none;
    }
    .compact-disclosure > summary::-webkit-details-marker { display: none; }
    .compact-disclosure > summary::after {
      content: "열기";
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 9px;
      color: var(--brand);
      background: #eef8f7;
      font-size: 12px;
      font-weight: 800;
    }
    .compact-disclosure[open] > summary {
      margin-bottom: 12px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 10px;
    }
    .compact-disclosure[open] > summary::after { content: "닫기"; }
    .disclosure-body {
      display: grid;
      gap: 10px;
    }
    .pyeong-toolbar {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      margin: 12px 0;
      align-items: end;
    }
    .pyeong-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 8px;
      margin: 10px 0 12px;
    }
    .pyeong-stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfd;
      padding: 9px 10px;
    }
    .valuation-dashboard {
      margin: 18px 0 14px;
      background: #ffffff;
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .core-dashboard {
      border-width: 2px;
      border-color: #b9d9d6;
      background: linear-gradient(180deg, #ffffff 0%, #f7fbfa 100%);
    }
    .core-dashboard .valuation-layout {
      grid-template-columns: 1fr;
    }
    .core-dashboard .valuation-chart {
      order: 1;
    }
    .core-dashboard .valuation-summary {
      order: 2;
      grid-template-columns: repeat(6, minmax(110px, 1fr));
    }
    .core-story {
      display: grid;
      grid-template-columns: repeat(3, minmax(180px, 1fr));
      gap: 10px;
      margin: 12px 0;
    }
    .core-card {
      min-height: 106px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      padding: 12px;
      display: grid;
      gap: 6px;
      align-content: start;
    }
    .core-card span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .core-card strong {
      color: var(--ink);
      font-size: 24px;
      line-height: 1.08;
    }
    .core-card small {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .core-card svg {
      width: 100%;
      height: 28px;
      overflow: visible;
    }
    .quality-funnel {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 8px;
      margin-top: 12px;
    }
    .quality-step {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 10px;
    }
    .quality-step span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .quality-step strong {
      display: block;
      margin-top: 5px;
      font-size: 18px;
    }
    .plain-guide {
      margin: 0 0 14px;
      border: 1px solid #bfd8d4;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: var(--shadow);
      padding: 16px;
    }
    .plain-guide h2 {
      margin: 0 0 6px;
      font-size: 20px;
    }
    .plain-guide > p {
      color: var(--muted);
      line-height: 1.55;
    }
    .plain-cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(180px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .plain-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px;
      background: #fbfcfd;
    }
    .plain-card span {
      display: block;
      color: var(--brand);
      font-size: 12px;
      font-weight: 900;
      margin-bottom: 7px;
    }
    .plain-card strong {
      display: block;
      font-size: 20px;
      margin-bottom: 5px;
    }
    .plain-card small {
      color: var(--muted);
      line-height: 1.45;
    }
    .valuation-toolbar {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 10px;
      margin: 12px 0;
      align-items: end;
    }
    .valuation-layout {
      display: grid;
      grid-template-columns: minmax(320px, 0.82fr) minmax(0, 1.18fr);
      gap: 12px;
      align-items: start;
    }
    .valuation-chart {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
    }
    .valuation-summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(120px, 1fr));
      gap: 8px;
    }
    .valuation-callout {
      grid-column: 1 / -1;
      border: 1px solid rgba(21, 111, 120, 0.26);
      border-radius: 8px;
      background: #eef8f7;
      padding: 13px 14px;
    }
    .valuation-callout.tone-good {
      border-color: rgba(47, 125, 79, 0.32);
      background: #eef8f2;
    }
    .valuation-callout.tone-neutral {
      border-color: rgba(184, 135, 27, 0.32);
      background: #fff9ec;
    }
    .valuation-callout.tone-warn {
      border-color: rgba(179, 72, 47, 0.32);
      background: #fff1ee;
    }
    .valuation-callout strong {
      display: block;
      margin-bottom: 4px;
      font-size: 20px;
    }
    .valuation-stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfd;
      padding: 9px 10px;
    }
    .valuation-stat span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .valuation-stat strong {
      display: block;
      margin-top: 4px;
      font-size: 16px;
    }
    .valuation-stat.primary strong {
      font-size: 20px;
    }
    .valuation-next {
      grid-column: 1 / -1;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      padding: 10px 12px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
    }
    .workflow-steps {
      display: grid;
      grid-template-columns: repeat(4, minmax(130px, 1fr));
      gap: 10px;
      margin: 12px 0 14px;
    }
    .workflow-step {
      border: 1px solid #d7e6e3;
      border-radius: 8px;
      background: #fff;
      padding: 13px 14px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      min-height: 80px;
      box-shadow: 0 6px 18px rgba(30, 40, 60, 0.05);
    }
    .workflow-step strong {
      display: block;
      color: var(--brand);
      font-size: 15px;
      margin-bottom: 5px;
    }
    .mode-switch {
      display: grid;
      grid-template-columns: repeat(2, minmax(180px, 1fr));
      gap: 10px;
      margin: 12px 0;
    }
    .mode-button {
      border: 1px solid #d7e6e3;
      border-radius: 8px;
      background: #fff;
      padding: 13px 14px;
      text-align: left;
      cursor: pointer;
      color: var(--muted);
      font: inherit;
      line-height: 1.45;
    }
    .mode-button strong {
      display: block;
      color: var(--ink);
      font-size: 15px;
      margin-bottom: 3px;
    }
    .mode-button.active {
      border-color: rgba(21, 111, 120, 0.42);
      background: #eef8f7;
      box-shadow: inset 0 0 0 1px rgba(21, 111, 120, 0.16), 0 8px 20px rgba(21, 111, 120, 0.08);
    }
    .dashboard-intent {
      margin: 14px 0 12px;
      padding: 20px 22px;
      border: 1px solid #bfd8d4;
      border-radius: 8px;
      background: linear-gradient(135deg, #ffffff 0%, #f0fbf8 100%);
      color: var(--muted);
      font-size: 15px;
      line-height: 1.6;
      box-shadow: var(--shadow);
    }
    .dashboard-intent strong {
      display: block;
      color: var(--ink);
      font-size: clamp(20px, 2.4vw, 30px);
      line-height: 1.18;
      margin-bottom: 8px;
    }
    .trend-board {
      margin: 0 0 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .trend-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.28fr) minmax(280px, 0.72fr);
      gap: 12px;
      align-items: stretch;
      margin-top: 12px;
    }
    .trend-chart {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
      min-height: 318px;
    }
    .trend-summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(120px, 1fr));
      gap: 8px;
      align-content: start;
    }
    .trend-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfd;
      padding: 10px 11px;
      min-height: 70px;
    }
    .trend-card.wide {
      grid-column: 1 / -1;
      background: #eef8f7;
      border-color: rgba(21, 111, 120, 0.22);
      color: #244047;
      line-height: 1.55;
    }
    .trend-card span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .trend-card strong {
      display: block;
      margin-top: 5px;
      font-size: 17px;
    }
    .trend-heatmap {
      margin-top: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: auto;
      background: #fff;
    }
    .trend-heatmap table {
      min-width: 940px;
      border: 0;
    }
    .trend-heatmap th {
      background: #f4f7f9;
    }
    .trend-month-cell {
      min-width: 64px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .trend-month-cell small {
      display: block;
      color: var(--muted);
      font-size: 10px;
      margin-top: 2px;
    }
    .trend-empty {
      padding: 16px;
      color: var(--muted);
      line-height: 1.55;
    }
    .usage-split-board {
      margin: 0 0 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      box-shadow: var(--shadow);
      padding: 14px;
    }
    .usage-split-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      margin-top: 12px;
    }
    .usage-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfd;
      padding: 12px;
      min-width: 0;
    }
    .usage-panel h3 {
      margin-bottom: 6px;
      font-size: 16px;
    }
    .usage-panel .muted {
      font-size: 12px;
      line-height: 1.5;
    }
    .usage-controls {
      display: grid;
      grid-template-columns: repeat(2, minmax(120px, 1fr));
      gap: 8px;
      margin: 10px 0;
    }
    .usage-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(92px, 1fr));
      gap: 8px;
      margin: 10px 0;
    }
    .usage-metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 8px 9px;
    }
    .usage-metric span {
      display: block;
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
    }
    .usage-metric strong {
      display: block;
      margin-top: 4px;
      font-size: 15px;
    }
    .usage-mini-table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .usage-mini-table th,
    .usage-mini-table td {
      padding: 8px 7px;
      font-size: 12px;
      vertical-align: top;
    }
    .usage-mini-table th {
      background: #f4f7f9;
    }
    .usage-trend-table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      margin-top: 12px;
    }
    .usage-trend-table th,
    .usage-trend-table td {
      padding: 8px 7px;
      font-size: 12px;
      vertical-align: top;
      border-bottom: 1px solid var(--line);
    }
    .usage-trend-table th {
      background: #f4f7f9;
      color: var(--muted);
    }
    .floor-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 42px;
      border-radius: 999px;
      background: #eef8f7;
      color: #156f78;
      font-size: 11px;
      font-weight: 800;
      padding: 4px 7px;
    }
    .floor-chip.first {
      background: #fff1ee;
      color: #b3482f;
    }
    .pyeong-stat span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .pyeong-stat strong {
      display: block;
      margin-top: 4px;
      font-size: 16px;
    }
    .pyeong-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(360px, 0.75fr);
      gap: 12px;
      align-items: start;
    }
    .pyeong-heatmap {
      max-height: 560px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .pyeong-heatmap table {
      min-width: 960px;
      border: 0;
    }
    .pyeong-heatmap th {
      position: sticky;
      top: 0;
      z-index: 3;
      background: #f4f7f9;
    }
    .pyeong-heatmap th:first-child,
    .pyeong-heatmap td:first-child {
      position: sticky;
      left: 0;
      z-index: 2;
      background: #fff;
      min-width: 220px;
      max-width: 260px;
      box-shadow: 1px 0 0 var(--line);
    }
    .pyeong-heatmap th:first-child {
      z-index: 4;
      background: #f4f7f9;
    }
    .pyeong-cell {
      min-width: 76px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .pyeong-cell small {
      display: block;
      color: var(--muted);
      font-size: 10px;
      margin-top: 2px;
    }
    .pyeong-name {
      display: grid;
      gap: 2px;
      font-size: 12px;
      line-height: 1.3;
      cursor: pointer;
    }
    .pyeong-name strong {
      font-size: 13px;
      word-break: keep-all;
    }
    .pyeong-name span {
      color: var(--muted);
      font-size: 11px;
    }
    .pyeong-side {
      max-height: 560px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .floor-chart-cell {
      min-width: 280px;
      width: 34vw;
      max-width: 520px;
    }
    .floor-chart svg {
      min-width: 260px;
      height: 96px;
    }
    .pill-warning {
      background: #fff3e6;
      color: #9a4a12;
    }
    @media (max-width: 980px) {
      .toolbar, .grid, .pyeong-toolbar, .pyeong-summary, .valuation-toolbar, .core-story { grid-template-columns: 1fr 1fr; }
      .grid > section:first-child { grid-column: 1 / -1; }
      .detail-panel { grid-template-columns: 1fr; }
      .commercial-report { grid-template-columns: 1fr; }
      .commercial-actions { justify-content: flex-start; min-width: 0; }
      .analysis-band { grid-template-columns: 1fr; }
      .method-grid { grid-template-columns: 1fr; }
      .pyeong-layout { grid-template-columns: 1fr; }
      .valuation-layout { grid-template-columns: 1fr; }
      .trend-layout { grid-template-columns: 1fr; }
      .usage-split-layout { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      header { padding: 20px 14px 14px; }
      main { padding: 14px; }
      .consumer-hero { grid-template-columns: 1fr; min-height: 560px; align-items: end; padding: 22px; background-position: center; }
      .consumer-hero-mini { justify-self: stretch; }
      .consumer-hero-actions a { flex: 1 1 180px; }
      .toolbar, .grid, .pyeong-toolbar, .pyeong-summary, .valuation-toolbar, .valuation-summary, .usage-controls, .usage-metrics, .mode-switch, .core-story, .commercial-summary { grid-template-columns: 1fr; }
      .kpi-strip { align-items: flex-start; }
      .commercial-actions .button { flex: 1 1 120px; }
      th, td { padding: 8px 6px; font-size: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>마곡동 상가·업무시설 실거래 찾기</h1>
    <p class="muted">건물명이나 지번을 입력하면 최근 10년 실거래 흐름과 상담용 요약을 바로 확인할 수 있습니다.</p>
    <div class="warn">최근 10년 ${escapeHtml(desiredYears[0])}-${escapeHtml(desiredYears.at(-1))}년 마곡동 상업업무용 매매 ${analysisRecords.length.toLocaleString("ko-KR")}건을 기준값에 반영했습니다. 해제·복수후보·지분·일괄거래 후보는 평균/추이에서 제외하고, 상세 근거는 아래 분석 기준에서 확인합니다.</div>
  </header>
  <main>
    <section class="consumer-hero" id="consumerHero" aria-label="마곡동 상업용 부동산 실거래 안내">
      <div class="consumer-hero-content">
        <span class="eyebrow">MAGOK COMMERCIAL PRICE GUIDE</span>
        <h2>건물명만 입력하면<br>실거래 흐름이 바로 보입니다</h2>
        <p>마곡동 상가·업무시설 매매 실거래를 일반 사용자도 읽기 쉽게 정리했습니다. 먼저 건물을 검색하고, 상담등급·평당가·월별 변동만 확인하세요.</p>
        <div class="consumer-hero-actions">
          <a class="hero-button" href="#search">건물 검색하기</a>
          <a class="hero-link" href="#buildingDetailSection">선택 결과 보기</a>
        </div>
      </div>
      <div class="consumer-hero-mini" aria-label="분석 데이터 요약">
        <span>최근 10년 기준값</span>
        <strong>${analysisRecords.length.toLocaleString("ko-KR")}건</strong>
        <small>해제·지분·일괄 후보 제외 후 반영</small>
      </div>
    </section>

    <div class="kpis" aria-label="데이터 기준 요약">
      <div class="kpi-strip">
        <span>기준값 <strong id="kpiRecords">-</strong></span>
        <span>기간 <strong id="kpiYears">-</strong></span>
        <span>건물 <strong id="kpiBuilding">-</strong></span>
        <span>중위 전용평당가 <strong id="kpiUnit">-</strong></span>
        <span id="kpiMaskedWrap">확인 필요 <strong id="kpiMasked">-</strong></span>
      </div>
    </div>

    <p class="data-note"><strong>데이터 안내.</strong> 상업업무용 매매 활성 거래 ${records.length.toLocaleString("ko-KR")}건 중 기준값 산식에 ${analysisRecords.length.toLocaleString("ko-KR")}건을 반영했습니다. 해제 거래, 복수 후보필지, 지분거래, 일괄거래 후보는 평균과 추이에서 제외했습니다.</p>

    <div class="dashboard-intent">
      <strong>먼저 건물을 검색하고, 선택 건물 요약만 보면 됩니다.</strong>
      처음 보는 사용자는 아래 검색창에서 건물명·지번·도로명을 입력한 뒤 상담등급, 기준 평당가, 묶음거래 여부를 확인하세요. 상세 표와 전문가용 분석은 접힌 영역에 따로 모았습니다.
    </div>

    <div class="workflow-steps" aria-label="대시보드 사용 순서">
      <div class="workflow-step"><strong>1. 검색</strong>건물명·지번·도로명 입력 후 Enter</div>
      <div class="workflow-step"><strong>2. 요약</strong>상담등급·평당가·거래건수 확인</div>
      <div class="workflow-step"><strong>3. 근거</strong>월별 그래프와 개별 거래표 확인</div>
      <div class="workflow-step"><strong>4. 저장</strong>요약 복사, CSV 다운로드, 인쇄/PDF</div>
    </div>

    <div class="mode-switch" id="dashboardUseMode" aria-label="대시보드 용도 선택">
      <button type="button" class="mode-button active" data-dashboard-use="office"><strong>업무시설 보기</strong>사무실·오피스 기준으로 보기</button>
      <button type="button" class="mode-button" data-dashboard-use="retail"><strong>상가 보기</strong>1층과 상층 가격을 나눠 보기</button>
    </div>

    <div class="toolbar">
      <label class="search-field">건물 검색
        <input id="search" type="search" placeholder="건물명·지번·도로명 입력 예: 퀸즈파크나인, 797-1" autocomplete="off" aria-controls="searchSuggestions" aria-expanded="false">
        <div id="searchSuggestions" class="search-suggestions" role="listbox"></div>
      </label>
      <label>주소 범위<select id="maskFilter"><option value="all">전체</option><option value="exact">확인된 건물</option><option value="masked">보조그룹</option></select></label>
      <label>최소 거래<input id="minCount" type="number" min="1" value="1"></label>
      <label>정렬<select id="sortBy"><option value="count">거래 많은 순</option><option value="change">변화 큰 순</option><option value="price">거래금액 순</option><option value="unit">평당가 순</option></select></label>
    </div>

    <section class="plain-guide" id="plainGuideBoard">
      <h2>마곡동 전체 흐름</h2>
      <p>선택 건물을 보기 전에 마곡동 전체 가격 흐름을 가볍게 확인하는 영역입니다. 처음에는 건물 검색부터 해도 괜찮습니다.</p>
      <div class="plain-cards" id="plainGuideCards"></div>
    </section>

    <section class="valuation-dashboard core-dashboard" id="aggregateTrendSection">
      <div class="detail-title">
        <h2>1. 마곡동 가격 흐름은 어느 방향인가?</h2>
        <span class="badge" id="aggregateTrendBadge">전체 DB 기준</span>
      </div>
      <p class="muted">연도, 월, 용도, 평형을 고르면 평당가 흐름과 거래량이 먼저 보입니다. 이 차트는 가격 판단이 아니라 시장 흐름 확인용입니다.</p>
      <div class="valuation-toolbar">
        <label>기간 단위<select id="aggregatePeriod"><option value="year">연도별</option><option value="month">월별</option></select></label>
        <label>연도 선택<select id="aggregateYear"></select></label>
        <label>월 선택<select id="aggregateMonth"></select></label>
        <label>용도<select id="aggregateUse"><option value="all">전체</option><option value="office">업무시설</option><option value="retail">근린생활시설</option></select></label>
        <label>평당가 기준<select id="aggregateBasis"><option value="exclusive">전용평당가</option><option value="contract">계약평당가</option><option value="supply">공급평당가</option></select></label>
        <label>평형별<select id="aggregateAreaBand"><option value="all">전체 평형</option><option value="under10">10평 미만</option><option value="10to30">10평 이상~30평 미만</option><option value="30to50">30평 이상~50평 미만</option><option value="50to100">50평 이상~100평 미만</option><option value="over100">100평 이상 거래</option></select></label>
      </div>
      <div class="core-story" id="aggregateStoryCards"></div>
      <div class="valuation-layout">
        <div class="valuation-summary" id="aggregateTrendSummary"></div>
        <div class="valuation-chart"><svg id="aggregateTrendChart" viewBox="0 0 980 420" role="img" aria-label="집합건물 연도별 월별 거래가격과 평당가"></svg></div>
      </div>
      <div class="table-scroll" style="margin-top:12px"><table id="aggregateTrendTable"></table></div>
    </section>

    <section class="valuation-dashboard" id="dataRefinementBoard">
      <div class="detail-title">
        <h2>2. 이 숫자는 얼마나 믿을 만한가?</h2>
        <span class="badge">믿고 볼 거래 · 확인할 거래 분리</span>
      </div>
      <p class="muted">모든 거래를 같은 무게로 보지 않습니다. 믿고 기준값으로 볼 거래, 참고만 할 거래, 개별 확인이 필요한 거래를 분리합니다.</p>
      <div class="quality-funnel" id="refinementFunnel"></div>
      <div class="table-scroll" style="margin-top:12px"><table id="refinementTierTable"></table></div>
    </section>

    <details class="pyeong-dashboard compact-disclosure" id="secondaryDashboardPack">
      <summary><span>전문가용 세부 분석 열기</span><span class="badge">용도·건물·층별 세부</span></summary>
      <div class="disclosure-body">

    <section class="valuation-dashboard" id="valuationDashboardSection">
      <div class="detail-title">
        <h2>10년 평당가 변화 현황</h2>
        <span class="badge" id="valuationScopeBadge">마곡동 상업업무용 추이</span>
      </div>
      <p class="muted">가격 입력란 없이 용도, 면적 기준, 기간 단위별 중위 평당가 흐름만 보여줍니다. 매수·매도 판단은 아래 10년 변화와 개별 거래표를 참고해 사용자가 직접 확인합니다.</p>
      <div class="valuation-toolbar">
        <label>평당가 기준<select id="valuationBasis"><option value="exclusive">전용평당가</option><option value="contract">계약평당가</option><option value="supply">공급평당가</option></select></label>
        <label>비교 용도<select id="valuationUse"><option value="office">업무시설</option><option value="retail">상가/근린생활</option></select></label>
        <label>기간 단위<select id="valuationPeriod"><option value="year">연도별 추이</option><option value="month">월별 추이</option></select></label>
      </div>
      <div class="valuation-layout">
        <div class="valuation-summary" id="valuationSummary"></div>
        <div class="valuation-chart"><svg id="valuationTrendChart" viewBox="0 0 980 420" role="img" aria-label="10년 평당가 변화 추이"></svg></div>
      </div>
      <p class="muted" id="valuationMeta" style="margin-top:10px">첫 화면은 마곡동 전체 상업업무용 시장 기준입니다. 건물 행을 클릭하거나 검색 후 Enter를 누르면 선택 건물 추이를 함께 표시합니다.</p>
    </section>

    <section class="trend-board" id="trendBoardSection">
      <div class="detail-title">
        <h2>건물·연도·월별 변화 보드</h2>
        <span class="badge" id="trendBoardBadge">선택 건물 기준</span>
      </div>
      <p class="muted" id="trendBoardMeta">첫 화면은 특정 건물을 추천하지 않도록 마곡동 전체 유사군 흐름을 먼저 보여줍니다. 건물을 선택하면 선택 건물의 연도별 평당가 선과 월별 거래 밀도로 전환됩니다.</p>
      <div class="trend-layout">
        <div class="trend-chart"><svg id="trendBoardChart" viewBox="0 0 980 360" role="img" aria-label="건물 연도별 평당가 변화"></svg></div>
        <div class="trend-summary" id="trendBoardSummary"></div>
      </div>
      <div class="trend-heatmap" id="trendMonthHeatmap" aria-label="월별 변화 히트맵"></div>
    </section>

    <section class="usage-split-board" id="usageSplitBoardSection">
      <div class="detail-title">
        <h2>업무시설·근린생활시설 판독판</h2>
        <span class="badge">용도 분리 기준</span>
      </div>
      <p class="muted">업무시설은 면적대별 시장 기준값을 먼저 보고, 근린생활시설은 층별 가격 차이를 먼저 봅니다. 특히 근린생활은 1층과 상층이 같은 가격군이 아니므로 층 필터로 나눠 확인하세요.</p>
      <div class="usage-split-layout">
        <section class="usage-panel">
          <h3>업무시설 기준값</h3>
          <p class="muted">오피스는 면적대와 건물별 차이를 같이 봅니다. 계약면적 매칭 건수가 있으면 계약평당가도 함께 확인할 수 있습니다.</p>
          <div class="usage-controls">
            <label>업무 면적대<select id="usageOfficeBand"></select></label>
            <label>추이 단위<select id="usageOfficePeriod"><option value="year">연도별 평당가</option><option value="month">월별 평당가</option></select></label>
            <label>정렬 기준<select id="usageOfficeSort"><option value="count">거래건수</option><option value="unit">전용평당가</option><option value="price">거래금액</option></select></label>
          </div>
          <div class="usage-metrics" id="usageOfficeMetrics"></div>
          <table class="usage-trend-table" id="usageOfficeTrendTable"></table>
          <table class="usage-mini-table" id="usageOfficeTable"></table>
        </section>
        <section class="usage-panel">
          <h3>근린생활시설 층별 기준값</h3>
          <p class="muted">근린생활시설은 1층, 2층, 상층, 지하/기타를 분리합니다. 1층은 붉은 표시로 따로 보며 업무시설 평균과 직접 비교하지 않습니다.</p>
          <div class="usage-controls">
            <label>층 구분<select id="usageRetailFloor"><option value="all">전체 층</option><option value="first">1층</option><option value="second">2층</option><option value="upper">3층 이상</option><option value="basement">지하</option><option value="unknown">층정보 없음</option></select></label>
            <label>추이 단위<select id="usageRetailPeriod"><option value="year">연도별 평당가</option><option value="month">월별 평당가</option></select></label>
            <label>정렬 기준<select id="usageRetailSort"><option value="floor">층 우선</option><option value="unit">전용평당가</option><option value="count">거래건수</option></select></label>
          </div>
          <div class="usage-metrics" id="usageRetailMetrics"></div>
          <table class="usage-trend-table" id="usageRetailTrendTable"></table>
          <table class="usage-mini-table" id="usageRetailTable"></table>
        </section>
      </div>
    </section>

      </div>
    </details>

    <details class="pyeong-dashboard compact-disclosure" id="pyeongDashboardSection">
      <summary><span>마곡동 전체 평당가 매트릭스</span><span class="badge" id="pyeongModeBadge">년도별 · 건물별</span></summary>
      <div class="disclosure-body">
      <p class="muted">년도별·월별·건물별로 중위 평당가를 비교합니다. 전용/공급/계약 기준을 바꾸면 같은 거래라도 다른 면적 기준으로 즉시 재집계됩니다.</p>
      <div class="pyeong-toolbar">
        <label>기간 단위<select id="pyeongGranularity"><option value="year">년도별</option><option value="month">월별</option></select></label>
        <label>평당가 기준<select id="pyeongBasis"><option value="exclusive">전용평당가</option><option value="supply">공급평당가</option><option value="contract">계약평당가</option></select></label>
        <label>용도 분리<select id="pyeongUseFilter"><option value="office">업무시설</option><option value="retail">상가/근린생활</option></select></label>
        <label>월 표시 범위<select id="pyeongMonthWindow"><option value="36">최근 36개월</option><option value="60">최근 60개월</option><option value="all">전체 월</option></select></label>
        <label>최소 건물 거래<input id="pyeongMinCount" type="number" min="1" value="2"></label>
        <label>매트릭스 정렬<select id="pyeongSortBy"><option value="recent">최근기간</option><option value="latest">최근 평당가</option><option value="count">거래건수</option><option value="change">변동률</option><option value="name">건물명</option></select></label>
      </div>
      <div class="pyeong-summary" id="pyeongSummary"></div>
      <div class="pyeong-layout">
        <div class="pyeong-heatmap" id="pyeongHeatmap"></div>
        <div class="pyeong-side"><table id="pyeongTable"></table></div>
      </div>
      </div>
    </details>

    <section id="buildingDetailSection" class="building-result-shell">
      <div class="building-result-topbar">
        <div><span>건물 검색</span> <span>›</span> <strong id="buildingSearchCrumb">건물을 선택하세요</strong></div>
        <div>데이터 기준일: <strong id="buildingDataDate">2026-06-23</strong></div>
      </div>
      <div class="building-profile-card">
        <img id="buildingProfileImage" src="magok-commercial-hero.png" alt="선택 건물 대표 이미지">
        <div class="building-profile-copy">
          <div class="detail-title">
            <h2 id="detailTitle">건물을 선택하면 요약이 나옵니다</h2>
            <span class="badge" id="detailBadge">검색부터 시작</span>
          </div>
          <p id="detailMeta">검색창에서 건물을 고르면 이곳에 상담등급, 평당가, 월별 거래 흐름이 정리됩니다.</p>
          <div class="building-profile-chips" id="buildingProfileChips"></div>
        </div>
        <div class="building-profile-actions">
          <button type="button" class="button secondary" data-commercial-action="copy-summary">요약 복사</button>
          <button type="button" class="button secondary" data-commercial-action="download-csv">CSV 다운로드</button>
          <button type="button" class="button secondary" data-commercial-action="print">인쇄/PDF</button>
        </div>
      </div>
      <div class="detail-tabs building-view-tabs" id="detailUseTabs"></div>
      <div class="commercial-report">
        <div class="commercial-summary" id="detailCommercialSummary"></div>
        <div class="commercial-actions"><span class="commercial-status" id="commercialActionStatus"></span></div>
      </div>
      <div class="building-result-grid">
        <aside class="building-side-card">
          <h3>위치</h3>
          <div class="building-map-preview" id="buildingMapPreview">마곡동<br><span id="buildingMapLabel">건물 선택 대기</span></div>
          <h3>건물 정보</h3>
          <dl class="building-info-list" id="buildingInfoList"></dl>
        </aside>
        <section class="building-chart-card">
          <h3>월별 평균 실거래가 추이 <span class="muted" id="buildingChartBasis">전용면적 기준</span></h3>
          <div class="detail-chart"><svg id="detailMonthlyChart" viewBox="0 0 920 360" role="img" aria-label="선택 건물 월단위 거래가격"></svg></div>
          <div class="detail-stats" id="detailStats"></div>
        </section>
        <aside class="building-recent-card">
          <div class="detail-title"><h3>최근 실거래 내역</h3><button type="button" class="button secondary" data-commercial-action="download-csv">전체 보기</button></div>
          <div class="table-scroll"><table id="detailTransactionTable"></table></div>
          <p class="muted" style="margin-top:10px">상세 CSV에는 호실 후보, 호실검증, 호실 후보검증, 전용면적 오차㎡, 면적근거, 계약면적 근거, 직접공용㎡, 각층/기타공용㎡가 포함됩니다.</p>
        </aside>
      </div>
      <div class="building-lower-grid">
        <section class="building-mini-card"><h3>현재 매물 vs 실거래 비교</h3><div class="mini-compare" id="buildingCompareMini"></div></section>
        <section class="building-mini-card"><h3>층별 평균 거래가</h3><div class="bar-list" id="buildingFloorBars"></div></section>
        <section class="building-mini-card"><h3>면적별 평균 평당가</h3><div class="bar-list" id="buildingAreaBars"></div></section>
      </div>
      <div class="detail-subsection building-mini-card">
        <h3>선택 건물 동일일자·동일층 묶음 거래</h3>
        <p class="muted" id="detailBundleMeta" style="margin-bottom:10px">선택 건물에서 같은 계약일·같은 층에 2건 이상 거래된 업무시설 호실을 합산해 보여줍니다.</p>
        <div class="table-scroll"><table id="detailSameDayBundleTable"></table></div>
      </div>
    </section>

    <details class="methodology compact-disclosure">
      <summary><span>분석 기준값과 신뢰도</span><span class="badge">계약면적·상가분리 기준</span></summary>
      <div class="method-grid">
        <div class="method-box">
          <h3>읽는 기준</h3>
          <ul>
            <li>기준값은 평균보다 중위 전용평당가를 우선합니다. 평균은 고가·저가 단일 거래에 흔들릴 수 있습니다.</li>
            <li>전용평당가 = 거래금액 / 전용평수, 공급평당가 = 거래금액 / 공급평수 후보, 계약평당가 = 거래금액 / 계약평수입니다.</li>
            <li>공급면적 후보는 전용+직접공용, 계약면적은 전용+직접공용+각층/기타공용으로 분리 표시합니다.</li>
            <li>오피스는 면적대와 건물별 차이를 같이 보고, 근린생활/상가는 1층과 상층을 분리해서 봅니다.</li>
          </ul>
        </div>
        <div class="method-box">
          <h3>신뢰도 등급</h3>
          <ul>
            <li>A 기준: 정확 지번 또는 공식 표제부+단일 후보+층면적 매칭이 확인된 시장 기준값.</li>
            <li>B 참고: 공식 단일 후보이나 약식 매칭이거나 일부 보완점이 남은 참고 기준값.</li>
            <li>C 보조: 미확정 후보, 이상치 후보, 표본 부족 등으로 보조 확인이 필요한 값.</li>
            <li>D 확인: 표본 1~2건. 개별 거래내역, 층, 면적, 계약면적을 먼저 확인합니다.</li>
          </ul>
        </div>
        <div class="method-box">
          <h3>공식자료 주의</h3>
          <ul>
            <li>국토부 실거래 공개 자료는 참고용이며 법적 효력이 없습니다. 외부 공개용 통계는 공식통계를 우선해야 합니다.</li>
            <li>신고정보는 변경·해제될 수 있어 제공 시점에 따라 건수와 내용이 달라질 수 있습니다.</li>
            <li>본 대시보드는 계약일 기준으로 집계하고, 해제 거래는 평균·중위값 계산에서 제외합니다.</li>
          </ul>
        </div>
        <div class="method-box">
          <h3>업무시설과 상가 분리</h3>
          <ul>
            <li>한국부동산원 상업용부동산 통계도 오피스와 매장용 기준층을 다르게 봅니다. 오피스 1~2층은 로비·매장 성격이 섞일 수 있습니다.</li>
            <li>근린생활/판매시설은 1층 기준 가격 차이가 커서 업무시설 면적대 평균과 직접 비교하지 않습니다.</li>
            <li>마스킹 지번은 개별 건물 기준값이 아니라 용도·면적·건축년 보조그룹입니다.</li>
          </ul>
        </div>
      </div>
    </details>

    <details class="pyeong-dashboard compact-disclosure" id="userDetailAnalysisPack">
      <summary><span>상세 표와 원자료 보기</span><span class="badge">업무·상가·전체 지번 분석</span></summary>
      <div class="disclosure-body">

    <div class="analysis-band">
      <section>
        <h2>업무시설 면적대별 평당가</h2>
        <p class="muted" style="margin-bottom:10px">업무시설은 전용면적 구간별로 거래금액과 전용/계약 평당가를 분리했습니다. 면적대별 평균은 시장 기준, 건물별 표는 개별 건물 프리미엄 차이를 보는 기준입니다.</p>
        <div class="table-scroll"><table id="officeAreaBandTable"></table></div>
      </section>
      <section>
        <h2>업무시설 동일일자·동일층 묶음 거래</h2>
        <p class="muted" style="margin-bottom:10px">같은 건물, 같은 계약일, 같은 층에서 2건 이상 거래된 호실을 하나의 묶음 거래처럼 합산합니다. 예를 들어 10평대 3건은 약 30평 묶음으로 보고 총액 기준 평당가를 계산합니다.</p>
        <div class="table-scroll"><table id="officeSameDayFloorTable"></table></div>
      </section>
    </div>

    <section style="margin-top:14px">
      <div class="detail-title">
        <h2>업무시설 면적대별 연도/월/건물 차이</h2>
        <label style="min-width:180px">면적대 선택<select id="officeBandSelect"></select></label>
      </div>
      <p class="muted" id="officeBandTrendMeta" style="margin-bottom:10px">-</p>
      <div class="analysis-band">
        <div class="chart-wrap"><svg id="officeBandYearChart" viewBox="0 0 920 320" role="img" aria-label="업무시설 면적대별 연도별 평당가"></svg></div>
        <div class="chart-wrap"><svg id="officeBandMonthChart" viewBox="0 0 920 320" role="img" aria-label="업무시설 면적대별 월별 평당가"></svg></div>
      </div>
      <div class="table-scroll" style="margin-top:10px"><table id="officeBandBuildingTable"></table></div>
    </section>

    <section style="margin-top:14px">
      <h2>근린생활/상가 건물별 층별 금액 차트</h2>
      <p class="muted" id="retailFloorChartCount" style="margin-bottom:10px">-</p>
      <div class="table-scroll"><table id="retailFloorChartTable"></table></div>
    </section>

    <div class="grid">
      <section>
        <h2>연도별 중위 ㎡단가와 거래량</h2>
        <div class="chart-wrap"><svg id="yearChart" viewBox="0 0 920 360" role="img" aria-label="연도별 중위 단가 차트"></svg></div>
        <div class="legend"><span><i class="dot" style="background: var(--brand)"></i>중위 ㎡단가(만원)</span><span><i class="dot" style="background: var(--brand-2)"></i>거래량</span></div>
      </section>
      <section>
        <h2>수집/품질 요약</h2>
        <table id="sourceTable"></table>
        <div class="cta">
          <span><strong>다음 액션.</strong> 미확정 보조그룹은 개별 건물 확정이 불가능하므로 정확 지번 그룹 중심으로 후보를 검토하세요.</span>
          <button class="button" onclick="window.print()">인쇄/PDF</button>
        </div>
      </section>
    </div>

    <section style="margin-top:14px">
      <div class="detail-title">
        <h2>3. 건물 비교 전에 평형부터 고르기</h2>
        <span class="badge" id="buildingAreaBandBadge">전체 평형</span>
      </div>
      <div class="valuation-toolbar">
        <label>평형별<select id="buildingAreaBand"><option value="all">전체 평형</option><option value="under10">10평 미만</option><option value="10to30">10평 이상~30평 미만</option><option value="30to50">30평 이상~50평 미만</option><option value="50to100">50평 이상~100평 미만</option><option value="over100">100평 이상 거래</option></select></label>
      </div>
      <p class="muted">같은 건물이라도 10평대와 50평대는 다르게 봐야 합니다. 아래 건물별 표와 그래프는 이 평형 필터를 같이 씁니다.</p>
    </section>

    <section style="margin-top:14px">
      <h2>건물별로 연도·월 가격이 어떻게 달랐나?</h2>
      <p class="muted" id="buildingAnalysisCount" style="margin-bottom:10px">-</p>
      <div class="table-scroll"><table id="buildingAnalysisTable"></table></div>
    </section>

    <section style="margin-top:14px">
      <h2>신뢰 가능한 월별 건물 흐름만 보기</h2>
      <p class="muted" id="buildingMonthlyGraphCount" style="margin-bottom:10px">-</p>
      <div class="graph-grid" id="buildingMonthlyGraphGrid"></div>
    </section>

    <section style="margin-top:14px">
      <h2>건물별 연도 흐름 비교</h2>
      <p class="muted" id="buildingGraphCount" style="margin-bottom:10px">-</p>
      <div class="graph-grid" id="buildingGraphGrid"></div>
    </section>

    <section style="margin-top:14px">
      <h2>지번별 가격 변화 테이블</h2>
      <p class="muted" id="groupCount" style="margin-bottom:10px">-</p>
      <div class="table-scroll"><table id="groupTable"></table></div>
    </section>

    <section style="margin-top:14px">
      <h2>변화율 상위 그룹</h2>
      <div class="chart-wrap"><svg id="moverChart" viewBox="0 0 920 420" role="img" aria-label="단가 변화율 상위 지번 그룹"></svg></div>
    </section>
      </div>
    </details>
  </main>

  <script id="dashboardData" type="application/json">${JSON.stringify(compactPayload).replace(/</g, "\\u003c")}</script>
  <script>
    const data = JSON.parse(document.getElementById("dashboardData").textContent);
    const fmt = new Intl.NumberFormat("ko-KR");
    const SQM_PER_PYEONG_CLIENT = 3.305785;
    const pct = (value) => Number.isFinite(value) ? value.toFixed(1) + "%" : "-";
    const money = (value) => Number.isFinite(value) ? fmt.format(Math.round(value)) : "-";
    const state = {
      search: "",
      mask: "all",
      minCount: 1,
      sortBy: "count",
      dashboardUse: "office",
      buildingAreaBand: "all",
      aggregatePeriod: "year",
      aggregateYear: "all",
      aggregateMonth: "all",
      aggregateUse: "all",
      aggregateBasis: "exclusive",
      aggregateAreaBand: "all",
      selectedParcelKey: "",
      selectedUseCategory: "office",
      officeBand: data.officeAreaBandSummary?.[0]?.band_label || "",
      suggestionIndex: 0,
      pyeongGranularity: "year",
      pyeongBasis: "exclusive",
      pyeongUse: "office",
      pyeongMonthWindow: "36",
      pyeongMinCount: 2,
      pyeongSortBy: "recent",
      valuationBasis: "exclusive",
      valuationUse: "office",
      valuationPeriod: "year",
      usageOfficeSort: "count",
      usageOfficePeriod: "year",
      usageRetailFloor: "all",
      usageRetailSort: "floor",
      usageRetailPeriod: "year",
    };

    function dashboardUseLabel(value = state.dashboardUse) {
      return value === "retail" ? "근린생활시설" : "업무시설";
    }

    function dashboardUseRecords() {
      return data.records.filter((record) => record.analysis_eligible !== false && useCategory(record) === state.dashboardUse);
    }

    function dashboardUseParcelKeys() {
      return new Set(dashboardUseRecords().map((record) => record.parcel_key));
    }

    function syncUseControls() {
      state.valuationUse = state.dashboardUse;
      state.pyeongUse = state.dashboardUse;
      const valuation = document.getElementById("valuationUse");
      const pyeong = document.getElementById("pyeongUseFilter");
      if (valuation) valuation.value = state.dashboardUse;
      if (pyeong) pyeong.value = state.dashboardUse;
      document.querySelectorAll("[data-dashboard-use]").forEach((button) => {
        button.classList.toggle("active", button.dataset.dashboardUse === state.dashboardUse);
      });
    }

    function yearSummaryForDashboardUse() {
      const rows = dashboardUseRecords();
      return data.source.available_years.map((year) => {
        const yearRows = rows.filter((record) => record.year === year);
        return {
          year,
          count: yearRows.length,
          masked_count: yearRows.filter((record) => record.is_masked_parcel).length,
          median_ppsqm_manwon: medianClient(yearRows.map((record) => record.price_per_sqm_manwon)),
          median_exclusive_ppyeong_manwon: medianClient(yearRows.map((record) => record.exclusive_ppyeong_manwon)),
        };
      });
    }

    function setKpis() {
      const rows = dashboardUseRecords();
      const parcelKeys = new Set(rows.map((record) => record.parcel_key));
      const years = data.source.available_years || [];
      const unresolved = data.metrics.unresolved_high_confidence_masked_records || 0;
      document.getElementById("kpiRecords").textContent = fmt.format(rows.length) + "건";
      document.getElementById("kpiYears").textContent = years.length ? years[0] + "-" + years.at(-1) : "-";
      document.getElementById("kpiBuilding").textContent = dashboardUseLabel() + " " + fmt.format(parcelKeys.size) + "개";
      const yearlyMedian = yearSummaryForDashboardUse().map((row) => row.median_exclusive_ppyeong_manwon).filter(Number.isFinite);
      const med = yearlyMedian.sort((a, b) => a - b)[Math.floor(yearlyMedian.length / 2)];
      document.getElementById("kpiUnit").textContent = money(med) + "만원/평";
      document.getElementById("kpiMasked").textContent = fmt.format(unresolved) + "건";
      document.getElementById("kpiMaskedWrap").hidden = unresolved === 0;
    }

    function drawYearChart() {
      const svg = document.getElementById("yearChart");
      const rows = yearSummaryForDashboardUse();
      const w = 920, h = 360, pad = 54;
      const maxUnit = Math.max(...rows.map((row) => row.median_ppsqm_manwon || 0)) * 1.12;
      const maxCount = Math.max(...rows.map((row) => row.count || 0)) * 1.18;
      const x = (index) => pad + index * ((w - pad * 2) / Math.max(rows.length - 1, 1));
      const yUnit = (value) => h - pad - ((value || 0) / maxUnit) * (h - pad * 2);
      const barW = Math.min(46, (w - pad * 2) / rows.length * 0.45);
      const points = rows.map((row, index) => x(index) + "," + yUnit(row.median_ppsqm_manwon)).join(" ");
      svg.innerHTML = \`
        <line x1="\${pad}" y1="\${h-pad}" x2="\${w-pad}" y2="\${h-pad}" stroke="#dbe1ea"/>
        <line x1="\${pad}" y1="\${pad}" x2="\${pad}" y2="\${h-pad}" stroke="#dbe1ea"/>
        \${rows.map((row, index) => {
          const bh = ((row.count || 0) / maxCount) * (h - pad * 2);
          const bx = x(index) - barW / 2;
          const by = h - pad - bh;
          return \`<rect x="\${bx}" y="\${by}" width="\${barW}" height="\${bh}" rx="4" fill="#b3482f" opacity="0.24">
            <title>\${row.year} 거래량 \${row.count}건</title></rect>\`;
        }).join("")}
        <polyline fill="none" stroke="#156f78" stroke-width="4" points="\${points}"/>
        \${rows.map((row, index) => \`<circle cx="\${x(index)}" cy="\${yUnit(row.median_ppsqm_manwon)}" r="5" fill="#156f78"><title>\${row.year} 중위 단가 \${money(row.median_ppsqm_manwon)}만원/㎡</title></circle>\`).join("")}
        \${rows.map((row, index) => \`<text x="\${x(index)}" y="\${h - 18}" text-anchor="middle" font-size="13" fill="#647083">\${row.year}</text>\`).join("")}
        <text x="\${pad}" y="25" font-size="13" fill="#647083">중위 ㎡단가(만원)</text>
      \`;
    }

    function drawMoverChart(groups) {
      const svg = document.getElementById("moverChart");
      const rows = groups.filter((group) => Number.isFinite(group.ppsqm_change_pct)).slice(0, 12);
      const w = 920, h = 420, padL = 210, padR = 44, rowH = 28;
      const maxAbs = Math.max(1, ...rows.map((row) => Math.abs(row.ppsqm_change_pct || 0)));
      const zeroX = padL + (w - padL - padR) / 2;
      svg.innerHTML = \`
        <line x1="\${zeroX}" y1="28" x2="\${zeroX}" y2="\${h - 28}" stroke="#dbe1ea"/>
        \${rows.map((row, index) => {
          const y = 42 + index * rowH;
          const len = Math.abs(row.ppsqm_change_pct) / maxAbs * ((w - padL - padR) / 2);
          const x = row.ppsqm_change_pct >= 0 ? zeroX : zeroX - len;
          const color = row.ppsqm_change_pct >= 0 ? "#2f7d4f" : "#b3482f";
          return \`
            <text x="14" y="\${y + 14}" font-size="12" fill="#172033">\${escapeSvg(row.parcel_label.slice(0, 28))}</text>
            <rect x="\${x}" y="\${y}" width="\${len}" height="18" rx="4" fill="\${color}" opacity="0.78"><title>\${escapeSvg(row.parcel_label)} \${pct(row.ppsqm_change_pct)}</title></rect>
            <text x="\${row.ppsqm_change_pct >= 0 ? x + len + 8 : x - 8}" y="\${y + 14}" text-anchor="\${row.ppsqm_change_pct >= 0 ? "start" : "end"}" font-size="12" fill="#647083">\${pct(row.ppsqm_change_pct)}</text>
          \`;
        }).join("")}
      \`;
    }

    function escapeSvg(value) {
      return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
    }

    function normalizeSearchValue(value) {
      return String(value ?? "")
        .toLowerCase()
        .replace(/엠/g, "m")
        .replace(/[()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function compactSearchValue(value) {
      return normalizeSearchValue(value).replace(/\s+/g, "");
    }

    function queryMatches(row, query, fields = []) {
      const normalizedQuery = normalizeSearchValue(query);
      if (!normalizedQuery) return true;
      const compactQuery = compactSearchValue(query);
      const haystack = normalizeSearchValue([row.search_text, ...fields].filter(Boolean).join(" "));
      const compactHaystack = haystack.replace(/\s+/g, "");
      const tokenMatched = normalizedQuery.split(" ").filter(Boolean).every((token) => haystack.includes(token) || compactHaystack.includes(token.replace(/\s+/g, "")));
      return haystack.includes(normalizedQuery) || compactHaystack.includes(compactQuery) || tokenMatched;
    }

    function scoreSearchResult(row, query) {
      const q = normalizeSearchValue(query);
      if (!q) return 0;
      const cq = compactSearchValue(query);
      const building = normalizeSearchValue(row.building_name);
      const buildingCompact = compactSearchValue(row.building_name);
      const parcel = normalizeSearchValue(row.parcel_label);
      const road = normalizeSearchValue(row.road);
      const haystack = normalizeSearchValue([row.search_text, row.parcel_label, row.parcel, row.building_name, row.road, row.main_use, row.zoning].filter(Boolean).join(" "));
      const compactHaystack = haystack.replace(/\s+/g, "");
      let score = 0;
      if (buildingCompact === cq) score += 1200;
      if (buildingCompact.includes(cq)) score += 850;
      if (building.startsWith(q)) score += 700;
      if (parcel.includes(q) || compactSearchValue(row.parcel_label).includes(cq)) score += 620;
      if (road.includes(q) || compactSearchValue(row.road).includes(cq)) score += 540;
      if (haystack.includes(q) || compactHaystack.includes(cq)) score += 360;
      if (!score) {
        let qi = 0;
        for (const char of compactHaystack) {
          if (char === cq[qi]) qi += 1;
          if (qi === cq.length) break;
        }
        if (qi === cq.length) score += Math.max(80, 240 - compactHaystack.length);
      }
      return score + Math.min(row.transaction_count || 0, 80);
    }

    function rankedSearchResults(limit = 8) {
      const q = state.search;
      if (!normalizeSearchValue(q)) return [];
      const allowed = dashboardUseParcelKeys();
      return data.parcelGroups
        .filter((group) => allowed.has(group.parcel_key))
        .map((group) => ({ group, score: scoreSearchResult(group, q) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.group.transaction_count - a.group.transaction_count || a.group.parcel_label.localeCompare(b.group.parcel_label, "ko"))
        .slice(0, limit);
    }

    function closeSearchSuggestions() {
      const box = document.getElementById("searchSuggestions");
      box.classList.remove("open");
      box.innerHTML = "";
      document.getElementById("search").setAttribute("aria-expanded", "false");
    }

    function renderSearchSuggestions() {
      const box = document.getElementById("searchSuggestions");
      const input = document.getElementById("search");
      const rows = rankedSearchResults();
      if (!rows.length) {
        closeSearchSuggestions();
        return;
      }
      state.suggestionIndex = Math.max(0, Math.min(state.suggestionIndex, rows.length - 1));
      box.innerHTML = rows.map(({ group, score }, index) => {
        const active = index === state.suggestionIndex;
        return '<button type="button" class="suggestion-item ' + (active ? "active" : "") + '" role="option" aria-selected="' + (active ? "true" : "false") + '" data-parcel-key="' + escapeSvg(group.parcel_key) + '">' +
          '<span class="suggestion-title">' + escapeSvg(buildingTitle(group)) + '</span>' +
          '<span class="suggestion-score">' + fmt.format(Math.round(score)) + '</span>' +
          '<span class="suggestion-meta">' + escapeSvg([group.parcel_label, group.road || "도로명 없음", fmt.format(group.transaction_count) + "건"].join(" · ")) + '</span>' +
        '</button>';
      }).join("");
      box.classList.add("open");
      input.setAttribute("aria-expanded", "true");
    }

    function selectedMonthlyGroup() {
      if (!state.selectedParcelKey) return null;
      return data.buildingMonthlySeries.find((group) => group.parcel_key === state.selectedParcelKey) || null;
    }

    function useCategory(record) {
      const use = String(record?.main_use || record?.business_type || "");
      if (/근린생활|판매/.test(use)) return "retail";
      if (use.includes("업무")) return "office";
      return "other";
    }

    function useCategoryLabel(category) {
      if (category === "office") return "업무시설";
      if (category === "retail") return "상가";
      if (category === "all") return "전체";
      return "기타";
    }

    function roomValidationLabel(row) {
      const confidence = String(row.contract_area_confidence || "");
      const count = Number(row.contract_area_matched_room_count);
      if (!confidence) return "미검증";
      if (confidence === "high" && count === 1) return "단일 호실 후보";
      if (confidence === "same_area_multi_room") return "동일면적 " + fmt.format(count || 0) + "호 후보";
      if (confidence === "rough_floor_area_nearest") return "근사면적 후보";
      if (confidence.includes("unique_room")) return "유일 호실 후보";
      if (confidence.includes("same_area_rooms")) return "동일면적 복수 후보";
      return "호실 후보 있음";
    }

    function roomCandidateText(row) {
      const unit = row.contract_area_matched_unit_sample || "";
      const count = Number(row.contract_area_matched_room_count);
      if (!unit && !count) return "-";
      return (unit || "호실 후보") + (count > 1 ? " 외 " + fmt.format(count - 1) + "개" : "");
    }

    function averageClient(values) {
      const nums = values.filter(Number.isFinite);
      if (!nums.length) return null;
      return nums.reduce((sum, value) => sum + value, 0) / nums.length;
    }

    function monthlyPointsFromRows(rows) {
      const byMonth = new Map();
      for (const row of rows) {
        if (!row.month) continue;
        if (!byMonth.has(row.month)) byMonth.set(row.month, []);
        byMonth.get(row.month).push(row);
      }
      return [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, monthRows]) => ({
          month,
          count: monthRows.length,
          avg_price_manwon: averageClient(monthRows.map((row) => row.price_manwon)),
          median_price_manwon: medianClient(monthRows.map((row) => row.price_manwon)),
        }));
    }

    function setDefaultUseCategory(parcelKey) {
      const rows = data.records.filter((record) => record.parcel_key === parcelKey);
      const categories = new Set(rows.map(useCategory));
      state.selectedUseCategory = categories.has("office") ? "office" : categories.has("retail") ? "retail" : "all";
    }

    function selectBuilding(parcelKey, shouldScroll = true) {
      state.selectedParcelKey = parcelKey;
      setDefaultUseCategory(parcelKey);
      setValuationDefaultsFromSelected();
      renderDecisionBoards();
      renderUsageSplitBoard();
      renderBuildingDetail();
      markSelectedBuilding();
      if (shouldScroll) {
        document.getElementById("buildingDetailSection").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    function selectFirstSearchResult() {
      const ranked = rankedSearchResults();
      const firstGroup = ranked[state.suggestionIndex]?.group || filteredGroups()[0];
      if (!firstGroup) return false;
      selectBuilding(firstGroup.parcel_key);
      closeSearchSuggestions();
      return true;
    }

    function markSelectedBuilding() {
      document.querySelectorAll("[data-parcel-key]").forEach((element) => {
        element.classList.toggle("selected", element.dataset.parcelKey === state.selectedParcelKey);
      });
    }

    function renderDetailUseTabs(allRows) {
      const counts = {
        office: allRows.filter((row) => useCategory(row) === "office").length,
        retail: allRows.filter((row) => useCategory(row) === "retail").length,
        all: allRows.length,
      };
      const tabs = [
        ["office", "업무시설"],
        ["retail", "상가"],
        ["all", "전체"],
      ].filter(([key]) => counts[key] > 0);
      if (!tabs.some(([key]) => key === state.selectedUseCategory)) {
        state.selectedUseCategory = tabs[0]?.[0] || "all";
      }
      document.getElementById("detailUseTabs").innerHTML = tabs.map(([key, label]) =>
        '<button type="button" class="detail-tab ' + (state.selectedUseCategory === key ? "active" : "") + '" data-detail-use="' + key + '">' +
          escapeSvg(label) + ' ' + fmt.format(counts[key]) + '건' +
        '</button>'
      ).join("");
    }

    function detailBundleRows(group) {
      return (data.officeSameDayFloorSummary || [])
        .filter((row) => row.parcel_key === group.parcel_key)
        .sort((a, b) => b.contract_date.localeCompare(a.contract_date) || b.transaction_count - a.transaction_count);
    }

    function commercialGrade(group, analysisRows, bundleRows, contractPyeongPrices) {
      if (!group || group.is_masked_parcel) return "C 보조";
      if (analysisRows.length >= 10 && contractPyeongPrices.length >= 3 && bundleRows.length >= 1) return "A 상담기준";
      if (analysisRows.length >= 5 && (contractPyeongPrices.length || bundleRows.length)) return "B 참고";
      if (analysisRows.length >= 3) return "C 보조";
      return "D 확인";
    }

    function eokText(value) {
      if (!Number.isFinite(value)) return "-";
      if (Math.abs(value) >= 10000) return (value / 10000).toFixed(2) + "억원";
      return money(value) + "만원";
    }

    function dealDateText(row) {
      if (!row || !row.month) return "-";
      return row.month.replace("-", ".") + "." + String(row.contract_day || "").padStart(2, "0");
    }

    function pyeongValue(row) {
      if (Number.isFinite(row?.exclusive_pyeong)) return row.exclusive_pyeong;
      if (Number.isFinite(row?.area_sqm)) return row.area_sqm / SQM_PER_PYEONG_CLIENT;
      return null;
    }

    function pyeongText(value) { return Number.isFinite(value) ? value.toFixed(2) + "평" : "-"; }
    function rowPyeongText(row) { return pyeongText(pyeongValue(row)); }
    function sqmPyeongText(row) {
      const pyeong = pyeongValue(row);
      if (!Number.isFinite(pyeong)) return "-";
      return (Number.isFinite(row?.area_sqm) ? row.area_sqm.toFixed(2) + "㎡ / " : "") + pyeong.toFixed(2) + "평";
    }
    function floorText(value) { return value ? String(value) + "층" : "-"; }

    function buildGroupedAverages(rows, groupFn, valueFn) {
      const map = new Map();
      for (const row of rows) {
        const key = groupFn(row);
        const value = valueFn(row);
        if (!key || !Number.isFinite(value)) continue;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
      }
      return [...map.entries()].map(([label, values]) => ({ label, value: medianClient(values), count: values.length }));
    }

    function renderBarList(targetId, rows, unit) {
      const max = Math.max(...rows.map((row) => row.value).filter(Number.isFinite), 1);
      document.getElementById(targetId).innerHTML = rows.length ? rows.map((row) => {
        const width = Math.max(8, Math.round((row.value / max) * 100));
        return '<div class="bar-row"><span>' + escapeSvg(row.label) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div><strong>' + escapeSvg(unit(row.value)) + '</strong></div>';
      }).join("") : '<p class="muted">표시할 표본이 없습니다.</p>';
    }

    function renderBuildingInfo(group, rows, analysisRows) {
      const years = analysisRows.map((row) => row.build_year).filter(Number.isFinite);
      const floors = rows.map((row) => Number(row.floor)).filter(Number.isFinite).sort((a, b) => a - b);
      const areas = rows.map((row) => pyeongValue(row)).filter(Number.isFinite).sort((a, b) => a - b);
      const uses = [...new Set(rows.map((row) => row.main_use).filter(Boolean))].slice(0, 3).join(", ") || group.main_use || "자료 없음";
      const infoRows = [["지번주소", group.parcel_label || "-"], ["도로명", group.road || "자료 없음"], ["용도", uses], ["사용승인", years.length ? Math.min(...years) + "년" : "자료 없음"], ["거래층", floors.length ? Math.min(...floors) + "층~" + Math.max(...floors) + "층" : "자료 없음"], ["전용면적", areas.length ? areas[0].toFixed(2) + "평~" + areas.at(-1).toFixed(2) + "평" : "자료 없음"]];
      document.getElementById("buildingInfoList").innerHTML = infoRows.map(([label, value]) => '<div class="building-info-row"><dt>' + escapeSvg(label) + '</dt><dd>' + escapeSvg(value) + '</dd></div>').join("");
    }

    function renderCommercialReport(group, rows, analysisRows, points, pyeongPrices, contractPyeongPrices) {
      const bundleRows = detailBundleRows(group);
      const latestPoint = points.at(-1);
      const latestRow = analysisRows[0] || rows[0] || null;
      const latestYear = latestRow?.year;
      const currentYearPrices = analysisRows.filter((row) => row.year === latestYear).map((row) => row.price_manwon).filter(Number.isFinite);
      const previousYearPrices = analysisRows.filter((row) => row.year === latestYear - 1).map((row) => row.price_manwon).filter(Number.isFinite);
      const currentMedian = medianClient(currentYearPrices);
      const previousMedian = medianClient(previousYearPrices);
      const change = currentMedian && previousMedian ? ((currentMedian - previousMedian) / previousMedian) * 100 : null;
      const summaryItems = [
        ["최근 거래가" + (latestRow ? " (" + dealDateText(latestRow).slice(0, 7) + ")" : ""), eokText(latestRow?.price_manwon), "전용 " + rowPyeongText(latestRow) + " | " + floorText(latestRow?.floor), "₩"],
        ["전년 대비", Number.isFinite(change) ? (change >= 0 ? "▲ " : "▼ ") + Math.abs(change).toFixed(1) + "%" : "-", previousMedian ? (latestYear - 1) + "년 " + eokText(previousMedian) + " → " + latestYear + "년 " + eokText(currentMedian) : "비교 표본 부족", "↗"],
        ["거래 건수" + (latestYear ? " (" + latestYear + "년)" : ""), fmt.format(latestYear ? rows.filter((row) => row.year === latestYear).length : rows.length) + "건", "전체 " + fmt.format(rows.length) + "건 · 기준값 " + fmt.format(analysisRows.length) + "건", "▣"],
        ["평당가", money(medianClient(pyeongPrices)) + "만원", "전용면적 기준 · 계약 " + (contractPyeongPrices.length ? money(medianClient(contractPyeongPrices)) + "만원" : "미확인"), "₩"],
      ];
      document.getElementById("detailCommercialSummary").innerHTML = summaryItems.map(([label, value, note, icon]) => '<div data-icon="' + escapeSvg(icon) + '"><span>' + escapeSvg(label) + '</span><strong>' + escapeSvg(value) + '</strong><small>' + escapeSvg(note) + '</small></div>').join("");
      document.getElementById("commercialActionStatus").textContent = latestPoint ? "최근월 " + latestPoint.month + " 기준, " + fmt.format(rows.length) + "건을 상담용 리포트로 정리할 수 있습니다." : "선택 건물의 상담용 리포트 원장을 정리할 수 있습니다.";
    }

    function renderBuildingDetail() {
      const group = selectedMonthlyGroup();
      if (!group) {
        document.getElementById("buildingSearchCrumb").textContent = "건물 선택 대기";
        document.getElementById("detailTitle").textContent = "건물을 선택하면 요약이 나옵니다";
        document.getElementById("detailBadge").textContent = "검색부터 시작";
        document.getElementById("detailMeta").textContent = "건물명, 지번, 도로명을 검색하면 이 영역이 건물 상세 화면으로 바뀝니다.";
        document.getElementById("buildingProfileChips").innerHTML = '<span>검색 대기</span><span>상담 요약 준비</span><span>월별 그래프 준비</span>';
        document.getElementById("buildingMapLabel").textContent = "건물 선택 대기";
        document.getElementById("buildingInfoList").innerHTML = ["지번주소", "도로명", "용도", "사용승인", "거래층", "전용면적"].map((label) => '<div class="building-info-row"><dt>' + label + '</dt><dd>건물 선택 후 표시</dd></div>').join("");
        document.getElementById("detailUseTabs").innerHTML = "";
        document.getElementById("detailStats").innerHTML = "";
        document.getElementById("detailCommercialSummary").innerHTML = [["상담 상태", "건물 선택 필요", "검색하면 즉시 요약 카드가 열립니다", "⌕"], ["최근 거래", "대기", "건물별 최신 거래를 표시합니다", "₩"], ["월별 그래프", "대기", "거래금액 변동을 보여줍니다", "↗"], ["원장 저장", "대기", "CSV·인쇄 기능 제공", "▣"]].map(([label, value, note, icon]) => '<div data-icon="' + icon + '"><span>' + label + '</span><strong>' + value + '</strong><small>' + note + '</small></div>').join("");
        document.getElementById("commercialActionStatus").textContent = "검색창에서 건물을 선택하세요.";
        document.getElementById("detailMonthlyChart").innerHTML = '<text x="24" y="58" fill="#647083" font-size="15">건물을 선택하면 월단위 거래가격이 표시됩니다.</text>';
        document.getElementById("detailTransactionTable").innerHTML = '<tbody><tr><td>건물을 선택하면 최근 실거래 내역이 표시됩니다.</td></tr></tbody>';
        document.getElementById("buildingCompareMini").innerHTML = '<p class="muted">건물 선택 후 표시됩니다.</p>';
        document.getElementById("buildingFloorBars").innerHTML = '<p class="muted">건물 선택 후 표시됩니다.</p>';
        document.getElementById("buildingAreaBars").innerHTML = '<p class="muted">건물 선택 후 표시됩니다.</p>';
        document.getElementById("detailBundleMeta").textContent = "건물을 선택하면 동일일자·동일층 묶음 거래가 표시됩니다.";
        document.getElementById("detailSameDayBundleTable").innerHTML = '<tbody><tr><td>건물을 선택하세요.</td></tr></tbody>';
        return;
      }
      const allRows = data.records.filter((record) => record.parcel_key === group.parcel_key).sort((a, b) => (b.month || "").localeCompare(a.month || "") || (b.contract_day || 0) - (a.contract_day || 0));
      renderDetailUseTabs(allRows);
      const rows = state.selectedUseCategory === "all" ? allRows : allRows.filter((record) => useCategory(record) === state.selectedUseCategory);
      const analysisRows = rows.filter((row) => row.analysis_eligible !== false);
      const prices = analysisRows.map((row) => row.price_manwon).filter(Number.isFinite);
      const pyeongPrices = analysisRows.map((row) => row.exclusive_ppyeong_manwon).filter(Number.isFinite);
      const contractPyeongPrices = analysisRows.map((row) => row.contract_ppyeong_manwon).filter(Number.isFinite);
      const points = monthlyPointsFromRows(analysisRows);
      const latest = points.at(-1);
      const years = [...new Set(rows.map((row) => row.year).filter(Boolean))].sort((a, b) => a - b);
      const publicStart = data.source.requested_years?.[0] || data.source.available_years?.[0];
      const coverageNote = years.length ? (publicStart && years[0] > publicStart ? " · 정확 지번 공개 관측 " + years[0] + "-" + years.at(-1) + "년만 표시" : " · 관측 " + years[0] + "-" + years.at(-1) + "년") : " · 관측 없음";
      const title = buildingTitle(group);
      const probableCount = rows.filter((row) => row.probable_parcel_key).length;
      document.getElementById("buildingSearchCrumb").textContent = title;
      document.getElementById("detailTitle").textContent = title;
      document.getElementById("detailBadge").textContent = useCategoryLabel(state.selectedUseCategory);
      document.getElementById("detailMeta").textContent = (group.road || group.parcel_label || "마곡동") + " · " + useCategoryLabel(state.selectedUseCategory) + " 거래 " + fmt.format(rows.length) + "건 · 관측월 " + fmt.format(points.length) + "개월 · 최근월 " + (latest?.month || "-") + coverageNote;
      document.getElementById("buildingProfileChips").innerHTML = [group.is_masked_parcel ? "미확정 보조그룹" : (probableCount ? "정확+추정" : (group.building_name_status || "정확 지번")), "지번 " + (group.parcel_label || "-"), "거래 " + fmt.format(rows.length) + "건", "계약면적 " + (contractPyeongPrices.length ? "확인" : "미확인")].map((text) => '<span>' + escapeSvg(text) + '</span>').join("");
      document.getElementById("buildingMapLabel").textContent = title;
      renderCommercialReport(group, rows, analysisRows, points, pyeongPrices, contractPyeongPrices);
      renderBuildingInfo(group, rows, analysisRows);
      document.getElementById("detailStats").innerHTML = [["기준값 반영", fmt.format(analysisRows.length) + "건"], ["최저-최고", prices.length ? eokText(Math.min(...prices)) + "~" + eokText(Math.max(...prices)) : "-"], ["중위 계약평당가", contractPyeongPrices.length ? money(medianClient(contractPyeongPrices)) + "만원" : "미확인"]].map(([label, value]) => '<div class="detail-stat"><span>' + escapeSvg(label) + '</span><strong>' + escapeSvg(value) + '</strong></div>').join("");
      drawDetailMonthlyChart(group, points);
      const recentRows = rows.slice(0, 8);
      document.getElementById("detailTransactionTable").innerHTML = '<thead><tr><th>계약일</th><th>층</th><th>전용면적</th><th>거래금액</th></tr></thead><tbody>' + (recentRows.length ? recentRows.map((row) => '<tr><td>' + escapeSvg(dealDateText(row)) + '</td><td>' + escapeSvg(floorText(row.floor)) + '</td><td>' + escapeSvg(sqmPyeongText(row)) + '</td><td><strong>' + escapeSvg(eokText(row.price_manwon)) + '</strong></td></tr>').join("") : '<tr><td colspan="4">표시할 거래가 없습니다.</td></tr>') + '</tbody>';
      const latestPrice = analysisRows[0]?.price_manwon;
      const medianPrice = medianClient(prices);
      document.getElementById("buildingCompareMini").innerHTML = '<div class="mini-price-box"><span>최근 거래</span><strong>' + escapeSvg(eokText(latestPrice)) + '</strong><small>최근 실거래 기준</small></div><div class="mini-vs">VS</div><div class="mini-price-box"><span>중위 거래</span><strong>' + escapeSvg(eokText(medianPrice)) + '</strong><small>선택 용도 기준</small></div>';
      renderBarList("buildingFloorBars", buildGroupedAverages(analysisRows, (row) => row.floor ? floorText(row.floor) : null, (row) => row.price_manwon).slice(0, 5), (value) => eokText(value));
      renderBarList("buildingAreaBars", buildGroupedAverages(analysisRows, (row) => areaBandClient(row.area_sqm).label, (row) => row.exclusive_ppyeong_manwon).slice(0, 5), (value) => money(value));
      renderDetailSameDayBundleTable(group);
    }

    function renderDetailSameDayBundleTable(group) {
      const rows = detailBundleRows(group);
      document.getElementById("detailBundleMeta").textContent = rows.length
        ? buildingTitle(group) + "에서 확인된 업무시설 묶음 거래 " + fmt.format(rows.length) + "개입니다. 총액과 합산면적으로 묶음 평당가를 계산합니다."
        : buildingTitle(group) + "에서 같은 계약일·같은 층 2건 이상 업무시설 묶음 거래가 없습니다.";
      document.getElementById("detailSameDayBundleTable").innerHTML = \`
        <thead><tr>
          <th>계약일</th><th>층</th><th>묶음건수</th><th>묶음면적대</th><th>호실면적대</th><th>호실면적</th><th>합산 전용평</th><th>합산 공급㎡ 후보</th><th>합산 계약㎡</th><th>총거래금액</th><th>평균 개별금액</th><th>묶음 전용평당가</th><th>묶음 공급평당가</th><th>묶음 계약평당가</th>
        </tr></thead>
        <tbody>
        \${rows.length ? rows.map((row) => \`
          <tr>
            <td>\${escapeSvg(row.contract_date)}</td>
            <td>\${escapeSvg(row.floor || "-")}</td>
            <td>\${fmt.format(row.transaction_count)}</td>
            <td><span class="badge">\${escapeSvg(row.bundle_area_band || "-")}</span></td>
            <td>\${(row.area_bands || []).map((value) => \`<span class="badge">\${escapeSvg(value)}</span>\`).join(" ") || "-"}</td>
            <td>\${(row.unit_area_summary_pyeong || []).join(" + ") || "-"}</td>
            <td>\${Number.isFinite(row.total_exclusive_pyeong) ? row.total_exclusive_pyeong.toFixed(1) + "평" : "-"}</td>
            <td>\${Number.isFinite(row.total_supply_area_sqm) && row.total_supply_area_sqm > 0 ? row.total_supply_area_sqm.toFixed(2) : "미확인"}</td>
            <td>\${Number.isFinite(row.total_contract_area_sqm) && row.total_contract_area_sqm > 0 ? row.total_contract_area_sqm.toFixed(2) : "미확인"}</td>
            <td>\${money(row.total_price_manwon)}</td>
            <td>\${money(row.avg_price_manwon)}</td>
            <td>\${money(row.bundle_exclusive_ppyeong_manwon)}</td>
            <td>\${Number.isFinite(row.bundle_supply_ppyeong_manwon) ? money(row.bundle_supply_ppyeong_manwon) : "공급면적 없음"}</td>
            <td>\${Number.isFinite(row.bundle_contract_ppyeong_manwon) ? money(row.bundle_contract_ppyeong_manwon) : "계약면적 없음"}</td>
          </tr>
        \`).join("") : '<tr><td colspan="14">선택 건물의 동일일자·동일층 업무시설 묶음 거래가 없습니다.</td></tr>'}
        </tbody>
      \`;
    }

    function selectedCommercialContext() {
      const group = selectedMonthlyGroup();
      if (!group) return null;
      const allRows = data.records
        .filter((record) => record.parcel_key === group.parcel_key)
        .sort((a, b) => (b.month || "").localeCompare(a.month || "") || (b.contract_day || 0) - (a.contract_day || 0));
      const rows = state.selectedUseCategory === "all"
        ? allRows
        : allRows.filter((record) => useCategory(record) === state.selectedUseCategory);
      const analysisRows = rows.filter((row) => row.analysis_eligible !== false);
      return {
        group,
        title: buildingTitle(group),
        rows,
        analysisRows,
        points: monthlyPointsFromRows(analysisRows),
        bundleRows: detailBundleRows(group),
      };
    }

    function selectedBuildingSummaryText() {
      const ctx = selectedCommercialContext();
      if (!ctx) return "건물을 선택하세요.";
      const pyeongPrices = ctx.analysisRows.map((row) => row.exclusive_ppyeong_manwon).filter(Number.isFinite);
      const contractPyeongPrices = ctx.analysisRows.map((row) => row.contract_ppyeong_manwon).filter(Number.isFinite);
      const prices = ctx.analysisRows.map((row) => row.price_manwon).filter(Number.isFinite);
      const latest = ctx.points.at(-1);
      const grade = commercialGrade(ctx.group, ctx.analysisRows, ctx.bundleRows, contractPyeongPrices);
      return [
        "[마곡동 상업업무용 실거래 상담 요약]",
        "건물: " + ctx.title,
        "지번/주소: " + [ctx.group.parcel_label, ctx.group.road || "도로명 없음"].join(" · "),
        "용도 기준: " + useCategoryLabel(state.selectedUseCategory),
        "상담등급: " + grade,
        "기준값 반영 거래: " + fmt.format(ctx.analysisRows.length) + "건 / 전체 표시 " + fmt.format(ctx.rows.length) + "건",
        "관측월: " + fmt.format(ctx.points.length) + "개월" + (latest ? " / 최근월 " + latest.month : ""),
        "중위 거래금액: " + money(medianClient(prices)) + "만원",
        "중위 전용평당가: " + money(medianClient(pyeongPrices)) + "만원/평",
        "중위 계약평당가: " + (contractPyeongPrices.length ? money(medianClient(contractPyeongPrices)) + "만원/평" : "미확인"),
        "동일일자·동일층 묶음거래: " + (ctx.bundleRows.length ? fmt.format(ctx.bundleRows.length) + "개" : "없음"),
        "주의: 국토부 공개 실거래 자료는 참고용이며 법적 효력은 없습니다. 계약일 기준, 해제/복수후보/일괄거래 후보는 기준값에서 제외될 수 있습니다.",
      ].join("\\n");
    }

    function csvCell(value) {
      const raw = String(value ?? "");
      return '"' + raw.replace(/"/g, '""') + '"';
    }

    function selectedBuildingCsv() {
      const ctx = selectedCommercialContext();
      if (!ctx) return "";
      const lines = [];
      lines.push(["섹션", "건물", "지번", "도로명", "용도기준", "상담요약"].map(csvCell).join(","));
      lines.push(["요약", ctx.title, ctx.group.parcel_label, ctx.group.road || "", useCategoryLabel(state.selectedUseCategory), selectedBuildingSummaryText().replace(/\\n/g, " / ")].map(csvCell).join(","));
      lines.push("");
      lines.push(["계약월", "계약일", "층", "용도", "전용㎡", "공급㎡후보", "계약㎡", "거래금액만원", "전용평당가만원", "공급평당가만원", "계약평당가만원", "기준값반영", "제외사유", "거래유형"].map(csvCell).join(","));
      for (const row of ctx.rows) {
        lines.push([
          row.month || "", row.contract_day || "", row.floor || "", row.main_use || "",
          Number.isFinite(row.area_sqm) ? row.area_sqm.toFixed(2) : "",
          Number.isFinite(row.supply_area_sqm) ? row.supply_area_sqm.toFixed(2) : "",
          Number.isFinite(row.contract_area_sqm) ? row.contract_area_sqm.toFixed(2) : "",
          row.price_manwon || "",
          Number.isFinite(row.exclusive_ppyeong_manwon) ? Math.round(row.exclusive_ppyeong_manwon) : "",
          Number.isFinite(row.supply_ppyeong_manwon) ? Math.round(row.supply_ppyeong_manwon) : "",
          Number.isFinite(row.contract_ppyeong_manwon) ? Math.round(row.contract_ppyeong_manwon) : "",
          row.analysis_eligible === false ? "제외" : "반영",
          (row.analysis_exclusion_reasons || []).join(";"),
          row.transaction_type || "",
        ].map(csvCell).join(","));
      }
      lines.push("");
      lines.push(["묶음계약일", "층", "묶음건수", "묶음면적대", "호실면적", "합산전용평", "합산공급㎡후보", "합산계약㎡", "총거래금액만원", "묶음전용평당가만원", "묶음공급평당가만원", "묶음계약평당가만원"].map(csvCell).join(","));
      for (const row of ctx.bundleRows) {
        lines.push([
          row.contract_date || "", row.floor || "", row.transaction_count || "", row.bundle_area_band || "",
          (row.unit_area_summary_pyeong || []).join(" + "),
          Number.isFinite(row.total_exclusive_pyeong) ? row.total_exclusive_pyeong.toFixed(1) : "",
          Number.isFinite(row.total_supply_area_sqm) ? row.total_supply_area_sqm.toFixed(2) : "",
          Number.isFinite(row.total_contract_area_sqm) ? row.total_contract_area_sqm.toFixed(2) : "",
          row.total_price_manwon || "",
          Number.isFinite(row.bundle_exclusive_ppyeong_manwon) ? Math.round(row.bundle_exclusive_ppyeong_manwon) : "",
          Number.isFinite(row.bundle_supply_ppyeong_manwon) ? Math.round(row.bundle_supply_ppyeong_manwon) : "",
          Number.isFinite(row.bundle_contract_ppyeong_manwon) ? Math.round(row.bundle_contract_ppyeong_manwon) : "",
        ].map(csvCell).join(","));
      }
      return "\\ufeff" + lines.join("\\r\\n");
    }

    function setCommercialStatus(message) {
      document.getElementById("commercialActionStatus").textContent = message;
    }

    async function copySelectedBuildingSummary() {
      const text = selectedBuildingSummaryText();
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          setCommercialStatus("상담 요약을 클립보드에 복사했습니다.");
          return;
        } catch (error) {}
      }
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      setCommercialStatus("상담 요약을 클립보드에 복사했습니다.");
    }

    function downloadSelectedBuildingCsv() {
      const ctx = selectedCommercialContext();
      if (!ctx) {
        setCommercialStatus("CSV를 만들려면 건물을 먼저 선택하세요.");
        return;
      }
      const csv = selectedBuildingCsv();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const safeName = (ctx.title + "_" + ctx.group.parcel_label).replace(/[\/:*?"<>|]+/g, "_");
      anchor.href = url;
      anchor.download = safeName + "_마곡동_실거래_상담원장.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setCommercialStatus("선택 건물 CSV 원장을 다운로드했습니다.");
    }

    function buildingTitle(group) {
      if (group?.building_name && group.building_name !== "확인필요") return group.building_name;
      if (group?.is_masked_parcel) return "미확정 보조그룹";
      return "건물명 확인필요";
    }

    function medianClient(values) {
      const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
      if (!nums.length) return null;
      const mid = Math.floor(nums.length / 2);
      return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
    }

    function drawDetailMonthlyChart(group, pointRows) {
      const svg = document.getElementById("detailMonthlyChart");
      const points = (pointRows || group.points).filter((point) => Number.isFinite(point.avg_price_manwon));
      const w = 920, h = 360, padL = 58, padR = 28, padT = 30, padB = 48;
      if (!points.length) {
        svg.innerHTML = '<text x="24" y="58" fill="#647083" font-size="15">월별 거래가격 데이터가 없습니다.</text>';
        return;
      }
      const indexByMonth = new Map(data.source.available_months.map((month, index) => [month, index]));
      const maxIndex = Math.max(data.source.available_months.length - 1, 1);
      const maxPrice = Math.max(...points.map((point) => Math.max(point.avg_price_manwon || 0, point.median_price_manwon || 0)), 1) * 1.14;
      const maxCount = Math.max(...points.map((point) => point.count), 1);
      const x = (month) => padL + ((indexByMonth.get(month) || 0) / maxIndex) * (w - padL - padR);
      const y = (value) => h - padB - ((value || 0) / maxPrice) * (h - padT - padB);
      const avgLine = points.map((point) => x(point.month) + "," + y(point.avg_price_manwon)).join(" ");
      const medLine = points.map((point) => x(point.month) + "," + y(point.median_price_manwon)).join(" ");
      const labelMonths = data.source.available_months.filter((_, index) => index % 12 === 0 || index === data.source.available_months.length - 1);
      svg.innerHTML = \`
        <line x1="\${padL}" y1="\${h-padB}" x2="\${w-padR}" y2="\${h-padB}" stroke="#dbe1ea"/>
        <line x1="\${padL}" y1="\${padT}" x2="\${padL}" y2="\${h-padB}" stroke="#dbe1ea"/>
        \${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const yy = h - padB - ratio * (h - padT - padB);
          return \`<line x1="\${padL}" y1="\${yy}" x2="\${w-padR}" y2="\${yy}" stroke="#eef2f5"/><text x="12" y="\${yy + 4}" font-size="11" fill="#647083">\${money(maxPrice * ratio)}</text>\`;
        }).join("")}
        \${points.map((point) => {
          const bh = (point.count / maxCount) * (h - padT - padB) * 0.5;
          return \`<rect x="\${x(point.month) - 3}" y="\${h - padB - bh}" width="6" height="\${bh}" rx="2" fill="#b3482f" opacity="0.18"><title>\${point.month} 거래 \${point.count}건</title></rect>\`;
        }).join("")}
        <polyline fill="none" stroke="#156f78" stroke-width="3.5" points="\${avgLine}"/>
        <polyline fill="none" stroke="#b3482f" stroke-width="2.5" stroke-dasharray="5 5" points="\${medLine}"/>
        \${points.map((point) => \`<circle cx="\${x(point.month)}" cy="\${y(point.avg_price_manwon)}" r="4" fill="#156f78"><title>\${point.month} 평균 \${money(point.avg_price_manwon)}만원, 중위 \${money(point.median_price_manwon)}만원, \${point.count}건</title></circle>\`).join("")}
        \${labelMonths.map((month) => \`<text x="\${x(month)}" y="\${h - 14}" text-anchor="middle" font-size="11" fill="#647083">\${month.slice(2, 7)}</text>\`).join("")}
        <text x="\${padL}" y="19" font-size="12" fill="#647083">거래금액(만원) · 선=평균, 점선=중위, 막대=건수</text>
      \`;
    }

    function renderSourceTable() {
      const rows = yearSummaryForDashboardUse();
      document.getElementById("sourceTable").innerHTML = \`
        <thead><tr><th>연도</th><th>건수</th><th>마스킹</th><th>중위 ㎡단가</th><th>중위 전용평당가</th></tr></thead>
        <tbody>
        \${rows.map((row) => \`
          <tr><td>\${row.year}</td><td>\${fmt.format(row.count)}</td><td>\${fmt.format(row.masked_count)}</td><td>\${money(row.median_ppsqm_manwon)}</td><td>\${money(row.median_exclusive_ppyeong_manwon)}</td></tr>
        \`).join("")}
        </tbody>
      \`;
    }

    function renderRefinementBoard() {
      const summary = data.refinementSummary || {};
      const tierCounts = summary.tier_counts || [];
      const tierMap = new Map(tierCounts.map((row) => [row.tier, row.count]));
      const reliable = Number(summary.refined_benchmark_records || 0);
      const analysis = Number(summary.analysis_records || 0);
      const reliableRate = analysis ? (reliable / analysis) * 100 : null;
      document.getElementById("refinementFunnel").innerHTML = [
        ["원자료", fmt.format(summary.total_records || 0) + "건"],
        ["기준값 반영", fmt.format(analysis) + "건"],
        ["A/B 정제 기준", fmt.format(reliable) + "건"],
        ["IQR 이상치 후보", fmt.format(summary.outlier_candidate_records || 0) + "건"],
        ["정제율", pct(reliableRate)],
      ].map(([label, value]) => '<div class="quality-step"><span>' + escapeSvg(label) + '</span><strong>' + escapeSvg(value) + '</strong></div>').join("");
      document.getElementById("refinementTierTable").innerHTML =
        '<thead><tr><th>정제 등급</th><th>거래건수</th><th>해석</th></tr></thead><tbody>' +
        ["A 기준", "B 참고", "C 보조", "D 확인", "제외"].map((tier) => {
          const meaning = {
            "A 기준": "공식 표제부와 단일 후보 매칭까지 확인된 기준값 후보",
            "B 참고": "일부 약식 매칭 또는 보완점은 있지만 시장 흐름 참고 가능",
            "C 보조": "미확정·이상치·표본 부족 요소가 있어 보조 자료로만 사용",
            "D 확인": "개별 거래 검증이 먼저 필요한 자료",
            "제외": "해제·지분·일괄·저단가 등 기준값 산식 제외",
          }[tier];
          return '<tr><td><span class="badge">' + escapeSvg(tier) + '</span></td><td>' + fmt.format(tierMap.get(tier) || 0) + '</td><td>' + escapeSvg(meaning) + '</td></tr>';
        }).join("") +
        '</tbody>';
    }

    function renderPlainGuide() {
      const summary = data.refinementSummary || {};
      const { basis, trend } = aggregateRows();
      const observedTrend = trend.filter((row) => Number.isFinite(row.median_unit_manwon));
      const first = observedTrend[0];
      const latest = observedTrend.at(-1);
      const change = trendChangePercent(first && { median: first.median_unit_manwon }, latest && { median: latest.median_unit_manwon });
      const reliable = Number(summary.refined_benchmark_records || 0);
      const analysis = Number(summary.analysis_records || 0);
      const reliableRate = analysis ? (reliable / analysis) * 100 : null;
      document.getElementById("plainGuideCards").innerHTML = [
        {
          step: "가격 흐름",
          title: latest ? "최근 " + basis.label + " " + money(latest.median_unit_manwon) + "만원/평" : "최근 가격 없음",
          body: first && latest ? aggregatePeriodLabel(first.period) + "부터 " + aggregatePeriodLabel(latest.period) + "까지 변화 " + pct(change) + "입니다." : "기간을 선택하면 가격 흐름이 보입니다.",
        },
        {
          step: "정제 기준",
          title: fmt.format(reliable) + "건",
          body: "기준값 산식 반영 " + fmt.format(analysis) + "건 중 A/B 등급으로 먼저 볼 거래입니다. 정제율 " + pct(reliableRate) + ".",
        },
        {
          step: "비교 축",
          title: "평형별로 보기",
          body: "건물별 표와 그래프는 같은 평형 필터를 공유합니다. 섞인 평균보다 같은 평형 흐름을 먼저 보세요.",
        },
      ].map((card) => '<div class="plain-card"><span>' + escapeSvg(card.step) + '</span><strong>' + escapeSvg(card.title) + '</strong><small>' + escapeSvg(card.body) + '</small></div>').join("");
    }

    function renderOfficeAreaBandTable() {
      const rows = data.officeAreaBandSummary || [];
      document.getElementById("officeAreaBandTable").innerHTML = \`
        <thead><tr>
          <th>면적대</th><th>신뢰도</th><th>거래건수</th><th>정확/마스킹</th><th>건물수</th><th>평균면적</th><th>중위거래금액</th><th>중위 전용평당가</th><th>25~75% 전용평당가</th><th>중위 공급평당가</th><th>중위 계약평당가</th><th>동일일자·동일층 묶음</th>
        </tr></thead>
        <tbody>
        \${rows.map((row) => \`
          <tr>
            <td><span class="badge">\${escapeSvg(row.band_label)}</span></td>
            <td><span class="badge">\${escapeSvg(row.reliability || "D 확인")}</span></td>
            <td>\${fmt.format(row.transaction_count)}</td>
            <td>\${fmt.format(row.exact_count)} / \${fmt.format(row.masked_count)}</td>
            <td>\${fmt.format(row.building_count)}</td>
            <td>\${Number.isFinite(row.avg_area_pyeong) ? row.avg_area_pyeong.toFixed(1) + "평" : "-"}</td>
            <td>\${money(row.median_price_manwon)}</td>
            <td>\${money(row.median_exclusive_ppyeong_manwon)}</td>
            <td>\${money(row.p25_exclusive_ppyeong_manwon)}~\${money(row.p75_exclusive_ppyeong_manwon)}</td>
            <td>\${Number.isFinite(row.median_supply_ppyeong_manwon) ? money(row.median_supply_ppyeong_manwon) : "공급면적 없음"}</td>
            <td>\${Number.isFinite(row.median_contract_ppyeong_manwon) ? money(row.median_contract_ppyeong_manwon) : "계약면적 없음"}</td>
            <td>\${fmt.format(row.same_day_floor_group_count)}개</td>
          </tr>
        \`).join("")}
        </tbody>
      \`;
    }

    function renderOfficeSameDayFloorTable() {
      const q = state.search;
      const rows = (data.officeSameDayFloorSummary || [])
        .filter((row) => queryMatches(row, q, [
          row.parcel_label,
          row.building_name,
          row.road,
          row.floor,
          row.floor ? row.floor + "층" : "",
          row.contract_date,
          row.bundle_area_band,
          Number.isFinite(row.total_exclusive_pyeong) ? row.total_exclusive_pyeong.toFixed(1) + "평" : "",
          ...(row.area_bands || []),
          ...(row.unit_area_summary_pyeong || []),
        ]))
        .slice(0, 60);
      document.getElementById("officeSameDayFloorTable").innerHTML = \`
        <thead><tr>
          <th>건물명</th><th>지번</th><th>계약일</th><th>층</th><th>묶음건수</th><th>묶음면적대</th><th>호실면적대</th><th>호실면적</th><th>합산 전용평</th><th>합산 공급㎡ 후보</th><th>합산 계약㎡</th><th>총거래금액</th><th>평균 개별금액</th><th>묶음 전용평당가</th><th>묶음 공급평당가</th><th>묶음 계약평당가</th>
        </tr></thead>
        <tbody>
        \${rows.length ? rows.map((row) => \`
          <tr class="clickable" data-parcel-key="\${escapeSvg(row.parcel_key)}">
            <td>\${escapeSvg(buildingTitle(row))}</td>
            <td>\${escapeSvg(row.parcel_label)}</td>
            <td>\${escapeSvg(row.contract_date)}</td>
            <td>\${escapeSvg(row.floor || "-")}</td>
            <td>\${fmt.format(row.transaction_count)}</td>
            <td><span class="badge">\${escapeSvg(row.bundle_area_band || "-")}</span></td>
            <td>\${(row.area_bands || []).map((value) => \`<span class="badge">\${escapeSvg(value)}</span>\`).join(" ") || "-"}</td>
            <td>\${(row.unit_area_summary_pyeong || []).join(" + ") || "-"}</td>
            <td>\${Number.isFinite(row.total_exclusive_pyeong) ? row.total_exclusive_pyeong.toFixed(1) + "평" : "-"}</td>
            <td>\${Number.isFinite(row.total_supply_area_sqm) && row.total_supply_area_sqm > 0 ? row.total_supply_area_sqm.toFixed(2) : "미확인"}</td>
            <td>\${Number.isFinite(row.total_contract_area_sqm) && row.total_contract_area_sqm > 0 ? row.total_contract_area_sqm.toFixed(2) : "미확인"}</td>
            <td>\${money(row.total_price_manwon)}</td>
            <td>\${money(row.avg_price_manwon)}</td>
            <td>\${money(row.bundle_exclusive_ppyeong_manwon)}</td>
            <td>\${Number.isFinite(row.bundle_supply_ppyeong_manwon) ? money(row.bundle_supply_ppyeong_manwon) : "공급면적 없음"}</td>
            <td>\${Number.isFinite(row.bundle_contract_ppyeong_manwon) ? money(row.bundle_contract_ppyeong_manwon) : "계약면적 없음"}</td>
          </tr>
        \`).join("") : '<tr><td colspan="16">동일일자·동일층 2건 이상 묶음 거래가 없습니다.</td></tr>'}
        </tbody>
      \`;
    }

    function setupOfficeBandSelect() {
      const select = document.getElementById("officeBandSelect");
      if (!select) return;
      select.innerHTML = (data.officeAreaBandSummary || []).map((row) => \`<option value="\${escapeSvg(row.band_label)}">\${escapeSvg(row.band_label)}</option>\`).join("");
      select.value = state.officeBand;
      select.addEventListener("change", (event) => {
        state.officeBand = event.target.value;
        renderTables();
      });
    }

    function drawOfficeBandTrendChart(svgId, rows, labelFormatter) {
      const svg = document.getElementById(svgId);
      const points = rows.filter((row) => Number.isFinite(row.median_exclusive_ppyeong_manwon));
      const w = 920, h = 320, padL = 58, padR = 28, padT = 30, padB = 46;
      if (!points.length) {
        svg.innerHTML = '<text x="24" y="58" fill="#647083" font-size="15">선택 면적대의 추세 데이터가 없습니다.</text>';
        return;
      }
      const maxUnit = Math.max(...points.map((row) => row.median_exclusive_ppyeong_manwon || 0), 1) * 1.14;
      const maxCount = Math.max(...points.map((row) => row.transaction_count || 0), 1);
      const x = (index) => padL + index * ((w - padL - padR) / Math.max(points.length - 1, 1));
      const y = (value) => h - padB - ((value || 0) / maxUnit) * (h - padT - padB);
      const barW = Math.max(3, Math.min(28, (w - padL - padR) / Math.max(points.length, 1) * 0.45));
      const line = points.map((row, index) => x(index) + "," + y(row.median_exclusive_ppyeong_manwon)).join(" ");
      const labelStep = points.length > 40 ? 12 : points.length > 18 ? 4 : 1;
      svg.innerHTML = \`
        <line x1="\${padL}" y1="\${h-padB}" x2="\${w-padR}" y2="\${h-padB}" stroke="#dbe1ea"/>
        <line x1="\${padL}" y1="\${padT}" x2="\${padL}" y2="\${h-padB}" stroke="#dbe1ea"/>
        \${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const yy = h - padB - ratio * (h - padT - padB);
          return \`<line x1="\${padL}" y1="\${yy}" x2="\${w-padR}" y2="\${yy}" stroke="#eef2f5"/><text x="12" y="\${yy + 4}" font-size="11" fill="#647083">\${money(maxUnit * ratio)}</text>\`;
        }).join("")}
        \${points.map((row, index) => {
          const bh = ((row.transaction_count || 0) / maxCount) * (h - padT - padB) * 0.45;
          return \`<rect x="\${x(index) - barW / 2}" y="\${h - padB - bh}" width="\${barW}" height="\${bh}" rx="2" fill="#b3482f" opacity="0.18"><title>\${labelFormatter(row)} 거래 \${row.transaction_count}건</title></rect>\`;
        }).join("")}
        <polyline fill="none" stroke="#156f78" stroke-width="3" points="\${line}"/>
        \${points.map((row, index) => \`<circle cx="\${x(index)}" cy="\${y(row.median_exclusive_ppyeong_manwon)}" r="3.5" fill="#156f78"><title>\${labelFormatter(row)} 중위 전용평당가 \${money(row.median_exclusive_ppyeong_manwon)}만원, 평균 \${money(row.avg_exclusive_ppyeong_manwon)}만원, \${row.transaction_count}건</title></circle>\`).join("")}
        \${points.map((row, index) => index % labelStep === 0 || index === points.length - 1 ? \`<text x="\${x(index)}" y="\${h - 13}" text-anchor="middle" font-size="10" fill="#647083">\${escapeSvg(labelFormatter(row))}</text>\` : "").join("")}
        <text x="\${padL}" y="19" font-size="12" fill="#647083">중위 전용평당가(만원/평) · 막대=거래건수</text>
      \`;
    }

    function filteredOfficeBandBuildings() {
      const q = state.search;
      return (data.officeAreaBandBuildingSummary || [])
        .filter((row) => row.band_label === state.officeBand)
        .filter((row) => row.transaction_count >= state.minCount)
        .filter((row) => state.mask === "all" || (state.mask === "exact" ? !row.is_masked_parcel : row.is_masked_parcel))
        .filter((row) => queryMatches(row, q, [row.parcel_label, row.building_name, row.road, row.band_label]))
        .sort((a, b) => {
          if (state.sortBy === "price") return (b.median_price_manwon || 0) - (a.median_price_manwon || 0);
          if (state.sortBy === "unit") return (b.median_exclusive_ppyeong_manwon || 0) - (a.median_exclusive_ppyeong_manwon || 0);
          return b.transaction_count - a.transaction_count || (b.median_exclusive_ppyeong_manwon || 0) - (a.median_exclusive_ppyeong_manwon || 0);
        });
    }

    function renderOfficeBandTrend() {
      const band = state.officeBand || data.officeAreaBandSummary?.[0]?.band_label || "";
      const yearRows = (data.officeAreaBandYearSeries || []).filter((row) => row.band_label === band);
      const monthRows = (data.officeAreaBandMonthSeries || []).filter((row) => row.band_label === band);
      const buildingRows = filteredOfficeBandBuildings();
      const summary = (data.officeAreaBandSummary || []).find((row) => row.band_label === band);
      document.getElementById("officeBandTrendMeta").textContent = summary
        ? \`\${band} · 전체 \${fmt.format(summary.transaction_count)}건 · 정확 지번 \${fmt.format(summary.exact_count)}건 · 건물 \${fmt.format(summary.building_count)}개 · 중위 전용평당가 \${money(summary.median_exclusive_ppyeong_manwon)}만원/평\`
        : "-";
      drawOfficeBandTrendChart("officeBandYearChart", yearRows, (row) => String(row.year));
      drawOfficeBandTrendChart("officeBandMonthChart", monthRows, (row) => String(row.month || "").slice(2));
      document.getElementById("officeBandBuildingTable").innerHTML = \`
        <thead><tr>
          <th>건물명</th><th>지번/그룹</th><th>상태</th><th>신뢰도</th><th>건수</th><th>관측월</th><th>평균면적</th><th>중위거래금액</th><th>중위 전용평당가</th><th>25~75% 전용평당가</th><th>중위 공급평당가</th><th>중위 계약평당가</th><th>계약면적 매칭</th>
        </tr></thead>
        <tbody>
        \${buildingRows.map((row) => \`
          <tr class="clickable" data-parcel-key="\${escapeSvg(row.parcel_key)}">
            <td>\${escapeSvg(buildingTitle(row))}</td>
            <td>\${escapeSvg(row.parcel_label)}</td>
            <td><span class="badge">\${row.is_masked_parcel ? "마스킹" : escapeSvg(row.building_name_status || "확인필요")}</span></td>
            <td><span class="badge">\${escapeSvg(row.reliability || "D 확인")}</span></td>
            <td>\${fmt.format(row.transaction_count)}</td>
            <td>\${fmt.format(row.observed_months.length)}</td>
            <td>\${Number.isFinite(row.avg_area_pyeong) ? row.avg_area_pyeong.toFixed(1) + "평" : "-"}</td>
            <td>\${money(row.median_price_manwon)}</td>
            <td>\${money(row.median_exclusive_ppyeong_manwon)}</td>
            <td>\${money(row.p25_exclusive_ppyeong_manwon)}~\${money(row.p75_exclusive_ppyeong_manwon)}</td>
            <td>\${Number.isFinite(row.median_supply_ppyeong_manwon) ? money(row.median_supply_ppyeong_manwon) : "공급면적 없음"}</td>
            <td>\${Number.isFinite(row.median_contract_ppyeong_manwon) ? money(row.median_contract_ppyeong_manwon) : "계약면적 없음"}</td>
            <td>\${fmt.format(row.contract_matched_count)}건</td>
          </tr>
        \`).join("")}
        </tbody>
      \`;
    }

    function miniFloorChart(building) {
      const floors = building.floors || [];
      const w = 520, h = 108, left = 54, right = 22, top = 18, rowH = 22;
      const maxUnit = Math.max(...floors.map((floor) => floor.median_exclusive_ppyeong_manwon || 0), 1);
      const rows = floors.slice(0, 4);
      return \`
        <div class="floor-chart">
          <svg viewBox="0 0 \${w} \${h}" role="img" aria-label="\${escapeSvg(building.parcel_label)} 층별 전용평당가">
            \${rows.map((floor, index) => {
              const y = top + index * rowH;
              const barW = ((floor.median_exclusive_ppyeong_manwon || 0) / maxUnit) * (w - left - right - 90);
              const color = floor.floor_order === 1 ? "#b3482f" : "#156f78";
              return \`
                <text x="8" y="\${y + 14}" font-size="12" fill="#647083">\${escapeSvg(floor.floor)}</text>
                <rect x="\${left}" y="\${y}" width="\${barW}" height="15" rx="4" fill="\${color}" opacity="\${floor.floor_order === 1 ? "0.82" : "0.62"}"><title>\${escapeSvg(floor.floor)} 중위 전용평당가 \${money(floor.median_exclusive_ppyeong_manwon)}만원, \${floor.transaction_count}건</title></rect>
                <text x="\${left + barW + 8}" y="\${y + 13}" font-size="11" fill="#172033">\${money(floor.median_exclusive_ppyeong_manwon)} · \${floor.transaction_count}건</text>
              \`;
            }).join("")}
            \${floors.length > rows.length ? \`<text x="8" y="\${h - 8}" font-size="11" fill="#647083">외 \${floors.length - rows.length}개 층</text>\` : ""}
          </svg>
        </div>
      \`;
    }

    function filteredRetailFloorBuildings() {
      const q = state.search;
      return (data.retailBuildingFloorSummary || [])
        .filter((row) => row.transaction_count >= state.minCount)
        .filter((row) => queryMatches(row, q, [row.parcel_label, row.building_name, row.road, row.main_uses.join(" "), row.floors.map((floor) => floor.floor).join(" ")]))
        .sort((a, b) => {
          if (state.sortBy === "unit") return (b.first_floor_median_exclusive_ppyeong_manwon || 0) - (a.first_floor_median_exclusive_ppyeong_manwon || 0);
          if (state.sortBy === "price") return (b.floors[0]?.median_price_manwon || 0) - (a.floors[0]?.median_price_manwon || 0);
          return b.transaction_count - a.transaction_count;
        });
    }

    function renderRetailFloorChartTable() {
      const rows = filteredRetailFloorBuildings();
      document.getElementById("retailFloorChartCount").textContent = \`현재 표시 \${fmt.format(rows.length)}개 / 전체 \${fmt.format((data.retailBuildingFloorSummary || []).length)}개. 근린생활/판매시설은 건물별 층을 분리했고 1층은 붉은 막대로 표시합니다.\`;
      document.getElementById("retailFloorChartTable").innerHTML = \`
        <thead><tr>
          <th>건물명</th><th>지번</th><th>주용도</th><th>층별 전용평당가 차트</th><th>층수</th><th>거래건수</th><th>1층 거래</th><th>1층 중위 전용평당가</th><th>관측연도</th>
        </tr></thead>
        <tbody>
        \${rows.map((row) => \`
          <tr class="clickable" data-parcel-key="\${escapeSvg(row.parcel_key)}">
            <td>\${escapeSvg(buildingTitle(row))}</td>
            <td>\${escapeSvg(row.parcel_label)}</td>
            <td>\${escapeSvg(row.main_uses.join(", "))}</td>
            <td class="floor-chart-cell">\${miniFloorChart(row)}</td>
            <td>\${fmt.format(row.floor_count)}</td>
            <td>\${fmt.format(row.transaction_count)}</td>
            <td><span class="badge \${row.first_floor_transaction_count ? "" : "pill-warning"}">\${row.first_floor_transaction_count ? fmt.format(row.first_floor_transaction_count) + "건" : "1층 없음"}</span></td>
            <td>\${Number.isFinite(row.first_floor_median_exclusive_ppyeong_manwon) ? money(row.first_floor_median_exclusive_ppyeong_manwon) : "-"}</td>
            <td>\${row.observed_years.join(", ")}</td>
          </tr>
        \`).join("")}
        </tbody>
      \`;
    }

    function filteredGroups() {
      const q = state.search;
      const allowed = dashboardUseParcelKeys();
      return data.parcelGroups
        .filter((group) => allowed.has(group.parcel_key))
        .filter((group) => group.transaction_count >= state.minCount)
        .filter((group) => state.mask === "all" || (state.mask === "exact" ? !group.is_masked_parcel : group.is_masked_parcel))
        .filter((group) => queryMatches(group, q, [group.parcel_label, group.building_name, group.road, group.main_use, group.zoning]))
        .sort((a, b) => {
          if (state.sortBy === "change") return Math.abs(b.ppsqm_change_pct || 0) - Math.abs(a.ppsqm_change_pct || 0);
          if (state.sortBy === "price") return (b.median_price_manwon || 0) - (a.median_price_manwon || 0);
          if (state.sortBy === "unit") return (b.median_exclusive_ppyeong_manwon || 0) - (a.median_exclusive_ppyeong_manwon || 0);
          return b.transaction_count - a.transaction_count;
        });
    }

    function uniqueClient(values) {
      return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value).trim() !== ""))];
    }

    function buildBuildingYearMonthRows() {
      const sourceRows = data.records
        .filter((record) => record.analysis_eligible !== false)
        .filter((record) => useCategory(record) === state.dashboardUse)
        .filter((record) => buildingAreaBandMatches(record))
        .filter((record) => state.mask === "all" || (state.mask === "exact" ? !record.is_masked_parcel : record.is_masked_parcel));
      const yearMap = new Map();
      const monthMap = new Map();
      for (const record of sourceRows) {
        const yearKey = record.parcel_key + "|" + record.year;
        const monthKey = yearKey + "|" + record.month;
        if (!yearMap.has(yearKey)) yearMap.set(yearKey, []);
        if (!monthMap.has(monthKey)) monthMap.set(monthKey, []);
        yearMap.get(yearKey).push(record);
        monthMap.get(monthKey).push(record);
      }
      return [...monthMap.entries()].map(([key, monthRows]) => {
        const keyParts = key.split("|");
        const month = keyParts.pop();
        const yearText = keyParts.pop();
        const parcelKey = keyParts.join("|");
        const yearRows = yearMap.get(parcelKey + "|" + yearText) || [];
        const first = monthRows[0] || yearRows[0] || {};
        const monthAvgPrice = averageClient(monthRows.map((row) => row.price_manwon));
        const yearAvgPrice = averageClient(yearRows.map((row) => row.price_manwon));
        const monthAvgUnit = averageClient(monthRows.map((row) => row.exclusive_ppyeong_manwon));
        const yearAvgUnit = averageClient(yearRows.map((row) => row.exclusive_ppyeong_manwon));
        const monthAvgContractUnit = averageClient(monthRows.map((row) => row.contract_ppyeong_manwon));
        const yearAvgContractUnit = averageClient(yearRows.map((row) => row.contract_ppyeong_manwon));
        const floors = uniqueClient(monthRows.map((row) => row.floor || "층정보 없음"));
        const uses = uniqueClient(monthRows.map((row) => row.main_use || "용도 없음"));
        return {
          parcel_key: parcelKey,
          parcel_label: first.parcel_label,
          parcel: first.parcel,
          road: first.road,
          building_name: first.building_name,
          building_name_status: first.building_name_status,
          search_text: normalizeSearchValue([
            first.parcel_key,
            first.parcel_label,
            first.parcel,
            first.road,
            first.building_name,
            first.building_name_status,
            first.main_use,
            first.zoning,
            yearText,
            month,
            floors,
            uses,
          ]),
          is_masked_parcel: first.is_masked_parcel,
          year: Number(yearText),
          month,
          year_transaction_count: yearRows.length,
          month_transaction_count: monthRows.length,
          year_avg_price_manwon: yearAvgPrice,
          month_avg_price_manwon: monthAvgPrice,
          month_vs_year_price_pct: Number.isFinite(monthAvgPrice) && Number.isFinite(yearAvgPrice) && yearAvgPrice !== 0 ? ((monthAvgPrice - yearAvgPrice) / yearAvgPrice) * 100 : null,
          year_avg_exclusive_ppyeong_manwon: yearAvgUnit,
          month_avg_exclusive_ppyeong_manwon: monthAvgUnit,
          year_avg_contract_ppyeong_manwon: yearAvgContractUnit,
          month_avg_contract_ppyeong_manwon: monthAvgContractUnit,
          floors: floors.slice(0, 5).join(", ") + (floors.length > 5 ? " 외" : ""),
          main_uses: uses.slice(0, 3).join(", ") + (uses.length > 3 ? " 외" : ""),
        };
      });
    }

    function filteredBuildingAnalysis() {
      const q = state.search;
      const baseRows = buildBuildingYearMonthRows()
        .filter((row) => row.year_transaction_count >= state.minCount);
      const matchedRows = q
        ? baseRows.filter((row) => queryMatches(row, q, [row.parcel_label, row.parcel, row.building_name, row.road, row.main_uses, row.floors, row.year, row.month]))
        : baseRows;
      const rows = matchedRows.length || !q ? matchedRows : baseRows;
      return rows.sort((a, b) => {
          if (state.sortBy === "price") return (b.year_avg_price_manwon || 0) - (a.year_avg_price_manwon || 0);
          if (state.sortBy === "unit") return (b.year_avg_exclusive_ppyeong_manwon || 0) - (a.year_avg_exclusive_ppyeong_manwon || 0);
          if (state.sortBy === "change") return Math.abs(b.month_vs_year_price_pct || 0) - Math.abs(a.month_vs_year_price_pct || 0);
          return b.year - a.year || (b.month || "").localeCompare(a.month || "") || b.year_transaction_count - a.year_transaction_count;
        });
    }

    function filteredBuildingGraphs() {
      const q = state.search;
      const rows = data.records
        .filter((record) => record.analysis_eligible !== false)
        .filter((record) => useCategory(record) === state.dashboardUse)
        .filter((record) => buildingAreaBandMatches(record))
        .filter((record) => state.mask === "all" || (state.mask === "exact" ? !record.is_masked_parcel : record.is_masked_parcel));
      const map = new Map();
      for (const record of rows) {
        if (!map.has(record.parcel_key)) {
          map.set(record.parcel_key, {
            parcel_key: record.parcel_key,
            parcel_label: record.parcel_label,
            parcel: record.parcel,
            road: record.road,
            building_name: record.building_name,
            building_name_status: record.building_name_status,
            is_masked_parcel: record.is_masked_parcel,
            rows: [],
          });
        }
        map.get(record.parcel_key).rows.push(record);
      }
      return [...map.values()].map((group) => {
        const byYear = new Map();
        for (const record of group.rows) {
          if (!byYear.has(record.year)) byYear.set(record.year, []);
          byYear.get(record.year).push(record);
        }
        const points = [...byYear.entries()].sort(([a], [b]) => a - b).map(([year, yearRows]) => ({
          year,
          count: yearRows.length,
          avg_price_manwon: averageClient(yearRows.map((row) => row.price_manwon)),
          median_price_manwon: medianClient(yearRows.map((row) => row.price_manwon)),
          median_exclusive_ppyeong_manwon: medianClient(yearRows.map((row) => row.exclusive_ppyeong_manwon)),
        }));
        return {
          parcel_key: group.parcel_key,
          parcel_label: group.parcel_label,
          parcel: group.parcel,
          road: group.road,
          building_name: group.building_name,
          building_name_status: group.building_name_status,
          is_masked_parcel: group.is_masked_parcel,
          transaction_count: group.rows.length,
          avg_price_manwon: averageClient(group.rows.map((row) => row.price_manwon)),
          points,
        };
      })
        .filter((group) => state.mask === "all" || (state.mask === "exact" ? !group.is_masked_parcel : group.is_masked_parcel))
        .filter((group) => queryMatches(group, q, [group.parcel_label, group.building_name, group.road]))
        .sort((a, b) => {
          if (state.sortBy === "price") return (b.avg_price_manwon || 0) - (a.avg_price_manwon || 0);
          if (state.sortBy === "unit") return (b.points.at(-1)?.median_exclusive_ppyeong_manwon || 0) - (a.points.at(-1)?.median_exclusive_ppyeong_manwon || 0);
          if (state.sortBy === "change") {
            const ac = amountChange(a);
            const bc = amountChange(b);
            return Math.abs(bc || 0) - Math.abs(ac || 0);
          }
          return b.transaction_count - a.transaction_count || (b.avg_price_manwon || 0) - (a.avg_price_manwon || 0);
        });
    }

    function amountChange(group) {
      const values = group.points.map((point) => point.avg_price_manwon).filter(Number.isFinite);
      if (values.length < 2 || !values[0]) return null;
      return ((values.at(-1) - values[0]) / values[0]) * 100;
    }

    function monthlyAmountChange(group) {
      const values = group.points.map((point) => point.avg_price_manwon).filter(Number.isFinite);
      if (values.length < 2 || !values[0]) return null;
      return ((values.at(-1) - values[0]) / values[0]) * 100;
    }

    const pyeongBasisConfig = {
      exclusive: { field: "exclusive_ppyeong_manwon", label: "전용평당가" },
      supply: { field: "supply_ppyeong_manwon", label: "공급평당가" },
      contract: { field: "contract_ppyeong_manwon", label: "계약평당가" },
    };

    const valuationBasisConfig = {
      exclusive: { field: "exclusive_ppyeong_manwon", areaField: "area_sqm", label: "전용평당가", areaLabel: "전용면적" },
      supply: { field: "supply_ppyeong_manwon", areaField: "supply_area_sqm", label: "공급평당가", areaLabel: "공급면적" },
      contract: { field: "contract_ppyeong_manwon", areaField: "contract_area_sqm", label: "계약평당가", areaLabel: "계약면적" },
    };

    function aggregateDisplayPeriod() {
      return state.aggregateYear !== "all" ? "month" : state.aggregatePeriod;
    }

    function aggregatePeriodKey(record) {
      return aggregateDisplayPeriod() === "year" ? String(record.year) : String(record.month || "");
    }

    function aggregatePeriodLabel(period) {
      if (aggregateDisplayPeriod() === "year") return String(period);
      if (state.aggregateYear !== "all" && String(period).startsWith(state.aggregateYear + "-")) return Number(String(period).slice(5, 7)) + "월";
      return String(period).slice(2);
    }

    function aggregateExpectedPeriods() {
      if (state.aggregateYear !== "all") {
        const months = state.aggregateMonth === "all"
          ? Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"))
          : [state.aggregateMonth];
        return months.map((month) => state.aggregateYear + "-" + month);
      }
      if (state.aggregatePeriod === "year") return data.source.available_years.map(String);
      const months = data.source.available_months.map(String);
      const filtered = state.aggregateMonth === "all" ? months : months.filter((month) => month.slice(5, 7) === state.aggregateMonth);
      return filtered.slice(-60);
    }

    function aggregateAreaBandLabel(value = state.aggregateAreaBand) {
      return {
        all: "전체 평형",
        under10: "10평 미만",
        "10to30": "10평 이상~30평 미만",
        "30to50": "30평 이상~50평 미만",
        "50to100": "50평 이상~100평 미만",
        over100: "100평 이상 거래",
      }[value] || "전체 평형";
    }

    function aggregateAreaBandMatches(record) {
      return areaBandValueMatches(record, state.aggregateAreaBand);
    }

    function areaBandValueMatches(record, value) {
      if (value === "all") return true;
      const pyeong = Number(record.area_sqm) / SQM_PER_PYEONG_CLIENT;
      if (!Number.isFinite(pyeong)) return false;
      if (value === "under10") return pyeong < 10;
      if (value === "10to30") return pyeong >= 10 && pyeong < 30;
      if (value === "30to50") return pyeong >= 30 && pyeong < 50;
      if (value === "50to100") return pyeong >= 50 && pyeong < 100;
      if (value === "over100") return pyeong >= 100;
      return true;
    }

    function buildingAreaBandMatches(record) {
      return areaBandValueMatches(record, state.buildingAreaBand);
    }

    function renderAggregateOptions() {
      const yearSelect = document.getElementById("aggregateYear");
      const monthSelect = document.getElementById("aggregateMonth");
      const yearOptions = '<option value="all">전체 연도</option>' + data.source.available_years
        .map((year) => '<option value="' + escapeSvg(year) + '">' + escapeSvg(year) + '년</option>')
        .join("");
      const months = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));
      const monthOptions = '<option value="all">전체 월</option>' + months
        .map((month) => '<option value="' + month + '">' + Number(month) + '월</option>')
        .join("");
      if (yearSelect.innerHTML !== yearOptions) yearSelect.innerHTML = yearOptions;
      if (monthSelect.innerHTML !== monthOptions) monthSelect.innerHTML = monthOptions;
      yearSelect.value = state.aggregateYear;
      monthSelect.value = state.aggregateMonth;
    }

    function aggregateRows() {
      const basis = valuationBasisConfig[state.aggregateBasis] || valuationBasisConfig.exclusive;
      const rows = data.records
        .filter((record) => record.analysis_eligible !== false)
        .filter((record) => state.aggregateUse === "all" || useCategory(record) === state.aggregateUse)
        .filter((record) => state.aggregateYear === "all" || String(record.year) === state.aggregateYear)
        .filter((record) => state.aggregateMonth === "all" || String(record.month || "").slice(5, 7) === state.aggregateMonth)
        .filter((record) => aggregateAreaBandMatches(record))
        .filter((record) => Number.isFinite(record.price_manwon) && Number.isFinite(record[basis.field]));
      const map = new Map();
      for (const record of rows) {
        const period = aggregatePeriodKey(record);
        if (!period) continue;
        if (!map.has(period)) map.set(period, []);
        map.get(period).push(record);
      }
      const periods = aggregateExpectedPeriods();
      const trend = periods.map((period) => {
        const periodRows = map.get(period) || [];
        return {
          period,
          count: periodRows.length,
          building_count: new Set(periodRows.map((row) => row.parcel_key)).size,
          avg_price_manwon: averageClient(periodRows.map((row) => row.price_manwon)),
          median_price_manwon: medianClient(periodRows.map((row) => row.price_manwon)),
          median_unit_manwon: medianClient(periodRows.map((row) => row[basis.field])),
        };
      });
      return { basis, sourceRows: rows, trend };
    }

    function tinySparkline(values, color = "#156f78") {
      const clean = values.filter(Number.isFinite);
      if (clean.length < 2) return '<svg viewBox="0 0 120 28" aria-hidden="true"><line x1="4" y1="18" x2="116" y2="18" stroke="#dbe1ea" stroke-width="2"/></svg>';
      const minValue = Math.min(...clean);
      const maxValue = Math.max(...clean);
      const y = (value) => 24 - ((value - minValue) / Math.max(maxValue - minValue, 1)) * 20;
      const points = clean.map((value, index) => (4 + (index / Math.max(clean.length - 1, 1)) * 112) + "," + y(value)).join(" ");
      return '<svg viewBox="0 0 120 28" aria-hidden="true"><polyline fill="none" stroke="' + color + '" stroke-width="3" points="' + points + '"/></svg>';
    }

    function drawAggregateTrendChart(trend, basisLabel) {
      const svg = document.getElementById("aggregateTrendChart");
      const values = trend.map((row) => row.median_unit_manwon).filter(Number.isFinite);
      const w = 980, h = 420, padL = 66, padR = 34, padT = 36, padB = 54;
      if (!values.length) {
        svg.innerHTML = '<text x="24" y="62" fill="#647083" font-size="15">집합건물 거래가격/평당가 추이 데이터가 없습니다.</text>';
        return;
      }
      const minValue = Math.min(...values) * 0.92;
      const maxValue = Math.max(...values) * 1.08;
      const x = (index) => padL + (index / Math.max(trend.length - 1, 1)) * (w - padL - padR);
      const y = (value) => h - padB - ((value - minValue) / Math.max(maxValue - minValue, 1)) * (h - padT - padB);
      const unitPath = trend.map((row, index) => Number.isFinite(row.median_unit_manwon) ? x(index) + "," + y(row.median_unit_manwon) : "").filter(Boolean).join(" ");
      const maxCount = Math.max(...trend.map((row) => row.count || 0), 1);
      const barWidth = Math.max(4, Math.min(28, ((w - padL - padR) / Math.max(trend.length, 1)) * 0.56));
      const labelStep = trend.length > 48 ? 12 : trend.length > 24 ? 6 : 1;
      svg.innerHTML = \`
        <line x1="\${padL}" y1="\${h-padB}" x2="\${w-padR}" y2="\${h-padB}" stroke="#dbe1ea"/>
        <line x1="\${padL}" y1="\${padT}" x2="\${padL}" y2="\${h-padB}" stroke="#dbe1ea"/>
        \${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = minValue + (maxValue - minValue) * ratio;
          const yy = y(value);
          return \`<line x1="\${padL}" y1="\${yy}" x2="\${w-padR}" y2="\${yy}" stroke="#eef2f5"/><text x="12" y="\${yy + 4}" font-size="11" fill="#647083">\${money(value)}</text>\`;
        }).join("")}
        \${trend.map((row, index) => {
          const barHeight = Math.max(0, ((row.count || 0) / maxCount) * 92);
          return row.count ? \`<rect x="\${x(index) - barWidth / 2}" y="\${h - padB - barHeight}" width="\${barWidth}" height="\${barHeight}" rx="3" fill="#d9ece9"><title>\${row.period} 거래 \${row.count}건</title></rect>\` : "";
        }).join("")}
        \${unitPath ? \`<polyline fill="none" stroke="#156f78" stroke-width="4" points="\${unitPath}"/>\` : ""}
        \${trend.map((row, index) => Number.isFinite(row.median_unit_manwon) ? \`<circle cx="\${x(index)}" cy="\${y(row.median_unit_manwon)}" r="3.3" fill="#156f78"><title>\${row.period} \${basisLabel} \${money(row.median_unit_manwon)}만원/평, \${row.count}건</title></circle>\` : "").join("")}
        \${trend.map((row, index) => index % labelStep === 0 || index === trend.length - 1 ? \`<text x="\${x(index)}" y="\${h - 17}" text-anchor="middle" font-size="10" fill="#647083">\${escapeSvg(aggregatePeriodLabel(row.period))}</text>\` : "").join("")}
        <text x="\${padL}" y="21" font-size="12" fill="#647083">청록 선=\${escapeSvg(basisLabel)} 중위 · 연한 막대=거래건수</text>
      \`;
    }

    function renderAggregateTrendBoard() {
      renderAggregateOptions();
      const { basis, sourceRows, trend } = aggregateRows();
      const observedTrend = trend.filter((row) => Number.isFinite(row.median_unit_manwon));
      const first = observedTrend[0];
      const latest = observedTrend.at(-1);
      const change = trendChangePercent(first && { median: first.median_unit_manwon }, latest && { median: latest.median_unit_manwon });
      document.getElementById("aggregatePeriod").value = state.aggregatePeriod;
      document.getElementById("aggregateUse").value = state.aggregateUse;
      document.getElementById("aggregateBasis").value = state.aggregateBasis;
      document.getElementById("aggregateAreaBand").value = state.aggregateAreaBand;
      const filterLabel = [
        useCategoryLabel(state.aggregateUse),
        state.aggregateYear === "all" ? "전체 연도" : state.aggregateYear + "년",
        state.aggregateMonth === "all" ? "전체 월" : Number(state.aggregateMonth) + "월",
        basis.label,
        aggregateAreaBandLabel(),
      ].join(" · ");
      document.getElementById("aggregateTrendBadge").textContent = filterLabel;
      document.getElementById("aggregateStoryCards").innerHTML = [
        {
          label: "가격 방향",
          value: pct(change),
          note: first && latest ? aggregatePeriodLabel(first.period) + " → " + aggregatePeriodLabel(latest.period) : "관측값 없음",
          spark: tinySparkline(observedTrend.map((row) => row.median_unit_manwon), "#156f78"),
        },
        {
          label: "최근 기준",
          value: latest ? money(latest.median_unit_manwon) + "만원/평" : "-",
          note: latest ? aggregatePeriodLabel(latest.period) + " · " + fmt.format(latest.count) + "건 · 평균 " + money(latest.avg_price_manwon) + "만원" : "최근 관측값 없음",
          spark: tinySparkline(observedTrend.map((row) => row.count), "#6b9d97"),
        },
        {
          label: "표본 범위",
          value: fmt.format(sourceRows.length) + "건",
          note: fmt.format(new Set(sourceRows.map((row) => row.parcel_key)).size) + "개 건물 · " + fmt.format(observedTrend.length) + "개 기간 관측",
          spark: tinySparkline(trend.map((row) => row.count), "#b3482f"),
        },
      ].map((card) => '<div class="core-card"><span>' + escapeSvg(card.label) + '</span><strong>' + escapeSvg(card.value) + '</strong><small>' + escapeSvg(card.note) + '</small>' + card.spark + '</div>').join("");
      document.getElementById("aggregateTrendSummary").innerHTML = [
        ["기준값 거래", fmt.format(sourceRows.length) + "건"],
        ["거래 건물수", fmt.format(new Set(sourceRows.map((row) => row.parcel_key)).size) + "개"],
        ["최근 " + basis.label, latest ? money(latest.median_unit_manwon) + "만원/평" : "-"],
        ["기간 변화", pct(change)],
        ["최근 평균금액", latest ? money(latest.avg_price_manwon) + "만원" : "-"],
        ["관측 기간", fmt.format(observedTrend.length) + "개 / 표시 " + fmt.format(trend.length) + "개"],
      ].map(([label, value]) => \`<div class="valuation-stat"><span>\${escapeSvg(label)}</span><strong>\${escapeSvg(value)}</strong></div>\`).join("");
      const tableTrend = trend.slice().sort((a, b) => String(b.period || "").localeCompare(String(a.period || "")));
      document.getElementById("aggregateTrendTable").innerHTML =
        '<thead><tr><th>기간</th><th>거래건수</th><th>건물수</th><th>평균거래금액</th><th>중위거래금액</th><th>' + escapeSvg(basis.label) + '</th></tr></thead><tbody>' +
        (tableTrend.map((row) =>
          '<tr><td>' + escapeSvg(aggregatePeriodLabel(row.period)) + '</td>' +
          '<td>' + fmt.format(row.count) + '</td>' +
          '<td>' + fmt.format(row.building_count) + '</td>' +
          '<td>' + money(row.avg_price_manwon) + '</td>' +
          '<td>' + money(row.median_price_manwon) + '</td>' +
          '<td>' + money(row.median_unit_manwon) + '</td></tr>'
        ).join("") || '<tr><td colspan="6">현재 조건의 집합건물 거래 표본이 없습니다.</td></tr>') +
        '</tbody>';
      drawAggregateTrendChart(trend, basis.label);
    }

    function areaBandClient(areaSqm) {
      const pyeong = Number(areaSqm) / SQM_PER_PYEONG_CLIENT;
      if (!Number.isFinite(pyeong)) return { label: "면적 미입력", min: 0, max: Infinity };
      if (pyeong <= 10) return { label: "10평 이하", min: 0, max: 10 };
      if (pyeong <= 20) return { label: "10~20평", min: 10, max: 20 };
      if (pyeong <= 40) return { label: "20~40평", min: 20, max: 40 };
      if (pyeong <= 70) return { label: "40~70평", min: 40, max: 70 };
      if (pyeong <= 100) return { label: "70~100평", min: 70, max: 100 };
      return { label: "100평 초과", min: 100, max: Infinity };
    }

    function selectedBuildingRowsForValuation() {
      return data.records
        .filter((record) => record.analysis_eligible !== false)
        .filter((record) => record.parcel_key === state.selectedParcelKey)
        .sort((a, b) => (b.month || "").localeCompare(a.month || "") || (b.contract_day || 0) - (a.contract_day || 0));
    }

    function latestValuationRow() {
      const rows = selectedBuildingRowsForValuation();
      const preferred = rows.find((record) => useCategory(record) === state.valuationUse && Number.isFinite(record.price_manwon) && Number.isFinite(record.area_sqm));
      return preferred || null;
    }

    function setValuationDefaultsFromSelected() {
      const row = latestValuationRow();
      if (!row) return;
      state.valuationUse = state.dashboardUse;
      document.getElementById("valuationUse").value = state.valuationUse;
    }

    function valuationPeriodKey(record) {
      return state.valuationPeriod === "year" ? String(record.year) : String(record.month || "");
    }

    function valuationAllPeriods() {
      return state.valuationPeriod === "year" ? data.source.available_years.map(String) : data.source.available_months.map(String);
    }

    function valuationRows() {
      const basis = valuationBasisConfig[state.valuationBasis] || valuationBasisConfig.exclusive;
      const selectedBaseRows = selectedBuildingRowsForValuation()
        .filter((record) => useCategory(record) === state.valuationUse && Number.isFinite(record[basis.field]));
      const latestSelected = selectedBaseRows.find((record) => Number.isFinite(record[basis.areaField]) || Number.isFinite(record.area_sqm));
      const selectedArea = latestSelected ? (latestSelected[basis.areaField] || latestSelected.area_sqm) : null;
      const inputBand = latestSelected ? areaBandClient(selectedArea) : { label: "전체 면적", min: 0, max: Infinity };
      const inSameBand = (record) => {
        const area = record[basis.areaField] || record.area_sqm;
        const pyeong = area / SQM_PER_PYEONG_CLIENT;
        if (!Number.isFinite(pyeong) || inputBand.label === "전체 면적") return true;
        return pyeong > inputBand.min && pyeong <= inputBand.max;
      };
      const useMatches = (record) => state.valuationUse === "all" || useCategory(record) === state.valuationUse;
      const priced = data.records.filter((record) => record.analysis_eligible !== false && Number.isFinite(record[basis.field]) && useMatches(record));
      const comparable = priced.filter(inSameBand);
      return {
        basis,
        inputBand,
        marketRows: comparable.length >= 6 ? comparable : priced,
        selectedRows: selectedBaseRows,
      };
    }

    function trendRowsFromRecords(records, basis) {
      const map = new Map();
      for (const record of records) {
        const period = valuationPeriodKey(record);
        if (!period) continue;
        if (!map.has(period)) map.set(period, []);
        map.get(period).push(record[basis.field]);
      }
      return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, values]) => ({
          period,
          count: values.length,
          median: medianClient(values),
          p25: percentileClient(values, 0.25),
          p75: percentileClient(values, 0.75),
        }))
        .filter((row) => Number.isFinite(row.median));
    }

    function percentileClient(values, p) {
      const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
      if (!nums.length) return null;
      const idx = (nums.length - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return nums[lo];
      return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
    }

    function trendChangePercent(firstRow, lastRow) {
      if (!firstRow || !lastRow || !Number.isFinite(firstRow.median) || !Number.isFinite(lastRow.median) || firstRow.median === 0) return null;
      return ((lastRow.median - firstRow.median) / firstRow.median) * 100;
    }

    function recentTrendChangePercent(trend) {
      if (!trend.length) return null;
      const latest = trend.at(-1);
      if (state.valuationPeriod === "year") {
        const baseYear = Number(latest.period) - 3;
        const base = trend.find((row) => Number(row.period) >= baseYear) || trend[0];
        return trendChangePercent(base, latest);
      }
      const base = trend[Math.max(0, trend.length - 37)];
      return trendChangePercent(base, latest);
    }

    function drawValuationTrendChart(marketTrend, selectedTrend, basisLabel) {
      const svg = document.getElementById("valuationTrendChart");
      const periods = valuationAllPeriods();
      const visiblePeriods = state.valuationPeriod === "month" ? periods.slice(-60) : periods;
      const visibleSet = new Set(visiblePeriods);
      const market = marketTrend.filter((row) => visibleSet.has(row.period));
      const selected = selectedTrend.filter((row) => visibleSet.has(row.period));
      const values = [
        ...market.flatMap((row) => [row.median, row.p25, row.p75]),
        ...selected.map((row) => row.median),
      ].filter(Number.isFinite);
      const w = 980, h = 420, padL = 66, padR = 34, padT = 36, padB = 54;
      if (!values.length) {
        svg.innerHTML = '<text x="24" y="62" fill="#647083" font-size="15">평당가 변화 추이 데이터가 없습니다.</text>';
        return;
      }
      const minValue = Math.min(...values) * 0.92;
      const maxValue = Math.max(...values) * 1.08;
      const indexByPeriod = new Map(visiblePeriods.map((period, index) => [period, index]));
      const x = (period) => padL + (indexByPeriod.get(period) / Math.max(visiblePeriods.length - 1, 1)) * (w - padL - padR);
      const y = (value) => h - padB - ((value - minValue) / Math.max(maxValue - minValue, 1)) * (h - padT - padB);
      const linePath = (rows, field) => rows.map((row) => x(row.period) + "," + y(row[field])).join(" ");
      const labelStep = visiblePeriods.length > 48 ? 12 : visiblePeriods.length > 24 ? 6 : 1;
      svg.innerHTML = \`
        <line x1="\${padL}" y1="\${h-padB}" x2="\${w-padR}" y2="\${h-padB}" stroke="#dbe1ea"/>
        <line x1="\${padL}" y1="\${padT}" x2="\${padL}" y2="\${h-padB}" stroke="#dbe1ea"/>
        \${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = minValue + (maxValue - minValue) * ratio;
          const yy = y(value);
          return \`<line x1="\${padL}" y1="\${yy}" x2="\${w-padR}" y2="\${yy}" stroke="#eef2f5"/><text x="12" y="\${yy + 4}" font-size="11" fill="#647083">\${money(value)}</text>\`;
        }).join("")}
        \${market.length ? \`<polyline fill="none" stroke="#b3482f" stroke-width="2" stroke-dasharray="4 5" points="\${linePath(market, "p75")}"/><polyline fill="none" stroke="#b3482f" stroke-width="2" stroke-dasharray="4 5" points="\${linePath(market, "p25")}"/><polyline fill="none" stroke="#156f78" stroke-width="4" points="\${linePath(market, "median")}"/>\` : ""}
        \${selected.length ? \`<polyline fill="none" stroke="#2f7d4f" stroke-width="3" points="\${linePath(selected, "median")}"/>\` : ""}
        \${market.map((row) => \`<circle cx="\${x(row.period)}" cy="\${y(row.median)}" r="3.5" fill="#156f78"><title>\${row.period} 마곡 유사군 중위 \${money(row.median)}만원/평, \${row.count}건</title></circle>\`).join("")}
        \${selected.map((row) => \`<circle cx="\${x(row.period)}" cy="\${y(row.median)}" r="3.2" fill="#2f7d4f"><title>\${row.period} 선택 건물 중위 \${money(row.median)}만원/평, \${row.count}건</title></circle>\`).join("")}
        \${visiblePeriods.map((period, index) => index % labelStep === 0 || index === visiblePeriods.length - 1 ? \`<text x="\${x(period)}" y="\${h - 17}" text-anchor="middle" font-size="10" fill="#647083">\${escapeSvg(state.valuationPeriod === "year" ? period : period.slice(2))}</text>\` : "").join("")}
        <text x="\${padL}" y="21" font-size="12" fill="#647083">\${escapeSvg(basisLabel)} 추이 · 청록=마곡 유사군 중위 · 초록=선택 건물 · 점선=25~75%</text>
      \`;
    }

    function renderValuationDashboard() {
      const group = selectedMonthlyGroup();
      const { basis, inputBand, marketRows, selectedRows } = valuationRows();
      const marketTrend = trendRowsFromRecords(marketRows, basis);
      const selectedTrend = trendRowsFromRecords(selectedRows, basis);
      const firstMarket = marketTrend[0];
      const latestMarket = marketTrend.at(-1);
      const latestSelected = selectedTrend.at(-1);
      const decadeChange = trendChangePercent(firstMarket, latestMarket);
      const recentChange = recentTrendChangePercent(marketTrend);
      const highPoint = marketTrend.reduce((best, row) => !best || row.median > best.median ? row : best, null);
      const lowPoint = marketTrend.reduce((best, row) => !best || row.median < best.median ? row : best, null);
      const periodLabel = state.valuationPeriod === "year" ? "연도별" : "월별";
      document.getElementById("valuationScopeBadge").textContent = (group ? buildingTitle(group) : "마곡동 전체 시장") + " · " + useCategoryLabel(state.valuationUse);
      document.getElementById("valuationSummary").innerHTML = \`
        <div class="valuation-callout tone-neutral"><strong>가격 입력 없음</strong><span>금액 입력과 자동 가격 판단을 제거하고, 10년간 \${escapeSvg(basis.label)} 변화만 참고자료로 제공합니다.</span></div>
        <div class="valuation-stat primary"><span>최근 중위 \${basis.label}</span><strong>\${latestMarket ? money(latestMarket.median) + "만원/평" : "-"}</strong></div>
        <div class="valuation-stat primary"><span>10년 변화</span><strong>\${pct(decadeChange)}</strong></div>
        <div class="valuation-stat"><span>최근 3년 변화</span><strong>\${pct(recentChange)}</strong></div>
        <div class="valuation-stat"><span>최고 관측</span><strong>\${highPoint ? highPoint.period + " · " + money(highPoint.median) : "-"}</strong></div>
        <div class="valuation-stat"><span>최저 관측</span><strong>\${lowPoint ? lowPoint.period + " · " + money(lowPoint.median) : "-"}</strong></div>
        <div class="valuation-stat"><span>비교 면적대</span><strong>\${escapeSvg(inputBand.label)}</strong></div>
        <div class="valuation-stat"><span>표본수</span><strong>\${fmt.format(marketRows.length)}건</strong></div>
        <div class="valuation-stat"><span>\${group ? "선택 건물 최근" : "선택 건물"}</span><strong>\${group ? (latestSelected ? money(latestSelected.median) + "만원/평" : "-") : "검색 후 표시"}</strong></div>
        <div class="valuation-stat"><span>관측 기간</span><strong>\${fmt.format(marketTrend.length)}개</strong></div>
        <div class="valuation-next"><strong>읽는 순서.</strong> 먼저 \${escapeSvg(periodLabel)} 중위 평당가의 방향을 보고, 선택 건물이 있으면 초록선과 청록선을 비교한 뒤 개별 거래표에서 층·면적·계약면적 매칭 여부를 확인하세요.</div>
      \`;
      document.getElementById("valuationMeta").textContent =
        "비교군: " + useCategoryLabel(state.valuationUse) + " · " + inputBand.label + " · " + basis.areaLabel + " 기준 · 마곡 유사 거래 " + fmt.format(marketRows.length) + "건. " +
        "가격 입력 없이 최근 기간 " + (latestMarket?.period || "-") + "의 중위 평당가와 10년 변화를 표시합니다.";
      drawValuationTrendChart(marketTrend, selectedTrend, basis.label);
    }

    function renderDecisionBoards() {
      renderValuationDashboard();
      renderTrendBoard();
    }

    function trendYearRowsFromRecords(records, basis) {
      const map = new Map();
      for (const record of records) {
        if (!record.year || !Number.isFinite(record[basis.field])) continue;
        const key = String(record.year);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(record[basis.field]);
      }
      return [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, values]) => ({
          period,
          count: values.length,
          median: medianClient(values),
        }))
        .filter((row) => Number.isFinite(row.median));
    }

    function drawTrendBoardChart(primaryTrend, marketTrend, basisLabel, primaryLabel) {
      const svg = document.getElementById("trendBoardChart");
      const years = data.source.available_years.map(String);
      const visibleSet = new Set(years);
      const primary = primaryTrend.filter((row) => visibleSet.has(row.period));
      const market = marketTrend.filter((row) => visibleSet.has(row.period));
      const values = [...primary.map((row) => row.median), ...market.map((row) => row.median)].filter(Number.isFinite);
      const counts = primary.map((row) => row.count).filter(Number.isFinite);
      const w = 980, h = 360, padL = 66, padR = 34, padT = 34, padB = 52;
      if (!values.length) {
        svg.innerHTML = '<text x="24" y="62" fill="#647083" font-size="15">건물 변화 추이를 그릴 평당가 데이터가 없습니다.</text>';
        return;
      }
      const minValue = Math.min(...values) * 0.92;
      const maxValue = Math.max(...values) * 1.08;
      const maxCount = Math.max(...counts, 1);
      const indexByYear = new Map(years.map((year, index) => [year, index]));
      const x = (period) => padL + (indexByYear.get(period) / Math.max(years.length - 1, 1)) * (w - padL - padR);
      const y = (value) => h - padB - ((value - minValue) / Math.max(maxValue - minValue, 1)) * (h - padT - padB);
      const linePath = (rows) => rows.map((row) => x(row.period) + "," + y(row.median)).join(" ");
      const barW = Math.max(12, Math.min(34, (w - padL - padR) / Math.max(years.length, 1) * 0.42));
      svg.innerHTML =
        '<line x1="' + padL + '" y1="' + (h-padB) + '" x2="' + (w-padR) + '" y2="' + (h-padB) + '" stroke="#dbe1ea"/>' +
        '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (h-padB) + '" stroke="#dbe1ea"/>' +
        [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = minValue + (maxValue - minValue) * ratio;
          const yy = y(value);
          return '<line x1="' + padL + '" y1="' + yy + '" x2="' + (w-padR) + '" y2="' + yy + '" stroke="#eef2f5"/><text x="12" y="' + (yy + 4) + '" font-size="11" fill="#647083">' + money(value) + '</text>';
        }).join("") +
        primary.map((row) => {
          const bh = (row.count / maxCount) * (h - padT - padB) * 0.46;
          return '<rect x="' + (x(row.period) - barW / 2) + '" y="' + (h - padB - bh) + '" width="' + barW + '" height="' + bh + '" rx="4" fill="#b3482f" opacity="0.18"><title>' + row.period + ' ' + primaryLabel + ' 거래 ' + fmt.format(row.count) + '건</title></rect>';
        }).join("") +
        (market.length ? '<polyline fill="none" stroke="#156f78" stroke-width="3" stroke-dasharray="7 5" points="' + linePath(market) + '"/>' : '') +
        (primary.length ? '<polyline fill="none" stroke="#2f7d4f" stroke-width="4" points="' + linePath(primary) + '"/>' : '') +
        market.map((row) => '<circle cx="' + x(row.period) + '" cy="' + y(row.median) + '" r="3" fill="#156f78"><title>' + row.period + ' 마곡 유사군 ' + money(row.median) + '만원/평, ' + fmt.format(row.count) + '건</title></circle>').join("") +
        primary.map((row) => '<circle cx="' + x(row.period) + '" cy="' + y(row.median) + '" r="4.2" fill="#2f7d4f"><title>' + row.period + ' ' + primaryLabel + ' ' + money(row.median) + '만원/평, ' + fmt.format(row.count) + '건</title></circle>').join("") +
        years.map((year, index) => '<text x="' + x(year) + '" y="' + (h - 18) + '" text-anchor="middle" font-size="11" fill="#647083">' + (index % 2 === 0 || years.length <= 7 ? year : "") + '</text>').join("") +
        '<text x="' + padL + '" y="22" font-size="12" fill="#647083">' + escapeSvg(basisLabel) + ' · 초록=' + escapeSvg(primaryLabel) + ' · 청록 점선=마곡 유사군 · 막대=' + escapeSvg(primaryLabel) + ' 거래건수</text>';
    }

    function trendMonthMatrixRows(records, basis) {
      const byYearMonth = new Map();
      for (const record of records) {
        if (!record.year || !record.month || !Number.isFinite(record[basis.field])) continue;
        const year = String(record.year);
        const month = String(record.month).slice(5, 7);
        const key = year + "-" + month;
        if (!byYearMonth.has(key)) byYearMonth.set(key, []);
        byYearMonth.get(key).push(record[basis.field]);
      }
      return data.source.available_years.map((year) => {
        const yearLabel = String(year);
        const cells = Array.from({ length: 12 }, (_, index) => {
          const month = String(index + 1).padStart(2, "0");
          const values = byYearMonth.get(yearLabel + "-" + month) || [];
          return {
            month,
            value: medianClient(values),
            count: values.length,
          };
        });
        return { year: yearLabel, cells };
      });
    }

    function renderTrendHeatmap(rows, basisLabel) {
      const values = rows.flatMap((row) => row.cells.map((cell) => cell.value)).filter(Number.isFinite);
      const minValue = values.length ? Math.min(...values) : 0;
      const maxValue = values.length ? Math.max(...values) : 1;
      if (!values.length) {
        document.getElementById("trendMonthHeatmap").innerHTML = '<div class="trend-empty">월별 변화 히트맵을 그릴 표본이 없습니다. 선택 건물 또는 용도 기준을 바꿔보세요.</div>';
        return;
      }
      const intensity = (value) => {
        if (!Number.isFinite(value)) return "transparent";
        const ratio = (value - minValue) / Math.max(maxValue - minValue, 1);
        const opacity = 0.1 + ratio * 0.48;
        return "rgba(21,111,120," + opacity.toFixed(2) + ")";
      };
      document.getElementById("trendMonthHeatmap").innerHTML =
        '<table><thead><tr><th>연도</th>' +
        Array.from({ length: 12 }, (_, index) => '<th>' + (index + 1) + '월</th>').join("") +
        '</tr></thead><tbody>' +
        rows.map((row) => '<tr><th>' + row.year + '</th>' + row.cells.map((cell) => {
          const label = Number.isFinite(cell.value) ? money(cell.value) : "-";
          const title = row.year + '-' + cell.month + ' ' + basisLabel + ' ' + label + '만원/평, ' + fmt.format(cell.count) + '건';
          return '<td class="trend-month-cell" style="background:' + intensity(cell.value) + '" title="' + escapeSvg(title) + '">' + label + '<small>' + (cell.count ? fmt.format(cell.count) + '건' : '') + '</small></td>';
        }).join("") + '</tr>').join("") +
        '</tbody></table>';
    }

    function renderTrendBoard() {
      const group = selectedMonthlyGroup();
      const { basis, inputBand, marketRows, selectedRows } = valuationRows();
      const selectedTrend = trendYearRowsFromRecords(selectedRows, basis);
      const marketTrend = trendYearRowsFromRecords(marketRows, basis);
      const hasSelectedBuilding = Boolean(group);
      const primaryRows = hasSelectedBuilding && selectedRows.length >= 2 ? selectedRows : marketRows;
      const primaryTrend = hasSelectedBuilding && selectedRows.length >= 2 ? selectedTrend : marketTrend;
      const primaryLabel = hasSelectedBuilding && selectedRows.length >= 2 ? "선택 건물" : "마곡 유사군";
      const trendValues = primaryTrend.map((row) => row.median).filter(Number.isFinite);
      const latest = primaryTrend.at(-1);
      const previous = primaryTrend.length > 1 ? primaryTrend.at(-2) : null;
      const first = primaryTrend[0] || null;
      const latestDelta = previous?.median ? ((latest.median - previous.median) / previous.median) * 100 : null;
      const totalDelta = first?.median ? ((latest.median - first.median) / first.median) * 100 : null;
      const bestYear = primaryTrend.reduce((best, row) => !best || row.median > best.median ? row : best, null);
      const totalCount = primaryRows.length;
      const observedMonths = new Set(primaryRows.map((row) => row.month).filter(Boolean)).size;
      const basisNotice = !hasSelectedBuilding
        ? "첫 화면은 특정 건물을 추천하거나 대표값으로 오해하지 않도록 마곡동 전체 유사군 기준으로 시작합니다. 검색 후 선택 건물 기준으로 전환됩니다."
        : selectedRows.length >= 2
        ? "선택 건물 실거래 기준입니다. 표본이 적은 연도는 개별 거래표에서 층과 면적을 같이 확인하세요."
        : "선택 건물 표본이 부족해 같은 용도·면적대 마곡 유사군으로 보조 표시합니다.";
      document.getElementById("trendBoardBadge").textContent = (group ? buildingTitle(group) : "마곡동 전체 시장") + " · " + basis.label;
      document.getElementById("trendBoardMeta").textContent =
        "기준: " + useCategoryLabel(state.valuationUse) + " · " + inputBand.label + " · " + basis.areaLabel + ". 초록선은 " + primaryLabel + ", 청록 점선은 마곡 유사군입니다.";
      document.getElementById("trendBoardSummary").innerHTML =
        '<div class="trend-card wide"><strong>건물 변화 해석.</strong>' + escapeSvg(basisNotice) + '</div>' +
        '<div class="trend-card"><span>최근 연도</span><strong>' + (latest ? latest.period + ' · ' + money(latest.median) + '만원/평' : '-') + '</strong></div>' +
        '<div class="trend-card"><span>직전 대비</span><strong>' + pct(latestDelta) + '</strong></div>' +
        '<div class="trend-card"><span>관측 시작 대비</span><strong>' + pct(totalDelta) + '</strong></div>' +
        '<div class="trend-card"><span>최고 연도</span><strong>' + (bestYear ? bestYear.period + ' · ' + money(bestYear.median) : '-') + '</strong></div>' +
        '<div class="trend-card"><span>표본 수</span><strong>' + fmt.format(totalCount) + '건</strong></div>' +
        '<div class="trend-card"><span>관측 월</span><strong>' + fmt.format(observedMonths) + '개월</strong></div>';
      drawTrendBoardChart(primaryTrend, marketTrend, basis.label, primaryLabel);
      renderTrendHeatmap(trendMonthMatrixRows(primaryRows, basis), basis.label);
    }

    function floorBucket(floor) {
      const order = Number(floor?.floor_order);
      if (order === 1) return "first";
      if (order === 2) return "second";
      if (order >= 3 && order < 900) return "upper";
      if (order < 0) return "basement";
      return "unknown";
    }

    function floorBucketLabel(bucket) {
      if (bucket === "first") return "1층";
      if (bucket === "second") return "2층";
      if (bucket === "upper") return "3층 이상";
      if (bucket === "basement") return "지하";
      if (bucket === "unknown") return "층정보 없음";
      return "전체 층";
    }

    function usageAreaBandLabel(pyeong) {
      if (!Number.isFinite(pyeong)) return "면적 미확인";
      if (pyeong < 10) return "10평 미만";
      if (pyeong < 30) return "10평 이상~30평 미만";
      if (pyeong < 50) return "30평 이상~50평 미만";
      if (pyeong < 100) return "50평 이상~100평 미만";
      return "100평 이상";
    }

    function usageTrendPeriodKey(record, periodMode) {
      return periodMode === "year" ? String(record.year) : String(record.month || "");
    }

    function buildUsageTrendRows(kind) {
      const periodMode = kind === "office" ? state.usageOfficePeriod : state.usageRetailPeriod;
      const rows = data.records
        .filter((record) => record.analysis_eligible !== false)
        .filter((record) => useCategory(record) === kind)
        .filter((record) => {
          if (kind === "office") return usageAreaBandLabel(record.exclusive_pyeong) === state.officeBand;
          const bucket = floorBucket({ floor: record.floor });
          return state.usageRetailFloor === "all" || bucket === state.usageRetailFloor;
        });
      const map = new Map();
      for (const record of rows) {
        const period = usageTrendPeriodKey(record, periodMode);
        if (!period) continue;
        if (!map.has(period)) map.set(period, []);
        map.get(period).push(record);
      }
      const trendRows = [...map.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, periodRows]) => ({
          period,
          count: periodRows.length,
          building_count: new Set(periodRows.map((row) => row.parcel_key)).size,
          avg_price_manwon: averageClient(periodRows.map((row) => row.price_manwon)),
          median_exclusive_ppyeong_manwon: medianClient(periodRows.map((row) => row.exclusive_ppyeong_manwon)),
          median_contract_ppyeong_manwon: medianClient(periodRows.map((row) => row.contract_ppyeong_manwon)),
        }));
      return periodMode === "month" ? trendRows.slice(-36) : trendRows;
    }

    function renderUsageTrendTable(tableId, kind) {
      const periodMode = kind === "office" ? state.usageOfficePeriod : state.usageRetailPeriod;
      const rows = buildUsageTrendRows(kind);
      const tableRows = rows.slice().sort((a, b) => String(b.period || "").localeCompare(String(a.period || "")));
      const title = periodMode === "year" ? "연도" : "월";
      document.getElementById(tableId).innerHTML =
        '<thead><tr><th>' + title + '</th><th>거래건수</th><th>건물수</th><th>평균거래금액</th><th>중위 전용평당가</th><th>중위 계약평당가</th></tr></thead><tbody>' +
        (tableRows.map((row) =>
          '<tr>' +
          '<td>' + escapeSvg(periodMode === "year" ? row.period : row.period.slice(2)) + '</td>' +
          '<td>' + fmt.format(row.count) + '</td>' +
          '<td>' + fmt.format(row.building_count) + '</td>' +
          '<td>' + money(row.avg_price_manwon) + '</td>' +
          '<td>' + money(row.median_exclusive_ppyeong_manwon) + '</td>' +
          '<td>' + (Number.isFinite(row.median_contract_ppyeong_manwon) ? money(row.median_contract_ppyeong_manwon) : "없음") + '</td>' +
          '</tr>'
        ).join("") || '<tr><td colspan="6">현재 조건의 평당가 추이 표본이 없습니다.</td></tr>') +
        '</tbody>';
    }

    function renderUsageOfficeOptions() {
      const select = document.getElementById("usageOfficeBand");
      if (!select) return;
      const options = (data.officeAreaBandSummary || []).map((row) => '<option value="' + escapeSvg(row.band_label) + '">' + escapeSvg(row.band_label) + '</option>').join("");
      if (select.innerHTML !== options) select.innerHTML = options;
      select.value = state.officeBand;
      document.getElementById("usageOfficeSort").value = state.usageOfficeSort;
      document.getElementById("usageOfficePeriod").value = state.usageOfficePeriod;
    }

    function usageOfficeRows() {
      const q = state.search;
      return (data.officeAreaBandBuildingSummary || [])
        .filter((row) => row.band_label === state.officeBand)
        .filter((row) => row.transaction_count >= state.minCount)
        .filter((row) => state.mask === "all" || (state.mask === "exact" ? !row.is_masked_parcel : row.is_masked_parcel))
        .filter((row) => queryMatches(row, q, [row.parcel_label, row.building_name, row.road, row.band_label]))
        .sort((a, b) => {
          if (state.usageOfficeSort === "unit") return (b.median_exclusive_ppyeong_manwon || 0) - (a.median_exclusive_ppyeong_manwon || 0);
          if (state.usageOfficeSort === "price") return (b.median_price_manwon || 0) - (a.median_price_manwon || 0);
          return b.transaction_count - a.transaction_count || (b.median_exclusive_ppyeong_manwon || 0) - (a.median_exclusive_ppyeong_manwon || 0);
        });
    }

    function usageRetailRows() {
      const q = state.search;
      const rows = [];
      for (const building of data.retailBuildingFloorSummary || []) {
        if (building.transaction_count < state.minCount) continue;
        if (!queryMatches(building, q, [building.parcel_label, building.building_name, building.road, building.main_uses.join(" "), building.floors.map((floor) => floor.floor).join(" ")])) continue;
        for (const floor of building.floors || []) {
          const bucket = floorBucket(floor);
          if (state.usageRetailFloor !== "all" && bucket !== state.usageRetailFloor) continue;
          rows.push({ ...floor, bucket, building_transaction_count: building.transaction_count, floor_count: building.floor_count });
        }
      }
      return rows.sort((a, b) => {
        if (state.usageRetailSort === "unit") return (b.median_exclusive_ppyeong_manwon || 0) - (a.median_exclusive_ppyeong_manwon || 0);
        if (state.usageRetailSort === "count") return (b.transaction_count || 0) - (a.transaction_count || 0);
        return (a.floor_order || 999) - (b.floor_order || 999) || (b.transaction_count || 0) - (a.transaction_count || 0);
      });
    }

    function renderUsageSplitBoard() {
      renderUsageOfficeOptions();
      const officeSummary = (data.officeAreaBandSummary || []).find((row) => row.band_label === state.officeBand);
      const officeRows = usageOfficeRows();
      const totalOfficeBuildings = new Set(data.records
        .filter((record) => record.analysis_eligible !== false && useCategory(record) === "office")
        .map((record) => record.parcel_key)).size;
      const retailRows = usageRetailRows();
      const firstRetailRows = retailRows.filter((row) => row.bucket === "first");
      document.getElementById("usageOfficeMetrics").innerHTML = [
        ["면적대", state.officeBand || "-"],
        ["전체 업무 거래건물", fmt.format(totalOfficeBuildings) + "개"],
        ["현재 표시 건물", fmt.format(officeRows.length) + "개"],
        ["중위 전용평당가", officeSummary ? money(officeSummary.median_exclusive_ppyeong_manwon) + "만원/평" : "-"],
        ["계약면적 매칭", officeSummary ? fmt.format(officeSummary.contract_matched_count) + "건" : "-"],
      ].map(([label, value]) => '<div class="usage-metric"><span>' + escapeSvg(label) + '</span><strong>' + escapeSvg(value) + '</strong></div>').join("");
      document.getElementById("usageOfficeTable").innerHTML =
        '<thead><tr><th>건물</th><th>건수</th><th>전용평당가</th><th>계약평당가</th></tr></thead><tbody>' +
        (officeRows.map((row) =>
          '<tr class="clickable" data-parcel-key="' + escapeSvg(row.parcel_key) + '">' +
          '<td>' + escapeSvg(buildingTitle(row)) + '<br><span class="muted">' + escapeSvg(row.parcel_label) + ' · ' + escapeSvg(row.reliability || "D 확인") + '</span></td>' +
          '<td>' + fmt.format(row.transaction_count) + '</td>' +
          '<td>' + money(row.median_exclusive_ppyeong_manwon) + '</td>' +
          '<td>' + (Number.isFinite(row.median_contract_ppyeong_manwon) ? money(row.median_contract_ppyeong_manwon) : "없음") + '</td>' +
          '</tr>'
        ).join("") || '<tr><td colspan="4">현재 조건에 맞는 업무시설 표본이 없습니다.</td></tr>') +
        '</tbody>';
      renderUsageTrendTable("usageOfficeTrendTable", "office");
      document.getElementById("usageRetailFloor").value = state.usageRetailFloor;
      document.getElementById("usageRetailSort").value = state.usageRetailSort;
      document.getElementById("usageRetailPeriod").value = state.usageRetailPeriod;
      document.getElementById("usageRetailMetrics").innerHTML = [
        ["층 구분", floorBucketLabel(state.usageRetailFloor)],
        ["표시 층/건물", fmt.format(retailRows.length) + "개"],
        ["1층 중위", firstRetailRows.length ? money(medianClient(firstRetailRows.map((row) => row.median_exclusive_ppyeong_manwon))) + "만원/평" : "-"],
      ].map(([label, value]) => '<div class="usage-metric"><span>' + escapeSvg(label) + '</span><strong>' + escapeSvg(value) + '</strong></div>').join("");
      document.getElementById("usageRetailTable").innerHTML =
        '<thead><tr><th>건물</th><th>층</th><th>건수</th><th>전용평당가</th><th>계약평당가</th></tr></thead><tbody>' +
        (retailRows.slice(0, 10).map((row) =>
          '<tr class="clickable" data-parcel-key="' + escapeSvg(row.parcel_key) + '">' +
          '<td>' + escapeSvg(buildingTitle(row)) + '<br><span class="muted">' + escapeSvg(row.parcel_label) + ' · ' + escapeSvg((row.main_uses || []).join(", ")) + '</span></td>' +
          '<td><span class="floor-chip ' + (row.bucket === "first" ? "first" : "") + '">' + escapeSvg(row.floor) + '</span></td>' +
          '<td>' + fmt.format(row.transaction_count) + '</td>' +
          '<td>' + money(row.median_exclusive_ppyeong_manwon) + '</td>' +
          '<td>' + (Number.isFinite(row.median_contract_ppyeong_manwon) ? money(row.median_contract_ppyeong_manwon) : "없음") + '</td>' +
          '</tr>'
        ).join("") || '<tr><td colspan="5">현재 조건에 맞는 근린생활시설 층별 표본이 없습니다.</td></tr>') +
        '</tbody>';
      renderUsageTrendTable("usageRetailTrendTable", "retail");
    }

    function useCategoryFromRecord(record) {
      const use = String(record.main_use || "");
      if (/업무/.test(use)) return "office";
      if (/근린생활|판매|상가/.test(use)) return "retail";
      return "other";
    }

    function periodLabel(period) {
      return state.pyeongGranularity === "year" ? String(period) : String(period).slice(2);
    }

    function pyeongPeriods() {
      if (state.pyeongGranularity === "year") return data.source.available_years.map(String);
      const months = data.source.available_months.map(String);
      if (state.pyeongMonthWindow === "all") return months;
      return months.slice(-Number(state.pyeongMonthWindow || 36));
    }

    function buildPyeongMatrix() {
      const basis = pyeongBasisConfig[state.pyeongBasis] || pyeongBasisConfig.exclusive;
      const periods = pyeongPeriods();
      const periodSet = new Set(periods);
      const groupMeta = new Map(data.parcelGroups.map((group) => [group.parcel_key, group]));
      const rowsByBuilding = new Map();
      for (const record of data.records) {
        if (record.analysis_eligible === false) continue;
        const value = record[basis.field];
        if (!Number.isFinite(value)) continue;
        if (state.pyeongUse !== "all" && useCategoryFromRecord(record) !== state.pyeongUse) continue;
        const period = state.pyeongGranularity === "year" ? String(record.year) : String(record.month || "");
        if (!periodSet.has(period)) continue;
        const meta = groupMeta.get(record.parcel_key) || record;
        if (state.mask !== "all" && (state.mask === "exact" ? meta.is_masked_parcel : !meta.is_masked_parcel)) continue;
        if (!queryMatches(meta, state.search, [record.parcel_label, record.building_name, record.road, record.main_use])) continue;
        if (!rowsByBuilding.has(record.parcel_key)) {
          rowsByBuilding.set(record.parcel_key, {
            meta,
            periodValues: new Map(),
            totalCount: 0,
          });
        }
        const row = rowsByBuilding.get(record.parcel_key);
        if (!row.periodValues.has(period)) row.periodValues.set(period, []);
        row.periodValues.get(period).push(value);
        row.totalCount += 1;
      }
      const rows = [...rowsByBuilding.entries()].map(([parcelKey, row]) => {
        const cells = {};
        for (const period of periods) {
          const values = row.periodValues.get(period) || [];
          cells[period] = {
            value: medianClient(values),
            count: values.length,
          };
        }
        const observedCells = periods.map((period) => ({ period, ...cells[period] })).filter((cell) => Number.isFinite(cell.value));
        const first = observedCells[0] || null;
        const latest = observedCells.at(-1) || null;
        const previous = observedCells.length > 1 ? observedCells.at(-2) : null;
        const changePct = first?.value ? ((latest.value - first.value) / first.value) * 100 : null;
        const latestDeltaPct = previous?.value ? ((latest.value - previous.value) / previous.value) * 100 : null;
        return {
          parcelKey,
          meta: row.meta,
          title: buildingTitle(row.meta),
          cells,
          totalCount: row.totalCount,
          observedPeriodCount: observedCells.length,
          first,
          latest,
          previous,
          changePct,
          latestDeltaPct,
        };
      })
        .filter((row) => row.totalCount >= state.pyeongMinCount)
        .sort((a, b) => {
          if (state.pyeongSortBy === "recent") return (b.latest?.period || "").localeCompare(a.latest?.period || "") || b.totalCount - a.totalCount || a.title.localeCompare(b.title, "ko");
          if (state.pyeongSortBy === "count") return b.totalCount - a.totalCount || a.title.localeCompare(b.title, "ko");
          if (state.pyeongSortBy === "change") return Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0) || b.totalCount - a.totalCount;
          if (state.pyeongSortBy === "name") return a.title.localeCompare(b.title, "ko") || a.meta.parcel_label.localeCompare(b.meta.parcel_label, "ko");
          return (b.latest?.value || 0) - (a.latest?.value || 0) || b.totalCount - a.totalCount;
        });
      return { basis, periods, rows };
    }

    function pyeongHeatColor(value, minValue, maxValue) {
      if (!Number.isFinite(value) || !Number.isFinite(minValue) || !Number.isFinite(maxValue) || maxValue <= minValue) return "#ffffff";
      const ratio = Math.max(0, Math.min(1, (value - minValue) / (maxValue - minValue)));
      const alpha = 0.08 + ratio * 0.34;
      return "rgba(21, 111, 120, " + alpha.toFixed(3) + ")";
    }

    function renderPyeongMatrix() {
      const { basis, periods, rows } = buildPyeongMatrix();
      const allValues = rows.flatMap((row) => periods.map((period) => row.cells[period]?.value).filter(Number.isFinite));
      const minValue = Math.min(...allValues);
      const maxValue = Math.max(...allValues);
      const latestValues = rows.map((row) => row.latest?.value).filter(Number.isFinite);
      const modeText = (state.pyeongGranularity === "year" ? "년도별" : "월별") + " · " + basis.label;
      document.getElementById("pyeongModeBadge").textContent = modeText;
      document.getElementById("pyeongSummary").innerHTML = \`
        <div class="pyeong-stat"><span>표시 건물</span><strong>\${fmt.format(rows.length)}개</strong></div>
        <div class="pyeong-stat"><span>표시 기간</span><strong>\${fmt.format(periods.length)}개</strong></div>
        <div class="pyeong-stat"><span>최근 중위 \${basis.label}</span><strong>\${money(medianClient(latestValues))}만원/평</strong></div>
        <div class="pyeong-stat"><span>값 범위</span><strong>\${money(minValue)}~\${money(maxValue)}</strong></div>
      \`;
      document.getElementById("pyeongHeatmap").innerHTML = rows.length ? \`
        <table>
          <thead><tr>
            <th>건물명/지번</th>
            \${periods.map((period) => \`<th class="pyeong-cell">\${escapeSvg(periodLabel(period))}</th>\`).join("")}
          </tr></thead>
          <tbody>
          \${rows.map((row) => \`
            <tr class="clickable \${row.parcelKey === state.selectedParcelKey ? "selected" : ""}" data-parcel-key="\${escapeSvg(row.parcelKey)}">
              <td>
                <span class="pyeong-name">
                  <strong>\${escapeSvg(row.title)}</strong>
                  <span>\${escapeSvg(row.meta.parcel_label)} · \${escapeSvg(row.meta.road || row.meta.building_name_status || "-")} · \${fmt.format(row.totalCount)}건</span>
                </span>
              </td>
              \${periods.map((period) => {
                const cell = row.cells[period] || {};
                const bg = pyeongHeatColor(cell.value, minValue, maxValue);
                return \`<td class="pyeong-cell" style="background:\${bg}">\${Number.isFinite(cell.value) ? money(cell.value) : "-"}<small>\${cell.count ? fmt.format(cell.count) + "건" : ""}</small></td>\`;
              }).join("")}
            </tr>
          \`).join("")}
          </tbody>
        </table>
      \` : '<div class="data-note">현재 조건에 맞는 평당가 표본이 없습니다. 기간, 용도, 평당가 기준, 최소 거래건수를 낮춰보세요.</div>';
      const sideRows = rows.slice(0, 80);
      document.getElementById("pyeongTable").innerHTML = \`
        <thead><tr>
          <th>건물명</th><th>최근기간</th><th>최근 \${basis.label}</th><th>건수</th><th>전기간 변동</th><th>직전대비</th>
        </tr></thead>
        <tbody>
        \${sideRows.map((row) => \`
          <tr class="clickable \${row.parcelKey === state.selectedParcelKey ? "selected" : ""}" data-parcel-key="\${escapeSvg(row.parcelKey)}">
            <td>\${escapeSvg(row.title)}<br><span class="muted">\${escapeSvg(row.meta.parcel_label)}</span></td>
            <td>\${row.latest ? escapeSvg(periodLabel(row.latest.period)) : "-"}</td>
            <td>\${money(row.latest?.value)}</td>
            <td>\${fmt.format(row.totalCount)}</td>
            <td>\${pct(row.changePct)}</td>
            <td>\${pct(row.latestDeltaPct)}</td>
          </tr>
        \`).join("")}
        </tbody>
      \`;
    }

    function miniAmountChart(group) {
      const w = 240, h = 100, pad = 20;
      const points = group.points.filter((point) => Number.isFinite(point.avg_price_manwon));
      if (!points.length) return '<svg viewBox="0 0 240 100"><text x="12" y="52" fill="#647083" font-size="12">거래금액 없음</text></svg>';
      const allYears = data.source.available_years;
      const maxPrice = Math.max(...points.map((point) => point.avg_price_manwon), 1) * 1.12;
      const maxCount = Math.max(...points.map((point) => point.count), 1);
      const x = (year) => pad + ((year - allYears[0]) / Math.max(allYears.at(-1) - allYears[0], 1)) * (w - pad * 2);
      const y = (value) => h - pad - ((value || 0) / maxPrice) * (h - pad * 2);
      const barW = Math.max(8, Math.min(18, (w - pad * 2) / allYears.length * 0.45));
      const line = points.map((point) => x(point.year) + "," + y(point.avg_price_manwon)).join(" ");
      return \`
        <svg viewBox="0 0 \${w} \${h}" role="img" aria-label="\${escapeSvg(group.parcel_label)} 거래금액 변동">
          <line x1="\${pad}" y1="\${h-pad}" x2="\${w-pad}" y2="\${h-pad}" stroke="#dbe1ea"/>
          \${points.map((point) => {
            const bh = (point.count / maxCount) * (h - pad * 2) * 0.55;
            return \`<rect x="\${x(point.year) - barW / 2}" y="\${h - pad - bh}" width="\${barW}" height="\${bh}" rx="2" fill="#b3482f" opacity="0.2"><title>\${point.year} 거래 \${point.count}건</title></rect>\`;
          }).join("")}
          <polyline fill="none" stroke="#156f78" stroke-width="2.5" points="\${line}"/>
          \${points.map((point) => \`<circle cx="\${x(point.year)}" cy="\${y(point.avg_price_manwon)}" r="3" fill="#156f78"><title>\${point.year} 평균 \${money(point.avg_price_manwon)}만원, 중위 \${money(point.median_price_manwon)}만원</title></circle>\`).join("")}
          \${allYears.map((year, index) => index % 2 === 0 || allYears.length <= 5 ? \`<text x="\${x(year)}" y="\${h - 4}" text-anchor="middle" font-size="9" fill="#647083">\${String(year).slice(2)}</text>\` : "").join("")}
        </svg>
      \`;
    }

    function miniMonthlyAmountChart(group) {
      const w = 240, h = 100, pad = 20;
      const points = group.points.filter((point) => Number.isFinite(point.avg_price_manwon));
      if (!points.length) return '<svg viewBox="0 0 240 100"><text x="12" y="52" fill="#647083" font-size="12">월별 거래 없음</text></svg>';
      const indexByMonth = new Map(data.source.available_months.map((month, index) => [month, index]));
      const maxIndex = Math.max(data.source.available_months.length - 1, 1);
      const maxPrice = Math.max(...points.map((point) => point.avg_price_manwon), 1) * 1.12;
      const maxCount = Math.max(...points.map((point) => point.count), 1);
      const x = (month) => pad + ((indexByMonth.get(month) || 0) / maxIndex) * (w - pad * 2);
      const y = (value) => h - pad - ((value || 0) / maxPrice) * (h - pad * 2);
      const barW = Math.max(3, Math.min(8, (w - pad * 2) / Math.max(data.source.available_months.length, 1) * 0.7));
      const line = points.map((point) => x(point.month) + "," + y(point.avg_price_manwon)).join(" ");
      const labelMonths = data.source.available_months.filter((_, index) => index % 12 === 0 || index === data.source.available_months.length - 1);
      return \`
        <svg viewBox="0 0 \${w} \${h}" role="img" aria-label="\${escapeSvg(group.parcel_label)} 월별 거래금액 변동">
          <line x1="\${pad}" y1="\${h-pad}" x2="\${w-pad}" y2="\${h-pad}" stroke="#dbe1ea"/>
          \${points.map((point) => {
            const bh = (point.count / maxCount) * (h - pad * 2) * 0.55;
            return \`<rect x="\${x(point.month) - barW / 2}" y="\${h - pad - bh}" width="\${barW}" height="\${bh}" rx="1" fill="#b3482f" opacity="0.18"><title>\${point.month} 거래 \${point.count}건</title></rect>\`;
          }).join("")}
          <polyline fill="none" stroke="#156f78" stroke-width="2" points="\${line}"/>
          \${points.map((point) => \`<circle cx="\${x(point.month)}" cy="\${y(point.avg_price_manwon)}" r="2.4" fill="#156f78"><title>\${point.month} 평균 \${money(point.avg_price_manwon)}만원, 중위 \${money(point.median_price_manwon)}만원</title></circle>\`).join("")}
          \${labelMonths.map((month) => \`<text x="\${x(month)}" y="\${h - 4}" text-anchor="middle" font-size="8" fill="#647083">\${month.slice(2, 7)}</text>\`).join("")}
        </svg>
      \`;
    }

    function buildingMonthlyGroupsForArea() {
      const reliableKeys = new Set(data.buildingMonthlySeries
        .filter((group) => group.monthly_graph_reliability_passed === true)
        .map((group) => group.parcel_key));
      const rows = data.records
        .filter((record) => record.analysis_eligible !== false)
        .filter((record) => reliableKeys.has(record.parcel_key))
        .filter((record) => useCategory(record) === state.dashboardUse)
        .filter((record) => buildingAreaBandMatches(record));
      const map = new Map();
      for (const record of rows) {
        if (!map.has(record.parcel_key)) {
          const base = data.buildingMonthlySeries.find((group) => group.parcel_key === record.parcel_key) || {};
          map.set(record.parcel_key, {
            parcel_key: record.parcel_key,
            parcel_label: record.parcel_label,
            parcel: record.parcel,
            road: record.road,
            building_name: record.building_name,
            building_name_status: record.building_name_status,
            is_masked_parcel: record.is_masked_parcel,
            monthly_graph_reliability_score: base.monthly_graph_reliability_score,
            monthly_graph_reliability_passed: base.monthly_graph_reliability_passed,
            rows: [],
          });
        }
        map.get(record.parcel_key).rows.push(record);
      }
      return [...map.values()].map((group) => {
        const byMonth = new Map();
        for (const record of group.rows) {
          if (!record.month) continue;
          if (!byMonth.has(record.month)) byMonth.set(record.month, []);
          byMonth.get(record.month).push(record);
        }
        return {
          ...group,
          transaction_count: group.rows.length,
          points: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, monthRows]) => ({
            month,
            count: monthRows.length,
            avg_price_manwon: averageClient(monthRows.map((row) => row.price_manwon)),
            median_price_manwon: medianClient(monthRows.map((row) => row.price_manwon)),
          })),
        };
      });
    }

    function filteredMonthlyGraphs() {
      const q = state.search;
      return buildingMonthlyGroupsForArea()
        .filter((group) => group.monthly_graph_reliability_passed === true)
        .filter((group) => group.transaction_count >= state.minCount)
        .filter((group) => state.mask === "all" || (state.mask === "exact" ? !group.is_masked_parcel : group.is_masked_parcel))
        .filter((group) => queryMatches(group, q, [group.parcel_label, group.building_name, group.road]))
        .sort((a, b) => {
          if (state.sortBy === "price") {
            const ap = a.points.at(-1)?.avg_price_manwon || 0;
            const bp = b.points.at(-1)?.avg_price_manwon || 0;
            return bp - ap;
          }
          if (state.sortBy === "change") return Math.abs(monthlyAmountChange(b) || 0) - Math.abs(monthlyAmountChange(a) || 0);
          return b.transaction_count - a.transaction_count;
        });
    }

    function renderMonthlyGraphs() {
      const groups = filteredMonthlyGraphs();
      const areaGroups = buildingMonthlyGroupsForArea();
      const reliableTotal = areaGroups.filter((group) => group.monthly_graph_reliability_passed === true).length;
      const hiddenTotal = data.buildingMonthlySeries.length - data.buildingMonthlySeries.filter((group) => group.monthly_graph_reliability_passed === true).length;
      document.getElementById("buildingMonthlyGraphCount").textContent = \`현재 표시 \${fmt.format(groups.length)}개 / 선택 평형 95% 이상 신뢰 그룹 \${fmt.format(reliableTotal)}개. 혼재·마스킹·건물명 미확인 등 \${fmt.format(hiddenTotal)}개 그룹은 월단위 그래프에서 숨겼습니다. 선은 월별 평균 거래금액, 옅은 막대는 월별 거래건수입니다.\`;
      document.getElementById("buildingMonthlyGraphGrid").innerHTML = groups.length ? groups.map((group) => {
        const change = monthlyAmountChange(group);
        const status = group.is_masked_parcel ? "미확정 보조그룹" : (group.building_name_status || "확인필요");
        const title = buildingTitle(group);
        return \`
          <article class="graph-card" data-parcel-key="\${escapeSvg(group.parcel_key)}">
            <h3>\${escapeSvg(title)}</h3>
            <div class="graph-meta">\${escapeSvg(group.parcel_label)} · \${escapeSvg(status)} · 신뢰 \${fmt.format(group.monthly_graph_reliability_score || 0)}점 · \${fmt.format(group.transaction_count)}건 · 월변동 \${pct(change)}</div>
            \${miniMonthlyAmountChart(group)}
          </article>
        \`;
      }).join("") : '<div class="data-note">현재 검색·필터 조건에서 95% 이상 신뢰 가능한 월단위 건물 그래프가 없습니다. 용도, 지번 상태, 최소 거래건수 조건을 낮춰도 혼재 그룹은 표시하지 않습니다.</div>';
    }

    function renderBuildingGraphs() {
      const groups = filteredBuildingGraphs();
      document.getElementById("buildingAreaBand").value = state.buildingAreaBand;
      document.getElementById("buildingAreaBandBadge").textContent = aggregateAreaBandLabel(state.buildingAreaBand);
      document.getElementById("buildingGraphCount").textContent = \`현재 표시 \${fmt.format(groups.length)}개 / 선택 평형 \${escapeSvg(aggregateAreaBandLabel(state.buildingAreaBand))}. 연도별 평균 그래프는 표본이 적어도 참고용으로 표시하며, 선은 연도별 평균 거래금액, 옅은 막대는 거래건수입니다.\`;
      document.getElementById("buildingGraphGrid").innerHTML = groups.map((group) => {
        const change = amountChange(group);
        const status = group.is_masked_parcel ? "미확정 보조그룹" : (group.building_name_status || "확인필요");
        const title = buildingTitle(group);
        return \`
          <article class="graph-card" data-parcel-key="\${escapeSvg(group.parcel_key)}">
            <h3>\${escapeSvg(title)}</h3>
            <div class="graph-meta">\${escapeSvg(group.parcel_label)} · \${escapeSvg(status)} · \${fmt.format(group.transaction_count)}건 · 변동 \${pct(change)}</div>
            \${miniAmountChart(group)}
          </article>
        \`;
      }).join("");
    }

    function renderBuildingAnalysisTable() {
      const rows = filteredBuildingAnalysis();
      const totalRows = buildBuildingYearMonthRows().length;
      document.getElementById("buildingAnalysisCount").textContent = \`현재 표시 \${fmt.format(rows.length)}개 / 전체 \${fmt.format(totalRows)}개. 단위는 건물 또는 지번 그룹 + 연도 + 월입니다. 연도 평균은 해당 건물의 같은 연도 전체 거래 평균, 월별 값은 해당 월 거래 평균입니다.\`;
      document.getElementById("buildingAnalysisTable").innerHTML = \`
        <thead><tr>
          <th>건물/지번</th><th>건물명</th><th>상태</th><th>연도</th><th>연도 거래건수</th><th>연도 평균거래금액</th><th>연도 평균 전용평당가</th><th>연도 평균 계약평당가</th><th>월</th><th>월 거래건수</th><th>월 평균거래금액</th><th>월 평균 전용평당가</th><th>월 평균 계약평당가</th><th>월-연도 금액차</th><th>월 거래층</th><th>월 용도</th>
        </tr></thead>
        <tbody>
        \${rows.length ? rows.map((row) => \`
          <tr class="clickable" data-parcel-key="\${escapeSvg(row.parcel_key)}">
            <td>\${escapeSvg(row.parcel_label)}</td>
            <td>\${escapeSvg(buildingTitle(row))}</td>
            <td><span class="badge">\${row.is_masked_parcel ? "마스킹" : escapeSvg(row.building_name_status || "확인필요")}</span></td>
            <td>\${row.year}</td>
            <td>\${fmt.format(row.year_transaction_count)}</td>
            <td>\${money(row.year_avg_price_manwon)}</td>
            <td>\${money(row.year_avg_exclusive_ppyeong_manwon)}</td>
            <td>\${Number.isFinite(row.year_avg_contract_ppyeong_manwon) ? money(row.year_avg_contract_ppyeong_manwon) : "계약면적 없음"}</td>
            <td>\${escapeSvg(row.month)}</td>
            <td>\${fmt.format(row.month_transaction_count)}</td>
            <td>\${money(row.month_avg_price_manwon)}</td>
            <td>\${money(row.month_avg_exclusive_ppyeong_manwon)}</td>
            <td>\${Number.isFinite(row.month_avg_contract_ppyeong_manwon) ? money(row.month_avg_contract_ppyeong_manwon) : "계약면적 없음"}</td>
            <td>\${pct(row.month_vs_year_price_pct)}</td>
            <td>\${escapeSvg(row.floors || "-")}</td>
            <td>\${escapeSvg(row.main_uses || "-")}</td>
          </tr>
        \`).join("") : '<tr><td colspan="16">현재 용도, 지번 상태, 최소 거래건수 조건에 맞는 연도·월 분석 행이 없습니다.</td></tr>'}
        </tbody>
      \`;
    }

    function renderGroupTable() {
      const groups = filteredGroups();
      document.getElementById("groupCount").textContent = \`현재 표시 \${fmt.format(groups.length)}개 / 전체 \${fmt.format(data.parcelGroups.length)}개. 정확 지번 \${fmt.format(data.metrics.exact_parcel_groups)}개, 미확정 보조그룹 \${fmt.format(data.metrics.masked_parcel_groups)}개, 건물명 확인 완료 \${fmt.format(data.metrics.building_name_enriched_groups)}개.\`;
      document.getElementById("groupTable").innerHTML = \`
        <thead><tr>
          <th>지번/보조그룹</th><th>건물명</th><th>건물명상태</th><th>상태</th><th>도로명</th><th>주용도</th><th>건수</th><th>관측연도</th><th>중위금액(만원)</th><th>전용평당가</th><th>공급평당가</th><th>계약평당가</th><th>단가변화</th>
        </tr></thead>
        <tbody>
        \${groups.map((group) => \`
          <tr class="clickable" data-parcel-key="\${escapeSvg(group.parcel_key)}">
            <td>\${escapeSvg(group.parcel_label)}</td>
            <td>\${escapeSvg(buildingTitle(group))}</td>
            <td><span class="badge">\${escapeSvg(group.building_name_status || "확인필요")}</span></td>
            <td><span class="badge">\${group.is_masked_parcel ? "마스킹" : "정확"}</span></td>
            <td>\${escapeSvg(group.road || "-")}</td>
            <td>\${escapeSvg(group.main_use || "-")}</td>
            <td>\${fmt.format(group.transaction_count)}</td>
            <td>\${group.observed_years.join(", ")}</td>
            <td>\${money(group.median_price_manwon)}</td>
            <td>\${money(group.median_exclusive_ppyeong_manwon)}</td>
            <td>\${Number.isFinite(group.median_supply_ppyeong_manwon) ? money(group.median_supply_ppyeong_manwon) : "공급면적 없음"}</td>
            <td>\${Number.isFinite(group.median_contract_ppyeong_manwon) ? money(group.median_contract_ppyeong_manwon) : "계약면적 없음"}</td>
            <td>\${pct(group.ppsqm_change_pct)}</td>
          </tr>
        \`).join("")}
        </tbody>
      \`;
      drawMoverChart(groups);
    }

    function renderTables() {
      syncUseControls();
      setKpis();
      drawYearChart();
      renderSourceTable();
      renderAggregateTrendBoard();
      renderRefinementBoard();
      renderPlainGuide();
      renderOfficeAreaBandTable();
      renderOfficeSameDayFloorTable();
      renderOfficeBandTrend();
      renderRetailFloorChartTable();
      renderDecisionBoards();
      renderUsageSplitBoard();
      renderPyeongMatrix();
      renderMonthlyGraphs();
      renderBuildingGraphs();
      renderBuildingAnalysisTable();
      renderGroupTable();
      renderBuildingDetail();
      markSelectedBuilding();
    }

    document.getElementById("search").addEventListener("input", (event) => {
      state.search = event.target.value;
      state.suggestionIndex = 0;
      renderTables();
      renderSearchSuggestions();
    });
    document.getElementById("search").addEventListener("keydown", (event) => {
      const ranked = rankedSearchResults();
      if (event.key === "ArrowDown" && ranked.length) {
        event.preventDefault();
        state.suggestionIndex = Math.min(state.suggestionIndex + 1, ranked.length - 1);
        renderSearchSuggestions();
        return;
      }
      if (event.key === "ArrowUp" && ranked.length) {
        event.preventDefault();
        state.suggestionIndex = Math.max(state.suggestionIndex - 1, 0);
        renderSearchSuggestions();
        return;
      }
      if (event.key === "Escape") {
        closeSearchSuggestions();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      state.search = event.target.value;
      renderTables();
      selectFirstSearchResult();
    });
    document.getElementById("maskFilter").addEventListener("change", (event) => { state.mask = event.target.value; renderTables(); });
    document.getElementById("minCount").addEventListener("input", (event) => { state.minCount = Number(event.target.value) || 1; renderTables(); });
    document.getElementById("sortBy").addEventListener("change", (event) => { state.sortBy = event.target.value; renderTables(); });
    document.getElementById("aggregatePeriod").addEventListener("change", (event) => { state.aggregatePeriod = event.target.value; renderAggregateTrendBoard(); renderPlainGuide(); });
    document.getElementById("aggregateYear").addEventListener("change", (event) => { state.aggregateYear = event.target.value; renderAggregateTrendBoard(); renderPlainGuide(); });
    document.getElementById("aggregateMonth").addEventListener("change", (event) => { state.aggregateMonth = event.target.value; renderAggregateTrendBoard(); renderPlainGuide(); });
    document.getElementById("aggregateUse").addEventListener("change", (event) => { state.aggregateUse = event.target.value; renderAggregateTrendBoard(); renderPlainGuide(); });
    document.getElementById("aggregateBasis").addEventListener("change", (event) => { state.aggregateBasis = event.target.value; renderAggregateTrendBoard(); renderPlainGuide(); });
    document.getElementById("aggregateAreaBand").addEventListener("change", (event) => { state.aggregateAreaBand = event.target.value; renderAggregateTrendBoard(); renderPlainGuide(); });
    document.getElementById("buildingAreaBand").addEventListener("change", (event) => { state.buildingAreaBand = event.target.value; renderTables(); });
    document.getElementById("pyeongGranularity").addEventListener("change", (event) => { state.pyeongGranularity = event.target.value; renderPyeongMatrix(); });
    document.getElementById("pyeongBasis").addEventListener("change", (event) => { state.pyeongBasis = event.target.value; renderPyeongMatrix(); });
    document.getElementById("pyeongUseFilter").addEventListener("change", (event) => { state.dashboardUse = event.target.value; state.pyeongUse = event.target.value; renderTables(); });
    document.getElementById("pyeongMonthWindow").addEventListener("change", (event) => { state.pyeongMonthWindow = event.target.value; renderPyeongMatrix(); });
    document.getElementById("pyeongMinCount").addEventListener("input", (event) => { state.pyeongMinCount = Number(event.target.value) || 1; renderPyeongMatrix(); });
    document.getElementById("pyeongSortBy").addEventListener("change", (event) => { state.pyeongSortBy = event.target.value; renderPyeongMatrix(); });
    document.getElementById("usageOfficeBand").addEventListener("change", (event) => { state.officeBand = event.target.value; renderOfficeBandTrend(); renderUsageSplitBoard(); });
    document.getElementById("usageOfficePeriod").addEventListener("change", (event) => { state.usageOfficePeriod = event.target.value; renderUsageSplitBoard(); });
    document.getElementById("usageOfficeSort").addEventListener("change", (event) => { state.usageOfficeSort = event.target.value; renderUsageSplitBoard(); });
    document.getElementById("usageRetailFloor").addEventListener("change", (event) => { state.usageRetailFloor = event.target.value; renderUsageSplitBoard(); });
    document.getElementById("usageRetailPeriod").addEventListener("change", (event) => { state.usageRetailPeriod = event.target.value; renderUsageSplitBoard(); });
    document.getElementById("usageRetailSort").addEventListener("change", (event) => { state.usageRetailSort = event.target.value; renderUsageSplitBoard(); });
    document.getElementById("valuationBasis").addEventListener("change", (event) => {
      state.valuationBasis = event.target.value;
      renderDecisionBoards();
    });
    document.getElementById("valuationUse").addEventListener("change", (event) => { state.dashboardUse = event.target.value; state.valuationUse = event.target.value; renderTables(); });
    document.getElementById("dashboardUseMode").addEventListener("click", (event) => {
      const button = event.target.closest("[data-dashboard-use]");
      if (!button) return;
      state.dashboardUse = button.dataset.dashboardUse;
      state.selectedParcelKey = "";
      renderTables();
    });
    document.getElementById("valuationPeriod").addEventListener("change", (event) => { state.valuationPeriod = event.target.value; renderDecisionBoards(); });
    document.addEventListener("click", (event) => {
      const commercialAction = event.target.closest("[data-commercial-action]");
      if (commercialAction) {
        const action = commercialAction.dataset.commercialAction;
        if (action === "copy-summary") copySelectedBuildingSummary();
        if (action === "download-csv") downloadSelectedBuildingCsv();
        if (action === "print") window.print();
        return;
      }
      const detailUse = event.target.closest("[data-detail-use]");
      if (detailUse) {
        state.selectedUseCategory = detailUse.dataset.detailUse;
        renderBuildingDetail();
        return;
      }
      const suggestion = event.target.closest("#searchSuggestions [data-parcel-key]");
      if (suggestion) {
        selectBuilding(suggestion.dataset.parcelKey);
        closeSearchSuggestions();
        return;
      }
      if (!event.target.closest(".search-field")) closeSearchSuggestions();
      const target = event.target.closest("[data-parcel-key]");
      if (!target) return;
      selectBuilding(target.dataset.parcelKey);
    });

    setupOfficeBandSelect();
    setValuationDefaultsFromSelected();
    renderTables();
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(docsDir, "20260608-magok-commercial-price-dashboard.html"), html, "utf8");

const prd = `# 마곡동 상업업무용 실거래 기준값 대시보드 PRD

## 1. Summary

마곡동 상업업무용 실거래 데이터를 중개인과 일반 투자자가 같은 기준으로 읽을 수 있게 만드는 로컬 HTML 대시보드다. 단순 평균표가 아니라 원천, 산식, 표본 신뢰도, 오피스/상가 분리 기준, 제외 규칙을 함께 보여준다.

## 2. Contacts

| 이름 | 역할 | 코멘트 |
|---|---|---|
| 사용자 | 의사결정자 | 마곡동 상업용 실거래 분석 기준과 참고자료 품질을 검토한다. |
| Codex | 분석/구현 | 공공데이터 API, 건축HUB 보강값, PRD, HTML 산출물을 관리한다. |
| 최종 사용자 | 중개인/투자자 | 기준값, 표본 신뢰도, 건물별 차이를 보고 후보를 판단한다. |

## 3. Background

### 왜 필요한가

- 현재 실거래 자료는 거래금액, 면적, 층, 용도가 섞여 있어 그대로 보면 기준값이 흔들린다.
- 중개인은 설명 가능한 기준값이 필요하고, 투자자는 건물별 프리미엄과 표본 신뢰도를 함께 봐야 한다.
- 국토부 실거래가 공개시스템은 참고용 자료이며 법적 효력이 없고, 신고정보는 변경·해제될 수 있다.
- 공공데이터포털 상업업무용 매매 실거래 API는 신고 자료를 법정동 코드와 계약년월로 조회하지만, 개인정보보호 때문에 일반건축물 지번이 일부만 제공될 수 있다.
- 한국부동산원 상업용부동산 통계도 오피스와 매장용 기준층을 다르게 본다. 오피스는 1~2층이 로비 또는 매장용일 수 있어 3층~최고층 기준을 쓰고, 매장용은 1층 기준을 쓴다.

### 리서치 근거

- 공공데이터포털 국토교통부_상업업무용 부동산 매매 실거래가 자료: https://www.data.go.kr/data/15126463/openapi.do
- 국토교통부 실거래가 공개시스템 조건별 자료제공 유의사항: https://rt.molit.go.kr/pt/xls/xls.do
- 한국부동산원 상업용부동산 임대동향조사: https://www.reb.or.kr/reb/cm/cntnts/cntntsView.do?cntntsId=1049&mi=10335&statId=S237220284

## 4. Objective

### 목적

중개인과 투자자가 같은 화면에서 기준값과 한계를 확인하고, 건물별 후보를 빠르게 좁힌다.

### Key Results

- KR1: 10년치 활성 거래 ${records.length.toLocaleString("ko-KR")}건을 계약일 기준으로 분석한다.
- KR2: 해제 거래 ${apiSource ? apiSource.canceled_rows.toLocaleString("ko-KR") : "0"}건은 평균·중위값 계산에서 제외한다.
- KR3: 정확 지번 ${payload.metrics.exact_parcel_groups.toLocaleString("ko-KR")}개와 미확정 보조그룹 ${payload.metrics.masked_parcel_groups.toLocaleString("ko-KR")}개를 구분한다.
- KR4: 계약면적 안전 매칭 ${payload.metrics.contract_area_matched_records.toLocaleString("ko-KR")}건만 계약평당가를 표시하고, 직접공용이 있는 거래는 공급면적 후보도 함께 표시한다.
- KR5: 사용자가 10분 안에 면적대, 월별 추세, 건물별 단가, 층별 차이를 검토할 수 있게 한다.
- KR6: 선택 건물 상담 요약, CSV 원장 다운로드, 인쇄/PDF CTA로 중개 상담 또는 투자 검토 자료화를 1분 안에 끝낸다.

## 5. Market Segments

### 공인중개사

- 고객에게 설명 가능한 기준값이 필요하다.
- 평균보다 중위값, 표본수, 층, 용도, 면적대 근거가 중요하다.

### 일반 투자자

- 건물별 가격 차이와 1층 상가 프리미엄을 빠르게 보고 싶다.
- 표본이 적은 값과 기준으로 써도 되는 값을 구분해야 한다.

### 내부 후보지 검토자

- 반복 수작업을 줄이고 후보 건물을 빠르게 추려야 한다.
- 인쇄/PDF로 근거자료를 남겨야 한다.

## 6. Value Propositions

- 기준값을 먼저 보여준다: 중위 전용평당가, 25~75% 범위, 표본수, 신뢰도 등급.
- 오피스와 상가를 분리한다: 업무시설은 면적대·건물별 기준, 근린생활/판매시설은 층별 기준.
- 건물별 프리미엄을 반영한다: 같은 면적대라도 건물마다 중위 단가와 표본수를 따로 보여준다.
- 데이터 한계를 숨기지 않는다: 마스킹 지번, 계약면적 미확인, 해제 거래 제외, 법적 효력 없음 문구를 화면에 고정한다.

## 7. Solution

### 7.1 UX

1. 건물명, 지번, 도로명 중 하나를 검색한다.
2. 선택 건물 상세에서 상담등급, 기준 평당가, 거래건수, 묶음거래 여부를 먼저 본다.
3. 월별 그래프와 개별 거래표로 층, 면적, 계약면적 근거를 확인한다.
4. 필요한 경우 시장 흐름 요약과 신뢰도 보드를 본다.
5. 업무시설 면적대, 상가 층별, 전체 지번표는 상세 표와 원자료 보기에서 필요할 때만 연다.
6. 상담 요약을 복사하거나 선택 건물 CSV 원장을 다운로드한다.
7. 인쇄/PDF로 저장한다.

### 7.2 Key Features

- 기준값 카드: 원천, 계약일 기준, 해제 거래 제외, 법적 효력 없음.
- 신뢰도 등급: A 기준, B 참고, C 보조, D 확인.
- 업무시설 면적대 분석: 10평 미만, 10평 이상~30평 미만, 30평 이상~50평 미만, 50평 이상~100평 미만, 100평 이상.
- 업무시설 시계열: 면적대 선택 후 연도별·월별 중위 전용평당가 차트.
- 업무시설 건물별 표: 같은 면적대 안의 건물별 중위 전용평당가, 25~75% 범위, 계약평당가, 표본수.
- 동일일자·동일층 묶음 거래: 같은 건물, 같은 계약일, 같은 층에서 2건 이상 거래된 호실을 하나의 묶음 계약처럼 합산해 총면적, 총거래금액, 묶음 전용/공급/계약평당가를 표시.
- 근린생활/상가 층별 차트: 건물별로 1층을 강조하고 상층과 비교한다.
- 공급평당가: 건축HUB 직접공용면적이 있는 거래만 전용+직접공용 기준으로 산출한다.
- 계약평당가: 건축HUB 전유+직접공용+각층/기타공용면적이 안전 매칭된 거래만 산출한다.
- 상용화 CTA: 선택 건물 상세에서 상담등급, 기준 평당가, 묶음거래 수를 요약하고 요약 복사, CSV 다운로드, 인쇄/PDF를 제공한다.

### 7.3 Data Standards

| 기준 | 정의 |
|---|---|
| 원천 | 국토교통부 공공데이터포털 상업업무용 부동산 매매 실거래가 API |
| 지역 | 서울특별시 강서구 마곡동 |
| 기간 | ${years.join(", ")}년, 계약일 기준 |
| 활성 거래 | 해제 거래 제외 ${records.length.toLocaleString("ko-KR")}건 |
| 기준 통계 | 중위값 우선, 평균은 참고 |
| 분산 표시 | 25~75% 전용평당가 범위 |
| 전용평당가 | 거래금액(만원) / (전용/연면적㎡ / 3.305785) |
| 공급평당가 | 거래금액(만원) / ((전용면적㎡ + 직접공용면적㎡) / 3.305785) |
| 계약평당가 | 거래금액(만원) / ((전용면적㎡ + 직접공용면적㎡ + 각층/기타공용면적㎡) / 3.305785) |
| 마스킹 지번 | 개별 건물값이 아닌 보조그룹값 |
| 업종 | API의 건축물주용도 기준 |

### 7.4 Reliability Rules

- A 기준: 정확 지번 또는 공식 표제부+단일 후보+층면적 매칭이 확인된 시장 기준값.
- B 참고: 공식 단일 후보이나 약식 매칭이거나 일부 보완점이 남은 참고 기준값.
- C 보조: 미확정 후보, 이상치 후보, 표본 부족 등으로 보조 확인이 필요한 값.
- D 확인: 표본 1~2건으로 개별 거래 확인이 먼저 필요한 값.

### 7.5 Assumptions

- 실거래 API의 건축물주용도는 실제 임차 업종이 아니라 공부상 주용도다.
- 마스킹 지번은 정확 건물 판단에 쓰지 않고 시장 보조값으로만 쓴다.
- 공급면적 후보는 전용+직접공용 기준이다. 직접공용이 없고 각층/기타공용만 있는 경우 공급면적 후보는 표시하지 않는다.
- 계약평당가는 건축물대장 전유공용면적 매칭이 안전한 거래에서만 의미가 있다.

## 8. Release

### 현재 버전

- 정적 HTML 대시보드.
- API 원자료 기반 10년치 집계.
- 건물명 보강, 계약면적 보강, 업무시설/상가 분리 분석.
- 기준값과 신뢰도 설명 포함.
- 선택 건물 상담 요약, CSV 다운로드, 인쇄/PDF CTA 포함.

### 다음 버전 후보

- 건물별 매매 사례 카드 자동 생성.
- 표본수 부족 건물 경고 필터.
- 공식통계 또는 임대료 자료와 비교하는 투자 참고 지표.
- PDF 보고서 자동 출력 레이아웃.

## 9. Validation

- 원자료 총건수, 해제 제외 건수, 연도 범위가 검증 스크립트와 일치해야 한다.
- HTML에 기준값, 신뢰도 등급, 법적 효력 없음, 계약일 기준, 해제 거래 제외 문구가 표시되어야 한다.
- 업무시설 면적대별 연도/월/건물 데이터가 존재해야 한다.
- 근린생활/상가 층별 차트에 1층 거래 여부가 표시되어야 한다.
- 선택 건물 상담 요약, CSV 다운로드, 요약 복사 CTA가 HTML에 표시되어야 한다.
- 스크립트 문법과 JSON 산출물이 파싱되어야 한다.
`;

fs.writeFileSync(path.join(docsDir, "20260608-magok-commercial-price-dashboard-prd.md"), prd, "utf8");

for (const [fileName, content] of Object.entries({
  "product_brief.json": {
    problem_statement: "마곡동 상업업무용 실거래 API의 지번 마스킹과 건물명 부재를 보정해 가격 변화 분석을 빠르게 한다.",
    user_goal: "최근 10년치 기준 지번별 거래가격 변화 대시보드를 HTML로 확인한다.",
    known_facts: payload.source,
    assumptions: ["공공데이터 API 승인 인증키는 로컬 .env.local에만 둔다.", "해제 거래는 평균/변동 분석에서 제외하는 것이 참고자료 정확도에 유리하다."],
    constraints: ["2017-2023 일부 지번은 공공데이터 정책상 마스킹되어 정확 지번 비교가 제한된다.", "API에는 건물명과 계약면적 컬럼이 없다."],
    revenue_goal: "분석 시간 절감, 후보 지번 선별 속도 개선, 오류 감소",
  },
  "user_flow.txt": [
    "1. HTML 대시보드를 연다.",
    "2. 검색창에 건물명, 지번, 도로명 중 하나를 입력하고 Enter를 누른다.",
    "3. 선택 건물 상세에서 상담등급, 기준 전용평당가, 계약평당가, 묶음거래 수를 먼저 확인한다.",
    "4. 월별 거래가격 그래프와 개별 거래내역으로 층, 면적, 계약면적 근거를 확인한다.",
    "5. 시장 전체 흐름과 신뢰도 보드는 필요할 때만 확인한다.",
    "6. 상세 표와 원자료 보기에서 업무시설 면적대, 상가 층별, 전체 지번표를 연다.",
    "7. 상담 요약을 복사하거나 선택 건물 CSV 원장을 다운로드한다.",
    "8. 필요하면 인쇄/PDF로 저장하거나 정확 지번 후보를 별도 검토한다.",
  ].join("\\\\n"),
  "schema.json": {
    record_fields: Object.keys(records[0] || {}),
    group_fields: Object.keys(groupSummaries[0] || {}),
    yearly_fields: Object.keys(yearly[0] || {}),
    building_amount_series_fields: Object.keys(buildingAmountSeries[0] || {}),
    office_area_band_summary_fields: Object.keys(officeAreaBandSummary[0] || {}),
    office_same_day_floor_summary_fields: Object.keys(officeSameDayFloorSummary[0] || {}),
    office_area_band_year_series_fields: Object.keys(officeAreaBandYearSeries[0] || {}),
    office_area_band_month_series_fields: Object.keys(officeAreaBandMonthSeries[0] || {}),
    office_area_band_building_summary_fields: Object.keys(officeAreaBandBuildingSummary[0] || {}),
    retail_building_floor_summary_fields: Object.keys(retailBuildingFloorSummary[0] || {}),
  },
  "api_contract.json": {
    type: "static-html-embedded-json",
    data_script_id: "dashboardData",
    filters: ["search", "maskFilter", "minCount", "sortBy", "officeBandSelect"],
    interactions: ["click building row or graph card to render monthly price drilldown", "copy selected-building consultation summary", "download selected-building CSV ledger", "select office area band to compare yearly, monthly, and building-level unit prices"],
    contract_area_basis: "official exclusive plus common area only when parcel, floor, and exclusive area match uniquely",
    output_files: ["data/processed/magok-commercial-transactions-dashboard.json", "docs/ai-output/20260608-magok-commercial-price-dashboard.html"],
  },
  "monetization.json": {
    revenue_goal: "내부 분석 시간 절감과 투자/영업 후보 선별 정확도 개선",
    expected_traffic: "월 4-12회 내부 검토",
    conversion_rate: "후보 검토 리드 전환 10-20%",
    average_order_value_or_arpu: "외부 매출형이 아니라 1회 분석 2시간 이상 절감",
    expected_revenue: "월 8-24시간 절감, 시간당 5만원 기준 월 40-120만원 가치",
    CAC_assumption: "추가 비용 0원, 승인된 공공데이터 API 사용",
    payback_assumption: "첫 분석 1회 사용으로 회수",
  },
  "cta_plan.json": {
    primary_cta: "건물 선택 후 상담등급과 기준 평당가를 확인하고 요약 복사 또는 CSV 다운로드로 상담 자료화",
    secondary_cta: "근린생활/상가는 건물별 1층과 상층 평당가 차이를 먼저 비교",
    review_cta: "정확 지번 건물별 월단위 거래가격과 동일일자·동일층 묶음 거래를 확인한 뒤 인쇄/PDF로 보관",
  },
})) {
  const body = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(path.join(docsDir, fileName), body, "utf8");
}

console.log(JSON.stringify({
  records: records.length,
  csvFiles: sourceFiles.length,
  years,
  missingYears,
  html: path.join(docsDir, "20260608-magok-commercial-price-dashboard.html"),
  data: path.join(dataDir, "magok-commercial-transactions-dashboard.json"),
}, null, 2));

