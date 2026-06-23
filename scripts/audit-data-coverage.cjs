// 마곡동 실거래 API/CSV 수집 범위와 마스킹으로 인한 건물 귀속 한계를 점검한다.
const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const root = path.resolve(__dirname, "..");
const decoder = new TextDecoder("windows-949");
const rawPath = path.join(root, "data", "processed", "api-commercial-monthly-raw.json");
const dashPath = path.join(root, "data", "processed", "magok-commercial-transactions-dashboard.json");
const outPath = path.join(root, "docs", "ai-output", "20260608-data-coverage-audit.md");

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

function csvSummaries() {
  return fs.readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith(".csv"))
    .sort()
    .map((file) => {
      const text = decoder.decode(fs.readFileSync(path.join(root, file)));
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      const headerIndex = lines.findIndex((line) => line.startsWith('"NO","시군구"'));
      if (headerIndex < 0) return { file, rows: 0, byYear: {}, exact: 0, masked: 0 };
      const headers = parseCsvLine(lines[headerIndex]);
      const byYear = {};
      let exact = 0;
      let masked = 0;
      let rows = 0;
      for (const line of lines.slice(headerIndex + 1)) {
        const values = parseCsvLine(line);
        if (values.length < headers.length || !values[0]) continue;
        const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
        rows += 1;
        const year = String(row["계약년월"] || "").slice(0, 4) || "unknown";
        byYear[year] = (byYear[year] || 0) + 1;
        const jibun = row["지번"] || "";
        if (!jibun || jibun.includes("*")) masked += 1;
        else exact += 1;
      }
      return { file, rows, byYear, exact, masked };
    });
}

function yearMonthRange(start, end) {
  const months = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(4, 6));
  const endYear = Number(end.slice(0, 4));
  const endMonth = Number(end.slice(4, 6));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return months;
}

function groupByYear(items) {
  const summary = {};
  for (const item of items) {
    const year = String(item.dealYear || item.source_month?.slice(0, 4));
    const masked = String(item.jibun || "").includes("*") || !item.jibun;
    const use = item.buildingUse || "용도없음";
    if (!summary[year]) summary[year] = { total: 0, exact: 0, masked: 0, office: 0, retail: 0, other: 0 };
    summary[year].total += 1;
    summary[year][masked ? "masked" : "exact"] += 1;
    if (use.includes("업무")) summary[year].office += 1;
    else if (/근린생활|판매/.test(use)) summary[year].retail += 1;
    else summary[year].other += 1;
  }
  return summary;
}

const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
const dash = JSON.parse(fs.readFileSync(dashPath, "utf8"));
const items = raw.items || [];
const activeItems = items.filter((item) => item.cdealType !== "O" && !item.cdealDay);
const months = yearMonthRange(raw.target.startMonth, raw.target.endMonth);
const monthlyCounts = {};
for (const item of items) monthlyCounts[item.source_month] = (monthlyCounts[item.source_month] || 0) + 1;
const zeroMonths = months.filter((month) => !monthlyCounts[month]);
const byYear = groupByYear(activeItems);
const csv = csvSummaries();
const mSignature = dash.records.filter((record) => record.parcel_key === "PARCEL|798-14");
const mSignatureExact = mSignature.filter((record) => !record.probable_parcel_key);
const mSignatureProbable = mSignature.filter((record) => record.probable_parcel_key);

const lines = [
  "# 마곡동 실거래 데이터 커버리지 점검",
  "",
  `- 생성시각: ${new Date().toISOString()}`,
  `- API 수집 대상: ${raw.target.startMonth}-${raw.target.endMonth} (${raw.target.monthCount}개월)`,
  `- API 원자료: ${items.length.toLocaleString("ko-KR")}건`,
  `- 해제 제외 활성 거래: ${activeItems.length.toLocaleString("ko-KR")}건`,
  `- 대시보드 원자료 표시 거래: ${dash.metrics.total_records.toLocaleString("ko-KR")}건`,
  `- 기준값 산식 반영 거래: ${(dash.metrics.analysis_records ?? dash.metrics.total_records).toLocaleString("ko-KR")}건`,
  `- 기준값 산식 제외 거래: ${(dash.metrics.analysis_excluded_records ?? 0).toLocaleString("ko-KR")}건`,
  `- 0건 월: ${zeroMonths.join(", ") || "없음"}`,
  "",
  "## 연도별 API 활성 거래",
  "",
  "|연도|전체|정확 지번|마스킹 지번|업무시설|상가(근린/판매)|기타|",
  "|---:|---:|---:|---:|---:|---:|---:|",
  ...Object.entries(byYear).sort(([a], [b]) => a.localeCompare(b)).map(([year, row]) =>
    `|${year}|${row.total}|${row.exact}|${row.masked}|${row.office}|${row.retail}|${row.other}|`),
  "",
  "## CSV 파일 대조",
  "",
  "|파일|행수|정확 지번|마스킹 지번|연도별 행수|",
  "|---|---:|---:|---:|---|",
  ...csv.map((row) => `|${row.file}|${row.rows}|${row.exact}|${row.masked}|${Object.entries(row.byYear).map(([year, count]) => `${year}:${count}`).join(", ")}|`),
  "",
  "## 판단",
  "",
  "- 저장된 API 원자료 기준으로 2017-01부터 2026-05까지 월별 거래는 들어와 있다. 2026-06은 현재 저장본 기준 0건이다.",
  "- 현재 대시보드의 2,832건은 마곡동 모든 부동산 실거래가 아니라 `상업업무용 매매` API의 해제 제외 활성 거래다.",
  `- 기준값 산식에는 지분거래, 대형/일괄거래 후보, 저단가 검토값을 제외한 ${(dash.metrics.analysis_records ?? dash.metrics.total_records).toLocaleString("ko-KR")}건만 사용한다.`,
  "- 오피스텔 매매, 공장/창고 매매, 토지 매매, 주거 매매는 승인된 보조 API 목록에는 있으나 현재 본 대시보드 산식에는 포함하지 않았다.",
  "- 2017-2023년 활성 거래는 전부 지번이 마스킹되어 정확 건물명으로 확정 귀속할 수 없다.",
  "- 2024년부터 대부분 정확 지번이 공개되어 건물명/도로명 보강과 상세 드릴다운이 가능하다.",
  "- 제2종근린생활, 제1종근린생활, 판매는 상가로 분류하고 업무시설과 분리해야 한다.",
  `- 마곡 M시그니처는 현재 상세 반영 ${mSignature.length}건이며, 정확 지번 ${mSignatureExact.length}건과 마스킹 지번 추정 ${mSignatureProbable.length}건으로 분리된다. 추정 거래는 마곡동 전체 전유공용면적 후보군에서 필지가 유일할 때만 붙인다. 업무시설 ${mSignature.filter((row) => String(row.main_use || "").includes("업무")).length}건, 상가 ${mSignature.filter((row) => /근린생활|판매/.test(String(row.main_use || ""))).length}건이다.`,
  "",
  "## 다음 조치",
  "",
  "- API 키가 제공되면 `PUBLIC_DATA_SERVICE_KEY`로 최신 원자료를 재호출해 현재 저장본과 월별 diff를 낼 수 있다.",
  "- 다만 2017-2023 마스킹 지번을 특정 건물로 자동 확정하는 것은 공식 원자료만으로는 위험하다. 건축년도, 전용면적, 층, 용도 기반 후보가 마곡동 전체 후보군에서 유일한 경우만 `추정`으로 별도 표시한다.",
];

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ ok: true, outPath, zeroMonths, activeRows: activeItems.length }, null, 2));
