await page.evaluate(({ titleT, descHtml, images, price, currency }) => {

  function applySwap() {

    // ===== MOBILCOVERS SPECIFIC =====

    const titleEl = document.querySelector(".product-title, .product__title, h1");
    if (titleEl) titleEl.textContent = titleT;

    const priceEl = document.querySelector(".product-price, .price, .product__price");
    if (priceEl && price) {
      priceEl.textContent = currency ? `${price} ${currency}` : price;
    }

    const descEl = document.querySelector(".product-description, .product__description, .rte");
    if (descEl) descEl.innerHTML = descHtml;

    // Swiper gallery
    const swiperWrapper = document.querySelector(".swiper-wrapper");
    if (swiperWrapper && images && images.length) {

      const slides = swiperWrapper.querySelectorAll(".swiper-slide img");
      slides.forEach((img, i) => {
        if (images[i]) {
          img.src = images[i];
          img.srcset = "";
        }
      });

      // Thumbnails
      const thumbs = document.querySelectorAll(".swiper-slide-thumb img");
      thumbs.forEach((img, i) => {
        if (images[i]) {
          img.src = images[i];
          img.srcset = "";
        }
      });
    }
  }

  applySwap();

  const observer = new MutationObserver(() => applySwap());
  observer.observe(document.body, { childList: true, subtree: true });

}, { titleT, descHtml: `<div>${descHtmlT}</div>`, images: product.images, price: product.price, currency: product.currency });
