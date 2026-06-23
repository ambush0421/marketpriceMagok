// 마스킹 실거래를 공식 데이터 후보군으로 얼마나 좁힐 수 있는지 분석합니다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data", "processed");
const rawPath = path.join(dataDir, "api-commercial-monthly-raw.json");
const areaPath = path.join(dataDir, "building-hub-area-results.json");
const titlePath = path.join(dataDir, "building-hub-title-results.json");
const irosPath = path.join(dataDir, "iros-openapi-results.json");
const outPath = path.join(dataDir, "masked-official-matching-analysis.json");
const docPath = path.join(root, "docs", "ai-output", "20260608-masked-years-official-matching-strategy.md");

function toNumber(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function signedFloor(item) {
  const floorNo = Math.abs(toNumber(item.flrNo) || 0);
  const floorName = String(item.flrGbCdNm || "");
  const floorCode = String(item.flrGbCd || "");
  return floorName.includes("지하") || floorCode === "10" ? -floorNo : floorNo;
}

function usageCategory(value) {
  const text = String(value || "");
  if (/교육연구/.test(text)) return "교육연구";
  if (/숙박/.test(text)) return "숙박";
  if (/근린생활|판매|소매|음식점|휴게|의원|학원|미용|체력단련|노래연습/.test(text)) return "상가";
  if (/업무|사무|오피스텔/.test(text)) return "업무";
  return "기타";
}

function roomUsageCategories(value) {
  const text = String(value || "");
  const categories = new Set([usageCategory(text)]);
  if (/학원/.test(text)) categories.add("교육연구");
  return [...categories];
}

function isExclusive(item) {
  const code = String(item.exposPubuseGbCd || "").trim();
  const name = String(item.exposPubuseGbCdNm || "").trim();
  return code === "1" || code === "01" || name.includes("전유");
}

function normArea(value) {
  const area = toNumber(value);
  return Number.isFinite(area) ? area.toFixed(2) : "";
}

function addIndex(map, key, room) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(room);
}

function buildParcelMeta(raw) {
  const meta = new Map();
  for (const item of raw.items || []) {
    const parcel = String(item.jibun || "");
    if (!parcel || parcel.includes("*")) continue;
    if (!meta.has(parcel)) meta.set(parcel, { buildYears: new Set(), exactTradeCount: 0 });
    const row = meta.get(parcel);
    if (item.buildYear) row.buildYears.add(String(item.buildYear));
    row.exactTradeCount += 1;
  }
  return meta;
}

function buildTitleMeta() {
  if (!fs.existsSync(titlePath)) return new Map();
  const data = JSON.parse(fs.readFileSync(titlePath, "utf8"));
  const meta = new Map();
  for (const result of data.results || []) {
    meta.set(result.parcel, {
      building_name: (result.names || [])[0] || "",
      road: result.road || "",
      title_items: result.title_items || [],
    });
  }
  return meta;
}

function buildRoomIndex(parcelMeta, titleMeta) {
  const data = JSON.parse(fs.readFileSync(areaPath, "utf8"));
  const results = Array.isArray(data.results) ? data.results : [];
  const exactIndex = new Map();
  const floorlessIndex = new Map();
  const allRooms = [];
  const contractUnits = [];
  const titleAreas = [];

  for (const [parcel, meta] of titleMeta.entries()) {
    const years = parcelMeta.get(parcel)?.buildYears || new Set();
    for (const item of meta.title_items || []) {
      const totalArea = toNumber(item.total_area_sqm);
      if (!Number.isFinite(totalArea) || totalArea <= 0) continue;
      const categories = roomUsageCategories(`${item.main_use || ""} ${item.etc_use || ""}`);
      titleAreas.push({
        parcel,
        building_name: item.building_name || meta.building_name || "",
        road: item.road || meta.road || "",
        floor: null,
        area_sqm: totalArea,
        usage_category: categories[0],
        usage_categories: categories,
        unit: "표제부",
        build_years: [...new Set([...(item.approval_year ? [String(item.approval_year)] : []), ...years])],
      });
    }
  }

  for (const result of results) {
    const parcel = result.parcel;
    const meta = titleMeta.get(parcel) || {};
    const years = parcelMeta.get(parcel)?.buildYears || new Set();
    const unitGroups = groupBy(result.items || [], (item) => String(item.mgmBldrgstPk || "").trim());
    for (const item of result.items || []) {
      if (!isExclusive(item)) continue;
      const area = normArea(item.area);
      if (!area) continue;
      const categories = roomUsageCategories(`${item.mainPurpsCdNm || ""} ${item.etcPurps || ""}`);
      const floor = signedFloor(item);
      const room = {
        parcel,
        building_name: item.bldNm || meta.building_name || "",
        road: item.newPlatPlc || meta.road || "",
        floor,
        area_sqm: toNumber(item.area),
        usage_category: categories[0],
        usage_categories: categories,
        unit: String(item.hoNm || "").trim(),
        build_years: [...years],
      };
      allRooms.push(room);
      for (const category of categories) {
        addIndex(exactIndex, `${category}|${floor}|${area}`, room);
        addIndex(floorlessIndex, `${category}|${area}`, room);
      }
    }
    for (const groupItems of unitGroups.values()) {
      const exclusive = groupItems.find(isExclusive);
      if (!exclusive) continue;
      const exclusiveArea = toNumber(exclusive.area);
      if (!Number.isFinite(exclusiveArea)) continue;
      const totalArea = groupItems.reduce((sum, groupItem) => {
        const areaValue = toNumber(groupItem.area);
        return Number.isFinite(areaValue) ? sum + areaValue : sum;
      }, 0);
      if (!Number.isFinite(totalArea) || totalArea <= 0) continue;
      const categories = roomUsageCategories(`${exclusive.mainPurpsCdNm || ""} ${exclusive.etcPurps || ""}`);
      contractUnits.push({
        parcel,
        building_name: exclusive.bldNm || meta.building_name || "",
        road: exclusive.newPlatPlc || meta.road || "",
        floor: signedFloor(exclusive),
        area_sqm: totalArea,
        exclusive_area_sqm: exclusiveArea,
        common_area_sqm: totalArea - exclusiveArea,
        usage_category: categories[0],
        usage_categories: categories,
        unit: String(exclusive.hoNm || "").trim(),
        build_years: [...years],
      });
    }
  }

  return { exactIndex, floorlessIndex, allRooms, contractUnits, titleAreas };
}

function uniqueParcels(candidates) {
  return [...new Set(candidates.map((candidate) => candidate.parcel))];
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

function filterByMaskedParcelPrefix(candidates, maskedJibun) {
  const prefix = String(maskedJibun || "").split("*")[0];
  if (!prefix) return candidates;
  const filtered = candidates.filter((candidate) => String(candidate.parcel || "").startsWith(prefix));
  return filtered.length ? filtered : candidates;
}

function rawMaskedKey(item) {
  return [
    item.source_month || `${item.dealYear || ""}${String(item.dealMonth || "").padStart(2, "0")}`,
    String(item.jibun || ""),
    String(item.buildingUse || ""),
    String(item.floor || ""),
    normArea(item.buildingAr),
    String(item.buildYear || ""),
    String(toNumber(item.dealAmount) ?? ""),
    String(item.dealDay || "").padStart(2, "0"),
  ].join("|");
}

function buildDealBundleTitleCandidates(maskedItems, indexes) {
  const bundles = groupBy(maskedItems, (item) => [
    item.source_month || `${item.dealYear || ""}${String(item.dealMonth || "").padStart(2, "0")}`,
    String(item.dealYear || ""),
    String(item.dealMonth || ""),
    String(item.dealDay || ""),
    String(item.jibun || ""),
  ].join("|"));
  const map = new Map();
  for (const items of bundles.values()) {
    if (items.length < 3) continue;
    const totalArea = items.reduce((sum, item) => {
      const area = toNumber(item.buildingAr);
      return Number.isFinite(area) ? sum + area : sum;
    }, 0);
    if (!Number.isFinite(totalArea) || totalArea <= 0) continue;
    const candidates = filterByMaskedParcelPrefix(indexes.titleAreas.filter((candidate) => (
      Math.abs(candidate.area_sqm - totalArea) <= Math.max(1, totalArea * 0.002)
    )), items[0].jibun);
    const parcels = uniqueParcels(candidates);
    if (parcels.length !== 1) continue;
    for (const item of items) {
      map.set(rawMaskedKey(item), {
        stage: "all_usage_deal_bundle_title_total_area_tolerance_002pct",
        candidates,
      });
    }
  }
  return map;
}

function findCandidates(item, indexes) {
  const category = usageCategory(item.buildingUse);
  const area = normArea(item.buildingAr);
  const floorText = String(item.floor || "").trim();
  const floor = floorText ? Number(floorText) : null;
  const hasFloor = Number.isFinite(floor);
  if (!area || !category) {
    return { stage: "insufficient", candidates: [] };
  }

  const buildYear = String(item.buildYear || "");
  if (hasFloor) {
    const exact = filterByMaskedParcelPrefix(indexes.exactIndex.get(`${category}|${floor}|${area}`) || [], item.jibun);
    const yearFiltered = buildYear
      ? exact.filter((candidate) => !candidate.build_years.length || candidate.build_years.includes(buildYear))
      : exact;
    if (yearFiltered.length) return { stage: "usage_floor_area_year", candidates: yearFiltered };
    if (exact.length) return { stage: "usage_floor_area", candidates: exact };
  }

  const floorless = filterByMaskedParcelPrefix(indexes.floorlessIndex.get(`${category}|${area}`) || [], item.jibun);
  if (floorless.length) return { stage: "usage_area_only", candidates: floorless };

  const nearby = filterByMaskedParcelPrefix(indexes.allRooms.filter((room) => {
    if (!(room.usage_categories || [room.usage_category]).includes(category)) return false;
    if (hasFloor && room.floor !== floor) return false;
    return Math.abs(room.area_sqm - Number(area)) <= 0.05;
  }), item.jibun);
  if (nearby.length) {
    return {
      stage: hasFloor ? "usage_floor_area_tolerance_005" : "usage_area_tolerance_005",
      candidates: nearby,
    };
  }

  const widerNearby = filterByMaskedParcelPrefix(indexes.allRooms.filter((room) => {
    if (!(room.usage_categories || [room.usage_category]).includes(category)) return false;
    if (hasFloor && room.floor !== floor) return false;
    return Math.abs(room.area_sqm - Number(area)) <= 0.1;
  }), item.jibun);
  if (widerNearby.length) {
    return {
      stage: hasFloor ? "usage_floor_area_tolerance_010" : "usage_area_tolerance_010",
      candidates: widerNearby,
    };
  }

  const sumGroups = groupBy(indexes.allRooms.filter((room) => {
    if (!(room.usage_categories || [room.usage_category]).includes(category)) return false;
    if (hasFloor && room.floor !== floor) return false;
    return true;
  }), (room) => hasFloor ? `${room.parcel}|${room.floor}` : room.parcel);
  const sumCandidates = [];
  for (const rooms of sumGroups.values()) {
    const sumArea = rooms.reduce((sum, room) => sum + room.area_sqm, 0);
    if (Math.abs(sumArea - Number(area)) > Math.max(0.5, Number(area) * 0.005)) continue;
    const first = rooms[0];
    sumCandidates.push({
      parcel: first.parcel,
      building_name: first.building_name,
      road: first.road,
      floor: first.floor,
      area_sqm: sumArea,
      usage_category: first.usage_category,
      usage_categories: first.usage_categories,
      unit: rooms.map((room) => room.unit).filter(Boolean).slice(0, 5).join("+"),
      build_years: first.build_years,
    });
  }
  const filteredSumCandidates = filterByMaskedParcelPrefix(sumCandidates, item.jibun);
  if (filteredSumCandidates.length) {
    return {
      stage: hasFloor ? "usage_floor_area_sum_tolerance_050" : "usage_area_sum_tolerance_050",
      candidates: filteredSumCandidates,
    };
  }

  const allUsageSumGroups = groupBy(indexes.allRooms.filter((room) => {
    if (hasFloor && room.floor !== floor) return false;
    return true;
  }), (room) => hasFloor ? `${room.parcel}|${room.floor}` : room.parcel);
  const allUsageSumCandidates = [];
  for (const rooms of allUsageSumGroups.values()) {
    const sumArea = rooms.reduce((sum, room) => sum + room.area_sqm, 0);
    if (Math.abs(sumArea - Number(area)) > Math.max(0.5, Number(area) * 0.005)) continue;
    const first = rooms[0];
    allUsageSumCandidates.push({
      parcel: first.parcel,
      building_name: first.building_name,
      road: first.road,
      floor: first.floor,
      area_sqm: sumArea,
      usage_category: first.usage_category,
      usage_categories: first.usage_categories,
      unit: rooms.map((room) => room.unit).filter(Boolean).slice(0, 5).join("+"),
      build_years: first.build_years,
    });
  }
  const filteredAllUsageSumCandidates = filterByMaskedParcelPrefix(allUsageSumCandidates, item.jibun);
  if (filteredAllUsageSumCandidates.length) {
    return {
      stage: hasFloor ? "all_usage_floor_area_sum_tolerance_005pct" : "all_usage_area_sum_tolerance_005pct",
      candidates: filteredAllUsageSumCandidates,
    };
  }

  const contractAreaCandidates = filterByMaskedParcelPrefix(indexes.contractUnits.filter((unit) => {
    if (!(unit.usage_categories || [unit.usage_category]).includes(category)) return false;
    if (hasFloor && unit.floor !== floor) return false;
    return Math.abs(unit.area_sqm - Number(area)) <= 0.05;
  }), item.jibun);
  if (contractAreaCandidates.length) {
    return {
      stage: hasFloor ? "usage_floor_contract_area_tolerance_005" : "usage_contract_area_tolerance_005",
      candidates: contractAreaCandidates,
    };
  }

  if (String(item.shareDealingType || "").includes("지분") && hasFloor) {
    const halfShareCandidates = filterByMaskedParcelPrefix(indexes.allRooms.filter((room) => {
      if (!(room.usage_categories || [room.usage_category]).includes(category)) return false;
      if (room.floor !== floor) return false;
      return Math.abs(room.area_sqm - (Number(area) * 2)) <= 0.05;
    }), item.jibun);
    if (halfShareCandidates.length) {
      return {
        stage: "usage_floor_half_share_area_tolerance_005",
        candidates: halfShareCandidates,
      };
    }
  }

  const allUsageNearby = filterByMaskedParcelPrefix(indexes.allRooms.filter((room) => {
    if (hasFloor && room.floor !== floor) return false;
    return Math.abs(room.area_sqm - Number(area)) <= 0.05;
  }), item.jibun);
  if (allUsageNearby.length) {
    return {
      stage: hasFloor ? "all_usage_floor_area_tolerance_005" : "all_usage_area_tolerance_005",
      candidates: allUsageNearby,
    };
  }

  const titleAreaTolerance = Math.max(1, Number(area) * 0.001);
  const titleAreaCandidates = filterByMaskedParcelPrefix(indexes.titleAreas.filter((candidate) => {
    if (!(candidate.usage_categories || [candidate.usage_category]).includes(category)) return false;
    return Math.abs(candidate.area_sqm - Number(area)) <= titleAreaTolerance;
  }), item.jibun);
  if (titleAreaCandidates.length) {
    return {
      stage: "usage_title_total_area_tolerance_001pct",
      candidates: titleAreaCandidates,
    };
  }

  const allUsageTitleAreaCandidates = filterByMaskedParcelPrefix(indexes.titleAreas.filter((candidate) => (
    Math.abs(candidate.area_sqm - Number(area)) <= titleAreaTolerance
  )), item.jibun);
  if (allUsageTitleAreaCandidates.length) {
    return {
      stage: "all_usage_title_total_area_tolerance_001pct",
      candidates: allUsageTitleAreaCandidates,
    };
  }
  const widerTitleAreaTolerance = Math.max(1, Number(area) * 0.002);
  const widerAllUsageTitleAreaCandidates = filterByMaskedParcelPrefix(indexes.titleAreas.filter((candidate) => (
    Math.abs(candidate.area_sqm - Number(area)) <= widerTitleAreaTolerance
  )), item.jibun);
  if (widerAllUsageTitleAreaCandidates.length) {
    return {
      stage: "all_usage_title_total_area_tolerance_002pct",
      candidates: widerAllUsageTitleAreaCandidates,
    };
  }
  return {
    stage: hasFloor ? "usage_floor_area_tolerance_010" : "usage_area_tolerance_010",
    candidates: [],
  };
}

function irosSummary() {
  if (!fs.existsSync(irosPath)) return { row_count: 0, exact_parcels: [] };
  const data = JSON.parse(fs.readFileSync(irosPath, "utf8"));
  const parcels = uniqueParcels((data.items || []).map((item) => ({ parcel: item.lot_no })));
  return {
    mode: data.mode,
    row_count: data.row_count || 0,
    exact_parcels: parcels.filter(Boolean),
    note: data.mode === "plan-only" ? "현재 등기소 전체 수집은 계획 단계이며, 최근 3년 확정 보강은 실행 후 반영한다." : "",
  };
}

function main() {
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  const parcelMeta = buildParcelMeta(raw);
  const titleMeta = buildTitleMeta();
  const indexes = buildRoomIndex(parcelMeta, titleMeta);
  const maxCollectedYear = Math.max(
    2023,
    ...(raw.items || []).map((item) => Number(item.dealYear)).filter(Number.isFinite)
  );
  const maskedItems = (raw.items || []).filter((item) => {
    const year = Number(item.dealYear);
    return year >= 2017
      && year <= maxCollectedYear
      && String(item.umdNm || "") === "마곡동"
      && String(item.jibun || "").includes("*")
      && item.cdealType !== "O"
      && !item.cdealDay;
  });
  const bundleCandidateMap = buildDealBundleTitleCandidates(maskedItems, indexes);

  const rows = maskedItems.map((item) => {
    let match = findCandidates(item, indexes);
    if (!match.candidates.length) {
      match = bundleCandidateMap.get(rawMaskedKey(item)) || match;
    }
    const parcels = uniqueParcels(match.candidates);
    return {
      source_month: item.source_month,
      deal_date: `${item.dealYear}-${String(item.dealMonth || "").padStart(2, "0")}-${String(item.dealDay || "").padStart(2, "0")}`,
      masked_jibun: item.jibun || "",
      use: item.buildingUse || "",
      usage_category: usageCategory(item.buildingUse),
      floor: item.floor || "",
      area_sqm: toNumber(item.buildingAr),
      build_year: item.buildYear || "",
      deal_amount_manwon: toNumber(item.dealAmount),
      stage: match.stage,
      candidate_room_count: match.candidates.length,
      candidate_parcel_count: parcels.length,
      candidate_parcels: parcels,
      unique_parcel: parcels.length === 1 ? parcels[0] : "",
      sample_candidates: match.candidates.slice(0, 5).map((candidate) => ({
        parcel: candidate.parcel,
        building_name: candidate.building_name,
        road: candidate.road,
        unit: candidate.unit,
      })),
    };
  });

  const summary = {
    generated_at: new Date().toISOString(),
    target: `2017-${maxCollectedYear} 마곡동 마스킹 상업업무용 활성 거래`,
    total_masked_rows: rows.length,
    unique_parcel_rows: rows.filter((row) => row.unique_parcel).length,
    ambiguous_rows: rows.filter((row) => !row.unique_parcel && row.candidate_parcel_count > 1).length,
    no_candidate_rows: rows.filter((row) => row.candidate_parcel_count === 0).length,
    by_stage: Object.fromEntries([...rows.reduce((map, row) => map.set(row.stage, (map.get(row.stage) || 0) + 1), new Map()).entries()].sort()),
    unique_by_stage: Object.fromEntries([...rows.filter((row) => row.unique_parcel).reduce((map, row) => map.set(row.stage, (map.get(row.stage) || 0) + 1), new Map()).entries()].sort()),
    high_confidence_unique_rows: rows.filter((row) => row.unique_parcel && ["usage_floor_area_year", "usage_floor_area"].includes(row.stage)).length,
    low_confidence_area_only_unique_rows: rows.filter((row) => row.unique_parcel && row.stage === "usage_area_only").length,
    by_year: Object.fromEntries([...rows.reduce((map, row) => {
      const year = row.deal_date.slice(0, 4);
      if (!map.has(year)) map.set(year, { total: 0, unique: 0, ambiguous: 0, none: 0 });
      const bucket = map.get(year);
      bucket.total += 1;
      if (row.unique_parcel) bucket.unique += 1;
      else if (row.candidate_parcel_count > 1) bucket.ambiguous += 1;
      else bucket.none += 1;
      return map;
    }, new Map()).entries()].sort()),
    iros: irosSummary(),
  };

  const result = { summary, rows };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

  const lines = [
    `# 2017-${maxCollectedYear} 마스킹 연도 공식 데이터 매칭 전략`,
    "",
    "## 결론",
    "",
    `등기소 API는 최근 3년 제한이 있으므로 2017-${maxCollectedYear} 전체 거래의 지번을 직접 복원하는 공식 API는 현재 확인되지 않았다. 최선은 국토부 실거래 원자료의 마스킹 행을 건축HUB 전유부 후보군에 대조하고, 최근 3년 등기소 확정값으로 규칙을 검증하는 방식이다.`,
    "",
    "## 공식 데이터별 역할",
    "",
    "|데이터|역할|한계|",
    "|---|---|---|",
    "|국토부 상업업무용 실거래 API|계약연월일, 거래금액, 층, 전용/연면적, 주용도, 건축년도, 마스킹 지번 확보|상업업무용은 건물명/도로명 없이 지번이 마스킹될 수 있음|",
    "|건축HUB 전유부/건축물대장|필지별 건물명, 도로명, 층, 호, 전유면적, 용도 후보군 확보|거래 사실은 없음|",
    "|등기정보광장 집합건물 실거래가|최근 3년 지번, 건물명, 층, 면적, 거래가액 확정 대조|최근 3년 제한과 일 10회 호출 제한|",
    "",
    "## 현재 로컬 분석 결과",
    "",
    `- 분석 대상: ${summary.total_masked_rows.toLocaleString("ko-KR")}건`,
    `- 공식 후보군 유일 필지: ${summary.unique_parcel_rows.toLocaleString("ko-KR")}건`,
    `- 대시보드 자동 귀속 후보(용도+층+전용면적 기반): ${summary.high_confidence_unique_rows.toLocaleString("ko-KR")}건`,
    `- 보조 후보(층 없음, 용도+전용면적만): ${summary.low_confidence_area_only_unique_rows.toLocaleString("ko-KR")}건`,
    `- 복수 후보: ${summary.ambiguous_rows.toLocaleString("ko-KR")}건`,
    `- 후보 없음/정보 부족: ${summary.no_candidate_rows.toLocaleString("ko-KR")}건`,
    "",
    "## 적용 규칙",
    "",
    "1. `용도분류 + 층 + 전용면적`이 일치하는 건축HUB 전유부 후보를 찾는다.",
    "2. 2024년 이후 정확 지번 실거래에서 확인된 필지별 건축년도가 있으면 같은 건축년도 후보를 우선한다.",
    "3. 후보 필지가 1개이고 층 정보가 있으면 `추정`으로 붙인다.",
    "4. 층이 없는 `용도+전용면적` 단독 유일 후보는 보조 후보로만 남기고 자동 상세 귀속하지 않는다.",
    "5. 후보 필지가 여러 개면 건물 상세에 붙이지 않고 `마스킹 보조그룹`으로 둔다.",
    "6. 등기소 최근 3년 수집이 완료되면 같은 면적/층/금액대 패턴을 검증 신호로 추가한다.",
    "7. 등기소 또는 등기부 원문으로 확인된 거래만 `확정`으로 올린다.",
    "",
    "## 다음 코드 작업",
    "",
    "- 현재 대시보드의 M시그니처 전용 추정 로직을 이 일반 후보 분석기로 확장한다.",
    "- 단, `unique_parcel_rows`만 상세에 붙이고 나머지는 계속 보조그룹으로 남긴다.",
    "- 등기소 API 일별 제한이 풀리면 `magok-all` 분기별 수집 결과를 이 분석기에 병합한다.",
  ];
  fs.writeFileSync(docPath, `${lines.join("\n")}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    outPath: path.relative(root, outPath),
    docPath: path.relative(root, docPath),
    summary,
  }, null, 2));
}

main();
