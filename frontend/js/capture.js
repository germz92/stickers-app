// Global variables
let video = null;
let canvas = null;
let photoData = null;
let stream = null;
let token = null;
let tokenExpiryTime = null;
let tokenCheckInterval = null;
let selectedEvent = null;
let pendingSubmissionId = null;
let countdownTimer = null;
let countdownActive = false;
let selectedThemePrompt = '';

// Custom Alert Function
function customAlert(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('customAlert');
        const messageEl = document.getElementById('customAlertMessage');
        const okBtn = document.getElementById('customAlertOk');
        
        messageEl.textContent = message;
        modal.style.display = 'flex';
        
        const closeHandler = () => {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', closeHandler);
            resolve();
        };
        
        okBtn.addEventListener('click', closeHandler);
    });
}

function getCaptureSession() {
    const adminToken = localStorage.getItem('adminToken');
    const adminExpiry = localStorage.getItem('adminTokenExpiry');
    if (adminToken) {
        return { token: adminToken, expiry: adminExpiry };
    }
    return {
        token: localStorage.getItem('captureToken'),
        expiry: localStorage.getItem('captureTokenExpiry')
    };
}

function enterCaptureApp() {
    document.getElementById('loginModal').style.display = 'none';
    document.getElementById('mainContent').style.display = 'block';
    startTokenExpiryChecker();
    loadEvents();
}

// Check for existing admin session on page load
document.addEventListener('DOMContentLoaded', () => {
    const session = getCaptureSession();
    token = session.token;
    tokenExpiryTime = session.expiry;

    if (token && tokenExpiryTime && Date.now() >= parseInt(tokenExpiryTime)) {
        showLoginModal();
        return;
    }

    if (token) {
        verifyToken();
    } else {
        showLoginModal();
    }
});

// Verify token
async function verifyToken() {
    try {
        const response = await fetch(`${API_BASE_URL}/auth/me`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            enterCaptureApp();
        } else {
            showLoginModal();
        }
    } catch (error) {
        console.error('Token verification error:', error);
        showLoginModal();
    }
}

// Show login modal
function showLoginModal() {
    token = null;
    document.getElementById('loginModal').style.display = 'flex';
    document.getElementById('mainContent').style.display = 'none';
}

function backToAdmin() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    window.location.href = 'admin.html';
}

// Session expired: send them back to admin login
function logout() {
    localStorage.removeItem('captureToken');
    localStorage.removeItem('captureTokenExpiry');
    token = null;
    tokenExpiryTime = null;
    selectedEvent = null;

    if (tokenCheckInterval) {
        clearInterval(tokenCheckInterval);
        tokenCheckInterval = null;
    }

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }

    showLoginModal();
}

// Start token expiry checker (checks every minute)
function startTokenExpiryChecker() {
    // Clear any existing interval
    if (tokenCheckInterval) {
        clearInterval(tokenCheckInterval);
    }
    
    tokenCheckInterval = setInterval(() => {
        if (!tokenExpiryTime) return;
        
        const timeRemaining = parseInt(tokenExpiryTime) - Date.now();
        
        // If token expires in less than 1 minute or has expired
        if (timeRemaining <= 60000) {
            console.log('Token expired, auto-logging out');
            clearInterval(tokenCheckInterval);
            
            // Show a message before logging out
            customAlert('Your session has expired. Please login again.').then(() => {
                logout();
            });
        }
    }, 60000); // Check every minute
}

// ===== EVENT SELECTION =====

// Load events
async function loadEvents() {
    try {
        const response = await fetch(`${API_BASE_URL}/events`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.status === 401) {
            // Token expired
            console.log('Token expired during event load');
            localStorage.removeItem('captureToken');
            token = null;
            showLoginModal();
            return;
        }
        
        if (!response.ok) throw new Error('Failed to load events');
        
        const events = await response.json();
        displayEvents(events);
        const requestedEventId = new URLSearchParams(window.location.search).get('event');
        if (requestedEventId && events.some((event) => String(event._id) === requestedEventId && !event.isArchived)) {
            selectEvent(requestedEventId);
        }
    } catch (error) {
        console.error('Error loading events:', error);
        document.getElementById('eventsList').innerHTML = 
            '<p class="loading">Failed to load events. Please refresh the page.</p>';
    }
}

// Display events as cards
function displayEvents(events) {
    const container = document.getElementById('eventsList');
    
    // Filter to only show non-archived events
    const activeEvents = events.filter(e => !e.isArchived);
    
    if (activeEvents.length === 0) {
        container.innerHTML = `
            <div class="no-events-message">
                <p>No events are open right now.</p>
                <p>Please try again in a moment.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = activeEvents.map(event => {
        const eventDate = new Date(event.eventDate);
        const formattedDate = eventDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
        
        return `
            <div class="event-card" onclick="selectEvent('${event._id}')">
                <h3>${escapeHtml(event.name)}</h3>
                <div class="event-date">${formattedDate}</div>
                ${event.access === 'shared' ? '<div class="event-shared-label">Shared with you</div>' : ''}
                ${event.description ? `<p class="event-description">${escapeHtml(event.description)}</p>` : ''}
                <button class="btn-select">Start</button>
            </div>
        `;
    }).join('');
}

// Select event and proceed to camera
async function selectEvent(eventId) {
    try {
        const response = await fetch(`${API_BASE_URL}/events/${eventId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to load event');
        
        selectedEvent = await response.json();
        
        // Proceed to camera
        startCamera();
    } catch (error) {
        console.error('Error selecting event:', error);
        await customAlert('Failed to select event. Please try again.');
    }
}

// Start camera
async function startCamera() {
    try {
        video = document.getElementById('video');
        canvas = document.getElementById('canvas');
        
        // Check if permission is already granted (reduces re-prompting on some browsers)
        if (navigator.permissions && navigator.permissions.query) {
            try {
                const permissionStatus = await navigator.permissions.query({ name: 'camera' });
                console.log('Camera permission status:', permissionStatus.state);
                
                if (permissionStatus.state === 'denied') {
                    await customAlert('Camera access denied. Please enable camera permissions in your browser settings.');
                    return;
                }
            } catch (e) {
                // Permissions API not fully supported, continue anyway
                console.log('Permissions API not available, proceeding with camera request');
            }
        }
        
        // Request camera access
        stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: 'user',
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            } 
        });
        
        video.srcObject = stream;
        
        resetCountdown();
        // Show camera step
        showStep('camera');
    } catch (error) {
        console.error('Camera error:', error);
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            await customAlert('Camera access denied. Please enable camera permissions and refresh the page.');
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            await customAlert('No camera found. Please connect a camera and try again.');
        } else {
            await customAlert('Unable to access camera. Please check permissions and try again.');
        }
    }
}

function resetCountdown() {
    countdownActive = false;
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
    const overlay = document.getElementById('countdownOverlay');
    if (overlay) overlay.style.display = 'none';
    const btn = document.getElementById('captureBtn');
    if (btn) {
        btn.disabled = false;
        const label = btn.querySelector('span');
        if (label) label.textContent = 'Take Photo';
    }
}

// Capture photo — 3 second countdown, then snap
function capturePhoto() {
    if (!video || countdownActive) return;

    const overlay = document.getElementById('countdownOverlay');
    const numberEl = document.getElementById('countdownNumber');
    const btn = document.getElementById('captureBtn');
    let count = 3;

    countdownActive = true;
    if (btn) btn.disabled = true;
    if (overlay) overlay.style.display = 'flex';
    if (numberEl) {
        numberEl.textContent = String(count);
        numberEl.classList.remove('tick');
        void numberEl.offsetWidth;
        numberEl.classList.add('tick');
    }

    countdownTimer = setInterval(() => {
        count -= 1;
        if (count <= 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;
            countdownActive = false;
            if (overlay) overlay.style.display = 'none';
            takePhoto();
            return;
        }
        if (numberEl) {
            numberEl.textContent = String(count);
            numberEl.classList.remove('tick');
            void numberEl.offsetWidth;
            numberEl.classList.add('tick');
        }
    }, 1000);
}

function takePhoto() {
    if (!video) {
        resetCountdown();
        return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const context = canvas.getContext('2d');
    
    // Mirror the photo to match the mirrored video view
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Reset transformation
    context.setTransform(1, 0, 0, 1, 0, 0);
    
    photoData = canvas.toDataURL('image/jpeg', 0.9);
    
    // Stop camera
    stopCamera();
    
    // Show theme step with photo preview
    document.getElementById('photoPreview').src = photoData;
    showFormPhase('theme');
    
    // Load capture settings and adapt form
    loadCaptureSettings();
    
    setTimeout(() => {
        const promptInput = document.getElementById('promptInput');
        if (promptInput && promptInput.offsetParent !== null && !promptInput.readOnly) {
            promptInput.focus();
        }
    }, 100);
}

// Load and apply capture settings (from selected event)
async function loadCaptureSettings() {
    if (!selectedEvent) {
        console.warn('No event selected');
        return;
    }
    
    try {
        // Get settings from selected event
        const settings = selectedEvent.captureSettings || {
            promptMode: 'free',
            customTextMode: 'free'
        };
        applyCaptureSettings(settings);
    } catch (error) {
        console.error('Error loading capture settings:', error);
        // Default to free mode if error
    }
}

// Apply capture settings to form
function applyCaptureSettings(settings) {
    console.log('Applying capture settings:', settings); // Debug log
    
    const promptGroup = document.querySelector('#promptInput').closest('.form-group');
    const customTextGroup = document.querySelector('#customTextInput').closest('.form-group');
    const promptInput = document.getElementById('promptInput');
    const customTextInput = document.getElementById('customTextInput');
    const continueBtn = document.getElementById('continueThemeBtn');
    selectedThemePrompt = '';
    
    // Remove any existing preset selections
    document.querySelectorAll('.preset-selection').forEach(el => el.remove());

    const promptLabel = promptGroup.querySelector('label strong');
    const promptHint = promptGroup.querySelector('.hint');
    if (promptLabel) promptLabel.textContent = 'What should you be?';
    if (promptHint) promptHint.textContent = 'Pick a costume, job, or scene';
    promptInput.placeholder = 'Try astronaut, superhero, chef...';
    
    // Handle Prompt Settings
    if (settings.promptMode === 'locked') {
        // Lock prompt - show title, hide input
        promptGroup.style.display = 'none';
        promptInput.value = settings.lockedPromptValue || '';
        promptInput.readOnly = true;
        
        // Show theme title
        const themeContainer = document.createElement('div');
        themeContainer.className = 'preset-selection locked-info';
        themeContainer.innerHTML = `
            <div class="form-group">
                <label><strong>Your look</strong></label>
                <div class="locked-value">${escapeHtml(settings.lockedPromptTitle || 'Today\'s theme')}</div>
            </div>
        `;
        continueBtn.parentElement.insertBefore(themeContainer, continueBtn);
        
    } else if (settings.promptMode === 'presets') {
        // Show prompt presets
        promptGroup.style.display = 'none';
        
        const presetsContainer = document.createElement('div');
        presetsContainer.className = 'preset-selection';
        presetsContainer.innerHTML = `
            <div class="form-group">
                <label><strong>Tap a look</strong> <span class="required">*</span></label>
                <div class="preset-buttons" id="promptPresetButtons"></div>
            </div>
        `;
        
        continueBtn.parentElement.insertBefore(presetsContainer, continueBtn);
        
        const buttonsContainer = document.getElementById('promptPresetButtons');
        (settings.promptPresets || []).forEach((preset, index) => {
            appendThemeChoiceButton(buttonsContainer, preset, 'preset-btn', () => {
                selectPromptPreset(index, settings.promptPresets);
            });
        });
        
    } else if (settings.promptMode === 'suggestions') {
        selectedThemePrompt = '';
        promptGroup.style.display = 'flex';
        promptInput.readOnly = false;
        promptInput.value = '';
        promptInput.placeholder = 'Or type your own look';
        if (promptLabel) promptLabel.textContent = 'Or type your own';
        if (promptHint) promptHint.textContent = 'Skip this if you tapped a look above.';
        
        if (settings.promptPresets && settings.promptPresets.length > 0) {
            const suggestionsContainer = document.createElement('div');
            suggestionsContainer.className = 'preset-selection';
            suggestionsContainer.innerHTML = `
                <div class="form-group">
                    <label><strong>Tap a look</strong></label>
                    <div class="preset-buttons suggestions" id="promptSuggestionButtons"></div>
                </div>
            `;
            promptGroup.parentElement.insertBefore(suggestionsContainer, promptGroup);
            
            const buttonsContainer = document.getElementById('promptSuggestionButtons');
            settings.promptPresets.forEach((preset, index) => {
                appendThemeChoiceButton(buttonsContainer, preset, 'preset-btn suggestion-btn', () => {
                    selectPromptSuggestion(index, settings.promptPresets);
                });
            });
        }
        
    } else {
        // Free entry
        promptGroup.style.display = 'flex';
        promptInput.readOnly = false;
        promptInput.value = '';
    }
    
    // Handle Custom Text Settings
    console.log('Custom text disabled:', settings.customTextDisabled); // Debug log
    console.log('Custom text mode:', settings.customTextMode); // Debug log
    
    if (settings.customTextDisabled === true) {
        // Custom text is completely disabled - hide everything and stop processing
        console.log('Custom text is DISABLED - hiding all custom text UI'); // Debug log
        customTextGroup.style.display = 'none';
        customTextInput.value = '';
        customTextInput.readOnly = true;
        // Don't process any further custom text logic
        
    } else if (settings.customTextMode === 'locked') {
        // Lock custom text - show value, hide input
        customTextGroup.style.display = 'none';
        customTextInput.value = settings.lockedCustomTextValue || '';
        customTextInput.readOnly = true;
        
        // Show locked text value
        const lockedContainer = document.createElement('div');
        lockedContainer.className = 'preset-selection locked-info';
        lockedContainer.innerHTML = `
            <div class="form-group">
                <label><strong>Your message</strong></label>
                <div class="locked-value">${escapeHtml(settings.lockedCustomTextValue || '')}</div>
            </div>
        `;
        continueBtn.parentElement.insertBefore(lockedContainer, continueBtn);
        
    } else if (settings.customTextMode === 'presets') {
        // Show custom text presets
        customTextGroup.style.display = 'none';
        
        const presetsContainer = document.createElement('div');
        presetsContainer.className = 'preset-selection';
        presetsContainer.innerHTML = `
            <div class="form-group">
                <label><strong>Tap a message</strong> <span class="required">*</span></label>
                <div class="preset-buttons" id="customTextPresetButtons"></div>
            </div>
        `;
        
        continueBtn.parentElement.insertBefore(presetsContainer, continueBtn);
        
        const buttonsContainer = document.getElementById('customTextPresetButtons');
        settings.customTextPresets.forEach((preset, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'preset-btn';
            button.textContent = preset.name;
            button.onclick = () => selectCustomTextPreset(index, settings.customTextPresets);
            buttonsContainer.appendChild(button);
        });
        
    } else if (settings.customTextMode === 'suggestions') {
        // Show suggestions + keep input visible
        customTextGroup.style.display = 'flex';
        customTextInput.readOnly = false;
        customTextInput.value = '';
        
        if (settings.customTextPresets && settings.customTextPresets.length > 0) {
            const suggestionsContainer = document.createElement('div');
            suggestionsContainer.className = 'preset-selection';
            suggestionsContainer.innerHTML = `
                <div class="form-group">
                    <label><strong>Or tap a message</strong></label>
                    <div class="preset-buttons suggestions" id="customTextSuggestionButtons"></div>
                </div>
            `;
            
            // Insert after custom text input
            customTextGroup.parentElement.insertBefore(suggestionsContainer, customTextGroup.nextSibling);
            
            const buttonsContainer = document.getElementById('customTextSuggestionButtons');
            settings.customTextPresets.forEach((preset, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'preset-btn suggestion-btn';
                button.textContent = preset.name;
                button.onclick = () => selectCustomTextSuggestion(index, settings.customTextPresets);
                buttonsContainer.appendChild(button);
            });
        }
        
    } else {
        // Free entry
        customTextGroup.style.display = 'flex';
        customTextInput.readOnly = false;
        customTextInput.value = '';
    }
    
    // Badge Mode: swap single name field for badge fields, hide custom text entirely
    applyBadgeFieldVisibility();

    validateTheme();
    validateDetails();
}

// Show/hide badge-specific fields based on the selected event's badgeMode
function applyBadgeFieldVisibility() {
    const badgeMode = isBadgeMode();
    const nameGroup = document.getElementById('nameGroup');
    const firstNameGroup = document.getElementById('firstNameGroup');
    const lastNameGroup = document.getElementById('lastNameGroup');
    const jobTitleGroup = document.getElementById('jobTitleGroup');
    const companyGroup = document.getElementById('companyGroup');
    const customTextGroup = document.querySelector('#customTextInput')?.closest('.form-group');

    if (nameGroup) nameGroup.style.display = badgeMode ? 'none' : 'flex';
    if (firstNameGroup) firstNameGroup.style.display = badgeMode ? 'flex' : 'none';
    if (lastNameGroup) lastNameGroup.style.display = badgeMode ? 'flex' : 'none';
    if (jobTitleGroup) jobTitleGroup.style.display = badgeMode ? 'flex' : 'none';
    if (companyGroup) companyGroup.style.display = badgeMode ? 'flex' : 'none';

    if (badgeMode) {
        // Custom text never applies in badge mode
        if (customTextGroup) customTextGroup.style.display = 'none';
        const customTextInput = document.getElementById('customTextInput');
        if (customTextInput) customTextInput.value = '';
    }
}

// Whether the currently selected event is in badge mode
function isBadgeMode() {
    return !!(selectedEvent && selectedEvent.badgeMode === true);
}

function appendThemeChoiceButton(container, preset, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    if (preset.imageUrl) {
        button.classList.add('has-preview');
        const img = document.createElement('img');
        img.src = preset.imageUrl;
        img.alt = preset.name || 'Theme preview';
        img.className = 'theme-preview-img';
        button.appendChild(img);
    }
    const label = document.createElement('span');
    label.className = 'theme-choice-label';
    label.textContent = preset.name || 'Theme';
    button.appendChild(label);
    button.addEventListener('click', onClick);
    container.appendChild(button);
}

function getThemePrompt() {
    const typed = document.getElementById('promptInput')?.value.trim() || '';
    if (typed) return typed;
    return (selectedThemePrompt || '').trim();
}

function clearSelectedSuggestion() {
    selectedThemePrompt = '';
    document.querySelectorAll('#promptSuggestionButtons .preset-btn').forEach((btn) => {
        btn.classList.remove('selected');
    });
}

// Select prompt preset
function selectPromptPreset(index, presets) {
    document.querySelectorAll('#promptPresetButtons .preset-btn').forEach(btn => btn.classList.remove('selected'));
    const buttons = document.querySelectorAll('#promptPresetButtons .preset-btn');
    if (buttons[index]) buttons[index].classList.add('selected');
    
    document.getElementById('promptInput').value = presets[index].value;
    validateTheme();
}

// Select custom text preset
function selectCustomTextPreset(index, presets) {
    document.querySelectorAll('#customTextPresetButtons .preset-btn').forEach(btn => btn.classList.remove('selected'));
    event.target.classList.add('selected');
    
    document.getElementById('customTextInput').value = presets[index].value;
    validateTheme();
}

// Select prompt suggestion without revealing the generation prompt
function selectPromptSuggestion(index, presets) {
    const promptInput = document.getElementById('promptInput');
    if (promptInput) promptInput.value = '';
    selectedThemePrompt = presets[index].value || '';
    document.querySelectorAll('#promptSuggestionButtons .preset-btn').forEach((btn) => {
        btn.classList.remove('selected');
    });
    const buttons = document.querySelectorAll('#promptSuggestionButtons .preset-btn');
    if (buttons[index]) buttons[index].classList.add('selected');
    validateTheme();
}

// Select custom text suggestion (fills input but doesn't lock it)
function selectCustomTextSuggestion(index, presets) {
    const customTextInput = document.getElementById('customTextInput');
    customTextInput.value = presets[index].value;
    customTextInput.focus();
    validateTheme();
}

// Escape HTML for safe display
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function resetCaptureForm() {
    pendingSubmissionId = null;
    selectedThemePrompt = '';
    document.getElementById('nameInput').value = '';
    document.getElementById('firstNameInput').value = '';
    document.getElementById('lastNameInput').value = '';
    document.getElementById('jobTitleInput').value = '';
    document.getElementById('companyInput').value = '';
    document.getElementById('emailInput').value = '';
    document.getElementById('phoneInput').value = '';
    document.getElementById('promptInput').value = '';
    document.getElementById('customTextInput').value = '';

    const continueBtn = document.getElementById('continueThemeBtn');
    if (continueBtn) {
        continueBtn.disabled = true;
        continueBtn.textContent = 'Create My Stickers';
    }
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Finish';
    }
    const retakeBtn = document.querySelector('.btn-retake');
    if (retakeBtn) retakeBtn.style.display = '';
}

// Retake photo
function retakePhoto() {
    photoData = null;
    resetCaptureForm();
    startCamera();
}

// Stop camera
function stopCamera() {
    resetCountdown();
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
}

// Show specific step
function showStep(step) {
    // Hide all steps
    document.getElementById('eventSelectStep').style.display = 'none';
    document.getElementById('cameraStep').style.display = 'none';
    document.getElementById('formStep').style.display = 'none';
    document.getElementById('thankYouStep').style.display = 'none';
    
    // Show requested step
    if (step === 'events') {
        document.getElementById('eventSelectStep').style.display = 'block';
    } else if (step === 'camera') {
        document.getElementById('cameraStep').style.display = 'block';
    } else if (step === 'form') {
        document.getElementById('formStep').style.display = 'block';
    } else if (step === 'thankyou') {
        document.getElementById('thankYouStep').style.display = 'block';
    }
}

function showFormPhase(phase) {
    showStep('form');
    const themeSection = document.getElementById('themeSection');
    const detailsSection = document.getElementById('detailsSection');
    const title = document.getElementById('formStepTitle');
    const retakeBtn = document.querySelector('.btn-retake');

    if (themeSection) themeSection.style.display = phase === 'theme' ? 'flex' : 'none';
    if (detailsSection) detailsSection.style.display = phase === 'details' ? 'flex' : 'none';
    if (title) title.textContent = phase === 'theme' ? 'Pick your look' : 'Almost done';
    if (retakeBtn) retakeBtn.style.display = phase === 'theme' ? '' : 'none';
}

function isCustomTextRequired() {
    const settings = selectedEvent?.captureSettings || {};
    if (isBadgeMode() || settings.customTextDisabled) return false;
    return settings.customTextMode === 'presets';
}

function validateTheme() {
    const prompt = getThemePrompt();
    const customText = document.getElementById('customTextInput')?.value.trim();
    const continueBtn = document.getElementById('continueThemeBtn');
    if (!continueBtn) return;
    const customOk = !isCustomTextRequired() || !!customText;
    continueBtn.disabled = !(prompt && customOk && photoData && !pendingSubmissionId);
}

function validateDetails() {
    let fieldsValid;
    if (isBadgeMode()) {
        const firstName = document.getElementById('firstNameInput').value.trim();
        const lastName = document.getElementById('lastNameInput').value.trim();
        const jobTitle = document.getElementById('jobTitleInput').value.trim();
        const company = document.getElementById('companyInput').value.trim();
        fieldsValid = !!(firstName && lastName && jobTitle && company);
    } else {
        fieldsValid = !!document.getElementById('nameInput').value.trim();
    }

    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) {
        submitBtn.disabled = !(fieldsValid && pendingSubmissionId);
    }
}

document.getElementById('nameInput')?.addEventListener('input', validateDetails);
document.getElementById('promptInput')?.addEventListener('input', () => {
    if (document.getElementById('promptInput').value.trim()) {
        clearSelectedSuggestion();
    }
    validateTheme();
});
document.getElementById('customTextInput')?.addEventListener('input', validateTheme);
document.getElementById('firstNameInput')?.addEventListener('input', validateDetails);
document.getElementById('lastNameInput')?.addEventListener('input', validateDetails);
document.getElementById('jobTitleInput')?.addEventListener('input', validateDetails);
document.getElementById('companyInput')?.addEventListener('input', validateDetails);

async function startGenerationAndContinue() {
    const badgeMode = isBadgeMode();
    const prompt = getThemePrompt();
    const customText = badgeMode ? '' : document.getElementById('customTextInput').value.trim();

    if (!prompt || !photoData) {
        await customAlert('Tap a look or type one first.');
        return;
    }
    if (isCustomTextRequired() && !customText) {
        await customAlert('Tap a message first.');
        return;
    }
    if (!selectedEvent) {
        await customAlert('No event selected. Please go back and select an event.');
        return;
    }

    const continueBtn = document.getElementById('continueThemeBtn');
    continueBtn.disabled = true;
    continueBtn.textContent = 'Creating stickers...';

    try {
        const response = await fetch(`${API_BASE_URL}/submissions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                eventId: selectedEvent._id,
                detailsPending: true,
                name: 'Guest',
                photo: photoData,
                prompt,
                customText
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Could not start generation');
        }

        pendingSubmissionId = data.submissionId;
        showFormPhase('details');
        validateDetails();
        setTimeout(() => {
            const focusId = isBadgeMode() ? 'firstNameInput' : 'nameInput';
            document.getElementById(focusId)?.focus();
        }, 100);
    } catch (error) {
        console.error('Early generation error:', error);
        await customAlert(`Error: ${error.message}`);
        continueBtn.disabled = false;
        continueBtn.textContent = 'Create My Stickers';
        validateTheme();
    }
}

async function submitCapture() {
    const badgeMode = isBadgeMode();
    const firstName = document.getElementById('firstNameInput').value.trim();
    const lastName = document.getElementById('lastNameInput').value.trim();
    const jobTitle = document.getElementById('jobTitleInput').value.trim();
    const company = document.getElementById('companyInput').value.trim();
    const name = badgeMode
        ? `${firstName} ${lastName}`.trim()
        : document.getElementById('nameInput').value.trim();
    const email = document.getElementById('emailInput').value.trim();
    const phone = document.getElementById('phoneInput').value.trim();

    if (!pendingSubmissionId) {
        await customAlert('Please pick your look first.');
        return;
    }
    if (!name) {
        await customAlert('Please enter your name.');
        return;
    }
    if (badgeMode && (!firstName || !lastName || !jobTitle || !company)) {
        await customAlert('Please enter your first name, last name, job title, and company.');
        return;
    }

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${pendingSubmissionId}/attendee`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                name,
                firstName: badgeMode ? firstName : '',
                lastName: badgeMode ? lastName : '',
                jobTitle: badgeMode ? jobTitle : '',
                company: badgeMode ? company : '',
                email,
                phone
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Could not save details');
        }

        showStep('thankyou');
    } catch (error) {
        console.error('Details save error:', error);
        await customAlert(`Error: ${error.message}`);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Finish';
    }
}

function startOver() {
    photoData = null;
    resetCaptureForm();
    startCamera();
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopCamera();
});
