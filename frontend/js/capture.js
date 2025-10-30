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
    
    if (settings.mode === 'locked') {
        // Locked mode: Hide inputs, use fixed values
        promptGroup.style.display = 'none';
        customTextGroup.style.display = 'none';
        
        // Store locked values (will be used on submit)
        document.getElementById('promptInput').value = settings.lockedPrompt || '';
        document.getElementById('customTextInput').value = settings.lockedCustomText || '';
        
    } else if (settings.mode === 'presets') {
        // Preset mode: Show selection buttons
        promptGroup.style.display = 'none';
        customTextGroup.style.display = 'none';
        
        // Create preset selection UI
        const presetsContainer = document.createElement('div');
        presetsContainer.className = 'preset-selection';
        presetsContainer.innerHTML = `
            <div class="form-group">
                <label><strong>Select Style</strong> <span class="required">*</span></label>
                <div class="preset-buttons" id="presetButtons"></div>
            </div>
        `;
        
        // Insert before submit button
        const submitBtn = document.getElementById('submitBtn');
        submitBtn.parentElement.insertBefore(presetsContainer, submitBtn);
        
        // Add preset buttons
        const buttonsContainer = document.getElementById('presetButtons');
        settings.presetOptions.forEach((preset, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'preset-btn';
            button.textContent = preset.name;
            button.onclick = () => selectPreset(index, settings.presetOptions);
            buttonsContainer.appendChild(button);
        });
        
    } else {
        // Free mode: Show normal inputs (default)
        promptGroup.style.display = 'flex';
        customTextGroup.style.display = 'flex';
    }
}

// Select preset option
function selectPreset(index, presets) {
    // Remove selected class from all buttons
    document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('selected'));
    
    // Add selected class to clicked button
    event.target.classList.add('selected');
    
    // Set hidden values
    const preset = presets[index];
    document.getElementById('promptInput').value = preset.prompt || '';
    document.getElementById('customTextInput').value = preset.customText || '';
    
    // Validate form (enable submit if name and photo are present)
    validateForm();
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
    
    // Check if prompt input is visible (free mode) or has value (locked/preset mode)
    const promptGroup = document.querySelector('#promptInput').closest('.form-group');
    const promptRequired = (promptGroup && promptGroup.style.display !== 'none') ? prompt : (prompt || true);
    
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = !(name && promptRequired && photoData);
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
