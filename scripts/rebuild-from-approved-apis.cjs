// 승인된 공공데이터 API를 사용해 마곡동 상업용 거래 월단위 재수집을 준비한다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "data", "processed");
const statusPath = path.join(outDir, "api-rebuild-status.json");
const commercialOutPath = path.join(outDir, "api-commercial-monthly-raw.json");

const serviceKey = process.env.PUBLIC_DATA_SERVICE_KEY || "";
const commercialEndpoint =
  process.env.COMMERCIAL_TRADE_API_URL ||
  "https://apis.data.go.kr/1613000/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade";
const buildingTitleEndpoint =
  process.env.BUILDING_HUB_TITLE_API_URL ||
  "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo";
const lawdCd = process.env.LAWD_CD || "11500";
const targetDong = process.env.TARGET_DONG || "마곡동";
const startMonth = process.env.START_MONTH || "201701";
const endMonth = process.env.END_MONTH || new Date().toISOString().slice(0, 7).replace("-", "");

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

async function fetchCommercialMonth(dealYm) {
  const url = new URL(commercialEndpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("LAWD_CD", lawdCd);
  url.searchParams.set("DEAL_YMD", dealYm);
  url.searchParams.set("numOfRows", "1000");
  url.searchParams.set("pageNo", "1");
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${dealYm}: ${text.slice(0, 200)}`);
  return parseItems(text)
    .filter((item) => Object.values(item).some((value) => String(value).includes(targetDong)))
    .map((item) => ({ source_month: dealYm, ...item }));
}

async function main() {
  const months = monthRange(startMonth, endMonth);
  const status = {
    generated_at: new Date().toISOString(),
    mode: serviceKey ? "fetch-ready" : "dry-run",
    credential_present: Boolean(serviceKey),
    credential_policy: "PUBLIC_DATA_SERVICE_KEY is read from environment only and never written to output.",
    target: { lawdCd, targetDong, startMonth, endMonth, monthCount: months.length },
    endpoints: {
      commercialEndpoint,
      buildingTitleEndpoint,
      note: "건축HUB 상세 기능명은 Swagger/가이드 기준으로 검증 후 BUILDING_HUB_*_API_URL 환경변수로 교체 가능.",
    },
    direct_apis: [
      "국토교통부_상업업무용 부동산 매매 실거래가 자료",
      "국토교통부_건축HUB_건축물대장정보 서비스",
    ],
    support_apis: [
      "국토교통부_오피스텔 매매 실거래가 자료",
      "국토교통부_오피스텔 전월세 실거래가 자료",
      "국토교통부_토지 매매 실거래가 자료",
      "국토교통부_공장 및 창고 등 부동산 매매 실거래가 자료",
      "전국공인중개사사무소표준데이터",
    ],
  };

  if (!serviceKey) {
    status.next_action = "Set PUBLIC_DATA_SERVICE_KEY and rerun: node scripts\\rebuild-from-approved-apis.cjs";
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf8");
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const allItems = [];
  const errors = [];
  for (const month of months) {
    try {
      const items = await fetchCommercialMonth(month);
      allItems.push(...items);
      console.log(`${month}: ${items.length}`);
    } catch (error) {
      errors.push({ month, error: error.message });
      console.error(`${month}: ${error.message}`);
    }
  }

  const result = {
    generated_at: new Date().toISOString(),
    target: status.target,
    row_count: allItems.length,
    error_count: errors.length,
    errors,
    items: allItems,
  };
  status.fetch_result = {
    output: commercialOutPath,
    row_count: allItems.length,
    error_count: errors.length,
  };

  fs.writeFileSync(commercialOutPath, JSON.stringify(result, null, 2), "utf8");
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf8");
  console.log(JSON.stringify(status.fetch_result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
