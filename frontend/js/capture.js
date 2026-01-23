// Global variables
let video = null;
let canvas = null;
let photoData = null;
let stream = null;
let token = null;
let selectedEvent = null;

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

// Check for existing token on page load
document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('captureToken');
    if (token) {
        // Verify token is still valid
        verifyToken();
    } else {
        // No token, show login modal immediately
        showLoginModal();
    }
});

// Login function
async function login() {
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');
    
    if (!password) {
        errorDiv.textContent = 'Please enter a password';
        errorDiv.classList.add('show');
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/auth/login/capture`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password })
        });

        const data = await response.json();

        if (response.ok) {
            token = data.token;
            localStorage.setItem('captureToken', token);
            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            
            // Load events for selection
            loadEvents();
        } else {
            errorDiv.textContent = data.error || 'Invalid password';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        console.error('Login error:', error);
        errorDiv.textContent = 'Connection error. Please check your network.';
        errorDiv.classList.add('show');
    }
}

// Verify token
async function verifyToken() {
    try {
        // Try to make a simple authenticated request
        const response = await fetch(`${API_BASE_URL}/events`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok || response.status === 403) {
            // Token is valid (403 means valid token but wrong role, which is OK for capture page)
            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            
            // Load events for selection
            loadEvents();
        } else if (response.status === 401) {
            // Token is invalid or expired
            console.log('Token expired or invalid, requesting re-login');
            localStorage.removeItem('captureToken');
            token = null;
            showLoginModal();
        } else {
            // Other error
            localStorage.removeItem('captureToken');
            token = null;
            showLoginModal();
        }
    } catch (error) {
        console.error('Token verification error:', error);
        // If verification fails, clear token and show login
        localStorage.removeItem('captureToken');
        token = null;
        showLoginModal();
    }
}

// Show login modal
function showLoginModal() {
    document.getElementById('loginModal').style.display = 'flex';
    document.getElementById('mainContent').style.display = 'none';
    // Clear password field
    const passwordField = document.getElementById('loginPassword');
    if (passwordField) {
        passwordField.value = '';
        passwordField.focus();
    }
    // Clear any error messages
    const errorDiv = document.getElementById('loginError');
    if (errorDiv) {
        errorDiv.textContent = '';
        errorDiv.classList.remove('show');
    }
}

// Logout function (clears token and shows login)
function logout() {
    localStorage.removeItem('captureToken');
    token = null;
    selectedEvent = null;
    
    // Stop camera if active
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    
    // Reset to login screen
    showLoginModal();
    
    // Reset all steps
    document.getElementById('eventSelectStep').style.display = 'none';
    document.getElementById('cameraStep').style.display = 'none';
    document.getElementById('formStep').style.display = 'none';
    document.getElementById('successStep').style.display = 'none';
    
    console.log('Logged out successfully');
}

// Allow Enter key to submit login
document.getElementById('loginPassword')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        login();
    }
});

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
                <p>No active events available.</p>
                <p>Please check back later or contact the event organizer.</p>
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
                ${event.description ? `<p class="event-description">${escapeHtml(event.description)}</p>` : ''}
                <button class="btn-select">Select This Event</button>
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

// Capture photo
function capturePhoto() {
    if (!video) return;
    
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
    
    // Show form step with photo preview
    document.getElementById('photoPreview').src = photoData;
    showStep('form');
    
    // Load capture settings and adapt form
    loadCaptureSettings();
    
    // Focus on name input
    setTimeout(() => {
        document.getElementById('nameInput').focus();
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
    const promptGroup = document.querySelector('#promptInput').closest('.form-group');
    const customTextGroup = document.querySelector('#customTextInput').closest('.form-group');
    const promptInput = document.getElementById('promptInput');
    const customTextInput = document.getElementById('customTextInput');
    const submitBtn = document.getElementById('submitBtn');
    
    // Remove any existing preset selections
    document.querySelectorAll('.preset-selection').forEach(el => el.remove());
    
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
                <label><strong>Theme</strong></label>
                <div class="locked-value">${escapeHtml(settings.lockedPromptTitle || 'Locked Theme')}</div>
            </div>
        `;
        submitBtn.parentElement.insertBefore(themeContainer, submitBtn);
        
    } else if (settings.promptMode === 'presets') {
        // Show prompt presets
        promptGroup.style.display = 'none';
        
        const presetsContainer = document.createElement('div');
        presetsContainer.className = 'preset-selection';
        presetsContainer.innerHTML = `
            <div class="form-group">
                <label><strong>Select Prompt</strong> <span class="required">*</span></label>
                <div class="preset-buttons" id="promptPresetButtons"></div>
            </div>
        `;
        
        submitBtn.parentElement.insertBefore(presetsContainer, submitBtn);
        
        const buttonsContainer = document.getElementById('promptPresetButtons');
        settings.promptPresets.forEach((preset, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'preset-btn';
            button.textContent = preset.name;
            button.onclick = () => selectPromptPreset(index, settings.promptPresets);
            buttonsContainer.appendChild(button);
        });
        
    } else if (settings.promptMode === 'suggestions') {
        // Show suggestions + keep input visible
        promptGroup.style.display = 'flex';
        promptInput.readOnly = false;
        promptInput.value = '';
        
        if (settings.promptPresets && settings.promptPresets.length > 0) {
            const suggestionsContainer = document.createElement('div');
            suggestionsContainer.className = 'preset-selection';
            suggestionsContainer.innerHTML = `
                <div class="form-group">
                    <label><strong>Quick Suggestions</strong></label>
                    <div class="preset-buttons suggestions" id="promptSuggestionButtons"></div>
                </div>
            `;
            
            // Insert after prompt input
            promptGroup.parentElement.insertBefore(suggestionsContainer, promptGroup.nextSibling);
            
            const buttonsContainer = document.getElementById('promptSuggestionButtons');
            settings.promptPresets.forEach((preset, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'preset-btn suggestion-btn';
                button.textContent = preset.name;
                button.onclick = () => selectPromptSuggestion(index, settings.promptPresets);
                buttonsContainer.appendChild(button);
            });
        }
        
    } else {
        // Free entry
        promptGroup.style.display = 'flex';
        promptInput.readOnly = false;
        promptInput.value = '';
    }
    
    // Handle Custom Text Settings
    if (settings.customTextMode === 'locked') {
        // Lock custom text - show value, hide input
        customTextGroup.style.display = 'none';
        customTextInput.value = settings.lockedCustomTextValue || '';
        customTextInput.readOnly = true;
        
        // Show locked text value
        const lockedContainer = document.createElement('div');
        lockedContainer.className = 'preset-selection locked-info';
        lockedContainer.innerHTML = `
            <div class="form-group">
                <label><strong>Custom Text</strong></label>
                <div class="locked-value">${escapeHtml(settings.lockedCustomTextValue || '')}</div>
            </div>
        `;
        submitBtn.parentElement.insertBefore(lockedContainer, submitBtn);
        
    } else if (settings.customTextMode === 'presets') {
        // Show custom text presets
        customTextGroup.style.display = 'none';
        
        const presetsContainer = document.createElement('div');
        presetsContainer.className = 'preset-selection';
        presetsContainer.innerHTML = `
            <div class="form-group">
                <label><strong>Select Text</strong> <span class="required">*</span></label>
                <div class="preset-buttons" id="customTextPresetButtons"></div>
            </div>
        `;
        
        submitBtn.parentElement.insertBefore(presetsContainer, submitBtn);
        
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
                    <label><strong>Quick Suggestions</strong></label>
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
    
    // Re-validate form
    validateForm();
}

// Select prompt preset
function selectPromptPreset(index, presets) {
    document.querySelectorAll('#promptPresetButtons .preset-btn').forEach(btn => btn.classList.remove('selected'));
    event.target.classList.add('selected');
    
    document.getElementById('promptInput').value = presets[index].value;
    validateForm();
}

// Select custom text preset
function selectCustomTextPreset(index, presets) {
    document.querySelectorAll('#customTextPresetButtons .preset-btn').forEach(btn => btn.classList.remove('selected'));
    event.target.classList.add('selected');
    
    document.getElementById('customTextInput').value = presets[index].value;
    validateForm();
}

// Select prompt suggestion (fills input but doesn't lock it)
function selectPromptSuggestion(index, presets) {
    const promptInput = document.getElementById('promptInput');
    promptInput.value = presets[index].value;
    promptInput.focus();
    validateForm();
}

// Select custom text suggestion (fills input but doesn't lock it)
function selectCustomTextSuggestion(index, presets) {
    const customTextInput = document.getElementById('customTextInput');
    customTextInput.value = presets[index].value;
    customTextInput.focus();
    validateForm();
}

// Escape HTML for safe display
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Retake photo
function retakePhoto() {
    photoData = null;
    
    // Clear form
    document.getElementById('nameInput').value = '';
    document.getElementById('emailInput').value = '';
    document.getElementById('phoneInput').value = '';
    document.getElementById('promptInput').value = '';
    document.getElementById('customTextInput').value = '';
    
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submit';
    
    // Restart camera
    startCamera();
}

// Stop camera
function stopCamera() {
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

// Validate form
function validateForm() {
    const name = document.getElementById('nameInput').value.trim();
    const prompt = document.getElementById('promptInput').value.trim();
    const customText = document.getElementById('customTextInput').value.trim();
    
    // Prompt is always required (either free entry, locked, or selected from presets)
    const promptValid = !!prompt;
    
    // Custom text is optional by default
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = !(name && promptValid && photoData);
}

// Add event listeners for form validation
document.getElementById('nameInput')?.addEventListener('input', validateForm);
document.getElementById('promptInput')?.addEventListener('input', validateForm);

// Submit capture
async function submitCapture() {
    const name = document.getElementById('nameInput').value.trim();
    const email = document.getElementById('emailInput').value.trim();
    const phone = document.getElementById('phoneInput').value.trim();
    const prompt = document.getElementById('promptInput').value.trim();
    const customText = document.getElementById('customTextInput').value.trim();
    
    if (!name || !prompt || !photoData) {
        await customAlert('Please fill in all required fields');
        return;
    }
    
    if (!selectedEvent) {
        await customAlert('No event selected. Please go back and select an event.');
        return;
    }

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
        const response = await fetch(`${API_BASE_URL}/submissions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                eventId: selectedEvent._id,
                name,
                email,
                phone,
                photo: photoData,
                prompt,
                customText
            })
        });

        const data = await response.json();

        if (response.ok) {
            // Show thank you page
            showStep('thankyou');
        } else {
            throw new Error(data.error || 'Submission failed');
        }
    } catch (error) {
        console.error('Submission error:', error);
        await customAlert(`Error: ${error.message}`);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
    }
}

// Start over - go back to camera for same event
function startOver() {
    // Reset form data but keep the selected event
    photoData = null;
    document.getElementById('nameInput').value = '';
    document.getElementById('emailInput').value = '';
    document.getElementById('phoneInput').value = '';
    document.getElementById('promptInput').value = '';
    document.getElementById('customTextInput').value = '';
    
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submit';
    
    // Go back to camera for same event
    startCamera();
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopCamera();
});
