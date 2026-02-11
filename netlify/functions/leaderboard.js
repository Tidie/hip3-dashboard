// netlify/functions/leaderboard.js
const axios = require('axios');

const SUPABASE_URL = 'https://sdcxusytmxaecfnfzweu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkY3h1c3l0bXhhZWNmbmZ6d2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTExNzUsImV4cCI6MjA4NTc4NzE3NX0.oG8UPS9OoXts8CrBVCkCfLBQaLLhSSBx7u1xuCJrTW8';

const HL_API = 'https://api.hyperliquid.xyz/info';

// Helper: fetch ALL HIP-3 fills for a user (fully paginated)
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
    allFills = [...hip3Fills];
    
    // Step 2: If we got 2000 fills, there might be more - paginate backwards in a LOOP
    if (fills.length >= 2000) {
        let oldestTime = Math.min(...fills.map(f => f.time));
        let hasMore = true;
        let iterations = 0;
        const maxIterations = 50; // Safety limit: max 50 * 2000 = 100k trades
        
        while (hasMore && iterations < maxIterations) {
            iterations++;
            try {
                console.log(`Pagination ${iterations}: fetching fills before ${new Date(oldestTime).toISOString()}`);
                
                const olderResponse = await axios.post(HL_API, {
                    type: 'userFillsByTime',
                    user: address,
                    startTime: 0,
                    endTime: oldestTime - 1,
                    aggregateByTime: false
                });
                
                const olderFills = olderResponse.data || [];
                
                if (olderFills.length === 0) {
                    hasMore = false;
                } else {
                    const olderHip3 = olderFills.filter(f => f.coin && f.coin.includes(':'));
                    allFills = [...allFills, ...olderHip3];
                    
                    // Update oldest time for next iteration
                    oldestTime = Math.min(...olderFills.map(f => f.time));
                    
                    // If we got less than 2000, we've reached the end
                    if (olderFills.length < 2000) {
                        hasMore = false;
                    }
                }
            } catch (e) {
                console.log('Pagination error:', e.message);
                hasMore = false;
            }
        }
        
        console.log(`Total fills fetched: ${allFills.length} (${iterations} pagination calls)`);
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
        // Reads from leaderboard_stats (updated by S3 bot)
        // ──────────────────────────────────────────────
        if (event.httpMethod === 'GET' && (fullPath.endsWith('/leaderboard') || fullPath === '/.netlify/functions/leaderboard')) {
            const params = event.queryStringParameters || {};
            const pageSize = Math.min(Math.max(parseInt(params.pageSize) || parseInt(params.limit) || 50, 1), 100);
            const page = Math.max(parseInt(params.page) || 1, 1);
            const offset = (page - 1) * pageSize;
            const sortBy = params.sortBy || 'total_volume';
            
            // Validate sortBy to prevent injection
            const allowedSorts = ['total_volume', 'total_pnl', 'total_fees', 'trades_count', 'pairs_traded'];
            const sortField = allowedSorts.includes(sortBy) ? sortBy : 'total_volume';

            // Fetch page of data with count
            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=*&order=${sortField}.desc&limit=${pageSize}&offset=${offset}`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': `${offset}-${offset + pageSize - 1}` } }
            );

            // Parse total count from content-range header
            const contentRange = response.headers['content-range'] || `0-0/0`;
            const total = parseInt(contentRange.split('/')[1]) || 0;
            const totalPages = Math.ceil(total / pageSize);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: response.data,
                    pagination: {
                        page,
                        pageSize,
                        total,
                        totalPages,
                        offset,
                        hasPrev: page > 1,
                        hasNext: page < totalPages
                    }
                })
            };
        }

        // ──────────────────────────────────────────────
        // POST /claim - Claim/update leaderboard position
        // < 100k trades: Full details from API with pagination
        // >= 100k trades: Supabase only (no API call, no overwrite)
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

            const address = rawAddress.toLowerCase();

            // Step 1: Check if address exists in leaderboard_stats (from S3 bot)
            const existingStats = await axios.get(
                `${SUPABASE_URL}/rest/v1/leaderboard_stats?address=eq.${address}`,
                { headers: supabaseHeaders() }
            );

            let dbTotals = null;
            if (existingStats.data && existingStats.data.length > 0) {
                dbTotals = existingStats.data[0];
            }

            const LARGE_ACCOUNT_THRESHOLD = 100000;
            const isLargeAccount = dbTotals && dbTotals.trades_count >= LARGE_ACCOUNT_THRESHOLD;

            let stats;
            let hip3FillsCount = 0;

            if (isLargeAccount) {
                // ═══════════════════════════════════════════════
                // LARGE ACCOUNT (>= 100k trades): Supabase only
                // NO API call, NO overwrite
                // ═══════════════════════════════════════════════
                stats = {
                    total_volume: dbTotals.total_volume || 0,
                    total_fees: dbTotals.total_fees || 0,
                    total_pnl: dbTotals.total_pnl || 0,
                    trades_count: dbTotals.trades_count || 0,
                    pairs_traded: dbTotals.pairs_traded || 0,
                    markets: null, // Signal to frontend: no market details
                    pnl_history: null, // Signal to frontend: no pnl history
                    score: (dbTotals.total_volume || 0) * 0.5 + (dbTotals.total_fees || 0) * 200,
                    large_account: true,
                    large_account_message: `This account has ${dbTotals.trades_count.toLocaleString()}+ trades. Detailed market breakdown and PnL history are not available for accounts with more than 100k trades to ensure data accuracy.`
                };
                hip3FillsCount = dbTotals.trades_count;

            } else {
                // ═══════════════════════════════════════════════
                // NORMAL ACCOUNT (< 100k trades): Full API fetch
                // ═══════════════════════════════════════════════
                let hip3Fills = await fetchAllHip3Fills(address);
                
                if (hip3Fills.length === 0 && rawAddress !== address) {
                    hip3Fills = await fetchAllHip3Fills(rawAddress);
                }

                if (hip3Fills.length === 0 && !dbTotals) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({
                            success: false,
                            message: `No HIP-3 trades found for this address. Make sure you have traded on HIP-3 markets (tokens with ":" in the name like xyz:TOKEN).`
                        })
                    };
                }

                const apiStats = hip3Fills.length > 0 ? computeStats(hip3Fills) : null;
                hip3FillsCount = hip3Fills.length;

                // Use DB totals if available (more accurate), otherwise API
                stats = {
                    total_volume: dbTotals?.total_volume || apiStats?.total_volume || 0,
                    total_fees: dbTotals?.total_fees || apiStats?.total_fees || 0,
                    total_pnl: dbTotals?.total_pnl || apiStats?.total_pnl || 0,
                    trades_count: dbTotals?.trades_count || apiStats?.trades_count || 0,
                    pairs_traded: apiStats?.pairs_traded || 0,
                    markets: apiStats?.markets || {},
                    pnl_history: apiStats?.pnl_history || [],
                    score: (dbTotals?.total_volume || apiStats?.total_volume || 0) * 0.5 + (dbTotals?.total_fees || apiStats?.total_fees || 0) * 200,
                    large_account: false
                };

                // Save to hip3_traders for detailed view (only for normal accounts)
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

                const existingTrader = await axios.get(
                    `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}`,
                    { headers: supabaseHeaders() }
                );

                if (existingTrader.data.length > 0) {
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

                // ONLY save to leaderboard_stats if NOT already in DB (new addresses only)
                if (!dbTotals && apiStats) {
                    await axios.post(
                        `${SUPABASE_URL}/rest/v1/leaderboard_stats`,
                        {
                            address: address,
                            total_volume: apiStats.total_volume,
                            total_fees: apiStats.total_fees,
                            total_pnl: apiStats.total_pnl,
                            trades_count: apiStats.trades_count,
                            updated_at: new Date().toISOString()
                        },
                        { headers: { ...supabaseHeaders(), 'Prefer': 'resolution=merge-duplicates' } }
                    );
                }
            }

            // Get rank by counting traders with higher volume
            const rankResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=address&total_volume=gt.${stats.total_volume}`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }
            );
            
            const totalResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=address`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }
            );

            const rankRange = rankResponse.headers['content-range'] || '0-0/0';
            const totalRange = totalResponse.headers['content-range'] || '0-0/1';
            
            const tradersAbove = parseInt(rankRange.split('/')[1]) || 0;
            const totalTraders = parseInt(totalRange.split('/')[1]) || 1;
            const rank = tradersAbove + 1;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        address: address,
                        total_volume: stats.total_volume,
                        total_fees: stats.total_fees,
                        total_pnl: stats.total_pnl,
                        trades_count: stats.trades_count,
                        pairs_traded: stats.pairs_traded,
                        markets: stats.markets,
                        pnl_history: stats.pnl_history,
                        score: stats.score,
                        rank: rank,
                        total_traders: totalTraders,
                        fills_analyzed: hip3FillsCount,
                        large_account: stats.large_account || false,
                        large_account_message: stats.large_account_message || null,
                        data_source: isLargeAccount ? 'database only (large account)' : (dbTotals ? 'database + API details' : 'hyperliquid API')
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
