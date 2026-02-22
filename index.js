const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rota de Healthcheck do Easypanel
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Scraper API está rodando!' });
});

// Rota Principal de Raspagem
app.get('/api/scrape', async (req, res) => {
    const { id } = req.query;

    if (!id) {
        return res.status(400).json({ error: 'O parâmetro "id" do produto é obrigatório.' });
    }

    try {
        console.log(`[Scraper] Iniciando raspagem para o produto: ${id}`);
        // Importação dinâmica para suportar ES Modules em CommonJS
        const scraperModule = await import('aliexpress-product-scraper');
        const scrape = scraperModule.default || scraperModule;
        
        // O scraper do github pede só o ID do produto
        const data = await scrape(id);

        console.log(`[Scraper] Sucesso para o produto: ${id}`);
        res.status(200).json(data);
    } catch (error) {
        console.error(`[Scraper] Erro ao raspar produto ${id}:`, error.message);
        res.status(500).json({
            error: 'Falha ao realizar o scraping do produto',
            details: error.message
        });
    }
});

app.listen(port, () => {
    console.log(`Alimonitor Scraper API rodando na porta ${port}`);
});
