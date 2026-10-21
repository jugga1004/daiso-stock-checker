// 앱 셸(정적 파일)을 오프라인용으로 캐싱한다. 재고·할인 API는 항상 최신 데이터가
// 필요하므로 절대 캐싱하지 않고 그대로 네트워크로 흘려보낸다.
//
// 전략: 네트워크 우선(network-first). 인터넷이 되면 항상 서버의 최신 파일을 받고(브라우저
// HTTP 캐시도 재검증), 오프라인일 때만 저장해 둔 사본을 보여준다. 예전에는 캐시를 먼저
// 보여주는 방식이라 배포 후에도 옛 화면이 한 번 더 남는 문제가 있었다.
//
// CACHE_NAME을 바꾸면 이전 캐시가 정리된다(배포마다 올려두면 안전).
var CACHE_NAME = "daiso-stock-checker-v21";
var APP_SHELL = ["./", "./index.html", "./style.css", "./app.js", "./dutyfree.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        // cache:"reload"로 브라우저 HTTP 캐시를 건너뛰고 서버에서 직접 받는다
        // (cache.addAll은 오래된 HTTP 캐시본을 그대로 저장할 수 있다).
        return Promise.all(
          APP_SHELL.map(function (path) {
            return fetch(path, { cache: "reload" }).then(function (res) {
              if (res.ok) return cache.put(path, res);
            });
          })
        );
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

  // 다른 오리진(재고·할인 API 등)은 캐시 없이 그대로 통과
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
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
        return caches.match(event.request).then(function (cached) {
          return cached || caches.match("./index.html");
        });
      })
  );
});
