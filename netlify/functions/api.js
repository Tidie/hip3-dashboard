// netlify/functions/api.js
const axios = require('axios');

exports.handler = async (event) => {
    // Headers CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    };

    // Gérer OPTIONS (preflight)
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    const path = event.path.replace('/.netlify/functions/api', '');

    try {
        // Route pour récupérer les statistiques globales HIP-3
        if (path === '/global-stats') {
            // Liste des DEX connus déployant des marchés HIP-3
            const dexes = ['xyz', 'vntl', 'km', 'cash', 'flx', 'hyna'];
            
            // Récupérer les données de tous les DEX en parallèle
            const dexPromises = dexes.map(dex =>
                axios.post(
                    'https://api.hyperliquid.xyz/info',
                    { type: 'metaAndAssetCtxs', dex }
                ).catch(err => {
                    console.error(`Error fetching ${dex}:`, err.message);
                    return null;
                })
            );
            
            const responses = await Promise.all(dexPromises);
            
            // Agréger tous les marchés HIP-3
            let hip3Assets = [];
            responses.forEach((response, index) => {
                if (response && response.data) {
                    const [meta, assetCtxs] = response.data;
                    const dexName = dexes[index];
                    
                    const markets = meta.universe.map((asset, idx) => ({
                        ...asset,
                        ctx: assetCtxs[idx],
                        dex: dexName // Ajouter le nom du DEX
                    }));
                    
                    hip3Assets = hip3Assets.concat(markets);
                }
            });
            
            console.log(`Total HIP-3 markets found: ${hip3Assets.length}`);
            
            // Calculer les statistiques globales
            let totalVolume24h = 0;
            let totalOI = 0;
            const marketStats = [];
            const dexStats = {};
            
            hip3Assets.forEach(asset => {
                const volume = parseFloat(asset.ctx.dayNtlVlm || 0);
                const oi = parseFloat(asset.ctx.openInterest || 0) * parseFloat(asset.ctx.markPx || 0);
                
                totalVolume24h += volume;
                totalOI += oi;
                
                // Stats par marché
                marketStats.push({
                    name: asset.name,
                    dex: asset.dex,
                    volume24h: volume,
                    openInterest: oi,
                    markPrice: parseFloat(asset.ctx.markPx || 0),
                    funding: parseFloat(asset.ctx.funding || 0),
                    premium: parseFloat(asset.ctx.premium || 0)
                });
                
                // Stats par DEX
                if (!dexStats[asset.dex]) {
                    dexStats[asset.dex] = {
                        name: asset.dex,
                        volume: 0,
                        oi: 0,
                        markets: 0
                    };
                }
                dexStats[asset.dex].volume += volume;
                dexStats[asset.dex].oi += oi;
                dexStats[asset.dex].markets += 1;
            });
            
            // Estimation des frais (0.05% du volume pour HIP-3)
            const estimatedFees24h = totalVolume24h * 0.0005;
            
            // Trier les marchés par volume
            marketStats.sort((a, b) => b.volume24h - a.volume24h);
            
            // Convertir dexStats en array et trier
            const dexArray = Object.values(dexStats).sort((a, b) => b.volume - a.volume);
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        totalVolume24h,
                        totalOI,
                        estimatedFees24h,
                        activeMarkets: hip3Assets.length,
                        topMarkets: marketStats.slice(0, 20),
                        allMarkets: marketStats,
                        dexBreakdown: dexArray,
                        timestamp: new Date().toISOString()
                    }
                })
            };
        }
        
        // Route pour l'historique de volume (données simulées basées sur les données actuelles)
        if (path === '/volume-history') {
            const days = parseInt(event.queryStringParameters?.days || '30');
            
            // Récupérer le volume actuel
            const metaResponse = await axios.post(
                'https://api.hyperliquid.xyz/info',
                { type: 'metaAndAssetCtxs' }
            );
            
            const [meta, assetCtxs] = metaResponse.data;
            const hip3Assets = meta.universe
                .map((asset, index) => ({ ...asset, ctx: assetCtxs[index] }))
                .filter(asset => asset.name.includes(':'));
            
            const currentVolume = hip3Assets.reduce((sum, asset) => 
                sum + parseFloat(asset.ctx.dayNtlVlm || 0), 0
            );
            
            // Générer historique simulé avec variation réaliste
            const history = [];
            const now = new Date();
            
            for (let i = days; i >= 0; i--) {
                const date = new Date(now);
                date.setDate(date.getDate() - i);
                
                // Variation aléatoire ±20%
                const variance = 0.8 + Math.random() * 0.4;
                const volume = currentVolume * variance;
                
                history.push({
                    date: date.toISOString().split('T')[0],
                    volume: Math.round(volume),
                    timestamp: date.getTime()
                });
            }
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: history
                })
            };
        }
        
        // Route pour récupérer un utilisateur
        if (path.startsWith('/user/')) {
            const address = path.replace('/user/', '');
            
            // Récupérer les fills
            const fillsResponse = await axios.post(
                'https://api.hyperliquid.xyz/info',
                { type: 'userFills', user: address }
            );
            
            const fills = fillsResponse.data;
            const hip3Fills = fills.filter(fill => fill.coin && fill.coin.includes(':'));
            
            if (hip3Fills.length === 0) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        message: 'Aucune activité HIP-3 trouvée'
                    })
                };
            }
            
            // Calculer les statistiques
            let totalVolume = 0;
            let totalFees = 0;
            let marketBreakdown = {};
            
            hip3Fills.forEach(fill => {
                const volume = parseFloat(fill.px) * parseFloat(fill.sz);
                const fee = parseFloat(fill.fee || 0);
                
                totalVolume += volume;
                totalFees += fee;
                
                if (!marketBreakdown[fill.coin]) {
                    marketBreakdown[fill.coin] = { volume: 0, trades: 0 };
                }
                marketBreakdown[fill.coin].volume += volume;
                marketBreakdown[fill.coin].trades += 1;
            });
            
            // Récupérer les positions pour l'OI
            let openInterest = 0;
            try {
                const positionsResponse = await axios.post(
                    'https://api.hyperliquid.xyz/info',
                    { type: 'clearinghouseState', user: address }
                );
                
                if (positionsResponse.data.assetPositions) {
                    positionsResponse.data.assetPositions.forEach(pos => {
                        if (pos.position.coin.includes(':')) {
                            openInterest += Math.abs(
                                parseFloat(pos.position.szi) * 
                                parseFloat(pos.position.entryPx || 0)
                            );
                        }
                    });
                }
            } catch (err) {
                console.log('Could not fetch positions:', err.message);
            }
            
            const marketArray = Object.entries(marketBreakdown).map(([market, data]) => ({
                name: market,
                volume: data.volume,
                trades: data.trades,
                percentage: ((data.volume / totalVolume) * 100).toFixed(2)
            })).sort((a, b) => b.volume - a.volume);
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        address,
                        totalVolume,
                        totalFees,
                        tradeCount: hip3Fills.length,
                        openInterest,
                        marketBreakdown: marketArray
                    }
                })
            };
        }
        
        // Route proxy générique
        if (path === '/hyperliquid' && event.httpMethod === 'POST') {
            const body = JSON.parse(event.body);
            
            const response = await axios.post(
                'https://api.hyperliquid.xyz/info',
                body
            );
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(response.data)
            };
        }
        
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Route not found: ' + path })
        };
        
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: error.message,
                path: path
            })
        };
    }
};
