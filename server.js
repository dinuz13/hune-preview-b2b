require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const TOOLBAR_HTML = `
<style>
  .hune-bar{position:sticky;top:0;z-index:999999;background:#fff;border-bottom:1px solid #eee;padding:10px 12px}
  .hune-bar .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .hune-bar a,.hune-bar button{font:700 13px Arial; border-radius:10px; border:1px solid #ddd; background:#fff; padding:8px 10px; cursor:pointer; text-decoration:none; color:#111}
  .hune-bar .primary{background:#009bb5;color:#fff;border:0}
  .hune-bar form{margin:0}
</style>
<div class="hune-bar">
  <div class="row">
    <a href="/" class="primary">← Volver</a>

    <form method="POST" action="/generate">
      <input type="hidden" name="clientUrl" value="__CLIENT__"/>
      <input type="hidden" name="huneUrl" value="https://www.hune.eco/products/halcon-w10"/>
      <button type="submit">Halcon W10</button>
    </form>

    <form method="POST" action="/generate">
      <input type="hidden" name="clientUrl" value="__CLIENT__"/>
      <input type="hidden" name="huneUrl" value="https://www.hune.eco/collections/auriculares/products/flora"/>
      <button type="submit">Flora</button>
    </form>

    <form method="POST" action="/generate">
      <input type="hidden" name="clientUrl" value="__CLIENT__"/>
      <input type="hidden" name="huneUrl" value="https://www.hune.eco/collections/cargadores/products/huron-65w"/>
      <button type="submit">Huron 65W</button>
    </form>
  </div>
</div>
`;
function injectToolbar($, clientUrl){
  const html = TOOLBAR_HTML.replaceAll("__CLIENT__", String(clientUrl||""));
  const body = $("body").first();
  if (body.length) body.prepend(html);
}


let chromium = null;
const PLAYWRIGHT_DISABLED = !!process.env.PLAYWRIGHT_DISABLED || !!process.env.RENDER;
try {
  if (!PLAYWRIGHT_DISABLED) {
    chromium = require("playwright").chromium;
  }
} catch {}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  if (!res.ok) throw new Error("Fetch failed " + res.status);
  return await res.text();
}

function absolutize(base, u) {
  try { return new URL(u, base).toString(); } catch { return u; }
}

function findJsonLdProduct($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).text();
    if (!txt) return;
    try { blocks.push(JSON.parse(txt)); } catch {}
  });

  const scan = (obj) => {
    if (!obj) return null;
    if (Array.isArray(obj)) { for (const x of obj) { const hit = scan(x); if (hit) return hit; } return null; }
    if (obj["@type"] === "Product") return obj;
    if (obj["@graph"]) return scan(obj["@graph"]);
    return null;
  };

  for (const b of blocks) {
    const hit = scan(b);
    if (hit) return hit;
  }
  return null;
}

function normalizeShopifyImg(u) {
  if (!u) return u;
  try {
    const url = new URL(u);
    url.searchParams.delete("width");
    url.searchParams.delete("height");
    url.searchParams.delete("crop");
    return url.toString();
  } catch {
    return u.replace(/([?&])width=\d+/g, "$1").replace(/[?&]$/,"");
  }
}

function baseFileKey(u) {
  const clean = normalizeShopifyImg(u);
  const m = clean.match(/\/files\/([^?]+)/i);
  return (m ? m[1] : clean).toLowerCase();
}

async function fetchHune(huneUrl) {
  const html = await fetchHtml(huneUrl);
  const $ = cheerio.load(html);
    // Quitar CSP del sitio origen (si viene como meta) para que no bloquee imgs de hune.eco
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="content-security-policy"]').remove();
    // (opcional) quitar <base> si existe, por si rompe URLs
    $('base').remove();
  const p = findJsonLdProduct($);

  const title = (p?.name || $('meta[property="og:title"]').attr("content") || $("title").first().text() || "HUNE Product").trim();
  const descText = (p?.description || $('meta[property="og:description"]').attr("content") || "").trim();
  const descHtml = descText ? `<p>${descText}</p>` : "";

  const offer = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
  const price = offer?.price || "";
  const currency = offer?.priceCurrency || "";

  const dom = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    const dsrc = $(el).attr("data-src");
    const srcset = $(el).attr("srcset");

    const push = (u) => {
      if (!u) return;
      if (!u.includes("/cdn/shop/")) return;
      const clean = u.split(" ")[0];
      dom.push(absolutize(huneUrl, clean));
    };

    push(src);
    push(dsrc);
    if (srcset && srcset.includes("/cdn/shop/")) {
      srcset.split(",").forEach(part => push(part.trim().split(" ")[0]));
    }
  });

  const byKey = new Map();
  for (const u of dom) {
    const norm = normalizeShopifyImg(u);
    const key = baseFileKey(norm);
    if (!byKey.has(key)) byKey.set(key, norm);
  }

  let uniq = Array.from(byKey.values());

  // orden por _01/_02... si existe
  const hasIndex = uniq.filter(u => /_(\d{2})\b/i.test(baseFileKey(u))).length >= 2;
  if (hasIndex) {
    uniq = uniq.filter(u => /_(\d{2})\b/i.test(baseFileKey(u)));
    uniq.sort((a, b) => {
      const fa = (baseFileKey(a).match(/_(\d{2})\b/i) || [])[1] || "99";
      const fb = (baseFileKey(b).match(/_(\d{2})\b/i) || [])[1] || "99";
      return Number(fa) - Number(fb);
    });
  }

  uniq = uniq.slice(0, 10);

  return { title, descHtml, images: uniq, price, currency };
}

app.get("/", (req, res) => {
  res.render("index", {
    clientDefault: "https://www.mobilcovers.dk/collections/kategori-headset-m-ledning/products/jlab-jbuds-pro-in-ear-horetelefoner-turkis",
    huneDefault: "https://www.hune.eco/products/brisa-ace"
  });
});

app.post("/generate", async (req, res) => {
  try {
    const clientUrl = (req.body.clientUrl || "").trim();
    const huneUrl = (req.body.huneUrl || "").trim();
    const p = await fetchHune(huneUrl);

    // Render / ambientes sin Playwright: devolvemos un HTML simple (rápido y seguro)
    if (!chromium) {
      const clientHtml = await fetchHtml(clientUrl);
      const $ = cheerio.load(clientHtml);

      // title
      const titleSel = [".product_name", ".product-title", ".product__title", "h1", "[itemprop='name']"];
      for (const s of titleSel) { const el = $(s).first(); if (el.length) el.text(p.title); }
      $("title").first().text(p.title);

      // desc
      const descSel = [".product-description", ".product__description", ".rte", "[itemprop='description']", ".product_description"];
      for (const s of descSel) { const el = $(s).first(); if (el.length) { el.html(p.descHtml || ""); break; } }

      // price
      if (p.price) {
        const priceSel = [".product-price", ".price", ".product__price", "[itemprop='price']"];
        for (const s of priceSel) { const el = $(s).first(); if (el.length) { el.text(p.currency ? `${p.price} ${p.currency}` : `${p.price}`); break; } }
      }

      // imgs (simple: reemplazar las primeras visibles dentro del “product area”)
      const imgs = $("main img, .product img, .product-page img").toArray().slice(0, Math.min(10, p.images.length || 1));
      imgs.forEach((img, i) => {
        const u = p.images[i] || p.images[0];
        if (!u) return;
        $(img).attr("src", u).attr("data-src", u).removeAttr("srcset").removeAttr("data-srcset");
      });

      injectToolbar($, clientUrl);
$("script").remove();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send($.html());
    }

    // Local con Playwright: swap “en vivo” y devolver HTML congelado
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    await page.goto(clientUrl, { waitUntil: "commit", timeout: 25000 });
    await page.waitForSelector("h1, .product_name, .product-title, .product__title", { timeout: 25000, state: "attached" });

    await page.evaluate(async (p) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const first = (...sels) => sels.map(s => document.querySelector(s)).find(Boolean);

      const titleAnchor = first(".product_name", ".product-title", ".product__title", "h1", "[itemprop='name']");
      const root = (titleAnchor && (titleAnchor.closest("main") || titleAnchor.closest(".product") || titleAnchor.closest(".product-page"))) || document.body;

      const setImg = (img, url) => {
        if (!img || !url) return false;
        const pic = img.closest("picture");
        if (pic) pic.querySelectorAll("source").forEach(s => s.setAttribute("srcset", url));
        img.src = url;
        img.setAttribute("data-src", url);
        img.removeAttribute("srcset");
        img.style.filter = "none";
        img.style.opacity = "1";
        img.classList.remove("lazyload","lazyloaded","blur-up","loading","is-loading","is-placeholder");
        return true;
      };

      for (let t = 0; t < 8; t++) {
        // title
        const nodes = Array.from(document.querySelectorAll(".product_name, .product-title, .product__title, h1, [itemprop='name'], .product_name.h4"));
        nodes.forEach(n => n.textContent = p.title);
        document.title = p.title;

        // desc
        const descEl = root.querySelector(".product-description") ||
                       root.querySelector(".product__description") ||
                       root.querySelector(".rte") ||
                       root.querySelector("[itemprop='description']") ||
                       root.querySelector(".product_description");
        if (descEl) descEl.innerHTML = p.descHtml || "";

        // price
        const priceEl = root.querySelector(".product-price") ||
                        root.querySelector(".price") ||
                        root.querySelector(".product__price") ||
                        root.querySelector("[itemprop='price']");
        if (priceEl && p.price) priceEl.textContent = p.currency ? `${p.price} ${p.currency}` : `${p.price}`;

        // images: main + thumbs cercanas
        const imgs = Array.from(root.querySelectorAll("img")).filter(im => im.offsetParent !== null);
        const byArea = imgs.map(im => ({ im, r: im.getBoundingClientRect() }))
                           .sort((a,b)=> (b.r.width*b.r.height) - (a.r.width*a.r.height));
        const main = byArea[0]?.im;

        let changed = 0;
        if (main && p.images?.length) { if (setImg(main, p.images[0])) changed++; }

        if (main && p.images?.length) {
          const mr = main.getBoundingClientRect();
          const thumbs = byArea
            .slice(1)
            .filter(x => x.r.width <= 170 && x.r.height <= 170)
            .filter(x => x.r.top > mr.bottom - 10 && x.r.top < mr.bottom + 420)
            .sort((a,b)=> a.r.left - b.r.left)
            .slice(0, Math.min(8, p.images.length));

          thumbs.forEach((x, idx) => {
            const u = p.images[idx] || p.images[0];
            if (setImg(x.im, u)) changed++;
          });
        }

        if (changed >= 3) break;
        await sleep(250);
      }

      document.querySelectorAll("script").forEach(s => s.remove());
    }, p);

    await page.waitForTimeout(250);
    const html = await page.content();
    await browser.close();

    const $ = cheerio.load(html);
    // Quitar CSP del sitio origen (si viene como meta) para que no bloquee imgs de hune.eco
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="content-security-policy"]').remove();
    // (opcional) quitar <base> si existe, por si rompe URLs
    $('base').remove();
injectToolbar($, clientUrl);
    $("script").remove();
    $('link[rel="modulepreload"]').remove();
    $('link[rel="preload"][as="script"]').remove();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send($.html());

  } catch (e) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send("Error: " + (e.message || e));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port", PORT));
