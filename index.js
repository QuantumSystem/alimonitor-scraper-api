const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Custom AliExpress Scraper ──────────────────────────────────────────────
// Strategy:
// 1) API Interception — capture ANY mtop.aliexpress XHR response with price data
// 2) DOM Extraction — read price from rendered page elements
// 3) runParams fallback — legacy SSR data (rarely works in 2025+)

async function scrapeProduct(productId) {
    // Dynamic import for ESM modules
    const puppeteerExtra = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    
    puppeteerExtra.use(StealthPlugin());

    let browser;
    try {
        browser = await puppeteerExtra.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1920,1080',
            ],
        });

        const page = await browser.newPage();

        // Realistic viewport & user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );

        // Accept English/USD to get USD prices
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // ── 1) API Interception ──
        // Capture ALL mtop responses — not just 'pdp'
        const capturedResponses = [];

        page.on('response', async (response) => {
            const url = response.url();
            try {
                // Broad match: any mtop.aliexpress response that could contain product/price data
                if (
                    (url.includes('mtop.aliexpress') || url.includes('mtop.taobao')) &&
                    (url.includes('product') || url.includes('pdp') || url.includes('item') || url.includes('price') || url.includes('sku') || url.includes('detail'))
                ) {
                    const text = await response.text();
                    if (text && text.length > 500) {
                        capturedResponses.push({ url, text });
                    }
                }
            } catch {
                // Response body may be unavailable
            }
        });

        const productUrl = `https://www.aliexpress.com/item/${productId}.html`;
        console.log(`[Scraper] Navigating to: ${productUrl}`);

        await page.goto(productUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // Wait extra time for CSR data to load
        await new Promise((r) => setTimeout(r, 5000));

        console.log(`[Scraper] Captured ${capturedResponses.length} API responses`);

        // ── Parse captured API responses ──
        let productData = null;

        for (const resp of capturedResponses) {
            try {
                const parsed = parseJsonp(resp.text);
                if (parsed?.data?.result) {
                    const extracted = extractFromApiResult(parsed.data.result);
                    if (extracted && (extracted.salePrice || extracted.originalPrice)) {
                        productData = extracted;
                        console.log(`[Scraper] ✅ Extracted from API: ${resp.url.substring(0, 100)}`);
                        break;
                    }
                }
                // Also check for data directly on parsed.data (different API format)
                if (parsed?.data?.priceModule || parsed?.data?.pageModule) {
                    productData = extractFromLegacyData(parsed.data);
                    if (productData) {
                        console.log(`[Scraper] ✅ Extracted from legacy API format`);
                        break;
                    }
                }
            } catch {
                // Skip unparseable responses
            }
        }

        // ── 2) runParams fallback ──
        if (!productData) {
            console.log('[Scraper] API interception failed, trying runParams...');
            const runParamsData = await page.evaluate(() => {
                try {
                    return window.runParams?.data || null;
                } catch {
                    return null;
                }
            });

            if (runParamsData && Object.keys(runParamsData).length > 0) {
                productData = extractFromLegacyData(runParamsData);
                if (productData) {
                    console.log('[Scraper] ✅ Extracted from runParams');
                }
            }
        }

        // ── 3) DOM Extraction fallback ──
        if (!productData) {
            console.log('[Scraper] runParams failed, trying DOM extraction...');
            productData = await extractFromDOM(page);
            if (productData) {
                console.log('[Scraper] ✅ Extracted from DOM');
            }
        }

        // ── 4) Try __INIT_DATA__ or other script-embedded JSON ──
        if (!productData) {
            console.log('[Scraper] DOM failed, trying embedded script data...');
            productData = await extractFromScripts(page);
            if (productData) {
                console.log('[Scraper] ✅ Extracted from embedded scripts');
            }
        }

        await browser.close();

        if (!productData) {
            throw new Error('Could not extract product data. All methods failed.');
        }

        return productData;
    } catch (error) {
        if (browser) await browser.close();
        throw error;
    }
}

// ── JSONP Parser ──
function parseJsonp(text) {
    const trimmed = text.trim();
    // JSONP format: callbackName({...})
    const match = trimmed.match(/^[a-zA-Z0-9_]+\(([\s\S]+)\)$/);
    if (match && match[1]) {
        return JSON.parse(match[1]);
    }
    return JSON.parse(trimmed);
}

// ── Extract from new API result format (mtop.aliexpress.pdp.pc.query or similar) ──
function extractFromApiResult(result) {
    const globalData = result.GLOBAL_DATA?.globalData || {};
    const priceInfo = result.PRICE?.targetSkuPriceInfo || {};
    const headerImages = result.HEADER_IMAGE_PC?.imagePathList || [];

    // Extract sale price (promotional price including SuperDeals)
    let salePrice = null;
    if (priceInfo.warmUpPrice) {
        salePrice = priceInfo.warmUpPrice;
    } else if (priceInfo.salePrice) {
        salePrice = priceInfo.salePrice;
    } else if (priceInfo.salePriceString) {
        const m = priceInfo.salePriceString.match(/([^\d]*)([0-9,.]+)/);
        if (m) {
            salePrice = {
                currency: 'USD',
                formatedAmount: priceInfo.salePriceString,
                value: parseFloat(m[2].replace(/,/g, '')),
            };
        }
    }

    // Fallback to discount price from PRICE component
    if (!salePrice && result.PRICE?.discountPrice?.minActivityAmount) {
        salePrice = result.PRICE.discountPrice.minActivityAmount;
    }

    let originalPrice = priceInfo.originalPrice || null;
    if (!originalPrice && result.PRICE?.origPrice?.minAmount) {
        originalPrice = result.PRICE.origPrice.minAmount;
    }

    return {
        title: result.PRODUCT_TITLE?.text || globalData.subject || '',
        salePrice,
        originalPrice,
        images: headerImages,
        rating: result.PC_RATING?.rating || '0',
        orders: globalData.sales || '0',
        storeInfo: {
            name: result.SHOP_CARD_PC?.storeName || globalData.storeName || '',
        },
    };
}

// ── Extract from legacy data format (runParams.data or old API) ──
function extractFromLegacyData(data) {
    const priceModule = data.priceModule || data.priceComponent || {};
    const productInfo = data.pageModule || data.productInfoComponent || {};
    const imageModule = data.imageModule || data.imageComponent || {};
    const tradeModule = data.tradeModule || data.tradeComponent || {};
    const storeModule = data.storeModule || data.sellerComponent || {};
    const feedbackModule = data.feedbackModule || data.feedbackComponent || {};

    let salePrice = priceModule.formatedActivityPrice || priceModule.discountPrice?.minActivityAmount || null;
    let originalPrice = priceModule.formatedPrice || priceModule.origPrice?.minAmount || null;

    if (typeof salePrice === 'string') {
        const m = salePrice.match(/([^\d]*)([0-9,.]+)/);
        if (m) {
            salePrice = {
                currency: 'USD',
                formatedAmount: salePrice,
                value: parseFloat(m[2].replace(/,/g, '')),
            };
        }
    }
    if (typeof originalPrice === 'string') {
        const m = originalPrice.match(/([^\d]*)([0-9,.]+)/);
        if (m) {
            originalPrice = {
                currency: 'USD',
                formatedAmount: originalPrice,
                value: parseFloat(m[2].replace(/,/g, '')),
            };
        }
    }

    if (!salePrice && !originalPrice) return null;

    return {
        title: productInfo.title || productInfo.subject || '',
        salePrice,
        originalPrice,
        images: imageModule.imagePathList || [],
        rating: feedbackModule.evarageStar || '0',
        orders: tradeModule.formatTradeCount || '0',
        storeInfo: {
            name: storeModule.storeName || '',
        },
    };
}

// ── Extract price from rendered DOM ──
async function extractFromDOM(page) {
    return await page.evaluate(() => {
        // Strategy: find price elements with various selectors
        const selectors = [
            // New AliExpress design (2024+)
            '[class*="Price--current"]',
            '[class*="Price--sale"]',
            '[class*="price--current"]',
            '[class*="price--sale"]',
            '[class*="uniform-banner-box-price"]',
            '[class*="es--wrap"] [class*="notranslate"]',
            // Generic price containers
            '.product-price-value',
            '[data-spm="price"] [class*="notranslate"]',
            // Fallback: any element with $ followed by digits
        ];

        let salePriceText = null;
        let originalPriceText = null;

        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
                salePriceText = els[0]?.textContent?.trim();
                if (els.length > 1) {
                    originalPriceText = els[1]?.textContent?.trim();
                }
                break;
            }
        }

        // Also try to find the original (crossed-out) price
        if (!originalPriceText) {
            const origSelectors = [
                '[class*="Price--original"]',
                '[class*="price--original"]',
                '[class*="price--del"]',
                'del [class*="notranslate"]',
                '.product-price-del',
            ];
            for (const sel of origSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    originalPriceText = el.textContent?.trim();
                    break;
                }
            }
        }

        // Last resort: search ALL elements for price pattern
        if (!salePriceText) {
            const allEls = document.querySelectorAll('span, div, p');
            for (const el of allEls) {
                const text = el.textContent?.trim() || '';
                // Match US$X.XX or $X.XX patterns
                if (/^(US)?\$\s?[0-9]+[.,][0-9]{2}$/.test(text) && text.length < 20) {
                    if (!salePriceText) {
                        salePriceText = text;
                    } else if (!originalPriceText && text !== salePriceText) {
                        originalPriceText = text;
                        break;
                    }
                }
            }
        }

        if (!salePriceText) return null;

        function parsePrice(text) {
            if (!text) return null;
            const cleaned = text.replace(/[^0-9.,]/g, '').replace(/,/g, '');
            const val = parseFloat(cleaned);
            if (isNaN(val)) return null;
            return { currency: 'USD', formatedAmount: text, value: val };
        }

        // Get title
        const titleEl = document.querySelector('h1') || document.querySelector('[data-pl="product-title"]');
        const title = titleEl?.textContent?.trim() || '';

        // Get images
        const imgEls = document.querySelectorAll('[class*="slider--img"] img, [class*="magnifier--image"] img, .product-image img');
        const images = Array.from(imgEls).map(img => img.src || img.getAttribute('data-src')).filter(Boolean);

        return {
            title,
            salePrice: parsePrice(salePriceText),
            originalPrice: parsePrice(originalPriceText),
            images: images.length > 0 ? images : [],
            rating: '0',
            orders: '0',
            storeInfo: { name: '' },
        };
    });
}

// ── Extract from embedded <script> JSON data ──
async function extractFromScripts(page) {
    return await page.evaluate(() => {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const text = script.textContent || '';
            // Look for __INIT_DATA__, runParams, or any large JSON with price info
            const patterns = [
                /window\.__INIT_DATA__\s*=\s*(\{[\s\S]+?\});/,
                /data:\s*(\{[\s\S]+?\});/,
                /"priceModule"\s*:\s*(\{[\s\S]+?\})[,;]/,
            ];
            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match && match[1] && match[1].length > 200) {
                    try {
                        const json = JSON.parse(match[1]);
                        // Look for price data in the parsed JSON
                        const pm = json.priceModule || json.priceComponent;
                        if (pm) {
                            let sp = pm.formatedActivityPrice || pm.formatedPrice;
                            if (sp) {
                                const m = sp.match(/([^\d]*)([0-9,.]+)/);
                                return {
                                    title: json.pageModule?.title || json.productInfoComponent?.subject || '',
                                    salePrice: m ? { currency: 'USD', formatedAmount: sp, value: parseFloat(m[2].replace(/,/g, '')) } : null,
                                    originalPrice: null,
                                    images: json.imageModule?.imagePathList || [],
                                    rating: json.feedbackModule?.evarageStar || '0',
                                    orders: json.tradeModule?.formatTradeCount || '0',
                                    storeInfo: { name: json.storeModule?.storeName || '' },
                                };
                            }
                        }
                    } catch {
                        // Not valid JSON
                    }
                }
            }
        }
        return null;
    });
}


// ── API Route ──
app.get('/api/scrape', async (req, res) => {
    const { id } = req.query;
    if (!id) {
        return res.status(400).json({ error: 'Missing product id. Use ?id=PRODUCT_ID' });
    }

    try {
        console.log(`\n[Scraper] === Starting scrape for: ${id} ===`);
        const data = await scrapeProduct(id);
        console.log(`[Scraper] ✅ Success:`, JSON.stringify({
            title: data.title?.substring(0, 50),
            salePrice: data.salePrice,
            originalPrice: data.originalPrice,
        }));
        res.json(data);
    } catch (error) {
        console.error(`[Scraper] ❌ Error for ${id}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Alimonitor Scraper API running on port ${port}`);
});
