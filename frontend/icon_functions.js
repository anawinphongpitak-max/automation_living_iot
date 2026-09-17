// Scene Icon Selector Functions

function toggleIconDropdown() {
    const dropdown = document.getElementById('scene-icon-dropdown');
    if (!dropdown) return;

    const isOpen = dropdown.classList.contains('open');

    if (isOpen) {
        dropdown.classList.remove('open');
    } else {
        dropdown.style.display = 'grid';
        // Trigger reflow to enable transition
        void dropdown.offsetWidth;
        dropdown.classList.add('open');
    }
}

function selectSceneIcon(iconName) {
    const preview = document.getElementById('scene-icon-preview');
    const hiddenInput = document.getElementById('scene-icon');
    const dropdown = document.getElementById('scene-icon-dropdown');

    if (preview) {
        preview.innerHTML = `<span class="material-symbols-outlined">${iconName}</span>`;
    }

    if (hiddenInput) {
        hiddenInput.value = iconName;
    }

    if (dropdown) {
        dropdown.classList.remove('open');
        setTimeout(() => {
            dropdown.style.display = 'none';
        }, 200);
    }
}

// Close icon dropdown when clicking outside
document.addEventListener('click', function(event) {
    const dropdown = document.getElementById('scene-icon-dropdown');
    const preview = document.getElementById('scene-icon-preview');

    if (!dropdown || !preview) return;

    if (!preview.contains(event.target) && !dropdown.contains(event.target)) {
        dropdown.classList.remove('open');
        setTimeout(() => {
            dropdown.style.display = 'none';
        }, 200);
    }
});
