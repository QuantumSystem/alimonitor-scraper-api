const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.get('/api/scrape', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Parâmetro "id" obrigatório.' });

    let browser;
    try {
        console.log(`[Scraper] Iniciando para: ${id}`);

        const puppeteerExtra = await import('puppeteer-extra');
        const StealthPlugin = await import('puppeteer-extra-plugin-stealth');
        const puppeteer = puppeteerExtra.default;
        puppeteer.use(StealthPlugin.default());

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-gpu', '--single-process'],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        });

        const page = await browser.newPage();
        
        // Simula um usuário brasileiro
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Seta cookie para forçar BRL/Brasil
        await page.setCookie({
            name: 'aep_usuc_f',
            value: 'site=bra&c_tp=BRL&region=BR&b_locale=pt_BR',
            domain: '.aliexpress.com',
        });

        // Tenta pt.aliexpress.com primeiro, com fallback para www
        const urls = [
            `https://pt.aliexpress.com/item/${id}.html`,
            `https://www.aliexpress.com/item/${id}.html`,
        ];

        let productData = null;

        for (const url of urls) {
            try {
                console.log(`[Scraper] Tentando: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

                // Espera o preço aparecer na página (até 10s)
                await page.waitForSelector('[class*="price"], [class*="Price"], .product-price', { timeout: 10000 }).catch(() => {});
                
                // Espera mais 2s para garantir que JavaScript renderizou tudo
                await new Promise(r => setTimeout(r, 2000));

                // Extração de dados diretamente do DOM renderizado
                productData = await page.evaluate(() => {
                    // === PREÇO ===
                    // Tenta múltiplos seletores de preço (AliExpress muda frequentemente)
                    const priceSelectors = [
                        '.product-price-current [class*="price-current"]',
                        '[class*="es--wrap"] [class*="notranslate"]',
                        '.uniform-banner-box-price',
                        '[class*="snow-price_snowPrice"]',
                        '[class*="price--current"]',
                        '[class*="product-price"]',
                    ];
                    
                    let priceText = '';
                    for (const sel of priceSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent.trim()) {
                            priceText = el.textContent.trim();
                            break;
                        }
                    }

                    // Fallback: procura qualquer elemento com R$ no texto
                    if (!priceText) {
                        const allElements = document.querySelectorAll('span, div, p');
                        for (const el of allElements) {
                            const text = el.textContent.trim();
                            // Procura padrão R$ seguido de número
                            if (/R\$\s*\d/.test(text) && text.length < 30 && !text.includes('economiza')) {
                                priceText = text;
                                break;
                            }
                        }
                    }

                    // === PREÇO ORIGINAL (riscado) ===
                    const origSelectors = [
                        '[class*="price--original"]',
                        '[class*="price-del"]',
                        'del',
                        '[class*="price--through"]',
                    ];
                    let origPriceText = '';
                    for (const sel of origSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent.trim() && /\d/.test(el.textContent)) {
                            origPriceText = el.textContent.trim();
                            break;
                        }
                    }

                    // === TÍTULO ===
                    const titleEl = document.querySelector('h1, [data-pl="product-title"]');
                    const title = titleEl ? titleEl.textContent.trim() : '';

                    // === IMAGENS ===
                    const images = [];
                    document.querySelectorAll('img[src*="ae01.alicdn.com"], img[src*="ae04.alicdn.com"]').forEach(img => {
                        const src = img.src || img.getAttribute('src');
                        if (src && !images.includes(src) && src.includes('_')) {
                            images.push(src.split('_')[0] + '_' + src.split('_').pop()); // URL limpa
                        }
                    });
                    // Também pega imagens dos thumbnails
                    document.querySelectorAll('[class*="slider"] img, [class*="image-view"] img').forEach(img => {
                        const src = img.src || img.getAttribute('src');
                        if (src && src.includes('alicdn.com') && !images.includes(src)) {
                            images.push(src);
                        }
                    });

                    // === RATING ===
                    const ratingEl = document.querySelector('[class*="rating"] strong, [aria-label*="star"]');
                    const rating = ratingEl ? ratingEl.textContent.trim() : '0';

                    // === VENDIDOS ===
                    let orders = '0';
                    const soldEls = document.querySelectorAll('span, div');
                    for (const el of soldEls) {
                        const t = el.textContent.trim();
                        if (/vendido|sold/i.test(t) && /\d/.test(t) && t.length < 30) {
                            const m = t.match(/([\d.,]+[\+]?)/); 
                            if (m) { orders = m[1]; break; }
                        }
                    }

                    // === LOJA ===
                    const storeEl = document.querySelector('[class*="store-name"] a, [class*="shop-name"] a, a[href*="/store/"]');
                    const storeName = storeEl ? storeEl.textContent.trim() : '';

                    // Tenta também pegar os dados do window.runParams como fallback
                    let runParamsPrice = null;
                    try {
                        const rp = window.runParams?.data;
                        if (rp) {
                            const priceComp = rp.priceComponent || rp.PRICE;
                            if (priceComp) {
                                const tpi = priceComp.targetSkuPriceInfo;
                                if (tpi) {
                                    const sp = tpi.warmUpPrice || tpi.salePrice;
                                    if (sp) runParamsPrice = sp;
                                }
                            }
                        }
                    } catch {}

                    return { priceText, origPriceText, title, images, rating, orders, storeName, runParamsPrice };
                });

                if (productData && (productData.priceText || productData.title)) {
                    console.log(`[Scraper] Dados encontrados em: ${url}`);
                    break;
                }
            } catch (navError) {
                console.log(`[Scraper] Falhou em ${url}: ${navError.message}`);
            }
        }

        await browser.close();

        if (!productData || (!productData.priceText && !productData.runParamsPrice)) {
            throw new Error('Não foi possível extrair os dados. Anti-bot ou página não carregou.');
        }

        // Parseia o preço do texto ("R$22,64" ou "R$ 903,99" ou "US $4.04")
        const parsePrice = (text) => {
            if (!text) return 0;
            const cleaned = text.replace(/[^0-9.,]/g, '');
            // Formato brasileiro: 1.234,56 → troca . por nada, , por .
            if (cleaned.includes(',')) {
                return parseFloat(cleaned.replace(/\.(?=\d{3})/g, '').replace(',', '.')) || 0;
            }
            return parseFloat(cleaned) || 0;
        };

        let salePriceValue = parsePrice(productData.priceText);
        let origPriceValue = parsePrice(productData.origPriceText);

        // Se o DOM não pegou o preço, tenta o runParams
        if (!salePriceValue && productData.runParamsPrice) {
            const rp = productData.runParamsPrice;
            if (rp.formatedAmount) {
                salePriceValue = parsePrice(rp.formatedAmount);
            } else if (rp.value) {
                salePriceValue = rp.value / 100;
            }
        }

        // Detecta a moeda pelo texto do preço
        const isBrl = /R\$/.test(productData.priceText) || salePriceValue > 10;
        const currency = isBrl ? 'BRL' : 'USD';

        const responseData = {
            title: productData.title,
            images: productData.images.length > 0 ? productData.images : [],
            salePrice: {
                value: salePriceValue,
                formatedAmount: productData.priceText,
                currency,
            },
            originalPrice: origPriceValue ? {
                value: origPriceValue,
                formatedAmount: productData.origPriceText,
                currency,
            } : null,
            rating: productData.rating,
            orders: productData.orders,
            storeInfo: { name: productData.storeName },
            currencyCode: currency,
        };

        console.log(`[Scraper] \u2705 ${productData.title?.substring(0, 50)} | ${productData.priceText} | ${currency}`);
        res.status(200).json(responseData);

    } catch (error) {
        console.error(`[Scraper] \u274C Erro: ${error.message}`);
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({ error: 'Falha no scraping', details: error.message });
    }
});

app.listen(port, () => {
    console.log(`Alimonitor Scraper API rodando na porta ${port}`);
});
