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

async function getLeaderboardStats(address) {
    const res = await axios.get(
        `${SUPABASE_URL}/rest/v1/leaderboard_stats?address=eq.${address}`,
        { headers: supabaseHeaders() }
    );
    return res.data?.[0] || null;
}

async function getTraderDetailsRPC(address) {
    const res = await axios.post(
        `${SUPABASE_URL}/rest/v1/rpc/get_trader_details`,
        { trader_address: address },
        { headers: supabaseHeaders() }
    );
    return res.data || { markets: {}, pnl_history: [] };
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
            
            // Get stats from leaderboard_stats
            const stats = await getLeaderboardStats(address);
            
            if (!stats) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: false, message: 'No HIP-3 trades found for this address.' })
                };
            }

            // Get details via RPC (fast aggregation on Supabase side)
            const details = await getTraderDetailsRPC(address);
            
            // Get rank
            const rankInfo = await getRankInfo(address, stats.total_volume);
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        address,
                        total_volume: stats.total_volume,
                        total_fees: stats.total_fees,
                        total_pnl: stats.total_pnl,
                        trades_count: stats.trades_count,
                        pairs_traded: stats.pairs_traded || Object.keys(details.markets || {}).length,
                        markets: details.markets,
                        pnl_history: details.pnl_history,
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
