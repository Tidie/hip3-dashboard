// netlify/functions/leaderboard.js
const axios = require('axios');

const SUPABASE_URL = 'https://sdcxusytmxaecfnfzweu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkY3h1c3l0bXhhZWNmbmZ6d2V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAyMTExNzUsImV4cCI6MjA4NTc4NzE3NX0.oG8UPS9OoXts8CrBVCkCfLBQaLLhSSBx7u1xuCJrTW8';

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

    const path = event.path.replace('/.netlify/functions/leaderboard', '');

    try {
        // GET /leaderboard - Get top traders
        if (event.httpMethod === 'GET' && path === '') {
            const limit = event.queryStringParameters?.limit || 100;
            
            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?select=*&order=score.desc&limit=${limit}`,
                {
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`
                    }
                }
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

        // POST /claim - Claim/update leaderboard position
        if (event.httpMethod === 'POST' && path === '/claim') {
            const { address } = JSON.parse(event.body);

            if (!address || !address.startsWith('0x')) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        message: 'Invalid address'
                    })
                };
            }

            // Fetch user's clearinghouse state
            const stateResponse = await axios.post(
                'https://api.hyperliquid.xyz/info',
                { 
                    type: 'clearinghouseState',
                    user: address
                }
            );

            const state = stateResponse.data;
            
            // Filter HIP-3 positions (contain ':' in coin name)
            const hip3Positions = (state.assetPositions || []).filter(p => {
                const coin = p.position?.coin || '';
                return coin.includes(':');
            });

            if (hip3Positions.length === 0) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        message: 'No HIP-3 activity found for this address'
                    })
                };
            }

            // Calculate stats
            let totalVolume = 0;
            let totalFees = 0;
            const marketsTraded = new Set();
            const marketDetails = {};

            hip3Positions.forEach(p => {
                const pos = p.position;
                const coin = pos.coin;
                const szi = parseFloat(pos.szi || 0);
                const entryPx = parseFloat(pos.entryPx || 0);
                const volume = Math.abs(szi * entryPx);
                
                totalVolume += volume;
                marketsTraded.add(coin);
                
                if (!marketDetails[coin]) {
                    marketDetails[coin] = { volume: 0, size: 0 };
                }
                marketDetails[coin].volume += volume;
                marketDetails[coin].size += Math.abs(szi);
            });

            // Estimate fees (0.05% of volume)
            totalFees = totalVolume * 0.0005;

            // Calculate composite score
            // Score = Volume weight + Fees weight + Diversity weight
            const score = (totalVolume * 0.5) + (totalFees * 100) + (marketsTraded.size * 10000);

            // Prepare trader data
            const traderData = {
                address: address,
                total_volume: totalVolume,
                total_fees: totalFees,
                pairs_traded: marketsTraded.size,
                trades_count: hip3Positions.length,
                markets: marketDetails,
                score: score,
                last_updated: new Date().toISOString()
            };

            // Check if address exists
            const existingResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}`,
                {
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`
                    }
                }
            );

            if (existingResponse.data.length > 0) {
                // Update existing
                await axios.patch(
                    `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}`,
                    traderData,
                    {
                        headers: {
                            'apikey': SUPABASE_KEY,
                            'Authorization': `Bearer ${SUPABASE_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
            } else {
                // Insert new
                traderData.first_seen = new Date().toISOString();
                await axios.post(
                    `${SUPABASE_URL}/rest/v1/hip3_traders`,
                    traderData,
                    {
                        headers: {
                            'apikey': SUPABASE_KEY,
                            'Authorization': `Bearer ${SUPABASE_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
            }

            // Get rank
            const allTradersResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?select=address&order=score.desc`,
                {
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`
                    }
                }
            );

            const rank = allTradersResponse.data.findIndex(t => t.address === address) + 1;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        ...traderData,
                        rank: rank,
                        total_traders: allTradersResponse.data.length
                    }
                })
            };
        }

        // GET /address/:address
        if (event.httpMethod === 'GET' && path.startsWith('/address/')) {
            const address = path.replace('/address/', '');

            const response = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?address=eq.${address}`,
                {
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`
                    }
                }
            );

            if (response.data.length === 0) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        message: 'Address not found'
                    })
                };
            }

            // Get rank
            const allTradersResponse = await axios.get(
                `${SUPABASE_URL}/rest/v1/hip3_traders?select=address&order=score.desc`,
                {
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`
                    }
                }
            );

            const rank = allTradersResponse.data.findIndex(t => t.address === address) + 1;

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    data: {
                        ...response.data[0],
                        rank: rank,
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
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                success: false,
                message: error.message
            })
        };
    }
};
