// Cloudflare Worker: 면세점 환율 중계 (장보기 체크 전용)
//
// 장보기 체크의 "면세점 환율" 탭이 쓰는 자체 데이터 경로다. 다른 서비스와 연결하지 않고
// 필요한 만큼만 독립적으로 구현했다.
//
//   GET /v1/recent?days=10   최근 영업일 매매기준율(USD, JPY) — 면세점 적용환율의 재료
//   GET /v1/product?url=…    면세점 상품 페이지에서 상품명·달러가 추출 (면세점 도메인만 허용)
//   GET /v1/health           키 설정 여부만 확인
//
// 설정(Workers → Settings → Variables and Secrets)
//   KOREAEXIM_KEY   (Secret, 필수) 한국수출입은행 오픈API 인증키. 코드·저장소에 넣지 말 것.
//   ALLOWED_ORIGIN  (Variable, 선택) 기본 "*". https://jugga1004.github.io 로 좁히는 걸 권장.
//
// 면세점 적용환율은 '전일 고시 매매기준율'이다(주말·공휴일엔 직전 영업일 값이 이어진다).

const UPSTREAM = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON";
const WANTED = { USD: "USD", "JPY(100)": "JPY" }; // JPY는 100엔 기준
const DEFAULT_DAYS = 8;
const MAX_DAYS = 10;
const TTL_PAST = 60 * 60 * 24 * 7;
const TTL_TODAY = 60 * 15;
const TTL_EMPTY = 60 * 10;

export default {
  async fetch(request, env, ctx) {
    const origin = env.ALLOWED_ORIGIN || "*";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "GET") return json({ ok: false, error: "GET만 지원합니다." }, 405, origin);

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/v1/health" || path === "/") {
        return json({ ok: true, service: "장보기 체크 면세점 환율", keyConfigured: Boolean(env.KOREAEXIM_KEY) }, 200, origin);
      }

      if (path === "/v1/product") {
        const pu = new URL(request.url);
        const debug = pu.searchParams.get("debug") === "1";
        const result = await fetchProduct(pu.searchParams.get("url") || "", debug);
        return json({ ok: true, ...result }, 200, origin);
      }

      if (!env.KOREAEXIM_KEY) {
        return json({ ok: false, error: "서버에 KOREAEXIM_KEY가 없습니다. Settings → Variables and Secrets 에서 Secret으로 등록하세요." }, 500, origin);
      }

      if (path === "/v1/recent") {
        const url = new URL(request.url);
        let days = parseInt(url.searchParams.get("days") || DEFAULT_DAYS, 10);
        if (!Number.isFinite(days) || days < 1) days = DEFAULT_DAYS;
        if (days > MAX_DAYS) days = MAX_DAYS;

        const today = kstToday();
        const targets = [];
        for (let i = 0; targets.length < days && i < days * 2 + 4; i++) {
          const iso = shift(today, -i);
          if (!isWeekend(iso)) targets.push(iso);
        }

        const rates = {};
        const missing = [];
        const rows = await Promise.all(targets.map((iso) => fetchOneCached(iso, env, ctx)));
        rows.forEach((row, i) => {
          if (row) rates[targets[i]] = row;
          else missing.push(targets[i]);
        });

        // 수출입은행이 오늘 자를 아직 안 내놨으면 서울외국환중개에서 직접 받는다(빠른 경로).
        if (!rates[today] && !isWeekend(today)) {
          const fast = await fetchSmbs(today);
          if (fast) {
            rates[today] = fast;
            const at = missing.indexOf(today);
            if (at >= 0) missing.splice(at, 1);
          }
        }

        const found = Object.keys(rates).sort();
        return json(
          { ok: true, today, latest: found.length ? found[found.length - 1] : null, rates, missing, source: "한국수출입은행 매매기준율(deal_bas_r)" },
          200,
          origin
        );
      }

      return json({ ok: false, error: "없는 경로입니다. /v1/recent, /v1/product, /v1/health 를 쓰세요." }, 404, origin);
    } catch (err) {
      return json({ ok: false, error: err.message || String(err) }, err.httpStatus || 500, origin);
    }
  },
};

// ---------------------------------------------------------------------------
// 면세점 상품 조회
// ---------------------------------------------------------------------------
// 브라우저는 다른 도메인을 못 읽으므로(CORS) 여기서 대신 읽어 상품명과 달러가를 뽑는다.
//
// 아무 주소나 받아주면 이 Worker가 열린 프록시가 되어 남의 서버를 찌르는 데 쓰일 수 있다.
// 그래서 면세점 도메인만 허용한다.
// 서브도메인까지 일일이 적어두면 모바일에서 공유한 주소(m. / mobile. 등)가
// 막힌다. 실제로 "모바일에서 복사한 링크가 안 붙는다"는 신고가 있었다.
// 그래서 등록 가능 도메인 기준으로 접미사 비교를 한다 — 범위는 여전히
// 면세점 네 곳으로 닫혀 있어서 열린 프록시가 되지는 않는다.
const ALLOWED_DOMAINS = ["lottedfs.com", "shilladfs.com", "ssgdfs.com", "hddfs.com"];

function hostAllowed(hostname) {
  const h = String(hostname || "").toLowerCase();
  return ALLOWED_DOMAINS.some((d) => h === d || h.endsWith("." + d));
}

// 모바일에서 공유한 주소는 호스트도 경로도 다르다. m.lottedfs.com은 허용은
// 되지만 마크업이 달라 파싱이 안 됐다.
//
// 주소를 통째로 해석하려 들지 않고 상품번호만 뽑아 표준 주소로 바꿔 끼운다.
// 어느 서브도메인에서 복사했든, 파라미터 순서가 어떻든 같은 자리로 모인다.
function canonicalUrl(u) {
  const h = u.hostname.toLowerCase();
  if (h === "lottedfs.com" || h.endsWith(".lottedfs.com")) {
    const prdNo = u.searchParams.get("prdNo");
    if (prdNo) {
      const opt = u.searchParams.get("prdOptNo") || "";
      // PC 페이지가 아니라 **모바일** 페이지를 읽는다. 이게 핵심이다.
      // PC는 할인가를 자바스크립트가 그려서 서버 HTML이 비어 있는데,
      // 모바일은 서버에서 통째로 그려 내려준다:
      //   <li class="regular_price discount"><span class="currency">$206</span>
      //   <li class="benefit_price"><strong class="rate">20%</strong>
      //                             <strong class="price">$164.8</strong>
      // 덕분에 헤드리스 브라우저가 필요 없다 — 어차피 Incapsula(WAF)가
      // 헤드리스를 차단해서(차단 이미지를 돌려준다) 그 길은 막혀 있었다.
      return new URL(
        "https://m.kor.lottedfs.com/kr/product/productDetail?prdNo=" +
          encodeURIComponent(prdNo) +
          (opt ? "&prdOptNo=" + encodeURIComponent(opt) : "")
      );
    }
  }
  return u;
}

const PRODUCT_TTL = 60 * 30; // 가격은 자주 안 바뀐다. 30분 캐시.

async function fetchProduct(rawUrl, debug) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "주소 형식이 올바르지 않습니다." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "http/https 주소만 됩니다." };
  }
  if (!hostAllowed(u.hostname)) {
    return {
      ok: false,
      error: `지원하지 않는 사이트입니다(${u.hostname}). 현재는 롯데·신라·신세계·현대 면세점만 읽을 수 있습니다.`,
    };
  }

  // 모바일 주소는 여기서 표준형으로 바뀐다.
  u = canonicalUrl(u);

  let res;
  try {
    res = await fetch(u.toString(), {
      // 봇으로 차단당하지 않게 일반 브라우저처럼 요청한다.
      headers: {
        // 모바일 호스트에 데스크톱 UA로 가면 다른 화면이 온다. 우리가 원하는
        // 서버 렌더링 가격표는 모바일 화면에만 있으므로 UA도 모바일로 맞춘다.
        "user-agent": /^m\./.test(u.hostname)
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ko-KR,ko;q=0.9",
      },
      cf: { cacheTtl: PRODUCT_TTL, cacheEverything: true },
    });
  } catch (err) {
    return { ok: false, error: `상품 페이지에 연결하지 못했습니다: ${err.message}` };
  }
  if (!res.ok) return { ok: false, error: `상품 페이지 응답 오류 (HTTP ${res.status})` };

  const html = await res.text();
  if (debug) {
    // 가격처럼 생긴 JSON 필드를 전부 보여준다. 어느 키가 '할인가'인지
    // 추측하지 않고 실제 응답을 보고 고르기 위한 것이다.
    const fields = {};
    const re = /"([A-Za-z_][A-Za-z0-9_]*(?:[Pp]rc|[Pp]rice|[Aa]mt|[Dd]c)[A-Za-z0-9_]*)"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (fields[m[1]] === undefined) fields[m[1]] = m[2];
      if (Object.keys(fields).length > 60) break;
    }
    // 할인가는 JSON이 아니라 마크업에 들어 있다. 그 부분도 같이 보여준다.
    const marks = {};
    ["grdSrpDscntAmt", "grdDscntRt", "grdSrpAmt", "DscntAmt"].forEach((k) => {
      const at = html.indexOf(k);
      marks[k] = at < 0 ? null : html.slice(Math.max(0, at - 80), at + 120).replace(/\s+/g, " ");
    });
    const areaRaw = pick(html, /<div class="detail_price_area">([\s\S]{0,1500}?)<\/ul>/i);
    return {
      ok: true,
      debug: true,
      host: u.hostname,
      bytes: html.length,
      fields,
      marks,
      priceAreaFound: areaRaw !== null,
      priceArea: areaRaw ? decodeEntities(areaRaw).replace(/\s+/g, " ").slice(0, 500) : null,
    };

  }
  const parsed = parseProduct(html, u.hostname);
  if (!parsed.usd && !parsed.name) {
    return { ok: false, error: "이 페이지에서 상품 정보를 찾지 못했습니다. 상품 상세 페이지 주소가 맞는지 확인해주세요." };
  }

  const canonical = u.toString();

  return { ok: true, url: canonical, host: u.hostname, ...parsed };
}

function parseProduct(html, host) {
  // 상품명: og:title 이 가장 안정적이다(속성 순서가 뒤바뀌는 경우가 있어 양쪽 다 본다).
  let name =
    pick(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    pick(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    "";
  name = decodeEntities(name).trim();
  // "롯데면세점" 같은 사이트명만 온 경우는 상품명이 아니다.
  if (/^(롯데면세점|신라면세점|신세계면세점|현대면세점)$/.test(name)) name = "";

  const brand = decodeEntities(pick(html, /"brndNm"\s*:\s*"([^"]+)"/) || "").trim();

  // 달러 표시가. 롯데는 saleUntPrc 가 달러, saleUntPrcGlbl 이 원화 환산가다.
  // 정가. 롯데는 saleUntPrc 가 달러, saleUntPrcGlbl 이 원화 환산가다.
  let listUsd = toNum(pick(html, /"saleUntPrc"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));
  if (listUsd === null) listUsd = toNum(pick(html, /"dutyFreePrice"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));
  if (listUsd === null) listUsd = toNum(pick(html, /"salePrice"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)"?/));

  // 가격 영역만 떼어 엔티티를 풀고 거기서만 찾는다. 600KB 전체를 해독할
  // 이유도 없고, 좁혀 놓으면 엉뚱한 숫자를 집을 일도 없다.
  const priceArea = decodeEntities(
    pick(html, /<div class="detail_price_area">([\s\S]{0,1500}?)<\/ul>/i) || ""
  );

  // 정가. 할인이 걸려 있으면 class가 "regular_price discount"가 된다.
  const listFromArea = toNum(
    pick(priceArea, /class="regular_price[^"]*"[\s\S]{0,200}?class="currency">\s*\$?\s*([0-9][0-9,]*\.?[0-9]*)/i)
  );
  if (listFromArea !== null) listUsd = listFromArea;

  // 할인가. 여기가 실제로 내는 돈이라 비교에 써야 할 값이다.
  const saleUsd = toNum(
    pick(priceArea, /class="benefit_price"[\s\S]{0,300}?class="price">\s*\$?\s*([0-9][0-9,]*\.?[0-9]*)/i)
  );
  const discountPct = toNum(pick(priceArea, /class="rate">\s*([0-9]+(?:\.[0-9]+)?)\s*%/i));

  // 할인가가 정가보다 크면 뭔가 잘못 집은 것이다. 그럴 땐 안 쓴다.
  const sale = saleUsd !== null && listUsd !== null && saleUsd > listUsd ? null : saleUsd;

  // usd는 '실제로 낼 달러'다. 할인가가 있으면 그쪽.
  const usd = sale !== null ? sale : listUsd;

  return { name, brand, usd, listUsd, saleUsd: sale, discountPct, parsedFrom: host };
}

function pick(s, re) {
  const m = s.match(re);
  return m ? m[1] : null;
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // 모바일 페이지는 $ 와 % 까지 16진 엔티티로 보낸다(&#x0024; &#x0025;).
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

// ---------------------------------------------------------------------------
// 환율 조회
// ---------------------------------------------------------------------------

async function fetchOneCached(iso, env, ctx) {
  // 인증키가 캐시 키에 들어가지 않도록 업스트림 URL이 아닌 합성 URL을 키로 쓴다.
  const cacheKey = new Request(`https://duty-fx.internal/rate/${iso}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const cached = await hit.json();
    return cached.found ? cached.row : null;
  }

  const row = await fetchOne(iso, env);
  const isToday = iso === kstToday();
  const ttl = row ? (isToday ? TTL_TODAY : TTL_PAST) : TTL_EMPTY;

  const toStore = new Response(JSON.stringify({ found: Boolean(row), row }), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, toStore.clone()));
  else await cache.put(cacheKey, toStore.clone());

  return row;
}

async function fetchOne(iso, env) {
  const ymd = iso.replace(/-/g, "");
  const target = `${UPSTREAM}?authkey=${encodeURIComponent(env.KOREAEXIM_KEY)}&searchdate=${ymd}&data=AP01`;

  let res;
  try {
    res = await fetch(target, { headers: { accept: "application/json" } });
  } catch (err) {
    throw httpError(`한국수출입은행 API에 연결하지 못했습니다: ${err.message}`, 502);
  }
  if (!res.ok) throw httpError(`한국수출입은행 API 응답 오류 (HTTP ${res.status})`, 502);

  let data;
  try {
    data = await res.json();
  } catch {
    throw httpError("한국수출입은행 API가 JSON이 아닌 응답을 보냈습니다.", 502);
  }
  if (!Array.isArray(data)) throw httpError("예상과 다른 응답 형식입니다.", 502);

  // 주말·공휴일·당일 11시 이전이면 빈 배열.
  if (data.length === 0) return null;

  const code = data[0] && data[0].result;
  // result 3은 오타뿐 아니라 키가 파기된 경우에도 나온다. 수출입은행은 개인정보
  // 보유기간(2년)이 지나면 키를 파기하며, 파기 전 등록 이메일로 재동의 안내가 간다.
  if (code === 3) {
    throw httpError(
      "인증키가 유효하지 않습니다 (result 3). 오타이거나, 보유기간 2년이 지나 키가 파기됐을 수 있습니다.",
      502
    );
  }
  if (code === 4) throw httpError("일일 호출 한도(1,000회)를 초과했습니다 (result 4).", 429);
  if (code === 2) throw httpError("요청 DATA 코드가 잘못되었습니다 (result 2).", 502);

  const row = {};
  for (const item of data) {
    if (!item || item.result !== 1) continue;
    const key = WANTED[item.cur_unit];
    if (!key) continue;
    const n = Number(String(item.deal_bas_r ?? "").replace(/,/g, "").trim());
    if (Number.isFinite(n) && n > 0) row[key] = n;
  }
  return Object.keys(row).length ? row : null;
}

// ---------------------------------------------------------------------------
// 유틸 — 전부 KST 기준 (고시가 한국 영업일 기준이므로)
// ---------------------------------------------------------------------------

function kstToday() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

function shift(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(iso) {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6;
}

function httpError(message, httpStatus) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  return err;
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

// ---------------------------------------------------------------------------
// 서울외국환중개 — 당일 매매기준율 (빠른 경로)
// ---------------------------------------------------------------------------
// 매매기준율을 실제로 고시하는 곳은 여기다. 수출입은행 오픈API는 중계일 뿐이고
// 늦는다. 2026-09-23 실측: 서울외국환중개는 09:36 이전에 이미 1,360.00이었고
// 수출입은행은 10:10:17에야 같은 값을 내놨다 — 34분 차이.
//
// 면세점 적용환율은 전일 고시분이라, 오늘 고시가 늦게 들어오면 "내일 적용환율"이
// 그만큼 늦게 뜬다. 그 34분이 이 경로를 붙이는 이유다.
//
// 이 주소는 브라우저 개발자도구로 찾았다. 페이지(TodayExRate.jsp)에는 표가 없고
// 값은 이 엔드포인트가 따로 내려준다. tr_date를 안 붙이면 오류 페이지가 온다.
//
// 응답이 쿼리스트링 모양이라 파싱이 간단하다:
//   ?test0=test&updown=0&USD=1,360.00&...&JPY=863.68&...&loading=ok&
//
// https는 526(인증서 검증 실패)이 난다. 체인이 불완전하고 Workers는 검증을
// 끌 수 없어서 http로 간다. 공개된 고시 환율이라 비밀이 오가지 않는다.
const SMBS_FLASH = "http://www.smbs.biz/Flash/TodayExRate_flash.jsp?tr_date=";
const SMBS_TTL = 60 * 10; // 하루 한 번 고시라 오래 잡아도 되지만, 고시 전 빈 응답을 오래 물지 않게

function smbsNum(raw) {
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 성공하면 { USD, JPY }, 아니면 null. 실패는 조용히 삼킨다 —
// 이건 어디까지나 빠른 경로고, 없으면 수출입은행이 받쳐준다.
async function fetchSmbs(iso) {
  try {
    const res = await fetch(SMBS_FLASH + iso, {
      headers: {
        // 기본 UA로는 막는 경우가 있다.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Referer: "http://www.smbs.biz/ExRate/TodayExRate.jsp",
      },
      cf: { cacheTtl: SMBS_TTL, cacheEverything: true },
    });
    if (!res.ok) return null;
    const text = await res.text();
    // 아직 고시 전이면 loading=ok가 안 붙거나 값이 비어서 온다.
    if (!/loading=ok/.test(text)) return null;
    const q = text.slice(text.indexOf("?") + 1);
    const params = new URLSearchParams(q);
    const USD = smbsNum(params.get("USD"));
    const JPY = smbsNum(params.get("JPY")); // 이미 100엔 기준이라 그대로 쓴다
    if (!USD && !JPY) return null;
    const row = {};
    if (USD) row.USD = USD;
    if (JPY) row.JPY = JPY;
    return row;
  } catch {
    return null;
  }
}

