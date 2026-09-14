# Záloha starého zobrazování tréninků

Stav **těsně před** tím, než se z aplikace vyndalo tlačítko „Spustit trénink"
(stará tréninková prezentace) a než se přepsala veřejná stránka sdíleného tréninku.

## Co je v téhle složce

| Soubor | Co to je |
|---|---|
| `index-PRED-prestavbou-2026-09-14.html` | Celá aplikace ve stavu, kdy „Spustit trénink" ještě fungovalo. `APP_VERSION 2026-09-14 15:10`. |
| `t-STARE-sdileni-2026-09-14.html` | Veřejná stránka sdíleného tréninku ve staré podobě (914 řádků, vlastní kopie staré prezentace). |

## Jak se to vrátí zpátky

Přejmenovat `index-PRED-prestavbou-2026-09-14.html` na `index.html`,
`t-STARE-sdileni-2026-09-14.html` na `t.html`, obojí nahrát na GitHub. Nic jiného
se nemění — `training-mode.css`, `sw.js` ani zbytek souborů stará prezentace
nepotřebuje v jiné podobě, než v jaké jsou.

## Druhá záloha, kdyby se tahle složka ztratila

Stejný stav je v repozitáři jako commit **`bca47d2`** (14. 9. 2026 18:25).
V repu je 293 commitů, všechny pojmenované „Add files via upload", takže tenhle
otisk je jediný spolehlivý způsob, jak ten stav najít.

## Co se ve starém zobrazení dělo a v novém už ne

- **„Spustit trénink"** — celoobrazovková prezentace jednoho cviku po druhém,
  ovládaná tlačítky Další/Předchozí, s časovačem dole. Nahrazuje ji Přehled
  tréninku a v něm „Spustit prezentaci" (Fáze cvičení).
- **Staré sdílení** — veřejná stránka s úvodní obrazovkou („N cvičení, doporučujeme
  celou obrazovku") a pak ta samá stará prezentace. Uměla navíc **ukázat komentáře
  u videí**; nové sdílení je zatím nemá.
