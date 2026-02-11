// netlify/functions/leaderboard.js
const axios = require('axios');

const SUPABASE_URL = 'https://sdcxusytmxaecfnfzweu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkY3h1c3l0bXhhZWNmbmZ6d2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTExNzUsImV4cCI6MjA4NTc4NzE3NX0.oG8UPS9OoXts8CrBVCkCfLBQaLLhSSBx7u1xuCJrTW8';

const HL_API = 'https://api.hyperliquid.xyz/info';

// Config
const LARGE_ACCOUNT_THRESHOLD = 100000; // 100k trades
const MAX_FILLS_TO_FETCH = 100000;      // Safety limit
const BATCH_SIZE = 2000;                // HL API limit per request

// Helper: fetch ALL HIP-3 fills for a user with FULL pagination
async function fetchAllHip3Fills(address, maxFills = MAX_FILLS_TO_FETCH) {
    let allHip3Fills = [];
    let endTime = Date.now();
    let iterations = 0;
    const maxIterations = Math.ceil(maxFills / BATCH_SIZE) + 5;
    
    console.log(`[${address}] Starting pagination...`);
    
    while (iterations < maxIterations) {
        iterations++;
        
        try {
            const response = await axios.post(HL_API, {
                type: 'userFillsByTime',
                user: address,
                startTime: 0,
                endTime: endTime,
                aggregateByTime: false
            }, { timeout: 5000 }); // 5s timeout per request
            
            const fills = response.data || [];
            
            if (fills.length === 0) {
                console.log(`[${address}] No more fills at iteration ${iterations}`);
                break;
            }
            
            // Filter HIP-3 fills only (coin contains ':')
            const hip3Fills = fills.filter(f => f.coin && f.coin.includes(':'));
            allHip3Fills.push(...hip3Fills); // More efficient than spread
            
            console.log(`[${address}] #${iterations}: ${fills.length} fills (${hip3Fills.length} HIP-3) | Total: ${allHip3Fills.length}`);
            
            // If we got less than BATCH_SIZE, we've reached the end
            if (fills.length < BATCH_SIZE) {
                break;
            }
            
            // If we've hit our limit, stop
            if (allHip3Fills.length >= maxFills) {
                console.log(`[${address}] Hit max limit: ${maxFills}`);
                break;
            }
            
            // Get oldest timestamp for next iteration
            const oldestTime = Math.min(...fills.map(f => f.time));
            endTime = oldestTime - 1;
            
            // Minimal delay - just enough to avoid rate limiting
            await new Promise(r => setTimeout(r, 50));
            
        } catch (e) {
            console.error(`[${address}] Error at iteration ${iterations}:`, e.message);
            // Don't break on error - we might have partial data
            if (allHip3Fills.length > 0) {
                console.log(`[${address}] Returning partial data: ${allHip3Fills.length} fills`);
                break;
            }
            throw e; // Re-throw if we have no data at all
        }
    }
    
    console.log(`[${address}] Done! Total HIP-3 fills: ${allHip3Fills.length}`);
    return allHip3Fills;
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
        'Content-Type': 'application/json'
    };
}

// Helper: Check if address exists in DB and get stats
async function getDbStats(address) {
    try {
        const response = await axios.get(
            `${SUPABASE_URL}/rest/v1/leaderboard_stats?address=eq.${address}`,
            { headers: supabaseHeaders() }
        );
        
        if (response.data && response.data.length > 0) {
            return response.data[0];
        }
        return null;
    } catch (e) {
        console.error('Error fetching DB stats:', e.message);
        return null;
    }
}

// Helper: Get rank for an address
async function getRankInfo(address, totalVolume) {
    try {
        // Get rank by counting traders with higher volume
        const rankResponse = await axios.get(
            `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=address&total_volume=gt.${totalVolume}`,
            { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }
        );
        
        // Get total traders count
        const totalResponse = await axios.get(
            `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=address`,
            { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }
        );

        const rankRange = rankResponse.headers['content-range'] || '0-0/0';
        const totalRange = totalResponse.headers['content-range'] || '0-0/1';
        
        const tradersAbove = parseInt(rankRange.split('/')[1]) || 0;
        const totalTraders = parseInt(totalRange.split('/')[1]) || 1;
        
        return {
            rank: tradersAbove + 1,
            total_traders: totalTraders
        };
    } catch (e) {
        console.error('Error getting rank:', e.message);
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

        // ──────────────────────────────────────────────
        // GET /leaderboard - Paginated leaderboard from Supabase
        // ──────────────────────────────────────────────
        if (event.httpMethod === 'GET' && (fullPath.endsWith('/leaderboard') || fullPath.includes('/leaderboard/'))) {
            const params = event.queryStringParameters || {};
            const page = parseInt(params.page) || 1;
            const limit = Math.min(parseInt(params.limit || params.pageSize) || 20, 100);
            const sortBy = params.sortBy || 'total_volume';
            const sortDir = params.sortDir === 'asc' ? 'asc' : 'desc';
            const offset = (page - 1) * limit;

            // Validate sortBy to prevent injection
            const allowedSorts = ['total_volume', 'total_pnl', 'total_fees', 'trades_count', 'pairs_traded'];
            const safeSortBy = allowedSorts.includes(sortBy) ? sortBy : 'total_volume';

            // Get paginated data from leaderboard_stats
            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=*&order=${safeSortBy}.${sortDir}&limit=${limit}&offset=${offset}`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact' } }
            );

            // Parse content-range for total count: "0-19/150"
            const contentRange = response.headers['content-range'] || '0-0/0';
            const total = parseInt(contentRange.split('/')[1]) || 0;
            const totalPages = Math.ceil(total / limit);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: response.data.map((t, idx) => ({
                        ...t,
                        rank: offset + idx + 1
                    })),
                    pagination: {
                        page,
                        limit,
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
        // With 100k trade threshold check
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

            // ═══════════════════════════════════════════════════════════
            // STEP 1: Check DB first for existing stats
            // ═══════════════════════════════════════════════════════════
            const existingStats = await getDbStats(address);
            
            if (existingStats && existingStats.trades_count >= LARGE_ACCOUNT_THRESHOLD) {
                // Large account - return DB stats only (no API fetch)
                console.log(`[${address}] Large account detected (${existingStats.trades_count} trades). Returning DB stats.`);
                
                const rankInfo = await getRankInfo(address, existingStats.total_volume);
                
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        data: {
                            address: address,
                            total_volume: existingStats.total_volume,
                            total_fees: existingStats.total_fees,
                            total_pnl: existingStats.total_pnl,
                            trades_count: existingStats.trades_count,
                            pairs_traded: existingStats.pairs_traded || 0,
                            rank: rankInfo.rank,
                            total_traders: rankInfo.total_traders,
                            large_account: true,
                            markets: null,
                            pnl_history: null,
                            message: `This account has ${existingStats.trades_count.toLocaleString()} trades. Detailed breakdown is not available for accounts with 100k+ trades.`
                        }
                    })
                };
            }

            // ═══════════════════════════════════════════════════════════
            // STEP 2: Fetch all fills from Hyperliquid API (with pagination)
            // ═══════════════════════════════════════════════════════════
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
                            message: `No HIP-3 trades found for this address. Make sure you have traded on HIP-3 markets (tokens with ":" in the name like xyz:TOKEN).`
                        })
                    };
                }
                // Use retry fills if original case worked
                hip3Fills.push(...retryFills);
            }

            // Compute real stats from fills
            const stats = computeStats(hip3Fills);

            // NOTE: We do NOT save anything to the database
            // The scan is READ-ONLY - just displays stats from Hyperliquid API
            // The leaderboard is ONLY updated by the S3 sync bot

            // Get rank info (read-only from leaderboard_stats)
            const rankInfo = await getRankInfo(address, stats.total_volume);

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
                        pairs_traded: stats.pairs_traded,
                        trades_count: stats.trades_count,
                        markets: stats.markets,
                        pnl_history: stats.pnl_history,
                        rank: rankInfo.rank,
                        total_traders: rankInfo.total_traders,
                        fills_analyzed: hip3Fills.length,
                        large_account: false
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
