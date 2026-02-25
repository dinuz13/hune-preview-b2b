require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { chromium } = require("playwright");

const app = express();
app.use(express.urlencoded({ extended: true }));

async function fetchHune(huneUrl) {
  const html = await fetchHtml(huneUrl);
  const $ = cheerio.load(html);
  const p = findJsonLdProduct($);

  const title = (p?.name || $("title").first().text() || "HUNE Product").trim();
  const descText = (p?.description || $('meta[property="og:description"]').attr("content") || "").trim();
  const descHtml = descText ? `<p>${descText}</p>` : "";

  // seed para detectar family HE-###
  const og = $('meta[property="og:image"]').attr("content") || "";
  const seed = (Array.isArray(p?.image) ? p.image[0] : p?.image) || og || "";
  const seedStr = (typeof seed === "string" ? seed : seed?.url || "");
  const m = seedStr.match(/(HE-\d{3})/i);
  const family = m ? m[1].toUpperCase() : null;

  // DOM images: src, data-src, srcset (TODAS)
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

  let images = Array.from(dom);

  // Filtrar por family si existe (HE-039 etc)
  if (family) images = images.filter(u => u.toUpperCase().includes(family));

  // Normalizar + dedup por archivo real (no por width)
  const byKey = new Map();
  for (const u of images) {
    const norm = normalizeShopifyImg(u);
    const key = baseFileKey(norm);
    if (!byKey.has(key)) byKey.set(key, norm);
  }

  let uniq = Array.from(byKey.values());

  // Ordenar por _01, _02... y después por nombre
  uniq.sort((a, b) => {
    const fa = (baseFileKey(a).match(/_(\d{2})\b/) || [])[1] || "99";
    const fb = (baseFileKey(b).match(/_(\d{2})\b/) || [])[1] || "99";
    if (Number(fa) !== Number(fb)) return Number(fa) - Number(fb);
    return baseFileKey(a).localeCompare(baseFileKey(b));
  });

  uniq = uniq.slice(0, 10);

  // PRICE (de JSON-LD si viene)
  const offer = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
  const price = offer?.price || "";
  const currency = offer?.priceCurrency || "";

  console.log("HUNE family:", family, "uniq images:", uniq.length);
  console.log(uniq);

  return { title, descHtml, images: uniq, price, currency };
}

function findJsonLdProduct($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { blocks.push(JSON.parse($(el).text())); } catch {}
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

function absolutize(base, u) {
  try { return new URL(u, base).toString(); } catch { return u; }
}
function normalizeShopifyImg(u) {
  if (!u) return u;
  // quitar width params típicos
  try {
    const url = new URL(u);
    url.searchParams.delete("width");
    url.searchParams.delete("height");
    url.searchParams.delete("crop");
    // mantener v=... si existe (cache bust)
    return url.toString();
  } catch {
    // por si viene sin URL válida
    return u.replace(/([?&])width=\d+/g, "$1").replace(/[?&]$/,"");
  }
}

function baseFileKey(u) {
  // key para dedup por archivo, ignorando params y tamaños
  const clean = normalizeShopifyImg(u);
  // quedarnos con el path /files/XXX.ext
  const m = clean.match(/\/files\/([^?]+)/i);
  return (m ? m[1] : clean).toLowerCase();
}
async function fetchHune(huneUrl) {
  const html = await fetchHtml(huneUrl);
  const $ = cheerio.load(html);
  const p = findJsonLdProduct($);

  const title = (p?.name || $("title").first().text() || "HUNE Product").trim();
  const descText = (p?.description || $('meta[property="og:description"]').attr("content") || "").trim();
  const descHtml = descText ? `<p>${descText}</p>` : "";

  // seed para detectar family HE-###
  const og = $('meta[property="og:image"]').attr("content") || "";
  const seed = (Array.isArray(p?.image) ? p.image[0] : p?.image) || og || "";
  const seedStr = (typeof seed === "string" ? seed : seed?.url || "");
  const m = seedStr.match(/(HE-\d{3})/i);
  const family = m ? m[1].toUpperCase() : null;

  // DOM images: src, data-src, srcset (TODAS)
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

  let images = Array.from(dom);

  // Filtrar por family si existe (HE-039 etc)
  if (family) images = images.filter(u => u.toUpperCase().includes(family));

  // Ordenar por _01, _02...
  images.sort((a, b) => {
    const na = (a.match(/_(\d{2})\b/) || [])[1] || "99";
    const nb = (b.match(/_(\d{2})\b/) || [])[1] || "99";
    return Number(na) - Number(nb);
  });
// 3) Normalizar + dedup por archivo real (no por width)
const byKey = new Map();
for (const u of images) {
  const norm = normalizeShopifyImg(u);
  const key = baseFileKey(norm);
  // si ya existe, preferir uno "grande" (si aparece) o el primero
  if (!byKey.has(key)) byKey.set(key, norm);
}

// lista final única por archivo
let uniq = Array.from(byKey.values());

// 4) Ordenar por _01, _02... y después por nombre
uniq.sort((a, b) => {
  const fa = (baseFileKey(a).match(/_(\d{2})\b/) || [])[1] || "99";
  const fb = (baseFileKey(b).match(/_(\d{2})\b/) || [])[1] || "99";
  if (Number(fa) !== Number(fb)) return Number(fa) - Number(fb);
  return baseFileKey(a).localeCompare(baseFileKey(b));
});

// limitar
uniq = uniq.slice(0, 10);

console.log("HUNE family:", family, "uniq images:", uniq.length);
console.log(uniq);

return { title, descHtml, images: uniq, price, currency };

app.get("/", (req, res) => {
  res.send(`
    <div style="font-family:Arial;max-width:860px;margin:40px auto;line-height:1.4">
      <h2>HUNE B2B Live Swap (Mobilcovers)</h2>
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
        Cambia título/desc/precio + galería principal + miniaturas (orden Hune).
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

    console.log(">>> swap");
    const debug = await page.evaluate(async (p) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const first = (...sels) => sels.map(s => document.querySelector(s)).find(Boolean);

      let last = { title:false, desc:false, price:false, imgs:0 };

      // anchor
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

      // retry ~2s
      for (let t = 0; t < 8; t++) {
        // TITLE: cambiar todos los candidatos
        const titleNodes = Array.from(document.querySelectorAll(".product_name, .product-title, .product__title, h1, [itemprop='name'], .product_name.h4"));
        if (titleNodes.length) { titleNodes.forEach(n => n.textContent = p.title); last.title = true; document.title = p.title; }

        // DESC
        const descEl = root.querySelector(".product-description") ||
                       root.querySelector(".product__description") ||
                       root.querySelector(".rte") ||
                       root.querySelector("[itemprop='description']") ||
                       root.querySelector(".product_description");
        if (descEl) { descEl.innerHTML = p.descHtml || ""; last.desc = true; }

        // PRICE
        const priceEl = root.querySelector(".product-price") ||
                        root.querySelector(".price") ||
                        root.querySelector(".product__price") ||
                        root.querySelector("[itemprop='price']");
        if (priceEl && p.price) { priceEl.textContent = p.currency ? `${p.price} ${p.currency}` : `${p.price}`; last.price = true; }

        // MAIN IMAGE = imagen más grande dentro de root
        const imgs = Array.from(root.querySelectorAll("img")).filter(im => im.offsetParent !== null);
        const byArea = imgs.map(im => ({ im, r: im.getBoundingClientRect() }))
                           .sort((a,b)=> (b.r.width*b.r.height) - (a.r.width*a.r.height));
        const main = byArea[0]?.im;

        let changed = 0;
        if (main && p.images?.length) {
          if (setImg(main, p.images[0])) changed++;
        }

        // THUMBS: elegir imgs chicas cercanas (debajo) y asignar p.images[0..]
        if (main && p.images?.length) {
          const mr = main.getBoundingClientRect();
          const thumbs = byArea
            .slice(1)
            .filter(x => x.r.width <= 170 && x.r.height <= 170)
            .filter(x => x.r.top > mr.bottom - 10 && x.r.top < mr.bottom + 320)
            .sort((a,b)=> a.r.left - b.r.left)
            .slice(0, 8);

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

      // congelar scripts
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
