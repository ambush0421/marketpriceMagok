// 등기정보광장 집합건물 실거래가 API를 단일 조건으로 호출하는 스크립트입니다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env.local");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#][^=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  loadEnvFile(envPath);

  const apiKey = process.env.IROS_OPEN_API_KEY || "";
  const apiId = process.env.IROS_APARTMENT_TRADE_API_ID || "0000000305";
  const baseUrl = process.env.IROS_APARTMENT_TRADE_API_URL || "https://data.iros.go.kr/openapi/cr/rs/selectCrRsRgsCsOpenApi.rest";

  if (!apiKey) {
    throw new Error("IROS_OPEN_API_KEY is missing in .env.local.");
  }

  const params = {
    id: apiId,
    reqtype: getArg("reqtype", "xml"),
    key: apiKey,
    search_type_api: getArg("type", "02"),
    search_start_date_api: getArg("start", "202503"),
    search_end_date_api: getArg("end", "202503"),
    search_amt_sect: getArg("amount", "04"),
    search_area_sect: getArg("area", "003"),
    search_regn1_name_api: getArg("region1", "900"),
    search_regn2_name_api: getArg("region2", "904"),
  };

  const buildingName = getArg("building", "");
  if (buildingName) {
    params.search_buld_name = buildingName;
  }

  const url = new URL(baseUrl);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const response = await fetch(url);
  const text = await response.text();
  const redactedUrl = url.toString().replace(apiKey, "[redacted]");
  const redactedText = text.replaceAll(apiKey, "[redacted]");

  console.log(JSON.stringify({
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    url: redactedUrl,
    length: text.length,
    starts: redactedText.slice(0, 2000),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
