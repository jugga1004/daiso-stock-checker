// 앱 셸(정적 파일)만 오프라인 캐싱한다. 재고 API(mcp.aka.page)는 항상 최신 데이터가
// 필요하므로 절대 캐싱하지 않고 그대로 네트워크로 흘려보낸다.
//
// 배포할 때마다 이 CACHE_NAME을 바꿔야 새 버전이 적용된다(예: v1 -> v2). index.html이
// 이 파일의 controllerchange 이벤트를 듣고 있다가 새 SW가 활성화되면 한 번 자동으로
// 새로고침하므로, 캐시 버전만 올리면 그다음엔 신경 쓸 게 없다.
var CACHE_NAME = "daiso-stock-checker-v3";
var APP_SHELL = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(APP_SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  // 다른 오리진(재고 API 등)은 캐시 없이 그대로 통과 — 절대 오래된 재고 정보를
  // 보여주면 안 되기 때문.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var networkFetch = fetch(event.request)
        .then(function (response) {
          if (response && response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(function () {
          return cached; // 오프라인이면 캐시된 화면이라도 보여준다
        });

      // 캐시가 있으면 일단 그걸 즉시 보여주고(빠름 + 오프라인 지원), 네트워크
      // 응답은 백그라운드에서 캐시를 갱신하는 데만 쓴다.
      return cached || networkFetch;
    })
  );
});
