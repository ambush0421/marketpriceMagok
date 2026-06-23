// 마곡동 실거래 총량 의심을 검증하기 위해 유형별 공공데이터 API 카운트를 대조한다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data", "processed");
const outJsonPath = path.join(dataDir, "broader-transaction-coverage.json");
const outMdPath = path.join(root, "docs", "ai-output", "20260609-broader-transaction-coverage.md");

function readEnvFile() {
  const envPath = path.join(root, ".env.local");
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const localEnv = readEnvFile();
const serviceKey = process.env.PUBLIC_DATA_SERVICE_KEY || localEnv.PUBLIC_DATA_SERVICE_KEY || "";
const lawdCd = process.env.LAWD_CD || localEnv.LAWD_CD || "11500";
const targetDong = process.env.TARGET_DONG || localEnv.TARGET_DONG || "마곡동";
const startMonth = process.env.START_MONTH || localEnv.START_MONTH || "201701";
const endMonth = process.env.END_MONTH || localEnv.END_MONTH || new Date().toISOString().slice(0, 7).replace("-", "");

const services = [
  {
    id: "commercial",
    label: "상업업무용 매매",
    transactionKind: "매매",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade",
    includeInBusinessTotal: true,
    includeInAllSaleTotal: true,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "officetel",
    label: "오피스텔 매매",
    transactionKind: "매매",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade",
    includeInBusinessTotal: true,
    includeInAllSaleTotal: true,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "officetelRent",
    label: "오피스텔 전월세",
    transactionKind: "전월세",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent",
    includeInBusinessTotal: true,
    includeInAllSaleTotal: false,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "industrial",
    label: "공장/창고 등 매매",
    transactionKind: "매매",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcInduTrade/getRTMSDataSvcInduTrade",
    includeInBusinessTotal: true,
    includeInAllSaleTotal: true,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "land",
    label: "토지 매매",
    transactionKind: "매매",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade",
    includeInBusinessTotal: false,
    includeInAllSaleTotal: true,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "apartment",
    label: "아파트 매매",
    transactionKind: "매매",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade",
    includeInBusinessTotal: false,
    includeInAllSaleTotal: true,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "apartmentRent",
    label: "아파트 전월세",
    transactionKind: "전월세",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent",
    includeInBusinessTotal: false,
    includeInAllSaleTotal: false,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "rowhouse",
    label: "연립다세대 매매",
    transactionKind: "매매",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade",
    includeInBusinessTotal: false,
    includeInAllSaleTotal: true,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "rowhouseRent",
    label: "연립다세대 전월세",
    transactionKind: "전월세",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcRHRent/getRTMSDataSvcRHRent",
    includeInBusinessTotal: false,
    includeInAllSaleTotal: false,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "detached",
    label: "단독/다가구 매매",
    transactionKind: "매매",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade",
    includeInBusinessTotal: false,
    includeInAllSaleTotal: true,
    includeInBrokerageVisibleTotal: true,
  },
  {
    id: "detachedRent",
    label: "단독/다가구 전월세",
    transactionKind: "전월세",
    endpoint: "https://apis.data.go.kr/1613000/RTMSDataSvcSHRent/getRTMSDataSvcSHRent",
    includeInBusinessTotal: false,
    includeInAllSaleTotal: false,
    includeInBrokerageVisibleTotal: true,
  },
];

function monthRange(start, end) {
  const months = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(4, 6));
  const endYear = Number(end.slice(0, 4));
  const endMonthNum = Number(end.slice(4, 6));
  while (year < endYear || (year === endYear && month <= endMonthNum)) {
    months.push(`${year}${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return months;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function firstTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1]).trim() : "";
}

function parseItems(xml) {
  const items = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const itemXml = match[1];
    const item = {};
    for (const field of itemXml.matchAll(/<([^/?][^>]*)>([\s\S]*?)<\/\1>/g)) {
      item[field[1]] = decodeXml(field[2]).trim();
    }
    items.push(item);
  }
  return items;
}

function matchesTargetDong(item) {
  const values = Object.values(item).map((value) => String(value || ""));
  return values.some((value) => value.includes(targetDong));
}

function isCanceled(item) {
  return String(item.cdealType || item.cdealDay || item.해제사유발생일 || "").trim() !== "";
}

function yearOf(item, month) {
  return String(item.dealYear || item.년 || item.DEAL_YEAR || month.slice(0, 4));
}

async function fetchPage(service, month, pageNo) {
  const url = new URL(service.endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("LAWD_CD", lawdCd);
  url.searchParams.set("DEAL_YMD", month);
  url.searchParams.set("numOfRows", "1000");
  url.searchParams.set("pageNo", String(pageNo));
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  const resultCode = firstTag(text, "resultCode");
  const resultMsg = firstTag(text, "resultMsg");
  if (resultCode && !["00", "000"].includes(resultCode)) throw new Error(`${resultCode} ${resultMsg}`.trim());
  return {
    totalCount: Number(firstTag(text, "totalCount")) || 0,
    items: parseItems(text),
  };
}

async function fetchService(service, months) {
  const rows = [];
  const errors = [];
  const monthly = {};
  let pagesFetched = 0;
  for (const month of months) {
    try {
      const first = await fetchPage(service, month, 1);
      pagesFetched += 1;
      const pageCount = Math.max(1, Math.ceil(first.totalCount / 1000));
      let pageItems = first.items;
      for (let page = 2; page <= pageCount; page += 1) {
        const next = await fetchPage(service, month, page);
        pagesFetched += 1;
        pageItems = pageItems.concat(next.items);
      }
      const targetItems = pageItems.filter(matchesTargetDong).map((item) => ({ source_month: month, ...item }));
      monthly[month] = targetItems.length;
      rows.push(...targetItems);
      if (targetItems.length > 0) console.log(`${service.label} ${month}: ${targetItems.length}`);
    } catch (error) {
      errors.push({ month, error: error.message });
      monthly[month] = null;
      console.error(`${service.label} ${month}: ${error.message}`);
    }
  }

  const activeRows = rows.filter((item) => !isCanceled(item));
  const byYear = {};
  const activeByYear = {};
  for (const item of rows) byYear[yearOf(item, item.source_month)] = (byYear[yearOf(item, item.source_month)] || 0) + 1;
  for (const item of activeRows) activeByYear[yearOf(item, item.source_month)] = (activeByYear[yearOf(item, item.source_month)] || 0) + 1;
  return {
    id: service.id,
    label: service.label,
    transactionKind: service.transactionKind,
    endpoint: service.endpoint.replace(serviceKey, "[SERVICE_KEY]"),
    includeInBusinessTotal: service.includeInBusinessTotal,
    includeInAllSaleTotal: service.includeInAllSaleTotal,
    includeInBrokerageVisibleTotal: service.includeInBrokerageVisibleTotal,
    rowCount: rows.length,
    activeRowCount: activeRows.length,
    canceledRowCount: rows.length - activeRows.length,
    byYear,
    activeByYear,
    monthly,
    errors,
    pagesFetched,
  };
}

async function main() {
  const months = monthRange(startMonth, endMonth);
  const result = {
    generated_at: new Date().toISOString(),
    credential_present: Boolean(serviceKey),
    credential_policy: "PUBLIC_DATA_SERVICE_KEY is read from environment or .env.local and never written to output.",
    target: { lawdCd, targetDong, startMonth, endMonth, monthCount: months.length },
    services: [],
    totals: {},
  };

  if (!serviceKey) {
    result.mode = "blocked";
    result.next_action = "Set PUBLIC_DATA_SERVICE_KEY in environment or .env.local";
  } else {
    result.mode = "fetched";
    for (const service of services) {
      console.log(`${service.label} 수집 시작`);
      result.services.push(await fetchService(service, months));
      console.log(`${service.label} 수집 완료`);
    }
    result.totals.businessActive = result.services
      .filter((service) => service.includeInBusinessTotal)
      .reduce((sum, service) => sum + service.activeRowCount, 0);
    result.totals.allSaleActive = result.services
      .filter((service) => service.includeInAllSaleTotal)
      .reduce((sum, service) => sum + service.activeRowCount, 0);
    result.totals.rentActive = result.services
      .filter((service) => service.transactionKind === "전월세")
      .reduce((sum, service) => sum + service.activeRowCount, 0);
    result.totals.brokerageVisibleActive = result.services
      .filter((service) => service.includeInBrokerageVisibleTotal)
      .reduce((sum, service) => sum + service.activeRowCount, 0);
    result.totals.errorCount = result.services.reduce((sum, service) => sum + service.errors.length, 0);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outJsonPath, JSON.stringify(result, null, 2), "utf8");

  const lines = [
    "# 마곡동 유형별 실거래 신고량 대조",
    "",
    `- 생성시각: ${result.generated_at}`,
    `- 대상: ${targetDong}, 법정동코드 앞 5자리 ${lawdCd}`,
    `- 기간: ${startMonth}-${endMonth} (${months.length}개월)`,
    `- 실행상태: ${result.mode}`,
    "",
    "## 요약",
    "",
    result.mode === "fetched"
      ? `- 업무/수익형 후보 합계(상업업무용+오피스텔+공장/창고): ${result.totals.businessActive.toLocaleString("ko-KR")}건`
      : `- ${result.next_action}`,
    result.mode === "fetched"
      ? `- 전체 매매 후보 합계(위 항목+토지+주거 매매): ${result.totals.allSaleActive.toLocaleString("ko-KR")}건`
      : "",
    result.mode === "fetched"
      ? `- 전월세 신고 후보 합계(오피스텔+주거 전월세): ${result.totals.rentActive.toLocaleString("ko-KR")}건`
      : "",
    result.mode === "fetched"
      ? `- 중개업소 체감 신고 후보 합계(매매+주거/오피스텔 전월세): ${result.totals.brokerageVisibleActive.toLocaleString("ko-KR")}건`
      : "",
    result.mode === "fetched"
      ? `- API 오류 월 수: ${result.totals.errorCount.toLocaleString("ko-KR")}건`
      : "",
    "",
    "## 유형별 건수",
    "",
    "|유형|구분|활성거래|해제/취소|원자료|오류월|",
    "|---|---|---:|---:|---:|---:|",
    ...result.services.map((service) =>
      `|${service.label}|${service.transactionKind}|${service.activeRowCount.toLocaleString("ko-KR")}|${service.canceledRowCount.toLocaleString("ko-KR")}|${service.rowCount.toLocaleString("ko-KR")}|${service.errors.length.toLocaleString("ko-KR")}|`),
    "",
    "## 연도별 활성 거래",
    "",
    "|유형|2017|2018|2019|2020|2021|2022|2023|2024|2025|2026|",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...result.services.map((service) =>
      `|${service.label}|${[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((year) => (service.activeByYear[String(year)] || 0).toLocaleString("ko-KR")).join("|")}|`),
    "",
    "## 판단",
    "",
    "- 2,832건은 `상업업무용 매매` 단일 API의 마곡동 활성 거래다.",
    "- 마곡동 실거래 체감 총량을 보려면 오피스텔, 공장/창고, 토지, 주거 매매 API를 별도 합산해야 한다.",
    "- 중개업소 영업량과 비교하려면 매매만으로는 부족하고 전월세 확정일자 신고 자료까지 함께 봐야 한다.",
    "- 상가 임대차 개별 신고 자료는 이번 공공데이터 API 묶음에 포함되지 않아, 실제 중개업소 체감 건수는 이보다 더 클 수 있다.",
    "- 가격 기준 대시보드는 업무시설/근린생활시설 기준을 유지하되, 상단에는 단일 API 기준인지 전체 후보 합산인지 명확히 표시해야 한다.",
  ].filter((line) => line !== "");
  fs.writeFileSync(outMdPath, `${lines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    ok: result.mode === "fetched" && result.totals.errorCount === 0,
    mode: result.mode,
    businessActive: result.totals.businessActive,
    allSaleActive: result.totals.allSaleActive,
    rentActive: result.totals.rentActive,
    brokerageVisibleActive: result.totals.brokerageVisibleActive,
    errorCount: result.totals.errorCount,
    outJsonPath,
    outMdPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
