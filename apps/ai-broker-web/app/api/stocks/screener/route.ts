// Stock Screener API Route
import { NextRequest, NextResponse } from 'next/server';
import { createYahooFinance } from '@/packages/investing/src/stocks/yahoo-finance-wrapper';
import { getAdminDB } from '@/lib/admin/db';
import { filterHiddenQuotes, getHiddenStockSymbolsSafe } from '@/lib/admin/listings';

const yahooFinance = createYahooFinance();

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const scrIds = searchParams.get('scrIds');

        if (!scrIds) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'scrIds parameter is required',
                    code: 'MISSING_SCRIDS',
                    timestamp: new Date().toISOString()
                },
                { status: 400 }
            );
        }

        const result = await yahooFinance.screener({ scrIds: scrIds as any });
        // Symbols an admin hid from the public lists (admin → Stocks).
        const quotes = filterHiddenQuotes(result.quotes as any[], await getHiddenStockSymbolsSafe(getAdminDB));

        return NextResponse.json({
            success: true,
            count: quotes.length,
            data: quotes,
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        return NextResponse.json(
            {
                success: false,
                error: error.message || 'Screener failed',
                code: 'SCREENER_ERROR',
                timestamp: new Date().toISOString()
            },
            { status: 500 }
        );
    }
}
