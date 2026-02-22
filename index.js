const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Rota principal - usa a biblioteca aliexpress-product-scraper (funciona de forma estável)
app.get('/api/scrape', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Parâmetro "id" obrigatório.' });

    try {
        console.log(`[Scraper] Buscando produto: ${id}`);
        
        const scraperModule = await import('aliexpress-product-scraper');
        const scrape = scraperModule.default || scraperModule;

        const data = await scrape(id, {
            puppeteerOptions: {
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            }
        });

        console.log(`[Scraper] ✅ Sucesso: ${data.title?.substring(0, 60)}`);
        console.log(`[Scraper] Preço venda:`, JSON.stringify(data.salePrice));
        console.log(`[Scraper] Preço original:`, JSON.stringify(data.originalPrice));
        
        res.status(200).json(data);
    } catch (error) {
        console.error(`[Scraper] ❌ Erro para ${id}:`, error.message);
        res.status(500).json({ error: 'Falha no scraping', details: error.message });
    }
});

app.listen(port, () => {
    console.log(`Alimonitor Scraper API rodando na porta ${port}`);
});
