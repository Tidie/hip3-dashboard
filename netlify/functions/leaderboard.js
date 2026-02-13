// netlify/functions/leaderboard.js
const axios = require('axios');

const SUPABASE_URL = 'https://sdcxusytmxaecfnfzweu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkY3h1c3l0bXhhZWNmbmZ6d2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTExNzUsImV4cCI6MjA4NTc4NzE3NX0.oG8UPS9OoXts8CrBVCkCfLBQaLLhSSBx7u1xuCJrTW8';

function supabaseHeaders() {
    return {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
    };
}

// Get trader from DB (leaderboard_stats + trader_details)
async function getTraderFromDB(address) {
    try {
        const [statsResp, detailsResp] = await Promise.all([
            axios.get(
                `${SUPABASE_URL}/rest/v1/leaderboard_stats?address=eq.${address}`,
                { headers: supabaseHeaders() }
            ),
            axios.get(
                `${SUPABASE_URL}/rest/v1/trader_details?address=eq.${address}`,
                { headers: supabaseHeaders() }
            )
        ]);
        
        const stats = statsResp.data?.[0];
        const details = detailsResp.data?.[0];
        
        if (!stats) return null;
        
        return {
            ...stats,
            markets: details?.markets || null,
            pnl_history: details?.pnl_history || null
        };
    } catch (e) {
        console.error(`[${address}] DB fetch error: ${e.message}`);
        return null;
    }
}

async function getRankInfo(address, totalVolume) {
    try {
        const [rankResp, totalResp] = await Promise.all([
            axios.get(`${SUPABASE_URL}/rest/v1/leaderboard_stats?select=address&total_volume=gt.${totalVolume}`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }),
            axios.get(`${SUPABASE_URL}/rest/v1/leaderboard_stats?select=address`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } })
        ]);
        
        const tradersAbove = parseInt((rankResp.headers['content-range'] || '0-0/0').split('/')[1]) || 0;
        const totalTraders = parseInt((totalResp.headers['content-range'] || '0-0/1').split('/')[1]) || 1;
        
        return { rank: tradersAbove + 1, total_traders: totalTraders };
    } catch (e) {
        return { rank: 0, total_traders: 0 };
    }
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    try {
        const fullPath = event.path || '';

        // GET /leaderboard
        if (event.httpMethod === 'GET' && (fullPath.endsWith('/leaderboard') || fullPath.includes('/leaderboard/'))) {
            const params = event.queryStringParameters || {};
            
            let page = parseInt(params.page, 10);
            if (isNaN(page) || page < 1) page = 1;
            
            let limit = parseInt(params.limit || params.pageSize, 10);
            if (isNaN(limit) || limit < 1) limit = 20;
            if (limit > 100) limit = 100;
            
            const sortBy = params.sortBy || 'total_volume';
            const sortDir = params.sortDir === 'asc' ? 'asc' : 'desc';
            const offset = (page - 1) * limit;

            const allowedSorts = ['total_volume', 'total_pnl', 'total_fees', 'trades_count', 'pairs_traded'];
            const safeSortBy = allowedSorts.includes(sortBy) ? sortBy : 'total_volume';

            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=*&order=${safeSortBy}.${sortDir}&limit=${limit}&offset=${offset}`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact' } }
            );

            const contentRange = response.headers['content-range'] || '0-0/0';
            let total = parseInt(contentRange.split('/')[1], 10);
            if (isNaN(total)) total = 0;
            
            const totalPages = Math.max(1, Math.ceil(total / limit));

            const tradersWithRank = response.data.map((t, idx) => ({ 
                ...t, 
                rank: offset + idx + 1 
            }));

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: tradersWithRank,
                    pagination: { page, limit, total, totalPages, offset, hasPrev: page > 1, hasNext: page < totalPages }
                })
            };
        }

        // POST /claim
        if (event.httpMethod === 'POST' && fullPath.endsWith('/claim')) {
            const { address: rawAddress } = JSON.parse(event.body);

            if (!rawAddress || !rawAddress.startsWith('0x') || rawAddress.length !== 42) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Invalid address' }) };
            }

            const address = rawAddress.toLowerCase();
            
            // Get from DB
            const dbData = await getTraderFromDB(address);
            
            if (!dbData) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: false, message: 'No HIP-3 trades found for this address.' })
                };
            }

            const rankInfo = await getRankInfo(address, dbData.total_volume);
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        address,
                        total_volume: dbData.total_volume,
                        total_fees: dbData.total_fees,
                        total_pnl: dbData.total_pnl,
                        trades_count: dbData.trades_count,
                        pairs_traded: dbData.pairs_traded || Object.keys(dbData.markets || {}).length,
                        markets: dbData.markets,
                        pnl_history: dbData.pnl_history,
                        rank: rankInfo.rank,
                        total_traders: rankInfo.total_traders
                    }
                })
            };
        }

        return { statusCode: 404, headers, body: JSON.stringify({ success: false, message: 'Not found' }) };

    } catch (error) {
        console.error('Error:', error.message);
        return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: error.message }) };
    }
};
