// netlify/functions/leaderboard.js
const axios = require('axios');

const SUPABASE_URL = 'https://sdcxusytmxaecfnfzweu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkY3h1c3l0bXhhZWNmbmZ6d2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTExNzUsImV4cCI6MjA4NTc4NzE3NX0.oG8UPS9OoXts8CrBVCkCfLBQaLLhSSBx7u1xuCJrTW8';

const HL_API = 'https://api.hyperliquid.xyz/info';

// Helper: fetch ALL HIP-3 fills for a user (paginated via userFillsByTime)
async function fetchAllHip3Fills(address) {
    let allFills = [];
    
    // Step 1: Get last 2000 fills via userFills
    const response = await axios.post(HL_API, {
        type: 'userFills',
        user: address,
        aggregateByTime: false
    });
    
    const fills = response.data || [];
    
    // Filter HIP-3 fills only (coin contains ':')
    const hip3Fills = fills.filter(f => f.coin && f.coin.includes(':'));
    allFills = hip3Fills;
    
    // Step 2: If we got exactly 2000 fills, there might be more - paginate backwards
    if (fills.length >= 2000 && hip3Fills.length > 0) {
        const oldestTime = Math.min(...fills.map(f => f.time));
        
        try {
            const olderResponse = await axios.post(HL_API, {
                type: 'userFillsByTime',
                user: address,
                startTime: 0,
                endTime: oldestTime - 1,
                aggregateByTime: false
            });
            
            const olderFills = (olderResponse.data || []).filter(f => f.coin && f.coin.includes(':'));
            allFills = [...allFills, ...olderFills];
        } catch (e) {
            // If pagination fails, we still have the first batch
            console.log('Pagination note:', e.message);
        }
    }
    
    return allFills;
}

// Helper: compute stats from fills
function computeStats(fills) {
    let totalVolume = 0;
    let totalFees = 0;
    let totalPnl = 0;
    let tradesCount = fills.length;
    const marketsTraded = new Set();
    const marketDetails = {};
    
    // For PnL history chart - group by day
    const dailyPnl = {};

    fills.forEach(fill => {
        const coin = fill.coin;
        const px = parseFloat(fill.px || 0);
        const sz = parseFloat(fill.sz || 0);
        const fee = parseFloat(fill.fee || 0);
        const closedPnl = parseFloat(fill.closedPnl || 0);
        const volume = px * sz;
        const time = fill.time;

        totalVolume += volume;
        totalFees += fee;
        totalPnl += closedPnl;
        marketsTraded.add(coin);

        if (!marketDetails[coin]) {
            marketDetails[coin] = { volume: 0, fees: 0, pnl: 0, trades: 0 };
        }
        marketDetails[coin].volume += volume;
        marketDetails[coin].fees += fee;
        marketDetails[coin].pnl += closedPnl;
        marketDetails[coin].trades += 1;
        
        // Group PnL by day for chart
        if (time) {
            const date = new Date(time).toISOString().split('T')[0]; // YYYY-MM-DD
            if (!dailyPnl[date]) dailyPnl[date] = 0;
            dailyPnl[date] += closedPnl;
        }
    });
    
    // Convert daily PnL to cumulative PnL array sorted by date
    const sortedDates = Object.keys(dailyPnl).sort();
    let cumulative = 0;
    const pnlHistory = sortedDates.map(date => {
        cumulative += dailyPnl[date];
        return { date, pnl: cumulative };
    });

    // Score formula:
    // Volume weight (50%) + Real fees weight (30%) + Diversity weight (20%)
    const volumeScore = totalVolume * 0.5;
    const feeScore = totalFees * 200;
    const diversityScore = marketsTraded.size * 15000;
    const score = volumeScore + feeScore + diversityScore;

    return {
        total_volume: totalVolume,
        total_fees: totalFees,
        total_pnl: totalPnl,
        pairs_traded: marketsTraded.size,
        trades_count: tradesCount,
        markets: marketDetails,
        pnl_history: pnlHistory,
        score: score
    };
}

// Supabase helper
function supabaseHeaders() {
    return {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    };
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const fullPath = event.path || '';
    console.log('Request:', event.httpMethod, fullPath);

    try {
        // ──────────────────────────────────────────────
        // GET /leaderboard - Get top traders (with sorting)
        // ──────────────────────────────────────────────
        if (event.httpMethod === 'GET' && (fullPath.endsWith('/leaderboard') || fullPath === '/.netlify/functions/leaderboard')) {
            const params = event.queryStringParameters || {};
            const limit = parseInt(params.limit || '50');
            const sortBy = params.sortBy || 'total_volume';
            
            // Validate sortBy to prevent injection
            const allowedSorts = ['total_volume', 'total_pnl', 'total_fees', 'trades_count', 'pairs_traded'];
            const sortField = allowedSorts.includes(sortBy) ? sortBy : 'total_volume';

            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?select=*&order=${sortField}.desc&limit=${limit}`,
                { headers: supabaseHeaders() }
            );

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: response.data
                })
            };
        }

        // ──────────────────────────────────────────────
        // POST /claim - Claim/update leaderboard position
        // Uses userFills (real trade history, not just open positions)
        // ──────────────────────────────────────────────
        if (event.httpMethod === 'POST' && fullPath.endsWith('/claim')) {
            const { address: rawAddress } = JSON.parse(event.body);

            if (!rawAddress || !rawAddress.startsWith('0x') || rawAddress.length !== 42) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        message: 'Invalid address format'
                    })
                };
            }

            // Normalize address to lowercase
            const address = rawAddress.toLowerCase();

            // Fetch real fills from Hyperliquid
            const hip3Fills = await fetchAllHip3Fills(address);

            if (hip3Fills.length === 0) {
                // Also try with original case (some APIs are case-sensitive)
                let retryFills = [];
                if (rawAddress !== address) {
                    retryFills = await fetchAllHip3Fills(rawAddress);
                }

                if (retryFills.length === 0) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({
                            success: false,
                            message: `No HIP-3 trades found for this address. Make sure you have traded on HIP-3 markets (tokens with ":" in the name like xyz:TOKEN). Found 0 HIP-3 fills out of the last 2000 trades checked.`
                        })
                    };
                }
                // Use retry fills if original case worked
                hip3Fills.push(...retryFills);
            }

            // Compute real stats from fills
            const stats = computeStats(hip3Fills);

            // Prepare trader data
            const traderData = {
                address: address,
                total_volume: stats.total_volume,
                total_fees: stats.total_fees,
                total_pnl: stats.total_pnl,
                pairs_traded: stats.pairs_traded,
                trades_count: stats.trades_count,
                markets: stats.markets,
                score: stats.score,
                last_updated: new Date().toISOString()
            };

            // Upsert: check if address exists (also check with lowercase)
            const existingResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}`,
                { headers: supabaseHeaders() }
            );

            if (existingResponse.data.length > 0) {
                await axios.patch(
                    `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}`,
                    traderData,
                    { headers: supabaseHeaders() }
                );
            } else {
                traderData.first_seen = new Date().toISOString();
                await axios.post(
                    `${SUPABASE_URL}/rest/v1/hip3_traders`,
                    traderData,
                    { headers: supabaseHeaders() }
                );
            }

            // Get rank by counting traders with higher volume
            const rankResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?select=address&total_volume=gt.${stats.total_volume}`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }
            );
            
            // Get total traders count
            const totalResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?select=address`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }
            );

            // Parse content-range header: "0-0/total"
            const rankRange = rankResponse.headers['content-range'] || '0-0/0';
            const totalRange = totalResponse.headers['content-range'] || '0-0/1';
            
            const tradersAbove = parseInt(rankRange.split('/')[1]) || 0;
            const totalTraders = parseInt(totalRange.split('/')[1]) || 1;
            const rank = tradersAbove + 1; // Rank = traders with more volume + 1

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        ...traderData,
                        pnl_history: stats.pnl_history,
                        rank: rank,
                        total_traders: totalTraders,
                        fills_analyzed: hip3Fills.length
                    }
                })
            };
        }

        // ──────────────────────────────────────────────
        // GET /address/:address - Get specific trader
        // ──────────────────────────────────────────────
        if (event.httpMethod === 'GET' && fullPath.includes('/address/')) {
            const rawAddress = fullPath.split('/address/')[1];
            const address = rawAddress.toLowerCase();

            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}`,
                { headers: supabaseHeaders() }
            );

            if (response.data.length === 0) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        message: 'Address not found. Use the Claim button first to index your trades.'
                    })
                };
            }

            const allTradersResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?select=address&order=score.desc`,
                { headers: supabaseHeaders() }
            );

            const rank = allTradersResponse.data.findIndex(t => t.address === address) + 1;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        ...response.data[0],
                        rank: rank || allTradersResponse.data.length,
                        total_traders: allTradersResponse.data.length
                    }
                })
            };
        }

        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ success: false, message: 'Not found' })
        };

    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                success: false,
                message: error.message,
                details: error.response?.data || null
            })
        };
    }
};
