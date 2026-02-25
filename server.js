require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT === "1";

let chromium = null;
if (USE_PLAYWRIGHT) {
  ({ chromium } = require("playwright"));
}
const app = express();
app.use(express.urlencoded({ extended: true }));

// 3 modelos fijos para reunión
const MODELS = [
  {
    key: "halcon",
    name: "Halcón W10",
    url: "https://www.hune.eco/products/halcon-w10?pr_prod_strat=e5_desc&pr_rec_id=e9c5e2f1e&pr_rec_pid=14887281951101&pr_ref_pid=14887066304893&pr_seq=uniform"
  },
  {
    key: "flora",
    name: "Flora (Auriculares)",
    url: "https://www.hune.eco/collections/auriculares/products/flora"
  },
  {
    key: "huron65",
    name: "Hurón 65W (Cargador)",
    url: "https://www.hune.eco/collections/cargadores/products/huron-65w"
  }
];

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

  const p = findJsonLdProduct($);

  const title = (p?.name || $('meta[property="og:title"]').attr("content") || $("title").first().text() || "HUNE Product").trim();
  const descText = (p?.description || $('meta[property="og:description"]').attr("content") || "").trim();
  const descHtml = descText ? `<p>${descText}</p>` : "";

  const offer = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
  const price = offer?.price || "";
  const currency = offer?.priceCurrency || "";

  // DOM images
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

  // dedup por archivo real (sin width=)
  const byKey = new Map();
  for (const u of dom) {
    const norm = normalizeShopifyImg(u);
    const key = baseFileKey(norm);
    if (!byKey.has(key)) byKey.set(key, norm);
  }
  let uniq = Array.from(byKey.values());

  // si hay set con _01/_02, lo priorizamos y ordenamos; si no, NO ordenamos (orden DOM)
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

  console.log("HUNE uniq images:", uniq.length);
  console.log(uniq);

  return { title, descHtml, images: uniq, price, currency };
}

function renderHome(clientUrlDefault) {
  const options = MODELS.map(m => `<option value="${m.url}">${m.name}</option>`).join("");
  return `
  <div style="font-family:Arial;max-width:900px;margin:36px auto;line-height:1.4">
    <h2 style="margin:0 0 8px">HUNE B2B Live Swap (Mobilcovers)</h2>
    <p style="margin:0 0 16px;color:#444">Elegí un modelo de Hune y generá la preview en la PDP del cliente.</p>

    <form method="POST" action="/generate" style="border:1px solid #eee;border-radius:14px;padding:16px">
      <label><b>Cliente PDP</b></label><br/>
      <input name="clientUrl" style="width:100%;padding:10px;margin:8px 0 14px" required
        value="${clientUrlDefault || "https://www.mobilcovers.dk/collections/kategori-headset-m-ledning/products/jlab-jbuds-pro-in-ear-horetelefoner-turkis"}"/>

      <label><b>Modelo Hune (rápido)</b></label><br/>
      <select name="hunePreset" style="width:100%;padding:10px;margin:8px 0 14px">
        <option value="">— Elegir uno —</option>
        ${options}
      </select>

      <label style="display:block;margin-top:6px"><b>O pegar otra PDP de Hune</b> (opcional)</label>
      <input name="huneUrl" style="width:100%;padding:10px;margin:8px 0 14px"
        placeholder="https://www.hune.eco/products/..." />

      <button style="padding:12px 16px;width:100%;background:#009bb5;color:#fff;border:0;border-radius:12px;font-weight:800;cursor:pointer">
        Generar preview
      </button>

      <p style="color:#666;font-size:12px;margin:12px 0 0">
        Tip: si elegís preset, ignora el campo “otra PDP”.
      </p>
    </form>
  </div>
  `;
}

function renderTopMenu(clientUrl, currentHuneUrl) {
  const buttons = MODELS.map(m => {
    const active = (currentHuneUrl || "").startsWith(m.url.split("?")[0]) ? "background:#111;color:#fff" : "background:#f3f3f3;color:#111";
    const href = `/generate?clientUrl=${encodeURIComponent(clientUrl)}&huneUrl=${encodeURIComponent(m.url)}`;
    return `<a href="${href}" style="text-decoration:none;padding:10px 12px;border-radius:10px;${active};font-weight:800;font-size:13px;display:inline-block">${m.name}</a>`;
  }).join(" ");

  const back = `<a href="/" style="text-decoration:none;color:#009bb5;font-weight:800">← cambiar URL cliente</a>`;

  return `
  <div style="position:sticky;top:0;z-index:99999;background:#fff;border-bottom:1px solid #eee">
    <div style="max-width:1200px;margin:0 auto;padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        ${back}
        <span style="color:#666;font-size:12px">Cliente: <b>${escapeHtml(clientUrl)}</b></span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${buttons}
      </div>
    </div>
  </div>
  `;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// HOME
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderHome());
});

// GENERATE via POST (desde el form)
app.post("/generate", async (req, res) => {
  const clientUrl = (req.body.clientUrl || "").trim();
  const preset = (req.body.hunePreset || "").trim();
  const manual = (req.body.huneUrl || "").trim();
  const huneUrl = preset || manual;

  if (!clientUrl || !huneUrl) return res.send("Error: falta clientUrl o huneUrl");
  return generatePreview(req, res, clientUrl, huneUrl);
});

// GENERATE via GET (para botones del menú)
app.get("/generate", async (req, res) => {
  const clientUrl = (req.query.clientUrl || "").trim();
  const huneUrl = (req.query.huneUrl || "").trim();
  if (!clientUrl || !huneUrl) return res.redirect("/");
  return generatePreview(req, res, clientUrl, huneUrl);
});

async function generatePreview(req, res, clientUrl, huneUrl) {
  try {
    const p = await fetchHune(huneUrl);

    if (!USE_PLAYWRIGHT) {
  return res.send("Playwright disabled on this environment.");
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"]
});
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    console.log(">>> goto", clientUrl);
    await page.goto(clientUrl, { waitUntil: "commit", timeout: 25000 });
    await page.waitForSelector("h1, .product_name, .product-title, .product__title", { timeout: 25000, state: "attached" });

    console.log(">>> swap");
    const debug = await page.evaluate(async (p) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const first = (...sels) => sels.map(s => document.querySelector(s)).find(Boolean);
      let last = { title:false, desc:false, price:false, imgs:0 };

      const titleAnchor = first(".product_name", ".product-title", ".product__title", "h1", "[itemprop='name']");
      const root = (titleAnchor && (titleAnchor.closest("main") || titleAnchor.closest(".product") || titleAnchor.closest(".product-page"))) || document.body;

      const setImg = (img, url) => {
        if (!img || !url) return false;

        // forzar <picture><source>
        const pic = img.closest("picture");
        if (pic) {
          pic.querySelectorAll("source").forEach(s => {
            s.setAttribute("srcset", url);
            s.setAttribute("data-srcset", url);
          });
        }

        img.src = url;
        img.setAttribute("data-src", url);
        img.setAttribute("data-zoom", url);
        img.removeAttribute("srcset");
        img.removeAttribute("data-srcset");

        // matar “gris / blur / placeholder”
        img.style.filter = "none";
        img.style.opacity = "1";
        img.style.mixBlendMode = "normal";
        img.style.transform = "none";
        img.classList.remove("lazyload","lazyloaded","blur-up","loading","is-loading","is-placeholder");
        return true;
      };

      for (let t = 0; t < 8; t++) {
        // TITLE
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

        // MAIN IMG (más grande)
        const imgs = Array.from(root.querySelectorAll("img")).filter(im => im.offsetParent !== null);
        const byArea = imgs.map(im => ({ im, r: im.getBoundingClientRect() }))
                           .sort((a,b)=> (b.r.width*b.r.height) - (a.r.width*a.r.height));
        const main = byArea[0]?.im;

        let changed = 0;
        if (main && p.images?.length) {
          if (setImg(main, p.images[0])) changed++;
        }

        // THUMBS cercanos
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
    let html = await page.content();
    await browser.close();

    // congela scripts también server-side
    const $ = cheerio.load(html);
    $("script").remove();
    $('link[rel="modulepreload"]').remove();
    $('link[rel="preload"][as="script"]').remove();
    html = $.html();

    // inyectar menú arriba para cambiar de modelo sin tocar URLs
    const menu = renderTopMenu(clientUrl, huneUrl);
    html = html.replace(/<body([^>]*)>/i, (m, attrs) => `<body${attrs}>${menu}`);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);

  } catch (e) {
    console.error(e);
    res.send("Error: " + (e.message || e));
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port", PORT));