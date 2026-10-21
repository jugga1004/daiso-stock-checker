(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 면세점 환율 탭 (장보기 체크 자체 구현 — 다른 서비스와 연결하지 않는다)
  // ---------------------------------------------------------------------
  // Worker(worker/duty-fx.js) 배포 후 주소를 넣는다. 비워두면 "준비 중"으로 보인다.
  // 예: "https://duty-fx.<계정>.workers.dev"
  var DUTY_FX_API = "https://duty-fx.jugga1004.workers.dev";

  var ITEMS_KEY = "daiso-stock-checker:dutyItems";
  var RATES_KEY = "daiso-stock-checker:dutyRatesCache";
  var WEEK_DAYS = 7;
  var QUOTE_HOUR = 9; // 매매기준율 최초 고시는 영업일 오전
  var WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

  var state = { rates: null, loading: false, error: "" };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function num(v, digits) {
    if (!isFinite(v)) return "—";
    return v.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function rate(v) {
    return num(v, 1); // 매매기준율은 소수점 한 자리로 고시된다
  }

  function won(v) {
    if (!isFinite(v)) return "—";
    return Math.round(v).toLocaleString("ko-KR") + "원";
  }

  function signedWon(v) {
    if (!isFinite(v)) return "—";
    var r = Math.round(v);
    return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r).toLocaleString("ko-KR") + "원";
  }

  // ---------------------------------------------------------------------
  // 날짜 (고시가 한국 영업일 기준이라 전부 KST로 다룬다)
  // ---------------------------------------------------------------------
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function kstNow() {
    var now = new Date();
    return new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
  }

  function toIso(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseIso(iso) {
    var p = iso.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function todayIso() {
    return toIso(kstNow());
  }

  function shift(iso, days) {
    var d = parseIso(iso);
    d.setDate(d.getDate() + days);
    return toIso(d);
  }

  function dayLabel(iso) {
    return iso.slice(5) + " (" + WEEKDAY_KO[parseIso(iso).getDay()] + ")";
  }

  // ---------------------------------------------------------------------
  // 적용환율 계산
  // ---------------------------------------------------------------------
  // 면세점은 '전일 고시 매매기준율'을 적용한다. 날짜 D의 적용환율은 D보다 앞선
  // 가장 최근 고시분이다. 주말·공휴일에는 고시가 없어 직전 영업일 값이 이어진다.
  function usdRates() {
    var out = {};
    var rows = (state.rates && state.rates.rates) || {};
    Object.keys(rows).forEach(function (d) {
      if (typeof rows[d].USD === "number") out[d] = rows[d].USD;
    });
    return out;
  }

  function appliedOn(iso) {
    var all = usdRates();
    var dates = Object.keys(all).sort();
    for (var i = dates.length - 1; i >= 0; i--) {
      if (dates[i] >= iso) continue; // 당일 고시는 '내일' 적용분
      return { appliedDate: iso, quoteDate: dates[i], rate: all[dates[i]] };
    }
    return null;
  }

  // 내일 적용분은 '오늘 고시'가 나와야 확정된다. 없으면 null — 오늘 값으로 때우지 않는다.
  function appliedTomorrow() {
    var today = todayIso();
    var v = usdRates()[today];
    if (typeof v !== "number") return null;
    return { appliedDate: shift(today, 1), quoteDate: today, rate: v };
  }

  function appliedSeries(days) {
    var out = [];
    var today = todayIso();
    for (var i = days - 1; i >= 0; i--) {
      var r = appliedOn(shift(today, -i));
      if (r) out.push(r);
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // 관심 상품 저장 (이 브라우저의 localStorage에만 저장)
  // ---------------------------------------------------------------------
  function loadItems() {
    try {
      var parsed = JSON.parse(localStorage.getItem(ITEMS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveItems(items) {
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(items));
    } catch (e) {
      // 저장소를 못 쓰는 환경이면 이번 세션에서만 유지된다
    }
  }

  function newId() {
    return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function addItem(name, usd, url) {
    var n = Number(usd);
    if (!(n > 0)) throw new Error("면세점 달러가를 0보다 큰 숫자로 입력해주세요.");
    var items = loadItems();
    items.push({ id: newId(), name: String(name || "").trim(), usd: n, url: String(url || "").trim() });
    saveItems(items);
  }

  function updateItemUsd(id, usd) {
    var n = Number(usd);
    if (!(n > 0)) throw new Error("달러가는 0보다 커야 합니다.");
    var items = loadItems();
    items.forEach(function (it) {
      if (it.id === id) it.usd = n;
    });
    saveItems(items);
  }

  function removeItem(id) {
    saveItems(
      loadItems().filter(function (it) {
        return it.id !== id;
      })
    );
  }

  // ---------------------------------------------------------------------
  // Worker 호출
  // ---------------------------------------------------------------------
  function fetchJson(path) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 20000);
    return fetch(DUTY_FX_API.replace(/\/+$/, "") + path, { signal: controller.signal })
      .then(function (res) {
        return res.json().catch(function () {
          throw new Error("서버 응답을 읽지 못했습니다 (HTTP " + res.status + ")");
        });
      })
      .then(function (body) {
        if (!body || body.ok === false) throw new Error((body && body.error) || "조회하지 못했습니다.");
        return body;
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  function loadRates() {
    if (!DUTY_FX_API || state.loading) return Promise.resolve();
    state.loading = true;
    state.error = "";
    return fetchJson("/v1/recent?days=10")
      .then(function (body) {
        state.rates = body;
        try {
          localStorage.setItem(RATES_KEY, JSON.stringify(body));
        } catch (e) {
          // 캐시는 없어도 된다
        }
      })
      .catch(function (err) {
        state.error = err.name === "AbortError" ? "응답이 늦어 조회하지 못했습니다." : err.message;
      })
      .finally(function () {
        state.loading = false;
        render();
      });
  }

  // ---------------------------------------------------------------------
  // 화면
  // ---------------------------------------------------------------------
  function stat(label, value, sub, cls) {
    return (
      '<div class="stat"><div class="stat__label">' + esc(label) + '</div><div class="stat__value ' + (cls || "") + '">' +
      value + "</div>" + (sub ? '<div class="stat__sub">' + sub + "</div>" : "") + "</div>"
    );
  }

  // 값이 없을 때만 왜 없는지 말해준다.
  function tomorrowSub(tomorrow) {
    if (tomorrow) return "";
    var now = kstNow();
    var day = now.getDay();
    if (day === 0 || day === 6) return "<br />주말 — 고시 없음";
    return now.getHours() >= QUOTE_HOUR ? "<br />고시 반영 대기 중" : "<br />오늘 고시 후 확정";
  }

  function renderEstimate() {
    var box = $("dutyEstimate");
    if (!DUTY_FX_API) {
      box.innerHTML =
        '<div class="duty-card"><h2>적용환율</h2><p class="muted small">준비 중입니다. 환율 데이터 서버를 연결하면 오늘·내일 면세점 적용환율이 표시됩니다.</p></div>';
      return;
    }
    if (!state.rates) {
      box.innerHTML =
        '<div class="duty-card"><h2>적용환율</h2><p class="muted small">' +
        (state.error
          ? esc(state.error) + ' <button type="button" class="link-btn" id="dutyRetry">다시 시도</button>'
          : "환율을 불러오는 중...") +
        "</p></div>";
      return;
    }

    var today = todayIso();
    var yesterday = shift(today, -1);
    var yd = appliedOn(yesterday);
    var td = appliedOn(today);
    var tm = appliedTomorrow();
    if (!td) {
      box.innerHTML = '<div class="duty-card"><h2>적용환율</h2><p class="muted small">오늘 이전의 매매기준율을 찾지 못했습니다.</p></div>';
      return;
    }

    var diff = tm ? tm.rate - td.rate : NaN;
    var diffYd = yd ? td.rate - yd.rate : NaN;
    box.innerHTML =
      '<div class="duty-card">' +
      '<div class="duty-card__head"><h2>적용환율 (미국 달러)</h2><span class="muted small">전일 고시 매매기준율 기준</span></div>' +
      '<div class="stat-grid">' +
      stat("어제", yd ? rate(yd.rate) + "원" : "—", dayLabel(yesterday)) +
      stat("오늘", rate(td.rate) + "원", dayLabel(today), isFinite(diffYd) ? (diffYd > 0 ? "neg" : diffYd < 0 ? "pos" : "") : "") +
      stat("내일", tm ? rate(tm.rate) + "원" : "미정", dayLabel(shift(today, 1)) + tomorrowSub(tm), isFinite(diff) ? (diff > 0 ? "neg" : diff < 0 ? "pos" : "") : "") +
      "</div>" +
      (isFinite(diff)
        ? '<p class="duty-note">내일 적용환율은 오늘보다 <strong>' + rate(Math.abs(diff)) + "원 " +
          (diff > 0 ? "올라갑니다" : diff < 0 ? "내려갑니다" : "같습니다") + "</strong>.</p>"
        : "") +
      "</div>";
  }

  function renderWeek() {
    var box = $("dutyWeek");
    if (!state.rates) {
      box.innerHTML = "";
      return;
    }
    var series = appliedSeries(WEEK_DAYS);
    if (!series.length) {
      box.innerHTML = "";
      return;
    }
    var tm = appliedTomorrow();
    var all = tm ? series.concat([tm]) : series;
    var today = todayIso();

    var rows = all
      .slice()
      .reverse()
      .map(function (r, idxFromTop) {
        var pos = all.length - 1 - idxFromTop;
        var d = pos > 0 ? r.rate - all[pos - 1].rate : NaN;
        var isTm = tm && r.appliedDate === tm.appliedDate;
        var isToday = r.appliedDate === today;
        return (
          '<tr class="' + (isTm ? "row-hi" : "") + '"><th>' + esc(dayLabel(r.appliedDate)) +
          (isTm ? ' <span class="duty-badge">내일</span>' : isToday ? ' <span class="duty-badge">오늘</span>' : "") +
          "</th><td><strong>" + rate(r.rate) + "</strong>원</td><td class=\"" +
          (isFinite(d) ? (d > 0 ? "neg" : d < 0 ? "pos" : "muted") : "muted") + '">' +
          (!isFinite(d) ? "—" : d === 0 ? rate(0) : (d > 0 ? "▲ " : "▼ ") + rate(Math.abs(d))) + "</td></tr>"
        );
      })
      .join("");

    box.innerHTML =
      '<div class="duty-card"><h2>최근 ' + WEEK_DAYS + "일 적용환율</h2>" +
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>적용일</th><th>적용환율</th><th>전일 대비</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" +
      '<p class="muted small">주말·공휴일에는 새 고시가 없어 직전 영업일 값이 그대로 이어집니다.</p></div>';
  }

  function renderItems() {
    var box = $("dutyItems");
    var items = loadItems();
    if (!items.length) {
      box.innerHTML = '<p class="muted small">등록한 상품이 없습니다. 위에 가격을 넣고 추가해보세요.</p>';
      return;
    }

    var today = todayIso();
    var yd = state.rates ? appliedOn(shift(today, -1)) : null;
    var td = state.rates ? appliedOn(today) : null;
    var tm = state.rates ? appliedTomorrow() : null;

    var totalUsd = 0;
    var rows = items
      .map(function (it) {
        totalUsd += it.usd;
        var yk = yd ? it.usd * yd.rate : NaN;
        var tk = td ? it.usd * td.rate : NaN;
        var mk = tm ? it.usd * tm.rate : NaN;
        var d = isFinite(mk) && isFinite(tk) ? mk - tk : NaN;
        var label = it.name ? '<span class="item-name__text" title="' + esc(it.name) + '">' + esc(it.name) + "</span>" : '<span class="muted">이름 없음</span>';
        return (
          '<tr><th class="item-name">' +
          (it.url ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + label + " ↗</a>" : label) +
          '</th><td><span class="usd-edit">$<input type="number" step="0.01" min="0" data-usd="' + esc(it.id) +
          '" value="' + num(it.usd, 2).replace(/,/g, "") + '" aria-label="면세점 달러가" /></span></td>' +
          '<td class="muted">' + (isFinite(yk) ? won(yk) : "—") + "</td>" +
          "<td>" + (isFinite(tk) ? won(tk) : "—") + "</td>" +
          "<td>" + (isFinite(mk) ? won(mk) : '<span class="muted">미정</span>') + "</td>" +
          '<td class="' + (isFinite(d) ? (d > 0 ? "neg" : d < 0 ? "pos" : "muted") : "muted") + '">' + (isFinite(d) ? signedWon(d) : "—") + "</td>" +
          "<td>" + (it.url ? '<button type="button" class="link-btn" data-refresh="' + esc(it.id) + '">새로고침</button> · ' : "") +
          '<button type="button" class="link-btn" data-del="' + esc(it.id) + '">삭제</button></td></tr>'
        );
      })
      .join("");

    var ty = yd ? totalUsd * yd.rate : NaN;
    var tt = td ? totalUsd * td.rate : NaN;
    var tmr = tm ? totalUsd * tm.rate : NaN;
    var tdiff = isFinite(tmr) && isFinite(tt) ? tmr - tt : NaN;
    var foot =
      '<tr class="row-hi"><th>합계 ' + items.length + "건</th><td>$" + num(totalUsd, 2) + '</td><td class="muted">' +
      (isFinite(ty) ? won(ty) : "—") + "</td><td><strong>" + (isFinite(tt) ? won(tt) : "—") + "</strong></td><td><strong>" +
      (isFinite(tmr) ? won(tmr) : '<span class="muted">미정</span>') + '</strong></td><td class="' +
      (isFinite(tdiff) ? (tdiff > 0 ? "neg" : tdiff < 0 ? "pos" : "muted") : "muted") + '"><strong>' +
      (isFinite(tdiff) ? signedWon(tdiff) : "—") + "</strong></td><td></td></tr>";

    var verdict = "";
    if (!td) {
      verdict = '<p class="muted small">적용환율이 아직 없어 원화가를 못 채웠습니다. 등록한 상품은 그대로 남아 있습니다.</p>';
    } else if (isFinite(tdiff) && Math.round(tdiff) !== 0) {
      verdict =
        '<p class="duty-note">등록한 ' + items.length + "건을 전부 산다면 <strong>" + (tdiff < 0 ? "내일" : "오늘") +
        "</strong> 적용환율 기준으로 <strong>" + won(Math.abs(tdiff)) + "</strong> 저렴합니다.</p>";
    } else if (isFinite(tdiff)) {
      verdict = '<p class="muted small">오늘과 내일 적용환율이 같아 가격 차이가 없습니다.</p>';
    }

    box.innerHTML =
      '<div class="table-scroll"><table class="data-table"><thead><tr><th>상품</th><th>달러</th><th>어제</th><th>오늘</th><th>내일</th><th>내일−오늘</th><th></th></tr></thead><tbody>' +
      rows + "</tbody><tfoot>" + foot + "</tfoot></table></div>" + verdict;
  }

  function updatePreview() {
    var usd = Number($("dutyItemUsd").value);
    var td = state.rates ? appliedOn(todayIso()) : null;
    $("dutyItemPreview").textContent = usd > 0 && td ? "오늘 기준 " + won(usd * td.rate) + " (" + rate(td.rate) + "원 적용)" : "";
  }

  function render() {
    renderEstimate();
    renderWeek();
    renderItems();
    updatePreview();
    setHidden($("dutyItemFetch"), !DUTY_FX_API);
  }

  function setHidden(node, hidden) {
    if (node) node.hidden = hidden;
  }

  // ---------------------------------------------------------------------
  // 이벤트
  // ---------------------------------------------------------------------
  function showError(msg) {
    var box = $("dutyItemError");
    box.textContent = msg || "";
    box.hidden = !msg;
  }

  function fetchProduct(url) {
    var clean = String(url || "").trim();
    if (!DUTY_FX_API) throw new Error("환율 서버가 연결돼 있어야 상품 정보를 가져올 수 있습니다.");
    if (!clean) throw new Error("상품 링크를 입력해주세요.");
    return fetchJson("/v1/product?url=" + encodeURIComponent(clean));
  }

  function refreshItemPrice(id, btn) {
    var it = loadItems().filter(function (x) { return x.id === id; })[0];
    if (!it || !it.url) return;
    showError("");
    if (btn) btn.textContent = "가져오는 중...";
    Promise.resolve()
      .then(function () { return fetchProduct(it.url); })
      .then(
        function (p) {
          if (p.usd) updateItemUsd(id, p.usd);
          render();
        },
        function (err) {
          if (btn) btn.textContent = "새로고침";
          showError((it.name || "상품") + ": " + err.message);
        }
      );
  }

  function wire() {
    $("dutyItemUsd").addEventListener("input", updatePreview);

    $("dutyItemForm").addEventListener("submit", function (e) {
      e.preventDefault();
      showError("");
      try {
        addItem($("dutyItemName").value, $("dutyItemUsd").value, $("dutyItemUrl").value);
        $("dutyItemName").value = "";
        $("dutyItemUsd").value = "";
        $("dutyItemUrl").value = "";
        render();
      } catch (err) {
        showError(err.message);
      }
    });

    // 링크를 붙여넣고 누르면 Worker가 상품 페이지를 읽어 이름·달러가를 채워준다.
    $("dutyItemFetch").addEventListener("click", function () {
      showError("");
      $("dutyItemPreview").textContent = "상품 정보를 가져오는 중...";
      Promise.resolve()
        .then(function () { return fetchProduct($("dutyItemUrl").value); })
        .then(
          function (p) {
            if (p.usd) $("dutyItemUsd").value = p.usd;
            if (p.name && !$("dutyItemName").value.trim()) $("dutyItemName").value = p.name;
            updatePreview();
            if (!p.usd) {
              showError("상품명은 가져왔지만 가격을 못 찾았습니다. 가격은 직접 입력해주세요.");
              return;
            }
            // 할인 중이면 할인가가 들어온다. 할인 표시가 없는 상품은 정가뿐이라 그 사실을 밝힌다.
            $("dutyItemPreview").innerHTML = p.saleUsd
              ? '<span class="duty-badge">할인가</span> $' + num(p.saleUsd, 2) +
                ' <span class="muted">(정가 $' + num(p.listUsd || p.usd, 2) + (p.discountPct ? " · " + num(p.discountPct, 0) + "% 할인" : "") + ")</span>"
              : '<span class="duty-badge duty-badge--warn">정가</span> $' + num(p.usd, 2) + " — 할인 표시가 없는 상품입니다. 다르면 목록에서 바로 고칠 수 있습니다.";
          },
          function (err) {
            $("dutyItemPreview").textContent = "";
            showError(err.message);
          }
        );
    });

    $("dutyItems").addEventListener("change", function (e) {
      var input = e.target.closest("input[data-usd]");
      if (!input) return;
      try {
        updateItemUsd(input.dataset.usd, input.value);
        render();
      } catch (err) {
        showError(err.message);
      }
    });

    $("dutyItems").addEventListener("click", function (e) {
      var ref = e.target.closest("button[data-refresh]");
      if (ref) return refreshItemPrice(ref.dataset.refresh, ref);
      var del = e.target.closest("button[data-del]");
      if (!del) return;
      removeItem(del.dataset.del);
      render();
    });

    $("dutyItemsRefreshAll").addEventListener("click", function () {
      loadItems().forEach(function (it) {
        if (it.url) refreshItemPrice(it.id, null);
      });
    });

    $("dutyEstimate").addEventListener("click", function (e) {
      if (e.target.closest("#dutyRetry")) loadRates();
    });
  }

  // 탭을 열 때 호출된다.
  var lastLoadedAt = 0;
  function show() {
    if (!state.rates) {
      try {
        var cached = JSON.parse(localStorage.getItem(RATES_KEY) || "null");
        if (cached && cached.rates) state.rates = cached; // 새로 받기 전에 마지막 값을 먼저 보여준다
      } catch (e) {
        // 캐시가 깨졌으면 무시
      }
    }
    render();
    // 마지막 조회 후 10분이 지났거나 아직 값이 없으면 다시 가져온다.
    if (!state.rates || Date.now() - lastLoadedAt > 10 * 60 * 1000) {
      lastLoadedAt = Date.now();
      loadRates();
    }
  }

  wire();
  window.DutyFree = { show: show };
})();
