// netlify/functions/leaderboard.js
const axios = require('axios');

const SUPABASE_URL = 'https://sdcxusytmxaecfnfzweu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkY3h1c3l0bXhhZWNmbmZ6d2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTExNzUsImV4cCI6MjA4NTc4NzE3NX0.oG8UPS9OoXts8CrBVCkCfLBQaLLhSSBx7u1xuCJrTW8';

const HL_API = 'https://api.hyperliquid.xyz/info';

const LARGE_ACCOUNT_THRESHOLD = 100000;
const MAX_FILLS_TO_FETCH = 100000;

// Helper: fetch ALL HIP-3 fills with pagination going FORWARD in time
async function fetchAllHip3Fills(address, maxFills = MAX_FILLS_TO_FETCH) {
    let allHip3Fills = [];
    let startTime = 0; // Start from the beginning
    let iterations = 0;
    const maxIterations = 60;
    const seenTxIds = new Set();
    
    console.log(`[${address}] === STARTING PAGINATION (forward in time) ===`);
    
    while (iterations < maxIterations) {
        iterations++;
        
        try {
            console.log(`[${address}] Iter ${iterations}: startTime=${startTime}`);
            
            const response = await axios.post(HL_API, {
                type: 'userFillsByTime',
                user: address,
                startTime: startTime,
                endTime: Date.now(),
                aggregateByTime: false
            }, { timeout: 10000 });
            
            const fills = response.data || [];
            
            console.log(`[${address}] Iter ${iterations}: received ${fills.length} fills`);
            
            if (fills.length === 0) {
                console.log(`[${address}] No fills returned - done`);
                break;
            }
            
            // Filter HIP-3 and dedupe
            let newFills = 0;
            for (const f of fills) {
                if (f.coin && f.coin.includes(':')) {
                    const txId = f.tid || `${f.time}-${f.oid}-${f.coin}-${f.px}-${f.sz}`;
                    if (!seenTxIds.has(txId)) {
                        seenTxIds.add(txId);
                        allHip3Fills.push(f);
                        newFills++;
                    }
                }
            }
            
            console.log(`[${address}] Iter ${iterations}: +${newFills} new HIP-3 | Total: ${allHip3Fills.length}`);
            
            // If less than 2000, we got everything
            if (fills.length < 2000) {
                console.log(`[${address}] Got ${fills.length} < 2000 - reached end`);
                break;
            }
            
            // Check limit
            if (allHip3Fills.length >= maxFills) {
                console.log(`[${address}] Hit max limit ${maxFills}`);
                break;
            }
            
            // Get the NEWEST timestamp and continue from there
            const timestamps = fills.map(f => f.time).filter(t => t);
            if (timestamps.length === 0) break;
            
            const newestTime = Math.max(...timestamps);
            
            // Move startTime forward (add 1ms to avoid duplicates)
            if (newestTime <= startTime) {
                console.log(`[${address}] Not making progress - stopping`);
                break;
            }
            
            startTime = newestTime + 1;
            
            // No new fills means we're stuck
            if (newFills === 0) {
                console.log(`[${address}] No new fills - stopping`);
                break;
            }
            
            await new Promise(r => setTimeout(r, 50));
            
        } catch (e) {
            console.error(`[${address}] ERROR: ${e.message}`);
            break;
        }
    }
    
    console.log(`[${address}] === DONE: ${allHip3Fills.length} fills in ${iterations} iters ===`);
    return allHip3Fills;
}

function computeStats(fills) {
    let totalVolume = 0, totalFees = 0, totalPnl = 0;
    const marketsTraded = new Set();
    const marketDetails = {};
    const dailyPnl = {};

    fills.forEach(fill => {
        const coin = fill.coin;
        const px = parseFloat(fill.px || 0);
        const sz = parseFloat(fill.sz || 0);
        const fee = parseFloat(fill.fee || 0);
        const closedPnl = parseFloat(fill.closedPnl || 0);
        const volume = px * sz;

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
        
        if (fill.time) {
            const date = new Date(fill.time).toISOString().split('T')[0];
            if (!dailyPnl[date]) dailyPnl[date] = 0;
            dailyPnl[date] += closedPnl;
        }
    });
    
    const sortedDates = Object.keys(dailyPnl).sort();
    let cumulative = 0;
    const pnlHistory = sortedDates.map(date => {
        cumulative += dailyPnl[date];
        return { date, pnl: cumulative };
    });

    return {
        total_volume: totalVolume,
        total_fees: totalFees,
        total_pnl: totalPnl,
        pairs_traded: marketsTraded.size,
        trades_count: fills.length,
        markets: marketDetails,
        pnl_history: pnlHistory,
        score: totalVolume * 0.5 + totalFees * 200 + marketsTraded.size * 15000
    };
}

function supabaseHeaders() {
    return {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
    };
}

async function getDbStats(address) {
    try {
        const response = await axios.get(
            `${SUPABASE_URL}/rest/v1/leaderboard_stats?address=eq.${address}`,
            { headers: supabaseHeaders() }
        );
        return response.data?.[0] || null;
    } catch (e) {
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
            const page = parseInt(params.page) || 1;
            const limit = Math.min(parseInt(params.limit || params.pageSize) || 20, 100);
            const sortBy = params.sortBy || 'total_volume';
            const sortDir = params.sortDir === 'asc' ? 'asc' : 'desc';
            const offset = (page - 1) * limit;

            const allowedSorts = ['total_volume', 'total_pnl', 'total_fees', 'trades_count', 'pairs_traded'];
            const safeSortBy = allowedSorts.includes(sortBy) ? sortBy : 'total_volume';

            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=*&order=${safeSortBy}.${sortDir}&limit=${limit}&offset=${offset}`,
                { headers: { ...supabaseHeaders(), 'Prefer': 'count=exact' } }
            );

            const total = parseInt((response.headers['content-range'] || '0-0/0').split('/')[1]) || 0;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: response.data.map((t, idx) => ({ ...t, rank: offset + idx + 1 })),
                    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasPrev: page > 1, hasNext: page < Math.ceil(total / limit) }
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
            console.log(`[${address}] === CLAIM REQUEST ===`);

            // Check for large accounts
            const existingStats = await getDbStats(address);
            if (existingStats && existingStats.trades_count >= LARGE_ACCOUNT_THRESHOLD) {
                const rankInfo = await getRankInfo(address, existingStats.total_volume);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        data: {
                            address,
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
                            message: `Account has ${existingStats.trades_count.toLocaleString()} trades. Details not available for 100k+ accounts.`
                        }
                    })
                };
            }

            // Fetch fills
            const hip3Fills = await fetchAllHip3Fills(address);

            if (hip3Fills.length === 0) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: false, message: 'No HIP-3 trades found.' })
                };
            }

            const stats = computeStats(hip3Fills);
            const rankInfo = await getRankInfo(address, stats.total_volume);

            console.log(`[${address}] === COMPLETE: ${stats.trades_count} trades ===`);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        address,
                        ...stats,
                        rank: rankInfo.rank,
                        total_traders: rankInfo.total_traders,
                        fills_analyzed: hip3Fills.length,
                        large_account: false
                    }
                })
            };
        }

        // GET /address/:address
        if (event.httpMethod === 'GET' && fullPath.includes('/address/')) {
            const address = fullPath.split('/address/')[1].toLowerCase();
            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}`,
                { headers: supabaseHeaders() }
            );

            if (response.data.length === 0) {
                return { statusCode: 404, headers, body: JSON.stringify({ success: false, message: 'Not found' }) };
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, data: response.data[0] })
            };
        }

        return { statusCode: 404, headers, body: JSON.stringify({ success: false, message: 'Not found' }) };

    } catch (error) {
        console.error('Error:', error.message);
        return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: error.message }) };
    }
};
