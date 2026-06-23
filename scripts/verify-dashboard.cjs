// 마곡동 실거래 대시보드 산출물이 최소 품질 조건을 만족하는지 검증한다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "processed", "magok-commercial-transactions-dashboard.json");
const htmlPath = path.join(root, "docs", "ai-output", "20260608-magok-commercial-price-dashboard.html");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(fs.existsSync(dataPath), "processed dashboard JSON is missing");
assert(fs.existsSync(htmlPath), "dashboard HTML is missing");

const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const html = fs.readFileSync(htmlPath, "utf8");

function normalizeSearch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/엠/g, "m")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesSearch(row, term) {
  const query = normalizeSearch(term);
  const compactQuery = query.replace(/\s+/g, "");
  const haystack = normalizeSearch([row.search_text, row.parcel_label, row.parcel, row.building_name, row.road, row.main_use, row.zoning].filter(Boolean).join(" "));
  return haystack.includes(query) || haystack.replace(/\s+/g, "").includes(compactQuery);
}

assert(data.metrics.total_records === 2832, `expected 2832 active API records, got ${data.metrics.total_records}`);
assert(data.metrics.analysis_records === 2365, `expected 2365 analysis-eligible records after outlier/share/bulk/candidate-set filtering, got ${data.metrics.analysis_records}`);
assert(data.metrics.analysis_excluded_records === 467, `expected 467 records excluded from benchmark calculations, got ${data.metrics.analysis_excluded_records}`);
assert(data.metrics.share_dealing_excluded_records === 112, `expected 112 share-dealing records excluded from benchmark calculations, got ${data.metrics.share_dealing_excluded_records}`);
assert(data.metrics.bulk_deal_excluded_records === 85, `expected 85 same-day bulk-building candidate records excluded from benchmark calculations, got ${data.metrics.bulk_deal_excluded_records}`);
assert(data.metrics.candidate_set_excluded_records === 258, `expected 258 candidate-set records excluded from benchmark calculations, got ${data.metrics.candidate_set_excluded_records}`);
assert(data.source.mode === "public-api", "dashboard should use public API source mode");
assert(data.source.api.raw_rows === 2985, `expected 2985 raw API records, got ${data.source.api.raw_rows}`);
assert(data.source.api.canceled_rows === 153, `expected 153 canceled API records, got ${data.source.api.canceled_rows}`);
assert(data.source.files.length === 7, `expected 7 source CSV files, got ${data.source.files.length}`);
assert(JSON.stringify(data.source.available_years) === JSON.stringify([2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]), "available years mismatch");
assert(JSON.stringify(data.source.missing_years) === JSON.stringify([]), "missing years warning mismatch");
assert(data.metrics.masked_parcel_records === 0, "unresolved masked parcel warning should be cleared");
assert(data.metrics.exact_parcel_records > 0, "exact parcel records should remain present");
assert(data.metrics.official_masked_matched_records === 1887, `expected 1887 official masked matches including candidate-grade area-only/tolerance/contract-area/all-usage/title-area/share/candidate-set matches, got ${data.metrics.official_masked_matched_records}`);
assert(data.metrics.official_candidate_set_records === 258, `expected 258 official candidate-set records, got ${data.metrics.official_candidate_set_records}`);
assert(data.metrics.recovery_masked_matched_records === 238, `expected 238 price-continuity recovery matches, got ${data.metrics.recovery_masked_matched_records}`);
assert(data.metrics.unresolved_high_confidence_masked_records === 0, "high-confidence masked candidates should be fully attached");
assert(data.records.filter((record) => record.building_name_status === "확인됨").length === 2541, "official-title-confirmed building matches should be represented separately");
assert(data.records.filter((record) => record.refinement_promotion).length === 1515, "official-title single-candidate matches should promote eligible C-grade records");
assert(data.parcel_groups.length > 100, "parcel group aggregation looks too small");
assert(data.year_summary.length === 10, "year summary should include 10 collected years");
assert(data.records.every((record) => Object.hasOwn(record, "building_name")), "building_name field should be present on every record");
assert(data.records.every((record) => Object.hasOwn(record, "building_name_status")), "building_name_status field should be present on every record");
assert(data.records.every((record) => Object.hasOwn(record, "official_title_confirmed")), "official title confirmation field should be present on every record");
assert(data.records.every((record) => Object.hasOwn(record, "official_single_candidate_match")), "official single candidate field should be present on every record");
assert(data.records.every((record) => Object.hasOwn(record, "masked_match_stage")), "masked match stage field should be present on every record");
assert(data.records.every((record) => Object.hasOwn(record, "exclusive_ppyeong_manwon")), "exclusive pyeong price field should be present on every record");
assert(data.records.every((record) => Object.hasOwn(record, "supply_ppyeong_manwon")), "supply pyeong price field should be present on every record");
assert(data.records.every((record) => Object.hasOwn(record, "analysis_eligible")), "analysis eligibility should be present on every record");
assert(data.records.every((record) => Object.hasOwn(record, "analysis_exclusion_reasons")), "analysis exclusion reasons should be present on every record");
assert(data.records.some((record) => record.analysis_eligible === false && (record.analysis_exclusion_reasons || []).includes("지분거래")), "share-dealing records should be explicitly excluded from benchmark calculations");
assert(data.records.some((record) => record.analysis_eligible === false && (record.analysis_exclusion_reasons || []).includes("저단가 검토")), "very-low-price records should be explicitly excluded from benchmark calculations");
assert(data.records.some((record) => record.analysis_eligible === false && (record.analysis_exclusion_reasons || []).includes("일괄/통건물 거래 후보")), "same-day bulk-building candidate records should be explicitly excluded from benchmark calculations");
assert(data.records.every((record) => !String(record.parcel_key || "").startsWith("CANDIDATE_SET|") || (record.analysis_eligible === false && (record.analysis_exclusion_reasons || []).includes("복수 후보필지"))), "candidate-set rows should be preserved as raw evidence but excluded from benchmark calculations");
assert(data.parcel_groups.every((group) => !String(group.parcel_key || "").startsWith("CANDIDATE_SET|")), "candidate-set rows should not become building benchmark groups");
const markersRows = data.records.filter((record) => record.building_name === "마커스빌딩");
assert(markersRows.length === 14, `expected 14 Markers Building split records, got ${markersRows.length}`);
assert(markersRows.every((record) => record.analysis_eligible === false && record.bulk_deal_candidate), "Markers Building split records should be excluded as one same-day bulk-building candidate");
assert(data.records.every((record) => record.analysis_eligible === false || !Number.isFinite(record.exclusive_ppyeong_manwon) || record.exclusive_ppyeong_manwon >= 900), "analysis-eligible records should not include sub-900 exclusive pyeong outliers");
assert(data.parcel_groups.every((group) => Object.hasOwn(group, "median_exclusive_ppyeong_manwon")), "exclusive pyeong price should be aggregated");
assert(data.parcel_groups.every((group) => Object.hasOwn(group, "median_supply_ppyeong_manwon")), "supply pyeong price should be aggregated");
assert(data.parcel_groups.every((group) => Object.hasOwn(group, "median_contract_ppyeong_manwon")), "contract pyeong price should be represented even when unavailable");
assert(data.metrics.building_name_enriched_groups >= 10, `expected at least 10 enriched building groups, got ${data.metrics.building_name_enriched_groups}`);
const realExactGroups = data.parcel_groups.filter((group) => String(group.parcel_key || "").startsWith("PARCEL|"));
assert(data.metrics.building_name_enriched_groups === realExactGroups.filter((group) => group.building_name_status === "확인됨").length, "confirmed exact parcel groups should be counted separately from candidate/probable groups");
assert(realExactGroups.filter((group) => group.building_name === "확인필요").length < realExactGroups.length / 3, "most exact parcel groups should carry an enriched building name");
assert(realExactGroups.filter((group) => group.road).length >= 50, "exact parcel groups should carry road-name addresses where available");
assert(data.parcel_groups.some((group) => matchesSearch(group, "퀸즈파크나인")), "building-name search should find Queens Park Nine");
assert(data.parcel_groups.some((group) => matchesSearch(group, "공항대로247")), "road-name search should ignore spacing and find 공항대로 247");
assert(data.parcel_groups.some((group) => matchesSearch(group, "797-1")), "jibun search should find parcel 797-1");
assert(data.parcel_groups.some((group) => matchesSearch(group, "마곡중앙6로21")), "road-name search should find 마곡중앙6로 21");
assert(data.parcel_groups.some((group) => group.building_name === "마곡 M시그니처" && matchesSearch(group, "엠시그니처")), "fuzzy building-name search should match 엠시그니처 to 마곡 M시그니처");
const mSignatureRows = data.records.filter((record) => record.parcel_key === "PARCEL|798-14");
assert(mSignatureRows.length >= 9, `expected at least 9 M signature records including probable masked matches, got ${mSignatureRows.length}`);
assert(mSignatureRows.filter((record) => !record.probable_parcel_key).length === 4, "M signature exact-parcel records should stay separate");
assert(mSignatureRows.filter((record) => record.probable_parcel_key).length >= 5, "M signature probable masked records should pass full-candidate uniqueness before attachment");
assert(mSignatureRows.filter((record) => record.official_masked_match_key).length >= 14, "M signature official masked matches should be attached from the general official matching analysis");
assert(mSignatureRows.filter((record) => String(record.main_use || "").includes("업무")).length >= 7, "M signature office records should include exact and probable masked matches");
assert(mSignatureRows.filter((record) => /근린생활|판매/.test(String(record.main_use || ""))).length >= 2, "M signature retail records should stay represented");
assert(mSignatureRows.some((record) => record.floor === "6" && record.area_sqm === 49.45 && record.contract_area_sqm === 112.8), "M signature 6F 49.45m2 exclusive should have 112.80m2 contract area");
assert(mSignatureRows.some((record) => record.floor === "9" && record.area_sqm === 49.45 && record.contract_area_sqm === 112.8 && record.probable_parcel_key), "M signature probable 9F 49.45m2 masked record should be attached");
assert(data.records.every((record) => !Number.isFinite(record.contract_area_sqm) || !Number.isFinite(record.area_sqm) || record.contract_area_sqm + 0.001 >= record.area_sqm), "contract area should never be smaller than exclusive area");
assert(data.records.every((record) => !Number.isFinite(record.contract_area_sqm) || !Number.isFinite(record.area_sqm) || record.area_sqm <= 0 || (record.contract_area_sqm / record.area_sqm >= 1 && record.contract_area_sqm / record.area_sqm <= 5)), "contract/exclusive area ratio should stay within a sane commercial-building range");
const embeddedPayload = JSON.parse(html.match(/<script id="dashboardData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const embeddedMSignatureSixFloor = embeddedPayload.records.filter((record) => record.parcel_key === "PARCEL|798-14" && record.month === "2025-03" && record.contract_day === 25 && record.floor === "6");
assert(embeddedMSignatureSixFloor.some((record) => record.area_sqm === 49.45 && record.contract_area_sqm === 112.8), "embedded dashboard should render M signature 6F 49.45m2 as 112.80m2 contract area");
assert(data.metrics.contract_area_matched_records === 1679, `expected 1679 contract-area matched records including full-candidate probable M signature records, got ${data.metrics.contract_area_matched_records}`);
assert(data.source.contract_area_match.metrics.matched_records === 1739, "strict contract area match source metrics mismatch");
assert(data.source.contract_area_match.metrics.rough_matched_records === 16, "rough contract area match source metrics mismatch");
assert(data.source.contract_area_match.metrics.total_matched_records === 1755, "total contract area match source metrics mismatch");
assert(data.methodology && data.methodology.version === "2026-06-08-researched-prd", "researched methodology should be embedded");
assert(Array.isArray(data.methodology.official_references) && data.methodology.official_references.length === 3, "official methodology references should be present");
assert(data.parcel_groups.some((group) => Number.isFinite(group.median_contract_ppyeong_manwon)), "at least one parcel group should have contract pyeong price");
assert(data.records.some((record) => Number.isFinite(record.supply_area_sqm)), "at least one record should have a supply-area candidate");
assert(data.records.some((record) => Number.isFinite(record.direct_common_area_sqm)), "direct common area should be represented");
assert(data.records.some((record) => Number.isFinite(record.shared_common_area_sqm)), "shared/common area should be represented");
assert(Array.isArray(data.building_floor_use_summary), "building floor/use summary should exist");
assert(data.building_floor_use_summary.length > 500, "building floor/use summary looks too small");
assert(Array.isArray(data.office_area_band_summary), "office area-band summary should exist");
assert(data.office_area_band_summary.length >= 4, "office area-band summary should include multiple bands");
assert(data.office_area_band_summary.some((row) => row.same_day_floor_group_count > 0), "office same-day floor samples should be counted");
assert(data.office_area_band_summary.every((row) => Object.hasOwn(row, "reliability")), "office area-band reliability should exist");
assert(data.office_area_band_summary.every((row) => Object.hasOwn(row, "p25_exclusive_ppyeong_manwon")), "office area-band lower quartile should exist");
assert(data.office_area_band_summary.every((row) => Object.hasOwn(row, "p75_exclusive_ppyeong_manwon")), "office area-band upper quartile should exist");
assert(Array.isArray(data.office_same_day_floor_summary), "office same-day floor summary should exist");
assert(data.office_same_day_floor_summary.some((row) => row.transaction_count >= 2 && Number.isFinite(row.total_price_manwon) && Number.isFinite(row.total_exclusive_pyeong)), "office same-day floor bundles should sum price and exclusive area");
assert(data.office_same_day_floor_summary.every((row) => Object.hasOwn(row, "area_bands")), "office same-day floor bundles should include area-band composition");
assert(data.office_same_day_floor_summary.every((row) => Object.hasOwn(row, "bundle_exclusive_ppyeong_manwon")), "office same-day floor bundles should include bundle exclusive pyeong price");
assert(data.office_same_day_floor_summary.every((row) => Object.hasOwn(row, "bundle_supply_ppyeong_manwon")), "office same-day floor bundles should include bundle supply pyeong price");
assert(data.office_same_day_floor_summary.every((row) => Object.hasOwn(row, "bundle_contract_ppyeong_manwon")), "office same-day floor bundles should include bundle contract pyeong price");
assert(Array.isArray(data.office_area_band_year_series), "office area-band year series should exist");
assert(data.office_area_band_year_series.length >= 20, "office area-band year series looks too small");
assert(Array.isArray(data.office_area_band_month_series), "office area-band month series should exist");
assert(data.office_area_band_month_series.length >= 100, "office area-band month series looks too small");
assert(Array.isArray(data.office_area_band_building_summary), "office area-band building summary should exist");
assert(data.office_area_band_building_summary.length >= 50, "office area-band building summary looks too small");
assert(Array.isArray(data.retail_building_floor_summary), "retail building floor summary should exist");
assert(data.retail_building_floor_summary.length > 10, "retail building floor summary looks too small");
assert(data.retail_building_floor_summary.some((row) => row.first_floor_transaction_count > 0), "retail summary should identify first-floor transactions");
assert(Array.isArray(data.building_amount_series), "building amount series should exist");
assert(data.building_amount_series.length === data.parcel_groups.length, "every parcel group should have a building amount series");
assert(Array.isArray(data.building_monthly_series), "building monthly series should exist");
assert(data.building_monthly_series.length === data.parcel_groups.length, "every parcel group should have a monthly series");
assert(Array.isArray(JSON.parse(html.match(/<script id="dashboardData" type="application\/json">([\s\S]*?)<\/script>/)[1]).records), "embedded records should exist for building drilldown");
assert(Array.isArray(data.source.available_months) && data.source.available_months.length > 110, "monthly coverage should be present");
assert(data.building_floor_use_summary.every((row) => Object.hasOwn(row, "floor")), "floor should be present in building analysis");
assert(data.building_floor_use_summary.every((row) => Object.hasOwn(row, "business_type")), "business type should be present in building analysis");
assert(data.building_floor_use_summary.every((row) => Object.hasOwn(row, "avg_price_manwon")), "average transaction amount should be present");

for (const marker of [
  "dashboardData",
  "마곡동 상가·업무시설 실거래 찾기",
  "consumerHero",
  "MAGOK COMMERCIAL PRICE GUIDE",
  "건물명만 입력하면",
  "실거래 흐름이 바로 보입니다",
  "건물 검색하기",
  "선택 결과 보기",
  "magok-commercial-hero.png",
  "먼저 건물을 검색하고, 선택 건물 요약만 보면 됩니다",
  "1. 검색",
  "2. 요약",
  "3. 근거",
  "4. 저장",
  "상세 표와 원자료 보기",
  "userDetailAnalysisPack",
  "최근 10년 2017-2026년 마곡동 상업업무용 매매",
  "조회 기간",
  "해제·복수후보·지분·일괄거래 후보",
  "건물명",
  "건물명상태",
  "퀸즈파크나인",
  "두산더랜드타워",
  "데이터 안내",
  "현재 표시",
  "건물별로 연도·월 가격이 어떻게 달랐나",
  "연도 평균거래금액",
  "월 평균거래금액",
  "월 평균 전용평당가",
  "월-연도 금액차",
  "건물별 연도 흐름 비교",
  "건물 비교 전에 평형부터 고르기",
  "buildingAreaBand",
  "buildingAreaBandBadge",
  "선택 평형",
  "신뢰 가능한 월별 건물 흐름만 보기",
  "95% 이상 신뢰 그룹",
  "monthly_graph_reliability_passed",
  "monthly_graph_reliability_score",
  "건물을 선택하면 요약이 나옵니다",
  "묶음면적대",
  "bundle_area_band",
  "마곡동 전체 흐름",
  "가격 흐름",
  "정제 기준",
  "비교 축",
  "plainGuideBoard",
  "plainGuideCards",
  "마곡동 가격 흐름은 어느 방향인가",
  "이 숫자는 얼마나 믿을 만한가",
  "dataRefinementBoard",
  "refinementSummary",
  "IQR 이상치 후보",
  "A/B 정제 기준",
  "aggregateTrendSection",
  "aggregateStoryCards",
  "secondaryDashboardPack",
  "전문가용 세부 분석 열기",
  "aggregatePeriod",
  "aggregateYear",
  "aggregateMonth",
  "aggregateUse",
  "aggregateBasis",
  "aggregateAreaBand",
  "평형별",
  "10평 미만",
  "100평 이상 거래",
  "aggregateTrendChart",
  "aggregateTrendTable",
  "renderAggregateOptions",
  "aggregateDisplayPeriod",
  "aggregateExpectedPeriods",
  "aggregatePeriodLabel",
  "연도 선택",
  "월 선택",
  "전체 연도",
  "전체 월",
  "renderAggregateTrendBoard",
  "drawAggregateTrendChart",
  "aggregateRows",
  "10년 평당가 변화 현황",
  "valuationDashboardSection",
  "valuationTrendChart",
  "valuationBasis",
  "valuationUse",
  "valuationPeriod",
  "renderValuationDashboard",
  "drawValuationTrendChart",
  "가격 입력 없음",
  "최근 중위",
  "10년 변화",
  "최근 3년 변화",
  "최고 관측",
  "최저 관측",
  "표본수",
  "마곡동 전체 시장",
  "검색 후 표시",
  "analysis_eligible",
  "analysis_excluded_records",
  "share_dealing_excluded_records",
  "상업업무용 매매",
  "평균/추이에서 제외",
  "기준값 반영",
  "지분거래",
  "저단가 검토",
  "특정 건물을 추천",
  "먼저 건물을 검색하고, 선택 건물 요약만 보면 됩니다",
  "건물·연도·월별 변화 보드",
  "trendBoardSection",
  "trendBoardChart",
  "trendMonthHeatmap",
  "월별 변화 히트맵",
  "renderTrendBoard",
  "drawTrendBoardChart",
  "trendMonthMatrixRows",
  "건물 변화 해석",
  "업무시설·근린생활시설 판독판",
  "업무시설 보기",
  "상가 보기",
  "dashboardUseMode",
  "dashboardUseRecords",
  "dashboardUseParcelKeys",
  "yearSummaryForDashboardUse",
  "usageSplitBoardSection",
  "usageOfficeBand",
  "usageOfficePeriod",
  "usageOfficeTrendTable",
  "usageOfficeTable",
  "usageRetailFloor",
  "usageRetailPeriod",
  "usageRetailTrendTable",
  "usageRetailTable",
  "추이 단위",
  "연도별 평당가",
  "월별 평당가",
  "renderUsageSplitBoard",
  "renderUsageTrendTable",
  "buildUsageTrendRows",
  "floorBucket",
  "근린생활시설 층별 기준값",
  "업무시설 기준값",
  "전체 업무 거래건물",
  "현재 표시 건물",
  "마곡동 전체 평당가 매트릭스",
  "년도별 · 건물별",
  "pyeongDashboardSection",
  "pyeongGranularity",
  "pyeongBasis",
  "pyeongUseFilter",
  "pyeongMonthWindow",
  "pyeongMinCount",
  "pyeongSortBy",
  "pyeongHeatmap",
  "pyeongTable",
  "pyeongSummary",
  "renderPyeongMatrix",
  "buildPyeongMatrix",
  "전용/공급/계약 기준",
  "최근 36개월",
  "최근 60개월",
  "전체 월",
  "detailMonthlyChart",
  "detailTransactionTable",
  "building-result-shell",
  "building-profile-card",
  "building-result-grid",
  "buildingSearchCrumb",
  "현재 매물 vs 실거래 비교",
  "층별 평균 거래가",
  "면적별 평균 평당가",
  "detailCommercialSummary",
  "commercialActionStatus",
  "요약 복사",
  "CSV 다운로드",
  "상담등급",
  "A 상담기준",
  "selectedBuildingSummaryText",
  "selectedBuildingCsv",
  "downloadSelectedBuildingCsv",
  "호실 후보",
  "호실검증",
  "전용면적 오차㎡",
  "호실 후보검증",
  "roomValidationLabel",
  "roomCandidateText",
  "선택 건물 동일일자·동일층 묶음 거래",
  "detailSameDayBundleTable",
  "detailBundleMeta",
  "data-parcel-key",
  "미확정 보조그룹",
  "미확인 건",
  "건물명 확인필요",
  "buildingMonthlyGraphGrid",
  "buildingGraphGrid",
  "평균거래금액",
  "월 용도",
  "전용평당가",
  "계약평당가",
  "공급평당가",
  "계약면적 매칭",
  "계약㎡",
  "공급㎡ 후보",
  "직접공용㎡",
  "각층/기타공용㎡",
  "면적근거",
  "추정",
  "중위 계약평당가",
  "중위 공급평당가",
  "계약면적 없음",
  "공급면적 없음",
  "분석 기준값과 신뢰도",
  "A 기준",
  "B 참고",
  "C 보조",
  "D 확인",
  "법적 효력",
  "계약일 기준",
  "25~75% 전용평당가",
  "업무시설 면적대별 평당가",
  "officeAreaBandTable",
  "업무시설 동일일자·동일층 묶음 거래",
  "묶음건수",
  "합산 전용평",
  "총거래금액",
  "묶음 전용평당가",
  "officeSameDayFloorTable",
  "업무시설 면적대별 연도/월/건물 차이",
  "officeBandSelect",
  "officeBandYearChart",
  "officeBandMonthChart",
  "officeBandBuildingTable",
  "근린생활/상가 건물별 층별 금액 차트",
  "retailFloorChartTable",
  "1층 중위 전용평당가",
  "층별 전용평당가 차트",
  "지번별 가격 변화 테이블",
  "건물 검색",
  "퀸즈파크나인",
  "공항대로 247",
  "queryMatches",
  "searchSuggestions",
  "scoreSearchResult",
  "rankedSearchResults",
  "ArrowDown",
  "selectFirstSearchResult",
  "detailUseTabs",
  "data-detail-use",
  "정확 지번 공개 관측",
  "업무시설",
  "상가",
  "keydown",
  "event.key !== \"Enter\"",
  "인쇄/PDF",
]) {
  assert(html.includes(marker), `HTML marker missing: ${marker}`);
}

assert(!html.includes("target=\"_blank\""), "building names should not open external pages; clicks should drive dashboard drilldown");
for (const forbidden of [
  "valuationIntent",
  "valuationPrice",
  "valuationArea",
  "valuationDecision",
  "거래금액(만원)<input",
  "판단 목적",
  "시장 대비 차이",
  "가격 위치",
  ">내 가격",
  "내 가격선",
  "비싸다",
  "싸다",
]) {
  assert(!html.includes(forbidden), `Removed valuation judgment marker still present: ${forbidden}`);
}

console.log(JSON.stringify({
  ok: true,
  records: data.metrics.total_records,
  sourceFiles: data.source.files.length,
  years: data.source.available_years,
  missingYears: data.source.missing_years,
  htmlBytes: Buffer.byteLength(html),
}, null, 2));
