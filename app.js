(function () {
  "use strict";

  var API_BASE = "https://mcp.aka.page/api";

  // ---------------------------------------------------------------------
  // 브랜드별 어댑터
  // ---------------------------------------------------------------------
  // 화면 로직은 정규화된 형태({id,name,price,imageUrl,soldOut} /
  // {storeCode,name,address,phone,hoursText,distanceKm,quantity})만 다루고,
  // API 경로/파라미터명/응답 스키마 차이는 어댑터 안에 가둔다.
  // (2026-08-19: 이마트24도 붙여봤으나 daiso-mcp → 이마트24 원천 사이트 구간에서
  // 403이 나는 문제가 있어 제거함. CU/GS25/올리브영/롯데마트는 daiso-mcp가 쓰는
  // 스크래핑 서비스(Zyte) 계정이 정지돼 있어 전부 500 에러 — 지금은 다이소만 정상.
  // 나중에 안정적으로 쓸 수 있는 곳이 생기면 이 자리에 같은 형태로 추가하면 됨.)
  var BRANDS = {
    daiso: {
      key: "daiso",
      label: "다이소",
      searchPlaceholder: "상품명을 입력하세요 (예: 수납박스)",
      manualLocationHint: "* 지역명 검색 결과는 서울시청 기준 거리로 정렬되며, 너무 먼 매장은 제외됩니다.",
      supportsDisplayLocation: true,

      searchProducts: function (q) {
        return apiGet("/daiso/products", { q: q, page: 1, pageSize: 20 }).then(function (data) {
          return (data.products || []).map(function (p) {
            return {
              id: p.id,
              name: p.name,
              price: typeof p.price === "number" ? p.price : null,
              imageUrl: p.imageUrl || null,
              soldOut: !!p.soldOut,
            };
          });
        });
      },

      fetchInventory: function (params) {
        return apiGet("/daiso/inventory", {
          productId: params.productId,
          lat: params.lat,
          lng: params.lng,
          keyword: params.keyword,
          page: 1,
          pageSize: 50,
        }).then(function (data) {
          var storeInventory = data.storeInventory || { stores: [] };
          return {
            onlineStock: typeof data.onlineStock === "number" ? data.onlineStock : null,
            stores: (storeInventory.stores || []).map(function (s) {
              return {
                storeCode: s.storeCode,
                name: s.storeName,
                address: s.address,
                phone: s.phone || null,
                hoursText: s.openTime && s.closeTime ? s.openTime + " - " + s.closeTime : null,
                distanceKm: s.distance !== undefined && s.distance !== null ? Number(s.distance) : null,
                quantity: typeof s.quantity === "number" ? s.quantity : 0,
              };
            }),
          };
        });
      },

      fetchDisplayLocation: function (params) {
        return apiGet("/daiso/display-location", {
          productId: params.productId,
          storeCode: params.storeCode,
        });
      },

      // "매장으로 찾기" 탭에서 매장을 먼저 고를 때 씀. /stores 응답에는 storeCode가
      // 없어서(직접 확인함), 이후 재고 조회 결과와는 매장명(name)으로 매칭한다.
      searchStores: function (keyword) {
        return apiGet("/daiso/stores", { keyword: keyword, limit: 20 }).then(function (data) {
          return (data.stores || []).map(function (s) {
            return {
              name: s.name,
              address: s.address,
              phone: s.phone || null,
              hoursText: s.openTime && s.closeTime ? s.openTime + " - " + s.closeTime : null,
              lat: s.lat,
              lng: s.lng,
            };
          });
        });
      },
    },
  };

  // ---------------------------------------------------------------------
  // 상태
  // ---------------------------------------------------------------------
  var state = {
    brand: "daiso",
    mode: "product", // 'product'(상품으로 찾기) | 'store'(매장으로 찾기)
    screen: "search",
    searchResults: [],
    selectedProduct: null,
    inventoryData: null,
    displayLocationCache: {}, // storeCode -> API 응답 캐시
    storeSearchResults: [],
    selectedStore: null,
  };

  function currentBrand() {
    return BRANDS[state.brand];
  }

  // ---------------------------------------------------------------------
  // DOM 참조
  // ---------------------------------------------------------------------
  var el = {
    modeTabs: document.getElementById("modeTabs"),
    viewSearch: document.getElementById("view-search"),
    viewProduct: document.getElementById("view-product"),
    viewStoreSearch: document.getElementById("view-store-search"),
    viewStoreProducts: document.getElementById("view-store-products"),
    searchForm: document.getElementById("searchForm"),
    searchInput: document.getElementById("searchInput"),
    searchErrorBox: document.getElementById("searchErrorBox"),
    searchLoading: document.getElementById("searchLoading"),
    searchResults: document.getElementById("searchResults"),
    backButton: document.getElementById("backButton"),
    productHeader: document.getElementById("productHeader"),
    locationStatus: document.getElementById("locationStatus"),
    manualLocationForm: document.getElementById("manualLocationForm"),
    manualLocationInput: document.getElementById("manualLocationInput"),
    manualLocationHint: document.getElementById("manualLocationHint"),
    inventoryLoading: document.getElementById("inventoryLoading"),
    inventoryErrorBox: document.getElementById("inventoryErrorBox"),
    inventorySummary: document.getElementById("inventorySummary"),
    storeList: document.getElementById("storeList"),
    storeSearchForm: document.getElementById("storeSearchForm"),
    storeSearchInput: document.getElementById("storeSearchInput"),
    storeSearchErrorBox: document.getElementById("storeSearchErrorBox"),
    storeSearchLoading: document.getElementById("storeSearchLoading"),
    storeSearchResults: document.getElementById("storeSearchResults"),
    backToStoreSearchButton: document.getElementById("backToStoreSearchButton"),
    storeProductHeader: document.getElementById("storeProductHeader"),
    storeProductForm: document.getElementById("storeProductForm"),
    storeProductInput: document.getElementById("storeProductInput"),
    storeProductErrorBox: document.getElementById("storeProductErrorBox"),
    storeProductLoading: document.getElementById("storeProductLoading"),
    storeProductResults: document.getElementById("storeProductResults"),
  };

  // ---------------------------------------------------------------------
  // 유틸
  // ---------------------------------------------------------------------
  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatPrice(price) {
    if (typeof price !== "number") return "";
    return price.toLocaleString("ko-KR") + "원";
  }

  function formatDistanceKm(distanceKm) {
    if (typeof distanceKm !== "number" || Number.isNaN(distanceKm)) return null;
    return (Math.round(distanceKm * 10) / 10) + "km";
  }

  // 지역명으로 검색할 때 반환되는 매장 목록은 이름/주소 텍스트 매칭 결과라
  // 엉뚱하게 먼 지역의 매장이 섞여 나올 수 있다(예: "삼성역" 검색 시 충북 음성군
  // 매장이 포함됨 - 다이소 API로 직접 확인함). distanceKm이 있는 경우에 한해
  // 거리순 정렬 + 너무 먼 매장 제외로 걸러낸다. distanceKm이 없으면(예: 이마트24
  // 키워드 검색) 순서를 그대로 둔다 — 없는 정보를 억지로 추정하지 않는다.
  var MAX_REASONABLE_DISTANCE_KM = 30;

  function sortAndFilterByDistance(stores) {
    var sorted = stores.slice().sort(function (a, b) {
      var da = typeof a.distanceKm === "number" ? a.distanceKm : Infinity;
      var db = typeof b.distanceKm === "number" ? b.distanceKm : Infinity;
      return da - db;
    });
    var nearby = sorted.filter(function (s) {
      return typeof s.distanceKm !== "number" || s.distanceKm <= MAX_REASONABLE_DISTANCE_KM;
    });
    // 반경 내 매장이 하나도 없으면(외곽 지역 등) 그냥 가까운 순서대로 몇 곳만 보여준다.
    return nearby.length > 0 ? nearby : sorted.slice(0, 5);
  }

  function setHidden(node, hidden) {
    if (node) node.hidden = hidden;
  }

  // ---------------------------------------------------------------------
  // API 클라이언트 (공통 fetch 래퍼 — 브랜드별 함수는 위 BRANDS 안에서 사용)
  // ---------------------------------------------------------------------
  function apiGet(path, params) {
    var url = new URL(API_BASE + path);
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });

    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, 15000); // 이마트24 등 스크래핑 기반 엔드포인트는 다이소보다 느릴 수 있어 여유를 둠

    // 원인 파악이 안 되는 실패가 반복돼서, 실패 시 무슨 일이 있었는지 콘솔(F12)에서
    // 바로 확인할 수 있도록 요청/응답 정보를 남긴다. UI 문구는 그대로 두고 진단 정보만 추가.
    return fetch(url.toString(), { signal: controller.signal })
      .catch(function (err) {
        console.error("[재고확인] 네트워크 요청 자체가 실패함:", url.toString(), err);
        var e = new Error("NETWORK_ERROR");
        e.cause = err;
        throw e;
      })
      .then(function (res) {
        if (res.status === 429) {
          console.error("[재고확인] 429 rate limit:", url.toString());
          var rateErr = new Error("RATE_LIMIT");
          rateErr.status = 429;
          throw rateErr;
        }
        if (!res.ok) {
          return res.text().then(function (bodyText) {
            console.error("[재고확인] HTTP 오류 응답:", url.toString(), res.status, bodyText);
            var apiErr = new Error("API_ERROR");
            apiErr.status = res.status;
            throw apiErr;
          });
        }
        return res.json();
      })
      .then(function (json) {
        if (!json || json.success !== true) {
          console.error("[재고확인] success:false 응답:", url.toString(), json);
          var e2 = new Error("API_ERROR");
          if (json && json.error && json.error.message) e2.message = json.error.message;
          throw e2;
        }
        return json.data;
      })
      .finally(function () {
        clearTimeout(timeoutId);
      });
  }

  function withRetry(fn, options) {
    // 이마트24는 실시간 스크래핑 기반이라 다이소보다 5xx가 자주 발생한다(직접 확인함).
    // 재시도 횟수를 조금 넉넉히 잡아 일시적인 실패를 더 잘 넘기도록 한다.
    var retries = (options && options.retries) || 3;
    var baseDelayMs = (options && options.baseDelayMs) || 700;

    function attempt(n) {
      return fn().catch(function (err) {
        if (err && err.status === 429) throw err; // rate limit은 재시도하지 않음
        if (n >= retries) throw err;
        var delay = baseDelayMs * Math.pow(2, n);
        return new Promise(function (resolve) {
          setTimeout(resolve, delay);
        }).then(function () {
          return attempt(n + 1);
        });
      });
    }

    return attempt(0);
  }

  function mapError(err) {
    if (err && err.status === 429) {
      return "오늘 조회 가능 횟수를 초과한 것 같습니다. 잠시 후 다시 시도해주세요.";
    }
    if (err && err.message === "NETWORK_ERROR") {
      return "네트워크 연결을 확인해주세요.";
    }
    if (err && err.status >= 500) {
      return "정보를 불러오는 서비스에 일시적인 문제가 있습니다(" + currentBrand().label + "). 잠시 후 다시 시도해주세요.";
    }
    return "정보를 불러오지 못했습니다. 다시 시도해주세요.";
  }

  // ---------------------------------------------------------------------
  // 화면 전환 / 모드 탭
  // ---------------------------------------------------------------------
  function navigateTo(screen) {
    state.screen = screen;
    setHidden(el.viewSearch, screen !== "search");
    setHidden(el.viewProduct, screen !== "product");
    setHidden(el.viewStoreSearch, screen !== "store-search");
    setHidden(el.viewStoreProducts, screen !== "store-products");
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;

    Array.prototype.forEach.call(el.modeTabs.querySelectorAll(".mode-tab"), function (tab) {
      tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
    });

    navigateTo(mode === "product" ? "search" : "store-search");
  }

  el.modeTabs.addEventListener("click", function (e) {
    var tab = e.target.closest(".mode-tab");
    if (!tab) return;
    setMode(tab.dataset.mode);
  });

  // ---------------------------------------------------------------------
  // 검색 화면
  // ---------------------------------------------------------------------
  function renderInlineError(box, message, retryFn) {
    if (!box) return;
    box.hidden = false;
    box.innerHTML =
      "<p>" + esc(message) + "</p>" +
      (retryFn ? '<button type="button" class="error-box__retry">다시 시도</button>' : "");
    if (retryFn) {
      var btn = box.querySelector(".error-box__retry");
      btn.addEventListener("click", function () {
        box.hidden = true;
        retryFn();
      });
    }
  }

  function clearInlineError(box) {
    if (!box) return;
    box.hidden = true;
    box.innerHTML = "";
  }

  function renderSearchResults(products) {
    if (!products || products.length === 0) {
      el.searchResults.innerHTML =
        '<li class="empty-state">검색 결과가 없습니다. 다른 검색어로 시도해보세요.</li>';
      return;
    }

    el.searchResults.innerHTML = products
      .map(function (p, index) {
        var soldOutBadge = p.soldOut
          ? '<span class="badge badge--soldout">품절</span>'
          : "";
        var thumb = p.imageUrl
          ? '<img src="' + esc(p.imageUrl) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'" />'
          : '<div class="product-card__placeholder">🏪</div>';
        return (
          '<li class="product-card" data-index="' + index + '" role="button" tabindex="0">' +
          thumb +
          '<div class="product-card__info">' +
          '<p class="product-card__name">' + esc(p.name) + soldOutBadge + "</p>" +
          '<p class="product-card__price">' + esc(formatPrice(p.price)) + "</p>" +
          "</div>" +
          "</li>"
        );
      })
      .join("");
  }

  function runSearch(q) {
    clearInlineError(el.searchErrorBox);
    el.searchResults.innerHTML = "";
    el.searchLoading.hidden = false;

    return withRetry(function () {
      return currentBrand().searchProducts(q);
    })
      .then(function (products) {
        state.searchResults = products;
        renderSearchResults(products);
      })
      .catch(function (err) {
        renderInlineError(el.searchErrorBox, mapError(err), function () {
          runSearch(q);
        });
      })
      .finally(function () {
        el.searchLoading.hidden = true;
      });
  }

  el.searchForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = el.searchInput.value.trim();
    if (!q) return;
    runSearch(q);
  });

  el.searchResults.addEventListener("click", function (e) {
    var card = e.target.closest(".product-card");
    if (!card) return;
    var index = Number(card.dataset.index);
    var product = state.searchResults[index];
    if (product) selectProduct(product);
  });

  el.searchResults.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var card = e.target.closest(".product-card");
    if (!card) return;
    e.preventDefault();
    var index = Number(card.dataset.index);
    var product = state.searchResults[index];
    if (product) selectProduct(product);
  });

  // ---------------------------------------------------------------------
  // 상품 상세 / 재고 화면
  // ---------------------------------------------------------------------
  function selectProduct(product) {
    state.selectedProduct = product;
    state.inventoryData = null;
    state.displayLocationCache = {};

    navigateTo("product");
    renderProductHeader(product);
    setHidden(el.manualLocationForm, true);
    setHidden(el.manualLocationHint, true);
    el.storeList.innerHTML = "";
    el.inventorySummary.hidden = true;
    clearInlineError(el.inventoryErrorBox);

    resolveLocationAndFetchInventory();
  }

  function renderProductHeader(product) {
    var soldOutBadge = product.soldOut
      ? '<span class="badge badge--soldout">품절</span>'
      : "";
    var thumb = product.imageUrl
      ? '<img src="' + esc(product.imageUrl) + '" alt="" onerror="this.style.visibility=\'hidden\'" />'
      : '<div class="product-header__placeholder">🏪</div>';
    el.productHeader.innerHTML =
      thumb +
      "<div>" +
      '<p class="product-header__name">' + esc(product.name) + soldOutBadge + "</p>" +
      '<p class="product-header__meta">' + esc(formatPrice(product.price)) + "</p>" +
      "</div>";
  }

  function resolveLocationAndFetchInventory() {
    el.locationStatus.textContent = "내 위치를 확인하는 중...";
    setHidden(el.manualLocationForm, true);
    setHidden(el.manualLocationHint, true);

    if (!("geolocation" in navigator)) {
      showManualLocationFallback(
        "이 브라우저는 위치 정보를 지원하지 않습니다. 지역명이나 매장명을 입력해주세요."
      );
      return;
    }

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        el.locationStatus.textContent = "내 위치 기준 근처 매장을 조회합니다.";
        fetchAndRenderInventory({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      },
      function (err) {
        var message =
          err.code === err.PERMISSION_DENIED
            ? "위치 권한이 거부되었습니다. 지역명이나 매장명을 검색해 매장을 찾아보세요."
            : "위치 정보를 가져오지 못했습니다. 지역명이나 매장명을 검색해 매장을 찾아보세요.";
        showManualLocationFallback(message);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  function showManualLocationFallback(message) {
    el.locationStatus.textContent = message;
    setHidden(el.manualLocationForm, false);
    var hint = currentBrand().manualLocationHint;
    if (hint) {
      el.manualLocationHint.textContent = hint;
      setHidden(el.manualLocationHint, false);
    } else {
      setHidden(el.manualLocationHint, true);
    }
    el.manualLocationInput.focus();
  }

  el.manualLocationForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var keyword = el.manualLocationInput.value.trim();
    if (!keyword) return;
    el.locationStatus.textContent = '"' + keyword + '" 근처 매장을 조회합니다.';
    fetchAndRenderInventory({ keyword: keyword });
  });

  function fetchAndRenderInventory(locationParams) {
    setHidden(el.inventoryLoading, false);
    clearInlineError(el.inventoryErrorBox);
    el.storeList.innerHTML = "";
    el.inventorySummary.hidden = true;

    var params = Object.assign({ productId: state.selectedProduct.id }, locationParams);

    return withRetry(function () {
      return currentBrand().fetchInventory(params);
    })
      .then(function (data) {
        state.inventoryData = data;
        renderInventory(data);
      })
      .catch(function (err) {
        renderInlineError(el.inventoryErrorBox, mapError(err), function () {
          fetchAndRenderInventory(locationParams);
        });
      })
      .finally(function () {
        setHidden(el.inventoryLoading, true);
      });
  }

  function renderInventory(data) {
    var stores = sortAndFilterByDistance(data.stores || []);
    var inStockCount = stores.filter(function (s) { return s.quantity > 0; }).length;

    el.inventorySummary.hidden = false;
    var onlineText =
      typeof data.onlineStock === "number"
        ? " · 온라인 재고 " + data.onlineStock + "개"
        : "";
    el.inventorySummary.textContent =
      "매장 " + stores.length + "곳 중 " + inStockCount + "곳 재고 보유" + onlineText;

    if (stores.length === 0) {
      el.storeList.innerHTML =
        '<li class="empty-state">근처에서 매장 정보를 찾지 못했습니다. 다른 지역명으로 검색해보세요.</li>';
      return;
    }

    el.storeList.innerHTML = stores.map(renderStoreRow).join("");
    autoLoadDisplayLocations(stores);
  }

  // 매장을 클릭하지 않아도 진열 위치(구역/층)가 바로 보이도록, 재고가 있는 매장에 한해
  // 목록을 그리자마자 각자 알아서 조회한다(품절 매장은 어차피 갈 이유가 없어 생략).
  function autoLoadDisplayLocations(stores) {
    if (!currentBrand().fetchDisplayLocation) return;

    stores.forEach(function (store) {
      if (!(store.quantity > 0)) return;
      var box = el.storeList.querySelector(
        '.store-row[data-store-code="' + CSS.escape(store.storeCode) + '"] .store-row__location'
      );
      if (!box) return;
      loadDisplayLocation(store.storeCode, box);
    });
  }

  function loadDisplayLocation(storeCode, box) {
    var cached = state.displayLocationCache[storeCode];
    if (cached) {
      box.innerHTML = cached;
      return;
    }

    box.textContent = "위치 확인 중...";

    withRetry(function () {
      return currentBrand().fetchDisplayLocation({
        productId: state.selectedProduct.id,
        storeCode: storeCode,
      });
    })
      .then(function (loc) {
        var html;
        if (loc.hasLocation && loc.locations && loc.locations.length > 0) {
          html = loc.locations
            .map(function (l) {
              return "<p>구역 " + esc(l.zoneNo) + " · " + esc(l.stairNo) + "층</p>";
            })
            .join("");
        } else {
          html = '<p class="muted">' + esc(loc.message || "진열 위치 정보가 없습니다.") + "</p>";
        }
        state.displayLocationCache[storeCode] = html;
        box.innerHTML = html;
      })
      .catch(function () {
        box.innerHTML = '<p class="muted">위치 정보를 불러오지 못했습니다. <a href="#" class="loc-retry">다시 시도</a></p>';
      });
  }

  function renderStoreRow(store) {
    var qty = store.quantity || 0;
    var soldOut = qty <= 0;
    var distanceText = formatDistanceKm(store.distanceKm);
    var canExpand = !!currentBrand().fetchDisplayLocation;

    var metaParts = [esc(store.address)];
    if (distanceText) metaParts.push(esc(distanceText));
    if (store.hoursText) metaParts.push(esc(store.hoursText));

    return (
      '<li class="store-row' + (soldOut ? " store-row--soldout" : "") + '" data-store-code="' +
      esc(store.storeCode) +
      '">' +
      '<div class="store-row__top">' +
      '<span class="store-row__name">' + esc(store.name) + "</span>" +
      '<span class="store-row__qty ' + (soldOut ? "qty--none" : "qty--ok") + '">' +
      (soldOut ? "재고 없음" : "재고 " + qty + "개") +
      "</span>" +
      "</div>" +
      '<div class="store-row__meta">' +
      metaParts.map(function (part) { return "<span>" + part + "</span>"; }).join("") +
      "</div>" +
      (store.phone
        ? '<a class="store-row__tel" href="tel:' + esc(store.phone) + '">전화하기</a>'
        : "") +
      (canExpand && !soldOut ? '<div class="store-row__location">위치 확인 중...</div>' : "") +
      "</li>"
    );
  }

  // 자동 조회가 실패했을 때만 쓰는 수동 재시도 링크
  el.storeList.addEventListener("click", function (e) {
    var retryLink = e.target.closest(".loc-retry");
    if (!retryLink) return;
    e.preventDefault();
    var row = retryLink.closest(".store-row");
    var box = retryLink.closest(".store-row__location");
    if (!row || !box) return;
    delete state.displayLocationCache[row.dataset.storeCode];
    loadDisplayLocation(row.dataset.storeCode, box);
  });

  el.backButton.addEventListener("click", function () {
    navigateTo("search");
  });

  // ---------------------------------------------------------------------
  // 매장으로 찾기 (매장을 먼저 고르고, 그 매장에 있는 상품을 찾는 흐름)
  // ---------------------------------------------------------------------
  // API에 "특정 매장의 전체 상품 목록"을 주는 기능이 없어서(직접 확인함), 키워드로
  // 상품을 검색한 뒤 상품 하나하나를 선택된 매장 좌표 기준으로 재고 조회해서
  // "이 매장에 있는지"를 우회적으로 확인한다. 상품 수만큼 API 호출이 늘어나므로
  // 후보를 STORE_PRODUCT_LIMIT개로 제한하고, 동시 요청 수도 제한한다.
  var STORE_PRODUCT_LIMIT = 12;
  var STORE_PRODUCT_CONCURRENCY = 4;

  function runWithConcurrency(items, limit, worker) {
    var results = new Array(items.length);
    var nextIndex = 0;

    function runNext() {
      var i = nextIndex++;
      if (i >= items.length) return Promise.resolve();
      return worker(items[i], i).then(function (r) {
        results[i] = r;
        return runNext();
      });
    }

    var starters = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) starters.push(runNext());
    return Promise.all(starters).then(function () {
      return results;
    });
  }

  function renderStoreSearchResults(stores) {
    if (!stores || stores.length === 0) {
      el.storeSearchResults.innerHTML =
        '<li class="empty-state">검색 결과가 없습니다. 다른 검색어로 시도해보세요.</li>';
      return;
    }

    el.storeSearchResults.innerHTML = stores
      .map(function (s, index) {
        var metaParts = [esc(s.address)];
        if (s.hoursText) metaParts.push(esc(s.hoursText));
        return (
          '<li class="store-card" data-index="' + index + '" role="button" tabindex="0">' +
          '<p class="store-card__name">' + esc(s.name) + "</p>" +
          '<p class="store-card__meta">' +
          metaParts.map(function (part) { return "<span>" + part + "</span>"; }).join("") +
          "</p>" +
          "</li>"
        );
      })
      .join("");
  }

  function runStoreSearch(keyword) {
    clearInlineError(el.storeSearchErrorBox);
    el.storeSearchResults.innerHTML = "";
    el.storeSearchLoading.hidden = false;

    return withRetry(function () {
      return currentBrand().searchStores(keyword);
    })
      .then(function (stores) {
        state.storeSearchResults = stores;
        renderStoreSearchResults(stores);
      })
      .catch(function (err) {
        renderInlineError(el.storeSearchErrorBox, mapError(err), function () {
          runStoreSearch(keyword);
        });
      })
      .finally(function () {
        el.storeSearchLoading.hidden = true;
      });
  }

  el.storeSearchForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var keyword = el.storeSearchInput.value.trim();
    if (!keyword) return;
    runStoreSearch(keyword);
  });

  function selectStoreFromList(index) {
    var store = state.storeSearchResults[index];
    if (!store) return;
    state.selectedStore = store;

    navigateTo("store-products");
    renderStoreProductHeader(store);
    el.storeProductInput.value = "";
    el.storeProductResults.innerHTML = "";
    clearInlineError(el.storeProductErrorBox);
    el.storeProductInput.focus();
  }

  el.storeSearchResults.addEventListener("click", function (e) {
    var card = e.target.closest(".store-card");
    if (!card) return;
    selectStoreFromList(Number(card.dataset.index));
  });

  el.storeSearchResults.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var card = e.target.closest(".store-card");
    if (!card) return;
    e.preventDefault();
    selectStoreFromList(Number(card.dataset.index));
  });

  function renderStoreProductHeader(store) {
    var metaParts = [esc(store.address)];
    if (store.hoursText) metaParts.push(esc(store.hoursText));
    el.storeProductHeader.innerHTML =
      '<div class="product-header__placeholder">🏬</div>' +
      "<div>" +
      '<p class="product-header__name">' + esc(store.name) + "</p>" +
      '<p class="product-header__meta">' + metaParts.join(" · ") + "</p>" +
      "</div>";
  }

  el.backToStoreSearchButton.addEventListener("click", function () {
    navigateTo("store-search");
  });

  function renderStoreProductSkeleton(products) {
    el.storeProductResults.innerHTML = products
      .map(function (p) {
        var thumb = p.imageUrl
          ? '<img src="' + esc(p.imageUrl) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'" />'
          : '<div class="product-card__placeholder">🏪</div>';
        return (
          '<li class="product-card" data-product-id="' + esc(p.id) + '">' +
          thumb +
          '<div class="product-card__info">' +
          '<p class="product-card__name">' + esc(p.name) + "</p>" +
          '<p class="product-card__price">' + esc(formatPrice(p.price)) +
          '<span class="stock-badge stock-badge--pending">확인 중...</span></p>' +
          "</div>" +
          "</li>"
        );
      })
      .join("");
  }

  function updateStoreProductBadge(productId, result) {
    var row = el.storeProductResults.querySelector('.product-card[data-product-id="' + CSS.escape(productId) + '"]');
    if (!row) return;
    var badge = row.querySelector(".stock-badge");
    if (!badge) return;

    if (result.status === "in") {
      badge.className = "stock-badge stock-badge--in";
      badge.textContent = "재고 " + result.quantity + "개";
    } else if (result.status === "out") {
      badge.className = "stock-badge stock-badge--out";
      badge.textContent = "재고 없음";
    } else {
      // 'unknown'(이 매장이 재고 추적 대상에 없음) / 'error'(조회 실패) 모두
      // "확인 불가"로 통일 — 사용자 입장에선 원인 구분보다 결과가 중요.
      badge.className = "stock-badge stock-badge--unknown";
      badge.textContent = "확인 불가";
    }
  }

  function checkProductAtStore(product, store) {
    // lat/lng 기반 "주변 매장" 조회는 실제 거리와 무관하게 정해진 소수의 매장만
    // 돌려주는 문제가 있어(직접 확인함 — 시흥능곡점 좌표로 조회해도 24km 떨어진
    // 매봉역점만 나옴), 매장명을 keyword로 넘겨 이름으로 정확히 찾는 방식을 쓴다.
    return withRetry(function () {
      return currentBrand().fetchInventory({ productId: product.id, keyword: store.name });
    })
      .then(function (data) {
        var match = (data.stores || []).find(function (s) { return s.name === store.name; });
        if (!match) return { status: "unknown" };
        return match.quantity > 0 ? { status: "in", quantity: match.quantity } : { status: "out" };
      })
      .catch(function () {
        return { status: "error" };
      });
  }

  function runStoreProductSearch(keyword) {
    clearInlineError(el.storeProductErrorBox);
    el.storeProductResults.innerHTML = "";
    el.storeProductLoading.hidden = false;
    var store = state.selectedStore;

    return withRetry(function () {
      return currentBrand().searchProducts(keyword);
    })
      .then(function (products) {
        products = products.slice(0, STORE_PRODUCT_LIMIT);
        if (products.length === 0) {
          el.storeProductResults.innerHTML =
            '<li class="empty-state">검색 결과가 없습니다. 다른 검색어로 시도해보세요.</li>';
          return;
        }

        renderStoreProductSkeleton(products);

        // 목록은 이미 그려졌으니 재고 확인은 백그라운드로 진행 — 화면 전체 로딩과
        // 별개로 각 상품 배지가 알아서 채워진다(진열 위치 자동조회와 같은 방식).
        runWithConcurrency(products, STORE_PRODUCT_CONCURRENCY, function (product) {
          return checkProductAtStore(product, store).then(function (result) {
            updateStoreProductBadge(product.id, result);
            return result;
          });
        });
      })
      .catch(function (err) {
        renderInlineError(el.storeProductErrorBox, mapError(err), function () {
          runStoreProductSearch(keyword);
        });
      })
      .finally(function () {
        el.storeProductLoading.hidden = true;
      });
  }

  el.storeProductForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var keyword = el.storeProductInput.value.trim();
    if (!keyword) return;
    runStoreProductSearch(keyword);
  });
})();
