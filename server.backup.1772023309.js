require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { chromium } = require("playwright");

const app = express();
app.use(express.urlencoded({ extended: true }));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
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
    // sacar tamaños para que no duplique
    url.searchParams.delete("width");
    url.searchParams.delete("height");
    url.searchParams.delete("crop");
    return url.toString();
  } catch {
    // fallback por si no parsea
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

  const p = findJsonLdProduct($);

  const title = (p?.name || $('meta[property="og:title"]').attr("content") || $("title").first().text() || "HUNE Product").trim();
  const descText = (p?.description || $('meta[property="og:description"]').attr("content") || "").trim();
  const descHtml = descText ? `<p>${descText}</p>` : "";

  // price/currency si viene en JSON-LD
  const offer = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
  const price = offer?.price || "";
  const currency = offer?.priceCurrency || "";

  // 1) juntar imágenes desde DOM (src, data-src, srcset)
  const dom = new Set();
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    const dsrc = $(el).attr("data-src");
    const srcset = $(el).attr("srcset");

    const push = (u) => {
      if (!u) return;
      if (!u.includes("/cdn/shop/")) return;
      const clean = u.split(" ")[0];
      dom.add(absolutize(huneUrl, clean));
    };

    push(src);
    push(dsrc);
    if (srcset && srcset.includes("/cdn/shop/")) {
      srcset.split(",").forEach(part => push(part.trim().split(" ")[0]));
    }
  });

  // 2) dedup por archivo real (sin widths)
  const byKey = new Map();
  for (const u of dom) {
    const norm = normalizeShopifyImg(u);
    const key = baseFileKey(norm);
    if (!byKey.has(key)) byKey.set(key, norm);
  }
  let uniq = Array.from(byKey.values());

  // 3) priorizar “set de producto” si hay sufijos _01 _02 ...
  const withIndex = uniq.filter(u => /_(\d{2})\b/i.test(baseFileKey(u)));
  if (withIndex.length >= 2) {
    uniq = withIndex;
  }

  // 4) ordenar por _01, _02... y luego por nombre
  uniq.sort((a, b) => {
    const fa = (baseFileKey(a).match(/_(\d{2})\b/i) || [])[1] || "99";
    const fb = (baseFileKey(b).match(/_(\d{2})\b/i) || [])[1] || "99";
    if (Number(fa) !== Number(fb)) return Number(fa) - Number(fb);
    return baseFileKey(a).localeCompare(baseFileKey(b));
  });

  uniq = uniq.slice(0, 10);

  console.log("HUNE uniq images:", uniq.length);
  console.log(uniq);

  return { title, descHtml, images: uniq, price, currency };
}

app.get("/", (req, res) => {
  res.send(`
    <div style="font-family:Arial;max-width:860px;margin:40px auto;line-height:1.4">
      <h2>HUNE B2B Live Swap</h2>
      <form method="POST" action="/generate">
        <label><b>Cliente PDP</b></label><br/>
        <input name="clientUrl" style="width:100%;padding:10px;margin:8px 0 14px" required
          value="https://www.mobilcovers.dk/collections/kategori-headset-m-ledning/products/jlab-jbuds-pro-in-ear-horetelefoner-turkis"/>
        <label><b>Hune PDP</b></label><br/>
        <input name="huneUrl" style="width:100%;padding:10px;margin:8px 0 14px" required
          value="https://www.hune.eco/products/brisa-ace"/>
        <button style="padding:12px 16px;width:100%;background:#009bb5;color:#fff;border:0;border-radius:10px;font-weight:800;cursor:pointer">
          Generar
        </button>
      </form>
      <p style="color:#666;font-size:12px;margin-top:12px">
        Cambia título/desc/precio + main image + miniaturas cercanas.
      </p>
    </div>
  `);
});

app.post("/generate", async (req, res) => {
  try {
    const clientUrl = (req.body.clientUrl || "").trim();
    const huneUrl = (req.body.huneUrl || "").trim();
    const p = await fetchHune(huneUrl);

    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    console.log(">>> goto", clientUrl);
    await page.goto(clientUrl, { waitUntil: "commit", timeout: 25000 });
    await page.waitForSelector("h1, .product_name, .product-title, .product__title", { timeout: 25000, state: "attached" });

    const debug = await page.evaluate(async (p) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const first = (...sels) => sels.map(s => document.querySelector(s)).find(Boolean);

      let last = { title:false, desc:false, price:false, imgs:0 };

      const titleAnchor = first(".product_name", ".product-title", ".product__title", "h1", "[itemprop='name']");
      const root = (titleAnchor && (titleAnchor.closest("main") || titleAnchor.closest(".product") || titleAnchor.closest(".product-page"))) || document.body;

      const setImg = (img, url) => {
        if (!img || !url) return false;
        img.src = url;
        img.setAttribute("data-src", url);
        img.setAttribute("data-zoom", url);
        img.removeAttribute("srcset");
        img.removeAttribute("data-srcset");
        return true;
      };

      for (let t = 0; t < 8; t++) {
        // título (cambiar todos los posibles)
        const titleNodes = Array.from(document.querySelectorAll(".product_name, .product-title, .product__title, h1, [itemprop='name'], .product_name.h4"));
        if (titleNodes.length) { titleNodes.forEach(n => n.textContent = p.title); last.title = true; document.title = p.title; }

        // desc
        const descEl = root.querySelector(".product-description") ||
                       root.querySelector(".product__description") ||
                       root.querySelector(".rte") ||
                       root.querySelector("[itemprop='description']") ||
                       root.querySelector(".product_description");
        if (descEl) { descEl.innerHTML = p.descHtml || ""; last.desc = true; }

        // price
        const priceEl = root.querySelector(".product-price") ||
                        root.querySelector(".price") ||
                        root.querySelector(".product__price") ||
                        root.querySelector("[itemprop='price']");
        if (priceEl && p.price) { priceEl.textContent = p.currency ? `${p.price} ${p.currency}` : `${p.price}`; last.price = true; }

        // main img = la más grande
        const imgs = Array.from(root.querySelectorAll("img")).filter(im => im.offsetParent !== null);
        const byArea = imgs.map(im => ({ im, r: im.getBoundingClientRect() }))
                           .sort((a,b)=> (b.r.width*b.r.height) - (a.r.width*a.r.height));
        const main = byArea[0]?.im;

        let changed = 0;
        if (main && p.images?.length) {
          if (setImg(main, p.images[0])) changed++;
        }

        // thumbs cercanos debajo
        if (main && p.images?.length) {
          const mr = main.getBoundingClientRect();
          const thumbs = byArea
            .slice(1)
            .filter(x => x.r.width <= 170 && x.r.height <= 170)
            .filter(x => x.r.top > mr.bottom - 10 && x.r.top < mr.bottom + 320)
            .sort((a,b)=> a.r.left - b.r.left)
            .slice(0, Math.min(8, p.images.length));

          thumbs.forEach((x, idx) => {
            const u = p.images[idx] || p.images[0];
            if (setImg(x.im, u)) changed++;
            const a = x.im.closest("a[href]");
            if (a && u) a.setAttribute("href", u);
          });
        }

        last.imgs = changed;
        if (last.title && last.desc && changed >= 3) break;
        await sleep(250);
      }

      document.querySelectorAll("script").forEach(s => s.remove());
      return last;
    }, p);

    console.log(">>> debug", debug);

    await page.waitForTimeout(300);
    const html = await page.content();
    await browser.close();

    const $ = cheerio.load(html);
    $("script").remove();
    $('link[rel="modulepreload"]').remove();
    $('link[rel="preload"][as="script"]').remove();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send($.html());

  } catch (e) {
    console.error(e);
    res.send("Error: " + (e.message || e));
  }
});

app.listen(3000, () => console.log("Running on port 3000"));
