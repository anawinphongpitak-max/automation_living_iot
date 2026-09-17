/* =====================================================
   MOBILE NAVIGATION
===================================================== */

function setupMobileNavigation() {
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('mobileSidebarBackdrop');
    const navItems = document.querySelectorAll('.nav-item');

    if (!mobileMenuBtn || !sidebar || !backdrop) {
        console.warn('[Mobile Nav] Elements not found');
        return;
    }

    // Open mobile menu
    function openMobileMenu() {
        sidebar.classList.add('mobile-open');
        backdrop.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    // Close mobile menu
    function closeMobileMenu() {
        sidebar.classList.remove('mobile-open');
        backdrop.classList.remove('active');
        document.body.style.overflow = '';
    }

    // Hamburger button click
    mobileMenuBtn.addEventListener('click', () => {
        if (sidebar.classList.contains('mobile-open')) {
            closeMobileMenu();
        } else {
            openMobileMenu();
        }
    });

    // Backdrop click
    backdrop.addEventListener('click', closeMobileMenu);

    // Close menu when navigation item is clicked
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            // Close mobile menu on mobile screens
            if (window.innerWidth <= 768) {
                closeMobileMenu();
            }
        });
    });

    // Close menu on window resize if switching to desktop
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (window.innerWidth > 768 && sidebar.classList.contains('mobile-open')) {
                closeMobileMenu();
            }
        }, 250);
    });
}

// Initialize mobile navigation after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupMobileNavigation);
} else {
    setupMobileNavigation();
}
