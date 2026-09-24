const CACHE_NAME = "trener-v31";
const APP_SHELL = ["./", "./index.html", "./training-mode.css", "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-512-maskable.png", "./club-logo.png", "./raptor-sound.mp3", "./Boxing%20Bell%20Sound%20Effect.mp3"];

/* =========================================================
   NOTIFIKACE (23. 9. 2026, doplněno 24. 9. 2026)
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

/* Vykreslení notifikace z datové zprávy. Používají ji obě cesty níž, ať vypadají stejně.
   renotify: true je tu schválně — notifikace se stejným štítkem (tag) se jinak tiše vymění
   za tu, co už visí v liště: nezavibruje, nepípne, nevyskočí. Pro nás je každá zpráva nová
   událost, takže chceme upozornit i při výměně. */
function zobrazNotifikaci(d) {
  const data = d || {};
  return self.registration.showNotification(data.title || "Trenér", {
    body: data.body || "",
    icon: data.icon || "./icon-192.png",
    badge: "./icon-192.png",
    tag: data.type || "trener",
    renotify: true,
    data: { url: data.url || "./index.html" }
  });
}

let fcmPripraveno = false;
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
  firebase.messaging().onBackgroundMessage((payload) => zobrazNotifikaci((payload && payload.data) || {}));
  fcmPripraveno = true;
} catch (e) {
  // Bez notifikací appka funguje dál — ukládání do mezipaměti níž na tomhle nezávisí.
  console.warn("[sw] knihovnu pro notifikace se nepodařilo natáhnout:", e);
}

/* Záchranná síť (24. 9. 2026). Když se knihovna výš nenatáhne — výpadek gstatic, síť za
   firewallem, starší prohlížeč — notifikaci by nevykreslil nikdo a zpráva by tiše zmizela,
   protože ten catch je mlčenlivý. Datová zpráva z FCM je ale obyčejná push událost, takže
   si ji umíme vykreslit sami. Když knihovna jede, tahle větev se hned vrátí, ať notifikace
   není dvakrát. */
self.addEventListener("push", (event) => {
  if (fcmPripraveno) return;
  let d = {};
  try {
    const j = event.data ? event.data.json() : {};
    d = j.data || j.notification || j || {};
  } catch (e) {
    d = { body: (event.data && event.data.text()) || "" };
  }
  event.waitUntil(zobrazNotifikaci(d));
});

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