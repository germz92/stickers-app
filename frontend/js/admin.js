// Global variables
let token = null;
let currentSubmission = null;
let currentImage = null;
let allSubmissions = [];
let presets = [];

// Check for existing token on page load
document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('adminToken');
    if (token) {
        verifyToken();
    }
});

// Login
async function login() {
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');
    
    if (!password) {
        errorDiv.textContent = 'Please enter a password';
        errorDiv.classList.add('show');
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/auth/login/admin`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password })
        });

        const data = await response.json();

        if (response.ok) {
            token = data.token;
            localStorage.setItem('adminToken', token);
            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            
            // Initialize
            loadSubmissions();
            loadPresets();
            checkComfyUIStatus();
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

// Logout
function logout() {
    localStorage.removeItem('adminToken');
    token = null;
    location.reload();
}

// Verify token
async function verifyToken() {
    try {
        const response = await fetch(`${API_BASE_URL}/submissions?status=pending`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            
            // Initialize
            loadSubmissions();
            loadPresets();
            checkComfyUIStatus();
        } else {
            localStorage.removeItem('adminToken');
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

// Tab Switching
function switchTab(tabName) {
    // Remove active class from all tabs
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    // Add active class to selected tab
    document.querySelector(`button[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`${tabName}Tab`).classList.add('active');
    
    // Load data if needed
    if (tabName === 'queue') {
        loadSubmissions();
    } else if (tabName === 'presets') {
        loadPresets();
    }
}

// Load Submissions
async function loadSubmissions() {
    try {
        const response = await fetch(`${API_BASE_URL}/submissions`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) throw new Error('Failed to load submissions');

        allSubmissions = await response.json();
        filterSubmissions();
        
        // Update queue count
        const pendingCount = allSubmissions.filter(s => s.status === 'pending').length;
        document.getElementById('queueCount').textContent = pendingCount;
    } catch (error) {
        console.error('Error loading submissions:', error);
        document.getElementById('submissionsList').innerHTML = 
            '<p class="error">Failed to load submissions. Please try again.</p>';
    }
}

// Filter Submissions
function filterSubmissions() {
    const filter = document.querySelector('input[name="statusFilter"]:checked').value;
    
    let filtered = allSubmissions;
    if (filter !== 'all') {
        filtered = allSubmissions.filter(s => s.status === filter);
    }
    
    displaySubmissions(filtered);
}

// Display Submissions
function displaySubmissions(submissions) {
    const container = document.getElementById('submissionsList');
    
    if (submissions.length === 0) {
        container.innerHTML = '<p class="loading">No submissions found</p>';
        return;
    }
    
    container.innerHTML = submissions.map(sub => `
        <div class="submission-card">
            <img id="thumb-${sub._id}" 
                 class="submission-thumbnail" 
                 src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect fill='%23f0f0f0' width='300' height='200'/><text x='50%25' y='50%25' text-anchor='middle' fill='%23999'>Loading...</text></svg>"
                 alt="${sub.name}">
            <div class="submission-info">
                <h3>👤 ${escapeHtml(sub.name)}</h3>
                <p><strong>Submitted:</strong> ${new Date(sub.createdAt).toLocaleString()}</p>
                <div class="prompt">
                    <strong>Prompt:</strong> ${escapeHtml(sub.prompt)}
                </div>
                ${sub.customText ? `<p><strong>Custom Text:</strong> ${escapeHtml(sub.customText)}</p>` : ''}
                <span class="submission-status ${sub.status}">${sub.status.toUpperCase()}</span>
            </div>
            <div class="submission-actions">
                ${sub.status === 'pending' ? `
                    <button onclick="approveSubmission('${sub._id}')" class="btn-success btn-sm">
                        ✅ Approve
                    </button>
                    <button onclick="rejectSubmission('${sub._id}')" class="btn-danger btn-sm">
                        ❌ Reject
                    </button>
                ` : ''}
                <button onclick="loadSubmissionForGeneration('${sub._id}')" class="btn-primary btn-sm">
                    ⚡ Generate
                </button>
                <button onclick="deleteSubmission('${sub._id}')" class="btn-danger btn-sm">
                    🗑️ Delete
                </button>
            </div>
        </div>
    `).join('');
    
    // Load thumbnails asynchronously
    submissions.forEach(sub => loadThumbnail(sub._id));
}

// Load thumbnail for a submission
async function loadThumbnail(submissionId) {
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${submissionId}/thumbnail`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const imgElement = document.getElementById(`thumb-${submissionId}`);
            if (imgElement && data.photo) {
                imgElement.src = data.photo;
            }
        }
    } catch (error) {
        console.error(`Failed to load thumbnail for ${submissionId}:`, error);
        const imgElement = document.getElementById(`thumb-${submissionId}`);
        if (imgElement) {
            imgElement.src = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect fill='%23ddd' width='300' height='200'/><text x='50%25' y='50%25' text-anchor='middle' fill='%23999'>Error Loading</text></svg>";
        }
    }
}

// Approve Submission
async function approveSubmission(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ status: 'approved' })
        });

        if (response.ok) {
            loadSubmissions();
            showStatus('Submission approved!', 'success');
        }
    } catch (error) {
        console.error('Error approving submission:', error);
        showStatus('Failed to approve submission', 'error');
    }
}

// Reject Submission
async function rejectSubmission(id) {
    if (!confirm('Are you sure you want to reject this submission?')) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ status: 'rejected' })
        });

        if (response.ok) {
            loadSubmissions();
            showStatus('Submission rejected', 'info');
        }
    } catch (error) {
        console.error('Error rejecting submission:', error);
        showStatus('Failed to reject submission', 'error');
    }
}

// Delete Submission
async function deleteSubmission(id) {
    if (!confirm('Are you sure you want to delete this submission? This cannot be undone.')) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            loadSubmissions();
            showStatus('Submission deleted', 'info');
        }
    } catch (error) {
        console.error('Error deleting submission:', error);
        showStatus('Failed to delete submission', 'error');
    }
}

// Load Submission for Generation
async function loadSubmissionForGeneration(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) throw new Error('Failed to load submission');

        currentSubmission = await response.json();
        currentImage = currentSubmission.photo;
        
        // Switch to generate tab
        switchTab('generate');
        
        // Display current selection
        document.getElementById('currentSubmission').innerHTML = `
            <img src="${currentImage}" alt="${currentSubmission.name}">
            <div class="info">
                <strong>Name:</strong> ${escapeHtml(currentSubmission.name)}<br>
                <strong>Status:</strong> <span class="submission-status ${currentSubmission.status}">${currentSubmission.status}</span><br>
                <strong>Source:</strong> Submission Queue
            </div>
        `;
        
        // Show replace and clear buttons
        document.getElementById('replaceImageBtn').style.display = 'block';
        document.getElementById('clearImageBtn').style.display = 'block';
        
        // Pre-fill form
        document.getElementById('promptInput').value = currentSubmission.prompt || '';
        document.getElementById('customTextInput').value = currentSubmission.customText || '';
        
        validateGenerateForm();
    } catch (error) {
        console.error('Error loading submission:', error);
        showStatus('Failed to load submission', 'error', 'generateTab');
    }
}

// Load Custom Image
function loadCustomImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
        showStatus('Please select a valid image file', 'error', 'generateTab');
        return;
    }
    
    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
        showStatus('Image size must be less than 10MB', 'error', 'generateTab');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
        currentImage = e.target.result;
        currentSubmission = null;
        
        document.getElementById('currentSubmission').innerHTML = `
            <img src="${currentImage}" alt="Custom upload">
            <div class="info">
                <strong>Source:</strong> Custom Upload<br>
                <strong>File:</strong> ${escapeHtml(file.name)}<br>
                <strong>Size:</strong> ${(file.size / 1024).toFixed(2)} KB
            </div>
        `;
        
        // Show replace and clear buttons
        document.getElementById('replaceImageBtn').style.display = 'block';
        document.getElementById('clearImageBtn').style.display = 'block';
        
        validateGenerateForm();
        showStatus('Image uploaded successfully! You can now generate stickers.', 'success', 'generateTab');
    };
    reader.readAsDataURL(file);
}

// Replace current image
function replaceImage() {
    document.getElementById('customImageUpload').click();
}

// Clear image selection
function clearImage() {
    currentImage = null;
    currentSubmission = null;
    
    document.getElementById('currentSubmission').innerHTML = `
        <p class="placeholder">
            Select a submission from the queue<br>
            <strong>or</strong><br>
            📁 Upload / Drag & Drop an image here
        </p>
    `;
    
    // Hide replace and clear buttons
    document.getElementById('replaceImageBtn').style.display = 'none';
    document.getElementById('clearImageBtn').style.display = 'none';
    
    // Clear file input
    document.getElementById('customImageUpload').value = '';
    
    // Clear prompts
    document.getElementById('promptInput').value = '';
    document.getElementById('customTextInput').value = '';
    document.getElementById('presetSelect').value = '';
    
    validateGenerateForm();
    showStatus('Selection cleared', 'info', 'generateTab');
}

// Validate Generate Form
function validateGenerateForm() {
    const prompt = document.getElementById('promptInput').value.trim();
    const hasImage = currentImage !== null;
    
    document.getElementById('generateBtn').disabled = !(prompt && hasImage);
}

// Add event listeners for form validation
document.getElementById('promptInput')?.addEventListener('input', validateGenerateForm);
document.getElementById('customTextInput')?.addEventListener('input', validateGenerateForm);

// Setup drag and drop for image upload
function setupDragAndDrop() {
    const dropZone = document.getElementById('currentSubmission');
    if (!dropZone) return;
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('drag-over');
        }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('drag-over');
        }, false);
    });
    
    dropZone.addEventListener('drop', handleDrop, false);
    
    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        
        if (files.length > 0) {
            const file = files[0];
            
            // Create a fake event object for loadCustomImage
            const fakeEvent = {
                target: {
                    files: [file]
                }
            };
            
            loadCustomImage(fakeEvent);
        }
    }
}

// Initialize drag and drop when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDragAndDrop);
} else {
    setupDragAndDrop();
}

// Global variable for tracking current generation
let generationSubmissionId = null;
let generationPollInterval = null;

// Generate Stickers
async function generateStickers() {
    const prompt = document.getElementById('promptInput').value.trim();
    const customText = document.getElementById('customTextInput').value.trim();
    
    if (!currentImage) {
        showStatus('Please select an image first', 'error', 'generateTab');
        return;
    }

    if (!prompt) {
        showStatus('Please enter a prompt', 'error', 'generateTab');
        return;
    }

    const generateBtn = document.getElementById('generateBtn');
    generateBtn.disabled = true;
    generateBtn.textContent = '⏳ Processing...';

    // Hide previous results
    document.getElementById('generatedImages').style.display = 'none';
    document.getElementById('statusMessage').style.display = 'none';

    try {
        let submissionId;
        
        // If we have an existing submission from the queue
        if (currentSubmission && currentSubmission._id) {
            submissionId = currentSubmission._id;
            
            // Update the submission with current values
            const updateResponse = await fetch(`${API_BASE_URL}/submissions/${submissionId}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    photo: currentImage,
                    prompt: prompt,
                    customText: customText
                })
            });

            if (!updateResponse.ok) {
                throw new Error('Failed to update submission');
            }

            // Approve for processing
            const approveResponse = await fetch(`${API_BASE_URL}/submissions/${submissionId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ status: 'approved' })
            });

            if (!approveResponse.ok) {
                throw new Error('Failed to approve submission');
            }
            
        } else {
            // For custom uploads, create a new submission
            const createResponse = await fetch(`${API_BASE_URL}/submissions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    name: 'Admin Upload',
                    photo: currentImage,
                    prompt: prompt,
                    customText: customText
                })
            });

            if (!createResponse.ok) {
                const errorData = await createResponse.json();
                throw new Error(errorData.error || 'Failed to create submission');
            }

            const newSubmission = await createResponse.json();
            submissionId = newSubmission.submissionId;

            // Immediately approve for processing
            const approveResponse = await fetch(`${API_BASE_URL}/submissions/${submissionId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ status: 'approved' })
            });

            if (!approveResponse.ok) {
                throw new Error('Failed to approve submission');
            }
        }
        
        // Start monitoring generation
        generationSubmissionId = submissionId;
        startGenerationMonitoring(submissionId);
        
    } catch (error) {
        console.error('Generation error:', error);
        showStatus(`❌ Error: ${error.message}`, 'error', 'generateTab');
        generateBtn.disabled = false;
        generateBtn.textContent = '⚡ Generate Stickers';
    }
}

// Start monitoring generation progress
function startGenerationMonitoring(submissionId) {
    // Show progress UI
    document.getElementById('generationProgress').style.display = 'block';
    document.getElementById('progressBar').style.width = '25%';
    document.getElementById('progressStatus').textContent = 'Waiting for processor to pick up request...';
    document.getElementById('step1').classList.add('active');
    
    let pollCount = 0;
    const maxPolls = 120; // 2 minutes max (2 second intervals)
    
    // Poll every 2 seconds
    generationPollInterval = setInterval(async () => {
        pollCount++;
        
        try {
            const response = await fetch(`${API_BASE_URL}/submissions/${submissionId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (!response.ok) {
                throw new Error('Failed to check submission status');
            }
            
            const submission = await response.json();
            updateGenerationProgress(submission);
            
            // Check if complete
            if (submission.status === 'completed') {
                clearInterval(generationPollInterval);
                generationPollInterval = null;
                displayGeneratedImages(submission);
            } else if (submission.status === 'rejected' || pollCount >= maxPolls) {
                clearInterval(generationPollInterval);
                generationPollInterval = null;
                
                document.getElementById('generationProgress').style.display = 'none';
                showStatus(submission.status === 'rejected' ? '❌ Generation was rejected' : '❌ Generation timeout - check processor', 'error', 'generateTab');
                
                const generateBtn = document.getElementById('generateBtn');
                generateBtn.disabled = false;
                generateBtn.textContent = '⚡ Generate Stickers';
            }
        } catch (error) {
            console.error('Poll error:', error);
        }
    }, 2000);
}

// Update generation progress UI based on status
function updateGenerationProgress(submission) {
    const progressBar = document.getElementById('progressBar');
    const progressStatus = document.getElementById('progressStatus');
    
    // Clear all step states
    document.querySelectorAll('.progress-steps .step').forEach(step => {
        step.classList.remove('active', 'complete');
    });
    
    switch (submission.status) {
        case 'approved':
            progressBar.style.width = '25%';
            progressStatus.textContent = 'Waiting for processor... (polls every 10 seconds)';
            document.getElementById('step1').classList.add('active');
            break;
        case 'processing':
            progressBar.style.width = '60%';
            progressStatus.textContent = 'Processing with ComfyUI... (this may take 30-60 seconds)';
            document.getElementById('step1').classList.add('complete');
            document.getElementById('step2').classList.add('active');
            break;
        case 'completed':
            progressBar.style.width = '100%';
            progressStatus.textContent = 'Complete! Displaying results...';
            document.getElementById('step1').classList.add('complete');
            document.getElementById('step2').classList.add('complete');
            document.getElementById('step3').classList.add('complete');
            document.getElementById('step4').classList.add('active');
            break;
    }
}

// Display generated images
async function displayGeneratedImages(submission) {
    // Hide progress
    setTimeout(() => {
        document.getElementById('generationProgress').style.display = 'none';
    }, 1000);
    
    // Show results section
    document.getElementById('generatedImages').style.display = 'block';
    
    // Re-enable generate button
    const generateBtn = document.getElementById('generateBtn');
    generateBtn.disabled = false;
    generateBtn.textContent = '⚡ Generate Stickers';
    
    if (!submission.generatedImages || submission.generatedImages.length === 0) {
        showStatus('⚠️ No images were generated', 'warning', 'generateTab');
        return;
    }
    
    // Display each image
    for (let i = 0; i < Math.min(4, submission.generatedImages.length); i++) {
        const slot = document.getElementById(`imageSlot${i + 1}`);
        const imageData = submission.generatedImages[i];
        
        // Process image to print-ready specs (600 DPI, 2.5" height = 1500px)
        const printReadyImage = await resizeImageForPrint(imageData.data, 1500);
        
        slot.innerHTML = `
            <img src="${printReadyImage}" alt="Generated Sticker ${i + 1}">
            <div class="image-info">600 DPI • 2.5"</div>
            <button class="download-btn" onclick="downloadImage('${printReadyImage}', 'sticker_${i + 1}_print_ready.png')">
                📥 Download
            </button>
        `;
    }
    
    showStatus('✅ Generation complete! Images are ready for printing at 600 DPI, 2.5" tall.', 'success', 'generateTab');
}

// Resize image to print-ready specifications
async function resizeImageForPrint(base64Image, targetHeight) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Calculate dimensions maintaining aspect ratio
            const aspectRatio = img.width / img.height;
            canvas.height = targetHeight; // 1500px = 2.5" at 600 DPI
            canvas.width = Math.round(targetHeight * aspectRatio);
            
            // Draw with high quality
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            
            resolve(canvas.toDataURL('image/png'));
        };
        img.src = base64Image;
    });
}

// Download single image
function downloadImage(base64Data, filename) {
    const link = document.createElement('a');
    link.href = base64Data;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Download all images
function downloadAllImages() {
    const slots = document.querySelectorAll('.image-slot img');
    slots.forEach((img, index) => {
        setTimeout(() => {
            downloadImage(img.src, `sticker_${index + 1}_print_ready_600dpi.png`);
        }, index * 200); // Stagger downloads
    });
    
    showStatus('📥 Downloading all images...', 'info', 'generateTab');
}

// Load Presets
async function loadPresets() {
    try {
        const response = await fetch(`${API_BASE_URL}/presets`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) throw new Error('Failed to load presets');

        presets = await response.json();
        displayPresets();
        updatePresetDropdown();
    } catch (error) {
        console.error('Error loading presets:', error);
        document.getElementById('presetsList').innerHTML = 
            '<p class="error">Failed to load presets</p>';
    }
}

// Display Presets
function displayPresets() {
    const container = document.getElementById('presetsList');
    
    if (presets.length === 0) {
        container.innerHTML = '<p class="loading">No presets saved yet</p>';
        return;
    }
    
    container.innerHTML = presets.map(preset => `
        <div class="preset-item">
            <div class="preset-item-info">
                <h4>${escapeHtml(preset.name)}</h4>
                <p><strong>Prompt:</strong> ${escapeHtml(preset.prompt)}</p>
                ${preset.customText ? `<p><strong>Text:</strong> ${escapeHtml(preset.customText)}</p>` : ''}
            </div>
            <div class="preset-item-actions">
                <button onclick="deletePreset('${preset._id}')" class="btn-danger btn-sm">
                    🗑️
                </button>
            </div>
        </div>
    `).join('');
}

// Update Preset Dropdown
function updatePresetDropdown() {
    const select = document.getElementById('presetSelect');
    select.innerHTML = '<option value="">Custom (type below)</option>' +
        presets.map(p => `<option value="${p._id}">${escapeHtml(p.name)}</option>`).join('');
}

// Load Preset Values
function loadPresetValues() {
    const presetId = document.getElementById('presetSelect').value;
    
    if (!presetId) {
        document.getElementById('promptInput').value = '';
        document.getElementById('customTextInput').value = '';
        return;
    }
    
    const preset = presets.find(p => p._id === presetId);
    if (preset) {
        document.getElementById('promptInput').value = preset.prompt || '';
        document.getElementById('customTextInput').value = preset.customText || '';
        validateGenerateForm();
    }
}

// Add Preset
async function addPreset() {
    const name = document.getElementById('newPresetName').value.trim();
    const prompt = document.getElementById('newPresetPrompt').value.trim();
    const customText = document.getElementById('newPresetText').value.trim();
    
    if (!name || !prompt) {
        showStatus('Name and prompt are required', 'error', 'presetsTab');
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/presets`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ name, prompt, customText })
        });

        if (response.ok) {
            document.getElementById('newPresetName').value = '';
            document.getElementById('newPresetPrompt').value = '';
            document.getElementById('newPresetText').value = '';
            
            loadPresets();
            showStatus('Preset saved successfully!', 'success', 'presetsTab');
        } else {
            const data = await response.json();
            showStatus(data.error || 'Failed to save preset', 'error', 'presetsTab');
        }
    } catch (error) {
        console.error('Error adding preset:', error);
        showStatus('Failed to save preset', 'error', 'presetsTab');
    }
}

// Delete Preset
async function deletePreset(id) {
    if (!confirm('Delete this preset?')) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/presets/${id}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            loadPresets();
            showStatus('Preset deleted', 'info', 'presetsTab');
        }
    } catch (error) {
        console.error('Error deleting preset:', error);
        showStatus('Failed to delete preset', 'error', 'presetsTab');
    }
}

// Check ComfyUI Status (placeholder - actual check would be done by processor)
function checkComfyUIStatus() {
    const statusEl = document.getElementById('comfyStatus');
    statusEl.textContent = '⚠️ Check via local processor';
    statusEl.className = 'status-indicator';
    
    // The actual ComfyUI status check should be done by the local processor
    // and could be stored in the database or communicated via another channel
}

// Show Status Message
function showStatus(message, type, tabId = null) {
    const statusDiv = tabId ? 
        document.querySelector(`#${tabId} .status-message`) :
        document.getElementById('statusMessage');
    
    if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.className = `status-message ${type}`;
        statusDiv.style.display = 'block';
        
        // Auto-hide after 5 seconds for success messages
        if (type === 'success') {
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 5000);
        }
    }
}

// Utility: Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

