// 건축HUB 전유공용면적 수집이 잘린 필지만 다중 페이지로 보강한다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data", "processed");
const envPath = path.join(root, ".env.local");
const areaPath = path.join(dataDir, "building-hub-area-results.json");
const contractAreaPath = path.join(dataDir, "contract-area-matches.json");
const statusPath = path.join(dataDir, "building-hub-area-refetch-status.json");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=");
  }
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
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

function parcelToBunJi(parcel) {
  const [bunRaw, jiRaw = "0"] = String(parcel).split("-");
  const bun = String(Number(bunRaw)).padStart(4, "0");
  const ji = String(Number(jiRaw)).padStart(4, "0");
  return { bun, ji };
}

function uniqueItems(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = [
      item.mgmBldrgstPk,
      item.exposPubuseGbCd,
      item.flrGbCd,
      item.flrNo,
      item.hoNm,
      item.area,
      item.mainPurpsCd,
      item.etcPurps,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

async function fetchParcelArea(parcel, serviceKey, endpoint) {
  const { bun, ji } = parcelToBunJi(parcel);
  const firstUrl = new URL(endpoint);
  firstUrl.searchParams.set("serviceKey", serviceKey);
  firstUrl.searchParams.set("sigunguCd", process.env.SIGUNGU_CD || "11500");
  firstUrl.searchParams.set("bjdongCd", process.env.BJDONG_CD || "10500");
  firstUrl.searchParams.set("platGbCd", process.env.PLAT_GB_CD || "0");
  firstUrl.searchParams.set("bun", bun);
  firstUrl.searchParams.set("ji", ji);
  firstUrl.searchParams.set("numOfRows", "1000");
  firstUrl.searchParams.set("pageNo", "1");

  const firstResponse = await fetch(firstUrl);
  const firstText = await firstResponse.text();
  if (!firstResponse.ok) throw new Error(`HTTP ${firstResponse.status}: ${firstText.slice(0, 200)}`);
  const firstItems = parseItems(firstText);
  const totalCount = Number(parseTag(firstText, "totalCount")) || firstItems.length;
  const actualPageSize = Math.max(1, firstItems.length);
  const requestedPageSize = Number(parseTag(firstText, "numOfRows")) || 1000;
  const effectivePageSize = Math.min(requestedPageSize, actualPageSize);
  const pages = Math.max(1, Math.ceil(totalCount / effectivePageSize));
  const items = [...firstItems];

  for (let page = 2; page <= pages; page += 1) {
    const url = new URL(firstUrl);
    url.searchParams.set("pageNo", String(page));
    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} page ${page}: ${text.slice(0, 200)}`);
    items.push(...parseItems(text));
  }

  return {
    parcel,
    totalCount,
    requestedPageSize,
    effectivePageSize,
    fetchedCount: items.length,
    items: uniqueItems(items),
  };
}

async function main() {
  loadEnvFile(envPath);
  const serviceKey = process.env.PUBLIC_DATA_SERVICE_KEY || "";
  const endpoint = process.env.BUILDING_HUB_AREA_API_URL
    || "https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo";
  if (!serviceKey) throw new Error("PUBLIC_DATA_SERVICE_KEY is missing");
  if (!fs.existsSync(areaPath)) throw new Error("building-hub-area-results.json is missing");
  if (!fs.existsSync(contractAreaPath)) throw new Error("contract-area-matches.json is missing");

  const areaData = JSON.parse(fs.readFileSync(areaPath, "utf8"));
  const contractAreaData = JSON.parse(fs.readFileSync(contractAreaPath, "utf8"));
  const targetParcels = Array.isArray(contractAreaData.truncated_parcels)
    ? contractAreaData.truncated_parcels
    : [];
  const resultMap = new Map((areaData.results || []).map((row) => [row.parcel, row]));
  const refetched = [];
  const errors = [];

  for (const parcel of targetParcels) {
    try {
      const next = await fetchParcelArea(parcel, serviceKey, endpoint);
      const previous = resultMap.get(parcel);
      resultMap.set(parcel, {
        ...(previous || {}),
        ...next,
        previousFetchedCount: previous?.fetchedCount ?? previous?.items?.length ?? null,
      });
      refetched.push({
        parcel,
        totalCount: next.totalCount,
        effectivePageSize: next.effectivePageSize,
        fetchedCount: next.fetchedCount,
        uniqueCount: next.items.length,
      });
      console.log(`${parcel}: ${next.fetchedCount}/${next.totalCount}`);
    } catch (error) {
      errors.push({ parcel, error: error.message });
      console.error(`${parcel}: ${error.message}`);
    }
  }

  const merged = {
    ...areaData,
    generated_at: new Date().toISOString(),
    source_api: areaData.source_api || "건축HUB 전유공용면적",
    endpoint,
    count: resultMap.size,
    partial: errors.length > 0,
    refetch: {
      generated_at: new Date().toISOString(),
      target_count: targetParcels.length,
      success_count: refetched.length,
      error_count: errors.length,
      credential_policy: "PUBLIC_DATA_SERVICE_KEY was read from environment only and not written to output.",
    },
    results: [...resultMap.values()].sort((a, b) => String(a.parcel).localeCompare(String(b.parcel), "ko-KR", { numeric: true })),
  };
  fs.writeFileSync(areaPath, JSON.stringify(merged, null, 2), "utf8");
  fs.writeFileSync(statusPath, JSON.stringify({
    ok: errors.length === 0,
    endpoint,
    refetched,
    errors,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ ok: errors.length === 0, refetched: refetched.length, errors: errors.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
