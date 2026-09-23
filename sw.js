const CACHE_NAME = "trener-v29";
const APP_SHELL = ["./", "./index.html", "./training-mode.css", "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-512-maskable.png", "./club-logo.png", "./raptor-sound.mp3", "./Boxing%20Bell%20Sound%20Effect.mp3"];

/* =========================================================
   NOTIFIKACE (23. 9. 2026)
   Server posílá DATOVÉ zprávy (functions/index.js), takže notifikaci vykresluje tenhle
   soubor sám a sám si řídí i ťuknutí na ni: když je appka otevřená, jen se do ní přepne
   a pošle jí adresu — appka pak otevře, co k notifikaci patří, BEZ načtení stránky znovu
   (jinak by trenér v tréninkovém režimu přišel o časomíru). Když otevřená není, otevře se.
   POZOR: notificationclick musí být navěšený DŘÍV, než se natáhne FCM — jinak si ho
   knihovna přepíše vlastní obsluhou (viz dokumentace Firebase).
   ========================================================= */
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const url = data.url || "./index.html";
  event.notification.close();
  event.waitUntil((async () => {
    const okna = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appka = okna.find((c) => c.url.indexOf(self.registration.scope) === 0);
    if (appka) {
      await appka.focus();
      appka.postMessage({ type: "trener-notifikace", url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

try {
  importScripts("https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js");
  firebase.initializeApp({
    apiKey: "AIzaSyDHEDRx6jJAE1-0fvTmaMetlh4w6CeTREY",
    authDomain: "trener-6d1b2.firebaseapp.com",
    projectId: "trener-6d1b2",
    storageBucket: "trener-6d1b2.firebasestorage.app",
    messagingSenderId: "796712714371",
    appId: "1:796712714371:web:740d1c4c73f9319f509bb6"
  });
  firebase.messaging().onBackgroundMessage((payload) => {
    const d = (payload && payload.data) || {};
    return self.registration.showNotification(d.title || "Trenér", {
      body: d.body || "",
      icon: d.icon || "./icon-192.png",
      badge: "./icon-192.png",
      tag: d.type || "trener",
      data: { url: d.url || "./index.html" }
    });
  });
} catch (e) {
  // Bez notifikací appka funguje dál — ukládání do mezipaměti níž na tomhle nezávisí.
  console.warn("[sw] notifikace se nepodařilo zapnout:", e);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Cizí domény (Firebase, YouTube, Google Fonts, Disk...) necháváme jít přímo na síť.
  if (url.origin !== location.origin) return;

  // Appka samotná (shell): napřed vždycky zkusit síť, ať appka nezůstává tiše na staré verzi.
  // Uložená verze slouží jen jako záchranná síť, když appka fakt nemá signál.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});