// Global variables
let video = null;
let canvas = null;
let photoData = null;
let stream = null;
let token = null;

// Check for existing token on page load
document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('captureToken');
    if (token) {
        // Verify token is still valid
        verifyToken();
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
            
            // Start camera automatically
            startCamera();
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
        const response = await fetch(`${API_BASE_URL}/submissions?status=pending`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok || response.status === 403) {
            // Token is valid (403 means valid token but wrong role, which is OK for capture page)
            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            
            // Start camera automatically
            startCamera();
        } else {
            // Token is invalid
            localStorage.removeItem('captureToken');
            token = null;
        }
    } catch (error) {
        console.error('Token verification error:', error);
    }
}

// Allow Enter key to submit login
document.getElementById('loginPassword')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        login();
    }
});

// Start camera
async function startCamera() {
    try {
        video = document.getElementById('video');
        canvas = document.getElementById('canvas');
        
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
        alert('Unable to access camera. Please check permissions and try again.');
    }
}

// Capture photo
function capturePhoto() {
    if (!video) return;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    
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

// Load and apply capture settings
async function loadCaptureSettings() {
    try {
        const response = await fetch(`${API_BASE_URL}/capture-settings`);
        if (response.ok) {
            const settings = await response.json();
            applyCaptureSettings(settings);
        }
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
    document.getElementById('cameraStep').style.display = 'none';
    document.getElementById('formStep').style.display = 'none';
    document.getElementById('thankYouStep').style.display = 'none';
    
    // Show requested step
    if (step === 'camera') {
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
    const prompt = document.getElementById('promptInput').value.trim();
    const customText = document.getElementById('customTextInput').value.trim();
    
    if (!name || !prompt || !photoData) {
        alert('Please fill in all required fields');
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
                name,
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
        alert(`Error: ${error.message}`);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
    }
}

// Start over - go back to camera
function startOver() {
    // Reset everything
    photoData = null;
    document.getElementById('nameInput').value = '';
    document.getElementById('promptInput').value = '';
    document.getElementById('customTextInput').value = '';
    
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submit';
    
    // Start camera again
    startCamera();
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopCamera();
});
