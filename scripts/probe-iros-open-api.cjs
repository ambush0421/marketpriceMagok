// 등기정보광장 OpenAPI 연결 상태를 확인하는 진단 스크립트입니다.
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

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    length: text.length,
    starts: text.slice(0, 180),
  };
}

async function main() {
  loadEnvFile(envPath);

  const apiKey = process.env.IROS_OPEN_API_KEY || "";
  const apiId = process.env.IROS_APARTMENT_TRADE_API_ID || "0000000305";
  const baseUrl = process.env.IROS_APARTMENT_TRADE_API_URL || "https://data.iros.go.kr/openapi/cr/rs/selectCrRsRgsCsOpenApi.rest";

  if (!apiKey) {
    throw new Error("IROS_OPEN_API_KEY is missing in .env.local.");
  }

  const trials = [
    {
      label: "monthly_xml_msignature_202503",
      params: {
        id: apiId,
        reqtype: "xml",
        key: apiKey,
        search_type_api: "02",
        search_start_date_api: "202503",
        search_end_date_api: "202503",
        search_amt_sect: "04",
        search_area_sect: "003",
        search_regn1_name_api: "900",
        search_regn2_name_api: "904",
        search_buld_name: "엠시그니처",
      },
    },
  ];

  const results = [];
  for (const trial of trials) {
    const url = new URL(baseUrl);
    for (const [name, value] of Object.entries(trial.params)) {
      url.searchParams.set(name, value);
    }
    const result = await fetchText(url);
    results.push({
      label: trial.label,
      status: result.status,
      contentType: result.contentType,
      length: result.length,
      looksHtml: /^\s*<!doctype html/i.test(result.starts) || /^\s*<html/i.test(result.starts),
      starts: result.starts.replace(apiKey, "[redacted]"),
    });
  }

  console.log(JSON.stringify({
    ok: true,
    endpoint: baseUrl,
    apiId,
    keyPresent: true,
    keyLength: apiKey.length,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
