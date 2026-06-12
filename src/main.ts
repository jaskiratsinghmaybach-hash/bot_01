import 'dotenv/config'; 

async function bootSystemEngine() {
  console.log('=============================================');
  console.log('      INITIALIZING BOT_01 TRADING CORE       ');
  console.log('=============================================');

  try {
    const { query } = await import('./infrastructure/database.js');
    const { initializeMarketFeed, backfillHistoricalData } = await import('./infrastructure/binance-feed.js');

    // 1. Handshake check with Postgres
    await query('SELECT NOW()');
    console.log('[BOOT] Database handshake completed.');

    // 2. Fetch last 50 candles over HTTP REST to pre-fill strategy memory
    await backfillHistoricalData();

    // 3. Fire up the live real-time Binance stream
    initializeMarketFeed();
    
  } catch (error: any) {
    console.error('[BOOT FATAL] Core initialization halted:', error.message);
    process.exit(1);
  }
}

bootSystemEngine();
