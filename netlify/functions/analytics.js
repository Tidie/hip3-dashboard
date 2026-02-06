// netlify/functions/analytics.js
// ═══════════════════════════════════════════════════════
// HIP-3 Analytics API
// ═══════════════════════════════════════════════════════

const axios = require('axios');

const SUPABASE_URL = 'https://sdcxusytmxaecfnfzweu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkY3h1c3l0bXhhZWNmbmZ6d2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTExNzUsImV4cCI6MjA4NTc4NzE3NX0.oG8UPS9OoXts8CrBVCkCfLBQaLLhSSBx7u1xuCJrTW8';
const HL_API = 'https://api.hyperliquid.xyz/info';

function sbHeaders() {
    return {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
    };
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const path = event.path.replace('/.netlify/functions/analytics', '');

    try {
        // ──────────────────────────────────────────────
        // GET /daily - Volume chart data (last 30 days)
        // ──────────────────────────────────────────────
        if (path === '/daily' || path === '') {
            const days = event.queryStringParameters?.days || 30;
            
            const res = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_daily_stats?select=*&order=date.desc&limit=${days}`,
                { headers: sbHeaders() }
            );

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: res.data.reverse() // Chronological order
                })
            };
        }

        // ──────────────────────────────────────────────
        // GET /heatmap - Hourly activity heatmap
        // ──────────────────────────────────────────────
        if (path === '/heatmap') {
            const res = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_hourly_stats?select=*`,
                { headers: sbHeaders() }
            );

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: res.data
                })
            };
        }

        // ──────────────────────────────────────────────
        // GET /whales - Recent whale trades
        // ──────────────────────────────────────────────
        if (path === '/whales') {
            const limit = event.queryStringParameters?.limit || 20;
            
            const res = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_whale_trades?select=*&order=timestamp.desc&limit=${limit}`,
                { headers: sbHeaders() }
            );

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: res.data
                })
            };
        }

        // ──────────────────────────────────────────────
        // GET /whales/wallets - Whale wallets to watch
        // ──────────────────────────────────────────────
        if (path === '/whales/wallets') {
            const res = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_whale_wallets?select=*&order=total_volume.desc&limit=20&is_watching=eq.true`,
                { headers: sbHeaders() }
            );

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: res.data
                })
            };
        }

        // ──────────────────────────────────────────────
        // GET /top-markets - Top 5 markets today
        // ──────────────────────────────────────────────
        if (path === '/top-markets') {
            const today = new Date().toISOString().slice(0, 10);
            
            const res = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_market_daily?date=eq.${today}&select=*&order=volume.desc&limit=5`,
                { headers: sbHeaders() }
            );

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: res.data
                })
            };
        }

        // ──────────────────────────────────────────────
        // GET /trader/:address - Trader profile
        // ──────────────────────────────────────────────
        if (path.startsWith('/trader/')) {
            const address = path.replace('/trader/', '').toLowerCase();
            
            if (!address || !address.startsWith('0x') || address.length !== 42) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ success: false, error: 'Invalid address' })
                };
            }

            // Get trader stats from DB
            const traderRes = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}&select=*`,
                { headers: sbHeaders() }
            );

            // Get recent fills from Hyperliquid
            let recentFills = [];
            let pnlHistory = [];
            try {
                const fillsRes = await axios.post(HL_API, {
                    type: 'userFills',
                    user: address,
                    aggregateByTime: false
                });
                
                const allFills = fillsRes.data || [];
                // Filter HIP-3 only
                const hip3Fills = allFills.filter(f => f.coin && f.coin.includes(':'));
                
                // Get recent 50 fills
                recentFills = hip3Fills.slice(0, 50).map(f => ({
                    time: f.time,
                    coin: f.coin,
                    side: f.side,
                    size: f.sz,
                    price: f.px,
                    pnl: f.closedPnl,
                    fee: f.fee
                }));
                
                // Calculate PnL over time (aggregate by day)
                const pnlByDay = {};
                let runningPnl = 0;
                
                // Sort fills by time ascending
                const sortedFills = [...hip3Fills].sort((a, b) => a.time - b.time);
                
                sortedFills.forEach(f => {
                    const day = new Date(f.time).toISOString().slice(0, 10);
                    const pnl = parseFloat(f.closedPnl || 0);
                    runningPnl += pnl;
                    pnlByDay[day] = runningPnl;
                });
                
                pnlHistory = Object.entries(pnlByDay).map(([date, pnl]) => ({ date, pnl }));
                
            } catch (e) {
                console.log('Could not fetch fills:', e.message);
            }

            // Calculate win rate
            let wins = 0, losses = 0;
            recentFills.forEach(f => {
                const pnl = parseFloat(f.pnl || 0);
                if (pnl > 0) wins++;
                else if (pnl < 0) losses++;
            });
            const winRate = (wins + losses) > 0 ? (wins / (wins + losses) * 100) : 0;

            const traderData = traderRes.data[0] || null;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        trader: traderData,
                        recentFills,
                        pnlHistory,
                        winRate: winRate.toFixed(1),
                        wins,
                        losses
                    }
                })
            };
        }

        // Not found
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ success: false, error: 'Endpoint not found' })
        };

    } catch (error) {
        console.error('Analytics error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};
