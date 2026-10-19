// Cloudflare Worker: 코스트코코리아 온라인몰 할인 상품 중계
//
// 브라우저(GitHub Pages)에서 costco.co.kr을 직접 호출하면 CORS로 403이 나서, 이 Worker가
// 대신 호출해 "할인 중인 상품"만 추려 돌려준다. 무료 플랜의 Worker 1회 실행당 외부 호출
// 한도(50회)를 지키기 위해 전체 상품(약 84페이지)을 CHUNK_PAGES 페이지씩 나눠
// 받는다: /?chunk=0, /?chunk=1, ... 응답의 totalChunks까지 프런트가 반복 호출한다.
//
// 결과는 Cloudflare 캐시에 CACHE_SECONDS 동안 저장해 코스트코 서버 호출을 최소화한다.
// 참고: 코스트코의 비공개 내부 API라 예고 없이 바뀌거나 차단될 수 있다.

const UPSTREAM = "https://www.costco.co.kr";
const PAGE_SIZE = 100; // 서버가 허용하는 최대값(직접 확인함)
const CHUNK_PAGES = 20; // Worker 1회 실행당 외부 호출 20회 (무료 한도 50회 이내)
const CACHE_SECONDS = 6 * 60 * 60;
const ALLOWED_ORIGIN = "https://jugga1004.github.io";

const FIELDS =
  "products(code,name,url,price(value),discountPrice(value)," +
  "couponDiscount(discountValue,discountStartDate,discountEndDate)," +
  "images(url,format,imageType)),pagination";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET",
    Vary: "Origin",
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(), ...extra },
  });
}

async function fetchPage(page) {
  const url = new URL(UPSTREAM + "/rest/v2/korea/products/search");
  url.searchParams.set("query", ":relevance");
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("currentPage", String(page));
  url.searchParams.set("fields", FIELDS);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (personal-project deals viewer)", Accept: "application/json" },
  });
  if (!res.ok) throw new Error("UPSTREAM_" + res.status);
  return res.json();
}

function pickThumb(images) {
  if (!Array.isArray(images)) return null;
  const t =
    images.find((i) => i.imageType === "PRIMARY" && i.format === "thumbnail") ||
    images.find((i) => i.format === "thumbnail") ||
    images[0];
  return t && t.url ? UPSTREAM + t.url : null;
}

async function buildChunk(chunk) {
  const first = chunk * CHUNK_PAGES;
  const now = Date.now();
  const items = [];
  let totalPages = null;

  for (let p = first; p < first + CHUNK_PAGES; p++) {
    if (totalPages !== null && p >= totalPages) break;
    const data = await fetchPage(p);
    totalPages = data.pagination && data.pagination.totalPages;
    for (const prod of data.products || []) {
      const cd = prod.couponDiscount;
      if (!cd || !(cd.discountValue > 0)) continue;
      const end = cd.discountEndDate ? Date.parse(cd.discountEndDate) : null;
      if (end && end < now) continue; // 이미 끝난 할인은 제외
      items.push({
        code: prod.code,
        name: prod.name,
        price: prod.price ? prod.price.value : null, // 판매가(온라인몰 표시 가격)
        discount: cd.discountValue, // 할인액(원)
        start: cd.discountStartDate || null,
        end: cd.discountEndDate || null,
        url: prod.url ? UPSTREAM + prod.url : null,
        img: pickThumb(prod.images),
      });
    }
  }

  return {
    chunk,
    totalChunks: Math.ceil((totalPages || 0) / CHUNK_PAGES),
    fetchedAt: new Date().toISOString(),
    source: "costco.co.kr 온라인몰",
    items,
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

    const reqUrl = new URL(request.url);
    const chunk = Number(reqUrl.searchParams.get("chunk") || 0);
    if (!Number.isInteger(chunk) || chunk < 0 || chunk > 20) return json({ error: "BAD_CHUNK" }, 400);

    const cache = caches.default;
    const cacheKey = new Request(reqUrl.origin + "/?chunk=" + chunk);
    const hit = await cache.match(cacheKey);
    if (hit) {
      const res = new Response(hit.body, hit);
      Object.entries(corsHeaders()).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    try {
      const data = await buildChunk(chunk);
      const res = json(data, 200, { "Cache-Control": "public, max-age=" + CACHE_SECONDS });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      return json({ error: "UPSTREAM_FAILED", message: String(e && e.message) }, 502);
    }
  },
};
