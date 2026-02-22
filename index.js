const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rota de Healthcheck
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Scraper API rodando!' });
});

// Rota Principal - Scraper customizado que acessa pt.aliexpress.com (BRL + promos)
app.get('/api/scrape', async (req, res) => {
    const { id } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'O parâmetro "id" do produto é obrigatório.' });
    }

    let browser;
    try {
        console.log(`[Scraper] Iniciando raspagem BR para o produto: ${id}`);

        // Importação dinâmica (ES Module)
        const puppeteerExtra = await import('puppeteer-extra');
        const StealthPlugin = await import('puppeteer-extra-plugin-stealth');
        const puppeteer = puppeteerExtra.default;
        puppeteer.use(StealthPlugin.default());

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        });

        const page = await browser.newPage();

        // Configura headers para simular um usuário brasileiro
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        });

        // Intercepta a API interna do AliExpress para pegar os dados do produto
        let apiData = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('mtop.aliexpress') && url.includes('pdp')) {
                try {
                    const text = await response.text();
                    if (text && text.length > 1000) {
                        // Parse JSONP: mtopjsonpX({...})
                        const trimmed = text.trim();
                        const match = trimmed.match(/^[a-zA-Z0-9_]+\(([\s\S]+)\)$/);
                        let parsed;
                        if (match && match[1]) {
                            parsed = JSON.parse(match[1]);
                        } else {
                            parsed = JSON.parse(trimmed);
                        }
                        if (parsed?.data?.result) {
                            apiData = parsed;
                        }
                    }
                } catch {}
            }
        });

        // ACESSA O SITE BRASILEIRO (pt.aliexpress.com) para pegar preço em BRL com promoções
        await page.goto(`https://pt.aliexpress.com/item/${id}.html`, {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        // Espera os dados da API serem capturados
        const maxWait = 15000;
        const startTime = Date.now();
        while (!apiData && (Date.now() - startTime) < maxWait) {
            await new Promise(r => setTimeout(r, 500));
        }

        // Fallback: tenta pegar via window.runParams (método antigo)
        if (!apiData) {
            const runParamsData = await page.evaluate(() => {
                try { return window.runParams?.data || null; } catch { return null; }
            });
            if (runParamsData && Object.keys(runParamsData).length > 0) {
                apiData = { data: { result: runParamsData } };
            }
        }

        if (!apiData?.data?.result) {
            throw new Error('Não foi possível extrair os dados do produto. Pode ser bloqueio anti-bot.');
        }

        const result = apiData.data.result;

        // Extrai o preço (já em BRL com promoções SuperDeals/Carnival)
        const priceInfo = result.PRICE?.targetSkuPriceInfo || {};
        
        // Preço promocional (warmUpPrice > salePrice > salePriceString)
        let salePrice = null;
        if (priceInfo.warmUpPrice) {
            salePrice = priceInfo.warmUpPrice;
        } else if (priceInfo.salePrice) {
            salePrice = priceInfo.salePrice;
        } else if (priceInfo.salePriceString) {
            const m = priceInfo.salePriceString.match(/([^\d]*)([0-9.,]+)/);
            if (m) {
                salePrice = {
                    value: parseFloat(m[2].replace(/\./g, '').replace(',', '.')),
                    formatedAmount: priceInfo.salePriceString,
                };
            }
        }

        // Preço original
        const origPrice = priceInfo.originalPrice || null;

        // Imagens
        const images = result.HEADER_IMAGE_PC?.imagePathList || [];

        // Título
        const title = result.PRODUCT_TITLE?.text || result.GLOBAL_DATA?.globalData?.subject || '';

        // Avaliações
        const rating = result.PC_RATING?.rating || '0';
        const totalReviews = result.PC_RATING?.totalValidNum || 0;

        // Vendidos
        const globalData = result.GLOBAL_DATA?.globalData || {};
        const orders = globalData.sales || '0';

        // Loja
        const storeInfo = {
            name: result.SHOP_CARD_PC?.storeName || globalData.storeName || '',
            logo: result.SHOP_CARD_PC?.logo || '',
        };

        // Moeda
        const currencyCode = globalData.currencyCode || 'BRL';

        await browser.close();

        const response_data = {
            title,
            images,
            salePrice: salePrice ? {
                value: salePrice.value,
                formatedAmount: salePrice.formatedAmount,
                currency: salePrice.currency || currencyCode,
            } : null,
            originalPrice: origPrice ? {
                value: origPrice.value,
                formatedAmount: origPrice.formatedAmount,
                currency: origPrice.currency || currencyCode,
            } : null,
            rating,
            totalReviews,
            orders,
            storeInfo,
            currencyCode,
        };

        console.log(`[Scraper] Sucesso para o produto: ${id} | Preço: ${salePrice?.formatedAmount || 'N/A'} | Moeda: ${currencyCode}`);
        res.status(200).json(response_data);

    } catch (error) {
        console.error(`[Scraper] Erro ao raspar produto ${id}:`, error.message);
        if (browser) await browser.close().catch(() => {});
        res.status(500).json({
            error: 'Falha ao realizar o scraping do produto',
            details: error.message,
        });
    }
});

app.listen(port, () => {
    console.log(`Alimonitor Scraper API rodando na porta ${port}`);
});
