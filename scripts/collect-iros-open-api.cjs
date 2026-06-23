// 등기정보광장 집합건물 실거래가 응답을 정규화해 저장하는 수집기입니다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env.local");
const outDir = path.join(root, "data", "processed");
const rawDir = path.join(root, "data", "raw", "iros-openapi");
const outPath = path.join(outDir, "iros-openapi-results.json");
const samplePath = path.join(outDir, "iros-msignature-202503-sample.json");
const commercialRawPath = path.join(outDir, "api-commercial-monthly-raw.json");

const amountCodes = {
  "00": "5천만원 이하",
  "01": "5천만원 초과 1억 이하",
  "02": "1억 초과 2억 이하",
  "03": "2억 초과 4억 이하",
  "04": "4억 초과 6억 이하",
  "05": "6억 초과 8억 이하",
  "06": "8억 초과 9억 이하",
  "07": "9억 초과 10억 이하",
  "08": "10억 초과 15억 이하",
  "09": "15억 초과 20억 이하",
  10: "20억 초과 30억 이하",
  11: "30억 초과 50억 이하",
  12: "50억 초과 100억 이하",
  13: "100억 초과",
};

const areaCodes = {
  "001": "0 ~ 20㎡",
  "002": "21㎡ ~ 40㎡",
  "003": "41㎡ ~ 60㎡",
  "004": "61㎡ ~ 85㎡",
  "005": "86㎡ ~ 100㎡",
  "006": "101㎡ ~ 135㎡",
  "007": "136㎡ ~ 165㎡",
  "008": "166㎡ ~ 198㎡",
  "009": "199㎡ 이상",
};

const region2Codes = {
  "904": "강서구",
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#][^=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function listArg(name, fallback) {
  return arg(name, fallback).split(",").map((value) => value.trim()).filter(Boolean);
}

function monthPeriods(start, end, split) {
  if (split === "full") return [{ start, end }];
  const periods = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(4, 6));
  const endYear = Number(end.slice(0, 4));
  const endMonth = Number(end.slice(4, 6));
  const step = split === "quarter" ? 3 : split === "half" ? 6 : 12;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const periodStart = `${year}${String(month).padStart(2, "0")}`;
    let periodEndYear = year;
    let periodEndMonth = month + step - 1;
    while (periodEndMonth > 12) {
      periodEndYear += 1;
      periodEndMonth -= 12;
    }
    const cappedEndYear = Math.min(periodEndYear, endYear);
    const cappedEndMonth = cappedEndYear === endYear ? Math.min(periodEndMonth, endMonth) : periodEndMonth;
    periods.push({ start: periodStart, end: `${cappedEndYear}${String(cappedEndMonth).padStart(2, "0")}` });

    month += step;
    while (month > 12) {
      year += 1;
      month -= 12;
    }
  }
  return periods;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseXmlItems(xml) {
  const items = [];
  for (const match of String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const itemXml = match[1];
    const item = {};
    for (const field of itemXml.matchAll(/<([^/?][^>]*)>([\s\S]*?)<\/\1>/g)) {
      item[field[1]] = decodeXml(field[2]).trim();
    }
    items.push(item);
  }
  return items;
}

function parseReturn(xml) {
  const code = xml.match(/<returnCode>([\s\S]*?)<\/returnCode>/)?.[1] || "";
  const message = xml.match(/<returnMessage>([\s\S]*?)<\/returnMessage>/)?.[1] || "";
  const totalCount = Number(xml.match(/<totCount>([\s\S]*?)<\/totCount>/)?.[1] || 0);
  return { code, message: decodeXml(message), totalCount };
}

function toNumber(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function amountCodeFromManwon(value) {
  const amount = toNumber(value);
  if (!Number.isFinite(amount)) return null;
  if (amount <= 5000) return "00";
  if (amount <= 10000) return "01";
  if (amount <= 20000) return "02";
  if (amount <= 40000) return "03";
  if (amount <= 60000) return "04";
  if (amount <= 80000) return "05";
  if (amount <= 90000) return "06";
  if (amount <= 100000) return "07";
  if (amount <= 150000) return "08";
  if (amount <= 200000) return "09";
  if (amount <= 300000) return "10";
  if (amount <= 500000) return "11";
  if (amount <= 1000000) return "12";
  return "13";
}

function areaCodeFromSqm(value) {
  const area = toNumber(value);
  if (!Number.isFinite(area)) return null;
  if (area <= 20) return "001";
  if (area <= 40) return "002";
  if (area <= 60) return "003";
  if (area <= 85) return "004";
  if (area <= 100) return "005";
  if (area <= 135) return "006";
  if (area <= 165) return "007";
  if (area <= 198) return "008";
  return "009";
}

function normalizeItem(item, request) {
  const causeDate = item.rgsCausDate || "";
  const month = causeDate ? causeDate.slice(0, 7) : `${request.start.slice(0, 4)}-${request.start.slice(4, 6)}`;
  return {
    source_kind: "iros-openapi",
    regn_addr: item.regnAddr || "",
    lot_no: item.lotNo || "",
    building_name: item.buldName || "",
    floor: item.buldNoFloor || "",
    cause_date: causeDate,
    received_date: item.recevDate || "",
    month,
    area_sqm: toNumber(item.area),
    deal_amount_won: toNumber(item.dealAmt),
    deal_amount_manwon: toNumber(item.dealAmt) ? toNumber(item.dealAmt) / 10000 : null,
    request,
  };
}

function requestFromArgs() {
  return {
    type: arg("type", "02"),
    start: arg("start", "202503"),
    end: arg("end", "202503"),
    amount: arg("amount", "04"),
    amount_label: amountCodes[arg("amount", "04")] || "",
    area: arg("area", "003"),
    area_label: areaCodes[arg("area", "003")] || "",
    region1: arg("region1", "900"),
    region1_label: "서울특별시",
    region2: arg("region2", "904"),
    region2_label: "강서구",
    building: arg("building", "엠시그니처"),
  };
}

function buildRequests() {
  const preset = arg("preset", "");
  if (preset === "magok-all") {
    const start = arg("start", "202306");
    const end = arg("end", "202606");
    const maxCalls = Number(arg("max-calls", "10"));
    const split = arg("split", "quarter");
    const combosPerPeriod = Number(arg("combos-per-period", "1"));
    if (!fs.existsSync(commercialRawPath)) {
      throw new Error("api-commercial-monthly-raw.json is missing. Run the public data rebuild first.");
    }
    const raw = JSON.parse(fs.readFileSync(commercialRawPath, "utf8"));
    const candidates = [];
    const periods = monthPeriods(start, end, split);
    for (const period of periods) {
      const comboCounts = new Map();
      for (const item of raw.items || []) {
        const month = String(item.source_month || "");
        if (month < period.start || month > period.end) continue;
        if (String(item.umdNm || "") !== "마곡동") continue;
        if (item.cdealType === "O" || item.cdealDay) continue;
        const amount = amountCodeFromManwon(item.dealAmount);
        const area = areaCodeFromSqm(item.buildingAr);
        if (!amount || !area) continue;
        const key = `${amount}|${area}`;
        comboCounts.set(key, (comboCounts.get(key) || 0) + 1);
      }
      candidates.push(...[...comboCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, combosPerPeriod)
        .map(([key, expected_count]) => {
          const [amount, area] = key.split("|");
          return {
            type: "02",
            start: period.start,
            end: period.end,
            amount,
            amount_label: amountCodes[amount] || "",
            area,
            area_label: areaCodes[area] || "",
            region1: "900",
            region1_label: "서울특별시",
            region2: "904",
            region2_label: "강서구",
            building: "",
            filter_dong: "마곡동",
            expected_public_data_count: expected_count,
          };
        }));
    }
    return candidates
      .sort((a, b) => b.start.localeCompare(a.start) || b.expected_public_data_count - a.expected_public_data_count)
      .slice(0, maxCalls)
      .sort((a, b) => a.start.localeCompare(b.start));
  }
  if (preset === "msignature") {
    const start = arg("start", "202306");
    const end = arg("end", "202606");
    const building = arg("building", "엠시그니처");
    const split = arg("split", "year");
    const periods = monthPeriods(start, end, split);
    const amounts = listArg("amounts", "03,04");
    const areas = listArg("areas", "003");
    const regions = listArg("regions", "904");
    const requests = [];
    for (const period of periods) {
      for (const region2 of regions) {
        for (const amount of amounts) {
          for (const area of areas) {
            requests.push({
              type: "02",
              start: period.start,
              end: period.end,
              amount,
              amount_label: amountCodes[amount] || "",
              area,
              area_label: areaCodes[area] || "",
              region1: "900",
              region1_label: "서울특별시",
              region2,
              region2_label: region2Codes[region2] || region2,
              building,
            });
          }
        }
      }
    }
    return requests;
  }
  return [requestFromArgs()];
}

async function fetchXml(request) {
  loadEnvFile(envPath);
  const apiKey = process.env.IROS_OPEN_API_KEY || "";
  const apiId = process.env.IROS_APARTMENT_TRADE_API_ID || "0000000305";
  const baseUrl = process.env.IROS_APARTMENT_TRADE_API_URL || "https://data.iros.go.kr/openapi/cr/rs/selectCrRsRgsCsOpenApi.rest";
  if (!apiKey) throw new Error("IROS_OPEN_API_KEY is missing in .env.local.");

  const url = new URL(baseUrl);
  url.searchParams.set("id", apiId);
  url.searchParams.set("reqtype", "xml");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("search_type_api", request.type);
  url.searchParams.set("search_start_date_api", request.start);
  url.searchParams.set("search_end_date_api", request.end);
  url.searchParams.set("search_amt_sect", request.amount);
  url.searchParams.set("search_area_sect", request.area);
  url.searchParams.set("search_regn1_name_api", request.region1);
  url.searchParams.set("search_regn2_name_api", request.region2);
  if (request.building) url.searchParams.set("search_buld_name", request.building);

  const response = await fetch(url);
  const xml = await response.text();
  const safeUrl = url.toString().replace(apiKey, "[redacted]");
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${xml.slice(0, 200)}`);
  return { xml, safeUrl };
}

function loadSampleXml() {
  if (!fs.existsSync(samplePath)) return "";
  const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  return sample.starts || "";
}

function canReuseSample(request) {
  return request.start === "202503"
    && request.end === "202503"
    && request.amount === "04"
    && request.area === "003"
    && request.region1 === "900"
    && request.region2 === "904"
    && request.building === "엠시그니처";
}

async function main() {
  const requests = buildRequests();
  const execute = hasFlag("execute");
  const sampleXml = loadSampleXml();
  if (!execute && !sampleXml) {
    throw new Error("No sample response found. Use --execute to call the IROS API.");
  }

  const responses = [];
  const allItems = [];

  for (const request of requests) {
    const fetched = execute ? await fetchXml(request) : null;
    const xml = fetched ? fetched.xml : canReuseSample(request) ? sampleXml : "";
    const safeUrl = fetched ? fetched.safeUrl : "sample:data/processed/iros-msignature-202503-sample.json";
    const parsed = xml
      ? parseReturn(xml)
      : { code: "PLANNED", message: "실제 호출 전 계획만 생성됨", totalCount: 0 };
    const items = xml
      ? parseXmlItems(xml)
          .map((item) => normalizeItem(item, request))
          .filter((item) => !request.filter_dong || item.regn_addr.includes(request.filter_dong))
      : [];
    allItems.push(...items);
    responses.push({
      request,
      request_url: safeUrl,
      response: parsed,
      row_count: items.length,
    });

    if (execute) {
      fs.mkdirSync(rawDir, { recursive: true });
      const rawName = `${request.start}-${request.end}-${request.amount}-${request.area}-${request.building || "all"}.xml`;
      fs.writeFileSync(path.join(rawDir, rawName), xml, "utf8");
    }
  }

  const result = {
    generated_at: new Date().toISOString(),
    mode: execute ? "api-execute" : "plan-only",
    api_limit_note: "등기정보광장 해당 API는 화면 명세 기준 일 최대 10회, 요청 최대 1,000건 제한이다.",
    strategy: "최근 3년 전체 기간을 한 번에 조회하고, 1,000건 초과 위험이 있을 때만 기간을 분할한다.",
    call_count: requests.length,
    requests,
    responses,
    row_count: allItems.length,
    items: allItems,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

  console.log(JSON.stringify({
    ok: true,
    mode: result.mode,
    output: path.relative(root, outPath),
    call_count: result.call_count,
    row_count: result.row_count,
    responses: responses.map((response) => ({
      amount: response.request.amount,
      area: response.request.area,
      returnCode: response.response.code,
      returnMessage: response.response.message,
      row_count: response.row_count,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
