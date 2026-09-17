const { chromium } = require('playwright');

async function diagnoseLayout(url, label) {
    const browser = await chromium.launch({ headless: true });
    const viewports = [
        { width: 375, height: 812, name: '375x812' },
        { width: 390, height: 844, name: '390x844' },
        { width: 430, height: 932, name: '430x932' },
        { width: 768, height: 1024, name: '768x1024' }
    ];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`TESTING: ${label}`);
    console.log(`URL: ${url}`);
    console.log('='.repeat(60));

    for (const viewport of viewports) {
        const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height }
        });

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(1000);

            const metrics = await page.evaluate(() => {
                const getElementMetrics = (selector) => {
                    const el = document.querySelector(selector);
                    if (!el) return null;

                    const rect = el.getBoundingClientRect();
                    const computed = window.getComputedStyle(el);

                    return {
                        selector,
                        width: rect.width,
                        height: rect.height,
                        left: rect.left,
                        right: rect.right,
                        computedWidth: computed.width,
                        computedMinWidth: computed.minWidth,
                        computedMaxWidth: computed.maxWidth,
                        computedPaddingLeft: computed.paddingLeft,
                        computedPaddingRight: computed.paddingRight,
                        computedMarginLeft: computed.marginLeft,
                        computedMarginRight: computed.marginRight,
                        computedTransform: computed.transform,
                        computedPosition: computed.position,
                        computedOverflow: computed.overflow,
                        computedBoxSizing: computed.boxSizing
                    };
                };

                return {
                    viewport: {
                        innerWidth: window.innerWidth,
                        innerHeight: window.innerHeight,
                        visualViewportWidth: window.visualViewport?.width,
                        visualViewportScale: window.visualViewport?.scale
                    },
                    document: {
                        documentElementClientWidth: document.documentElement.clientWidth,
                        documentElementScrollWidth: document.documentElement.scrollWidth,
                        bodyClientWidth: document.body.clientWidth,
                        bodyScrollWidth: document.body.scrollWidth,
                        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
                    },
                    elements: {
                        html: getElementMetrics('html'),
                        body: getElementMetrics('body'),
                        main: getElementMetrics('.main'),
                        pageContent: getElementMetrics('#page-content'),
                        sidebar: getElementMetrics('.sidebar'),
                        topbar: getElementMetrics('.topbar'),
                        dashboardGrid: getElementMetrics('.dashboard-grid'),
                        heroCard: getElementMetrics('.hero-card'),
                        card: getElementMetrics('.card'),
                        floatingDock: getElementMetrics('.floating-dock'),
                        spotifyMainPlayer: getElementMetrics('#spotify-main-player'),
                        spotifyMiniPlayer: getElementMetrics('#spotify-mini-player'),
                        spotifyMiniPlayerClass: getElementMetrics('.spotify-mini-player')
                    }
                };
            });

            console.log(`\n--- ${viewport.name} ---`);
            console.log(`Window: ${metrics.viewport.innerWidth}x${metrics.viewport.innerHeight}`);
            console.log(`Visual Viewport: ${metrics.viewport.visualViewportWidth} (scale: ${metrics.viewport.visualViewportScale})`);
            console.log(`Document scrollWidth: ${metrics.document.documentElementScrollWidth}`);
            console.log(`Body scrollWidth: ${metrics.document.bodyScrollWidth}`);
            console.log(`Horizontal Overflow: ${metrics.document.hasHorizontalOverflow ? 'YES ⚠️' : 'NO ✓'}`);

            if (metrics.document.hasHorizontalOverflow) {
                console.log(`  └─ Overflow by: ${metrics.document.documentElementScrollWidth - metrics.viewport.innerWidth}px`);
            }

            console.log('\nKey Element Widths:');
            ['html', 'body', 'main', 'pageContent', 'dashboardGrid', 'heroCard'].forEach(key => {
                const el = metrics.elements[key];
                if (el) {
                    console.log(`  ${el.selector}: ${el.width.toFixed(1)}px (computed: ${el.computedWidth})`);
                    if (el.right > metrics.viewport.innerWidth) {
                        console.log(`    ⚠️ OVERFLOWS RIGHT by ${(el.right - metrics.viewport.innerWidth).toFixed(1)}px`);
                    }
                }
            });

            console.log('\nSpotify Elements:');
            ['floatingDock', 'spotifyMiniPlayer', 'spotifyMiniPlayerClass'].forEach(key => {
                const el = metrics.elements[key];
                if (el) {
                    console.log(`  ${el.selector}: ${el.width.toFixed(1)}px at left:${el.left.toFixed(1)} right:${el.right.toFixed(1)}`);
                    console.log(`    max-width: ${el.computedMaxWidth}, position: ${el.computedPosition}`);
                    if (el.right > metrics.viewport.innerWidth) {
                        console.log(`    ⚠️ OVERFLOWS by ${(el.right - metrics.viewport.innerWidth).toFixed(1)}px`);
                    }
                }
            });

        } catch (error) {
            console.log(`\n--- ${viewport.name} ---`);
            console.log(`ERROR: ${error.message}`);
        } finally {
            await page.close();
        }
    }

    await browser.close();
}

(async () => {
    const currentUrl = 'http://localhost:3000';
    const referenceUrl = 'http://localhost:3001';

    console.log('\n' + '='.repeat(60));
    console.log('MOBILE RESPONSIVE FORENSIC DIAGNOSIS');
    console.log('='.repeat(60));

    try {
        await diagnoseLayout(currentUrl, 'CURRENT MAIN');
    } catch (error) {
        console.log(`\nCURRENT TEST FAILED: ${error.message}`);
        console.log('Make sure the server is running on port 3000');
    }

    console.log('\n\n');

    try {
        await diagnoseLayout(referenceUrl, 'REFERENCE (Known-Good)');
    } catch (error) {
        console.log(`\nREFERENCE TEST FAILED: ${error.message}`);
        console.log('Reference server not running - comparison skipped');
    }
})();
