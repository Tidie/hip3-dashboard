// netlify/functions/leaderboard.js
const axios = require('axios');

const SUPABASE_URL = 'https://sdcxusytmxaecfnfzweu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkY3h1c3l0bXhhZWNmbmZ6d2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTExNzUsImV4cCI6MjA4NTc4NzE3NX0.oG8UPS9OoXts8CrBVCkCfLBQaLLhSSBx7u1xuCJrTW8';

const HL_API = 'https://api.hyperliquid.xyz/info';

// Config
const LARGE_ACCOUNT_THRESHOLD = 100000;
const MAX_FILLS_TO_FETCH = 100000;

// Helper: fetch ALL HIP-3 fills with FULL pagination
async function fetchAllHip3Fills(address, maxFills = MAX_FILLS_TO_FETCH) {
    let allHip3Fills = [];
    let endTime = Date.now();
    let iterations = 0;
    const maxIterations = 55; // Safety limit: 55 * 2000 = 110k trades max
    let prevEndTime = null;
    
    console.log(`[${address}] === STARTING PAGINATION ===`);
    
    while (iterations < maxIterations) {
        iterations++;
        
        try {
            console.log(`[${address}] Iteration ${iterations}: fetching with endTime=${endTime}...`);
            
            const response = await axios.post(HL_API, {
                type: 'userFillsByTime',
                user: address,
                startTime: 0,
                endTime: endTime,
                aggregateByTime: false
            }, { timeout: 10000 }); // 10s timeout per request
            
            const fills = response.data || [];
            
            console.log(`[${address}] Iteration ${iterations}: received ${fills.length} fills`);
            
            if (fills.length === 0) {
                console.log(`[${address}] No more fills returned - DONE`);
                break;
            }
            
            // Filter HIP-3 fills only
            const hip3Fills = fills.filter(f => f.coin && f.coin.includes(':'));
            
            if (hip3Fills.length > 0) {
                allHip3Fills.push(...hip3Fills);
                console.log(`[${address}] Iteration ${iterations}: +${hip3Fills.length} HIP-3 fills | Total: ${allHip3Fills.length}`);
            } else {
                console.log(`[${address}] Iteration ${iterations}: 0 HIP-3 fills in this batch`);
            }
            
            // Check if we got less than 2000 - means we reached the end
            if (fills.length < 2000) {
                console.log(`[${address}] Got ${fills.length} < 2000 fills - reached the end`);
                break;
            }
            
            // Check limit
            if (allHip3Fills.length >= maxFills) {
                console.log(`[${address}] Reached max limit ${maxFills} - stopping`);
                break;
            }
            
            // Get oldest timestamp and go further back
            const timestamps = fills.map(f => f.time).filter(t => t);
            if (timestamps.length === 0) {
                console.log(`[${address}] No valid timestamps - stopping`);
                break;
            }
            
            const oldestTime = Math.min(...timestamps);
            
            // Safety: check we're making progress
            if (prevEndTime !== null && oldestTime >= prevEndTime) {
                console.log(`[${address}] Not making progress (${oldestTime} >= ${prevEndTime}) - stopping`);
                break;
            }
            
            prevEndTime = endTime;
            endTime = oldestTime - 1; // Go back 1ms before oldest
            
            // Small delay
            await new Promise(r => setTimeout(r, 50));
            
        } catch (e) {
            console.error(`[${address}] ERROR at iteration ${iterations}: ${e.message}`);
            if (allHip3Fills.length > 0) {
                console.log(`[${address}] Returning partial data: ${allHip3Fills.length} fills`);
            }
            break;
        }
    }
    
    console.log(`[${address}] === PAGINATION COMPLETE: ${allHip3Fills.length} HIP-3 fills in ${iterations} iterations ===`);
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
        
        if (time) {
            const date = new Date(time).toISOString().split('T')[0];
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
        if (response.data && response.data.length > 0) {
            return response.data[0];
        }
        return null;
    } catch (e) {
        console.error('Error fetching DB stats:', e.message);
        return null;
    }
}

async function getRankInfo(address, totalVolume) {
    try {
        const rankResponse = await axios.get(
            `${SUPABASE_URL}/rest/v1/leaderboard_stats?select=address&total_volume=gt.${totalVolume}`,
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
        
        return { rank: tradersAbove + 1, total_traders: totalTraders };
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

            const contentRange = response.headers['content-range'] || '0-0/0';
            const total = parseInt(contentRange.split('/')[1]) || 0;
            const totalPages = Math.ceil(total / limit);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: response.data.map((t, idx) => ({ ...t, rank: offset + idx + 1 })),
                    pagination: { page, limit, total, totalPages, offset, hasPrev: page > 1, hasNext: page < totalPages }
                })
            };
        }

        // POST /claim
        if (event.httpMethod === 'POST' && fullPath.endsWith('/claim')) {
            const { address: rawAddress } = JSON.parse(event.body);

            if (!rawAddress || !rawAddress.startsWith('0x') || rawAddress.length !== 42) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ success: false, message: 'Invalid address format' })
                };
            }

            const address = rawAddress.toLowerCase();
            
            console.log(`[${address}] === CLAIM REQUEST ===`);

            // Check DB for large accounts
            const existingStats = await getDbStats(address);
            
            if (existingStats && existingStats.trades_count >= LARGE_ACCOUNT_THRESHOLD) {
                console.log(`[${address}] Large account (${existingStats.trades_count} trades) - returning DB stats`);
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
                            message: `This account has ${existingStats.trades_count.toLocaleString()} trades. Detailed breakdown not available for 100k+ accounts.`
                        }
                    })
                };
            }

            // Fetch all fills from Hyperliquid API
            console.log(`[${address}] Fetching fills from Hyperliquid...`);
            const hip3Fills = await fetchAllHip3Fills(address);

            if (hip3Fills.length === 0) {
                // Retry with original case
                let retryFills = [];
                if (rawAddress !== address) {
                    console.log(`[${address}] Retrying with original case: ${rawAddress}`);
                    retryFills = await fetchAllHip3Fills(rawAddress);
                }

                if (retryFills.length === 0) {
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({
                            success: false,
                            message: `No HIP-3 trades found for this address.`
                        })
                    };
                }
                hip3Fills.push(...retryFills);
            }

            console.log(`[${address}] Computing stats for ${hip3Fills.length} fills...`);
            const stats = computeStats(hip3Fills);
            const rankInfo = await getRankInfo(address, stats.total_volume);

            console.log(`[${address}] === CLAIM COMPLETE: ${stats.trades_count} trades, $${Math.round(stats.total_volume)} volume ===`);

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

        // GET /address/:address
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
                    body: JSON.stringify({ success: false, message: 'Address not found.' })
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
                    data: { ...response.data[0], rank: rank || allTradersResponse.data.length, total_traders: allTradersResponse.data.length }
                })
            };
        }

        return { statusCode: 404, headers, body: JSON.stringify({ success: false, message: 'Not found' }) };

    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, message: error.message, details: error.response?.data || null })
        };
    }
};
