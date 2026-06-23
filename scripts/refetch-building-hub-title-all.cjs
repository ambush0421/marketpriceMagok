// 마곡동 건축HUB 표제부 전체를 다중 페이지로 수집해 필지 후보군을 확장한다.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data", "processed");
const envPath = path.join(root, ".env.local");
const titlePath = path.join(dataDir, "building-hub-title-results.json");
const statusPath = path.join(dataDir, "building-hub-title-refetch-status.json");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
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

function parcelFromItem(item) {
  const bun = Number(item.bun);
  const ji = Number(item.ji);
  if (!Number.isFinite(bun)) return "";
  return ji ? `${bun}-${ji}` : String(bun);
}

function roadFromItem(item) {
  return item.newPlatPlc || item.platPlc || "";
}

function toNumber(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function approvalYear(item) {
  const raw = String(item.useAprDay || "").trim();
  return raw.length >= 4 ? raw.slice(0, 4) : "";
}

async function fetchPage(endpoint, serviceKey, pageNo) {
  const url = new URL(endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("sigunguCd", process.env.SIGUNGU_CD || "11500");
  url.searchParams.set("bjdongCd", process.env.BJDONG_CD || "10500");
  url.searchParams.set("numOfRows", "100");
  url.searchParams.set("pageNo", String(pageNo));
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} page ${pageNo}: ${text.slice(0, 200)}`);
  return {
    totalCount: Number(parseTag(text, "totalCount")) || 0,
    numOfRows: Number(parseTag(text, "numOfRows")) || 100,
    items: parseItems(text),
  };
}

async function main() {
  loadEnvFile(envPath);
  const serviceKey = process.env.PUBLIC_DATA_SERVICE_KEY || "";
  const endpoint = process.env.BUILDING_HUB_TITLE_API_URL
    || "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo";
  if (!serviceKey) throw new Error("PUBLIC_DATA_SERVICE_KEY is missing");

  const first = await fetchPage(endpoint, serviceKey, 1);
  const pages = Math.max(1, Math.ceil(first.totalCount / first.numOfRows));
  const items = [...first.items];
  for (let page = 2; page <= pages; page += 1) {
    const next = await fetchPage(endpoint, serviceKey, page);
    items.push(...next.items);
  }

  const byParcel = new Map();
  for (const item of items) {
    const parcel = parcelFromItem(item);
    if (!parcel) continue;
    if (!byParcel.has(parcel)) byParcel.set(parcel, { parcel, names: new Set(), roads: new Set(), title_items: [], count: 0 });
    const row = byParcel.get(parcel);
    if (item.bldNm) row.names.add(item.bldNm);
    if (roadFromItem(item)) row.roads.add(roadFromItem(item));
    row.title_items.push({
      building_name: item.bldNm || "",
      road: roadFromItem(item),
      main_use: item.mainPurpsCdNm || "",
      etc_use: item.etcPurps || "",
      total_area_sqm: toNumber(item.totArea),
      floor_area_sqm: toNumber(item.vlRatEstmTotArea),
      building_area_sqm: toNumber(item.archArea),
      ground_floors: toNumber(item.grndFlrCnt),
      basement_floors: toNumber(item.ugrndFlrCnt),
      approval_year: approvalYear(item),
      regstr_kind: item.regstrKindCdNm || "",
    });
    row.count += 1;
  }

  const previous = fs.existsSync(titlePath)
    ? JSON.parse(fs.readFileSync(titlePath, "utf8"))
    : { results: [] };
  for (const row of previous.results || []) {
    if (!byParcel.has(row.parcel)) byParcel.set(row.parcel, { parcel: row.parcel, names: new Set(), roads: new Set(), title_items: [], count: 0 });
    const next = byParcel.get(row.parcel);
    for (const name of row.names || []) if (name) next.names.add(name);
    if (row.road) next.roads.add(row.road);
    for (const item of row.title_items || []) next.title_items.push(item);
    next.count = Math.max(next.count, row.count || 0);
  }

  const results = [...byParcel.values()].map((row) => ({
    parcel: row.parcel,
    names: [...row.names].filter(Boolean),
    road: [...row.roads].filter(Boolean)[0] || "",
    title_items: row.title_items,
    count: row.count,
  })).sort((a, b) => String(a.parcel).localeCompare(String(b.parcel), "ko-KR", { numeric: true }));

  const output = {
    generated_at: new Date().toISOString(),
    source_api: "건축HUB 표제부",
    endpoint,
    totalCount: first.totalCount,
    count: results.length,
    credential_policy: "PUBLIC_DATA_SERVICE_KEY was read from environment only and not written to output.",
    results,
  };
  fs.writeFileSync(titlePath, JSON.stringify(output, null, 2), "utf8");
  fs.writeFileSync(statusPath, JSON.stringify({
    ok: true,
    totalCount: first.totalCount,
    pageCount: pages,
    parcelCount: results.length,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, totalCount: first.totalCount, pageCount: pages, parcelCount: results.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
