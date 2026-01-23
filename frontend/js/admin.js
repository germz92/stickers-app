// Global variables
let token = null;
let currentSubmission = null;
let currentImage = null;
let allSubmissions = [];
let presets = [];
let pollInterval = null;

// Event management
let allEvents = [];
let currentEvent = null;

// Custom Alert & Confirm Functions
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

function customConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('customConfirm');
        const messageEl = document.getElementById('customConfirmMessage');
        const yesBtn = document.getElementById('customConfirmYes');
        const noBtn = document.getElementById('customConfirmNo');
        
        messageEl.textContent = message;
        modal.style.display = 'flex';
        
        const yesHandler = () => {
            modal.style.display = 'none';
            yesBtn.removeEventListener('click', yesHandler);
            noBtn.removeEventListener('click', noHandler);
            resolve(true);
        };
        
        const noHandler = () => {
            modal.style.display = 'none';
            yesBtn.removeEventListener('click', yesHandler);
            noBtn.removeEventListener('click', noHandler);
            resolve(false);
        };
        
        yesBtn.addEventListener('click', yesHandler);
        noBtn.addEventListener('click', noHandler);
    });
}

// Pagination state
let paginationState = {
    total: 0,
    loaded: 0,
    hasMore: false,
    limit: 50
};
let isPolling = false;

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
            
            // Initialize - show event selection first
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

// Logout
function logout() {
    localStorage.removeItem('adminToken');
    token = null;
    location.reload();
}

// Verify token
async function verifyToken() {
    try {
        const response = await fetch(`${API_BASE_URL}/events`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            
            // Initialize - show event selection first
            loadEvents();
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
async function loadSubmissions(silent = false, append = false) {
    if (!currentEvent) {
        console.warn('No event selected');
        return;
    }
    
    try {
        const skip = append ? allSubmissions.length : 0;
        const url = `${API_BASE_URL}/submissions?eventId=${currentEvent._id}&limit=${paginationState.limit}&skip=${skip}`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) throw new Error('Failed to load submissions');

        const data = await response.json();
        const newSubmissions = data.submissions || data; // Handle both old and new format
        const pagination = data.pagination || { total: newSubmissions.length, hasMore: false };
        
        // Update pagination state
        paginationState.total = pagination.total;
        paginationState.hasMore = pagination.hasMore;
        
        if (append) {
            // Append new submissions
            allSubmissions = [...allSubmissions, ...newSubmissions];
        } else {
            // Replace all submissions
            allSubmissions = newSubmissions;
        }
        
        paginationState.loaded = allSubmissions.length;
        
        // Always update the display (even during silent refresh)
        filterSubmissions(); // This will call updateLoadMoreButton() after filtering
        
        // Update queue count
        const pendingCount = allSubmissions.filter(s => s.status === 'pending').length;
        document.getElementById('queueCount').textContent = pendingCount;
    } catch (error) {
        if (!silent) {
            console.error('Error loading submissions:', error);
            document.getElementById('submissionsList').innerHTML = 
                '<p class="error">Failed to load submissions. Please try again.</p>';
        }
    }
}

// Load more submissions
async function loadMoreSubmissions() {
    const btn = document.getElementById('loadMoreBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Loading...';
    }
    
    await loadSubmissions(false, true); // silent=false, append=true
    
    if (btn) {
        btn.disabled = false;
        btn.textContent = 'Load More';
    }
}

// Update load more button visibility
function updateLoadMoreButton() {
    let btn = document.getElementById('loadMoreBtn');
    
    if (!btn) {
        // Create button if it doesn't exist
        const container = document.getElementById('loadMoreContainer');
        if (container) {
            btn = document.createElement('button');
            btn.id = 'loadMoreBtn';
            btn.className = 'btn-secondary';
            btn.textContent = 'Load More';
            btn.onclick = loadMoreSubmissions;
            container.appendChild(btn);
        }
    }
    
    if (btn) {
        // Check if there are actually visible submissions (not "No submissions found")
        const submissionsList = document.getElementById('submissionsList');
        const hasVisibleSubmissions = submissionsList && 
            submissionsList.querySelector('.submission-card') !== null;
        
        // Only show if there's more data AND we have visible submissions
        const shouldShow = paginationState.hasMore && paginationState.total > 0 && hasVisibleSubmissions;
        btn.style.display = shouldShow ? 'block' : 'none';
        
        // Update button text with count
        if (shouldShow) {
            const remaining = paginationState.total - paginationState.loaded;
            btn.textContent = `Load More (${remaining} remaining)`;
        }
    }
}

// Start auto-polling
function startPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
    }
    
    isPolling = true;
    
    // Poll every 3 seconds
    pollInterval = setInterval(() => {
        if (isPolling && token) {
            loadSubmissions(true); // Silent refresh
        }
    }, 3000);
}

// Stop polling
function stopPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    isPolling = false;
}

// ===== EVENT MANAGEMENT =====

// Load all events
async function loadEvents() {
    try {
        const showArchived = document.getElementById('showArchivedEvents')?.checked || false;
        const url = `${API_BASE_URL}/events?includeArchived=${showArchived}`;
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) throw new Error('Failed to load events');

        allEvents = await response.json();
        displayEvents();
    } catch (error) {
        console.error('Error loading events:', error);
        document.getElementById('eventsList').innerHTML = 
            '<p class="loading">Failed to load events. Please try again.</p>';
    }
}

// Display events as cards
function displayEvents() {
    const container = document.getElementById('eventsList');
    
    if (allEvents.length === 0) {
        container.innerHTML = `
            <div class="no-events">
                <p class="loading">No events found. Create your first event to get started!</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = allEvents.map(event => {
        const eventDate = new Date(event.eventDate);
        const formattedDate = eventDate.toLocaleDateString('en-US', { 
            weekday: 'short', 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
        const isArchived = event.isArchived;
        
        return `
            <div class="event-card ${isArchived ? 'archived' : ''}" onclick="selectEvent('${event._id}')">
                <div class="event-card-header">
                    <h3>${escapeHtml(event.name)}</h3>
                    ${isArchived ? '<span class="event-badge archived">Archived</span>' : '<span class="event-badge active">Active</span>'}
                </div>
                <div class="event-card-date">${formattedDate}</div>
                ${event.description ? `<p class="event-card-description">${escapeHtml(event.description)}</p>` : ''}
                <div class="event-card-stats">
                    <div class="event-stat">
                        <span class="event-stat-value ${event.pendingCount > 0 ? 'pending' : ''}">${event.pendingCount || 0}</span>
                        <span class="event-stat-label">Pending</span>
                    </div>
                    <div class="event-stat">
                        <span class="event-stat-value">${event.totalCount || 0}</span>
                        <span class="event-stat-label">Total</span>
                    </div>
                </div>
                <div class="event-card-actions" onclick="event.stopPropagation()">
                    <button onclick="openEditEventModal('${event._id}')" class="btn-secondary btn-sm">Edit</button>
                    ${isArchived 
                        ? `<button onclick="unarchiveEvent('${event._id}')" class="btn-success btn-sm">Restore</button>`
                        : `<button onclick="archiveEvent('${event._id}')" class="btn-warning btn-sm">Archive</button>`
                    }
                    <button onclick="deleteEvent('${event._id}')" class="btn-danger btn-sm">Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

// Select event and show queue
async function selectEvent(eventId) {
    const event = allEvents.find(e => e._id === eventId);
    if (!event) return;
    
    currentEvent = event;
    
    // Update header with event name
    document.getElementById('currentEventName').textContent = event.name;
    
    // Switch screens
    document.getElementById('eventSelectionScreen').style.display = 'none';
    document.getElementById('eventQueueScreen').style.display = 'block';
    
    // Load event data
    loadSubmissions();
    loadPresets();
    startPolling();
}

// Go back to event selection
function backToEvents() {
    stopPolling();
    currentEvent = null;
    allSubmissions = [];
    
    document.getElementById('eventQueueScreen').style.display = 'none';
    document.getElementById('eventSelectionScreen').style.display = 'block';
    
    loadEvents();
}

// Open create event modal
function openCreateEventModal() {
    document.getElementById('newEventName').value = '';
    document.getElementById('newEventDescription').value = '';
    document.getElementById('newEventDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('createEventError').style.display = 'none';
    document.getElementById('createEventModal').style.display = 'flex';
}

// Close create event modal
function closeCreateEventModal() {
    document.getElementById('createEventModal').style.display = 'none';
}

// Create new event
async function createNewEvent() {
    const name = document.getElementById('newEventName').value.trim();
    const description = document.getElementById('newEventDescription').value.trim();
    const eventDate = document.getElementById('newEventDate').value;
    const errorDiv = document.getElementById('createEventError');
    
    if (!name || !eventDate) {
        errorDiv.textContent = 'Name and date are required';
        errorDiv.style.display = 'block';
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/events`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ name, description, eventDate })
        });
        
        if (response.ok) {
            closeCreateEventModal();
            loadEvents();
            showStatus('Event created successfully!', 'success');
        } else {
            const data = await response.json();
            errorDiv.textContent = data.error || 'Failed to create event';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Create event error:', error);
        errorDiv.textContent = 'Connection error. Please try again.';
        errorDiv.style.display = 'block';
    }
}

// Open edit event modal
function openEditEventModal(eventId) {
    const event = allEvents.find(e => e._id === eventId);
    if (!event) return;
    
    document.getElementById('editEventId').value = event._id;
    document.getElementById('editEventName').value = event.name;
    document.getElementById('editEventDescription').value = event.description || '';
    document.getElementById('editEventDate').value = new Date(event.eventDate).toISOString().split('T')[0];
    document.getElementById('editEventError').style.display = 'none';
    document.getElementById('editEventModal').style.display = 'flex';
}

// Close edit event modal
function closeEditEventModal() {
    document.getElementById('editEventModal').style.display = 'none';
}

// Save event changes
async function saveEventChanges() {
    const eventId = document.getElementById('editEventId').value;
    const name = document.getElementById('editEventName').value.trim();
    const description = document.getElementById('editEventDescription').value.trim();
    const eventDate = document.getElementById('editEventDate').value;
    const errorDiv = document.getElementById('editEventError');
    
    if (!name || !eventDate) {
        errorDiv.textContent = 'Name and date are required';
        errorDiv.style.display = 'block';
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/events/${eventId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ name, description, eventDate })
        });
        
        if (response.ok) {
            closeEditEventModal();
            loadEvents();
            
            // Update current event if it's the one being edited
            if (currentEvent && currentEvent._id === eventId) {
                const updatedEvent = await response.json();
                currentEvent = updatedEvent;
                document.getElementById('currentEventName').textContent = updatedEvent.name;
            }
            
            showStatus('Event updated successfully!', 'success');
        } else {
            const data = await response.json();
            errorDiv.textContent = data.error || 'Failed to update event';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Update event error:', error);
        errorDiv.textContent = 'Connection error. Please try again.';
        errorDiv.style.display = 'block';
    }
}

// Archive event
async function archiveEvent(eventId) {
    if (!await customConfirm('Archive this event? It will be hidden from the capture page.')) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/events/${eventId}/archive`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ isArchived: true })
        });
        
        if (response.ok) {
            loadEvents();
            showStatus('Event archived', 'info');
        } else {
            showStatus('Failed to archive event', 'error');
        }
    } catch (error) {
        console.error('Archive event error:', error);
        showStatus('Error archiving event', 'error');
    }
}

// Unarchive event
async function unarchiveEvent(eventId) {
    try {
        const response = await fetch(`${API_BASE_URL}/events/${eventId}/archive`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ isArchived: false })
        });
        
        if (response.ok) {
            loadEvents();
            showStatus('Event restored', 'success');
        } else {
            showStatus('Failed to restore event', 'error');
        }
    } catch (error) {
        console.error('Unarchive event error:', error);
        showStatus('Error restoring event', 'error');
    }
}

// Delete event
async function deleteEvent(eventId) {
    if (!await customConfirm('Delete this event? This can only be done if there are no submissions.')) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/events/${eventId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            loadEvents();
            showStatus('Event deleted', 'info');
        } else {
            const data = await response.json();
            await customAlert(data.error || 'Failed to delete event');
        }
    } catch (error) {
        console.error('Delete event error:', error);
        showStatus('Error deleting event', 'error');
    }
}

// Track previous filter to detect changes
let previousFilter = 'pending';

// Toggle extra tabs visibility
function toggleExtraTabs() {
    const extraTabs = document.querySelectorAll('.extra-tab');
    const btn = document.getElementById('toggleTabsBtn');
    const isHidden = extraTabs[0].style.display === 'none';
    
    extraTabs.forEach(tab => {
        tab.style.display = isHidden ? 'flex' : 'none';
    });
    
    btn.textContent = isHidden ? 'Hide Extra Tabs' : 'Show All Tabs';
}

// Filter Submissions
function filterSubmissions() {
    const filter = document.querySelector('input[name="statusFilter"]:checked').value;
    const searchTerm = document.getElementById('searchInput')?.value.toLowerCase() || '';
    const sortOrderElement = document.getElementById('sortOrder');
    
    // Auto-switch sort order when switching to/from completed, rejected, or failed tabs
    if (filter !== previousFilter) {
        if (filter === 'completed' || filter === 'rejected' || filter === 'failed') {
            // Switch to newest first for completed/rejected/failed
            sortOrderElement.value = 'newest';
        } else if (previousFilter === 'completed' || previousFilter === 'rejected' || previousFilter === 'failed') {
            // Switch back to oldest first when leaving completed/rejected/failed
            sortOrderElement.value = 'oldest';
        }
        previousFilter = filter;
    }
    
    const sortOrder = sortOrderElement.value;
    
    // Filter by status
    let filtered = allSubmissions;
    if (filter !== 'all') {
        filtered = allSubmissions.filter(s => s.status === filter);
    }
    
    // Filter by search term (search in name)
    if (searchTerm) {
        filtered = filtered.filter(s => 
            s.name.toLowerCase().includes(searchTerm)
        );
    }
    
    // Sort by date
    filtered = [...filtered].sort((a, b) => {
        // Use processedAt for completed submissions, createdAt for others
        const dateA = filter === 'completed' && a.processedAt 
            ? new Date(a.processedAt).getTime() 
            : new Date(a.createdAt).getTime();
        const dateB = filter === 'completed' && b.processedAt 
            ? new Date(b.processedAt).getTime() 
            : new Date(b.createdAt).getTime();
        
        if (sortOrder === 'oldest') {
            return dateA - dateB; // Oldest first
        } else {
            return dateB - dateA; // Newest first
        }
    });
    
    displaySubmissions(filtered);
    updateLoadMoreButton(); // Update button after filtering to check if there are visible results
}

// Display Submissions
function displaySubmissions(submissions) {
    const container = document.getElementById('submissionsList');
    
    if (submissions.length === 0) {
        container.innerHTML = '<p class="loading">No submissions found</p>';
        return;
    }
    
    container.innerHTML = submissions.map(sub => {
        // Different display for completed vs other statuses
        if (sub.status === 'completed' && sub.generatedImages && sub.generatedImages.length > 0) {
            return `
                <div class="submission-card completed-card">
                    <div class="completed-preview">
                        <img class="submission-thumbnail-small" 
                             src="${sub.photo || 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\'><rect fill=\'%23f0f0f0\' width=\'100\' height=\'100\'/></svg>'}"
                             alt="${sub.name}"
                             loading="lazy">
                        <div class="sticker-thumbnails">
                            ${sub.generatedImages.slice(0, 4).map((img, idx) => `
                                <img src="${img.url}" 
                                     alt="Sticker ${idx + 1}" 
                                     class="sticker-thumb"
                                     loading="lazy"
                                     onclick='openLightbox(${JSON.stringify(sub.generatedImages)}, ${idx})'>
                            `).join('')}
                        </div>
                    </div>
                    <div class="submission-info">
                        <h3>${escapeHtml(sub.name)}</h3>
                        <p><strong>Completed:</strong> ${new Date(sub.processedAt || sub.createdAt).toLocaleString()}</p>
                        <span class="submission-status ${sub.status}">${sub.status.toUpperCase()}</span>
                    </div>
                    <div class="submission-actions">
                        <button onclick="viewCompletedSubmission('${sub._id}')" class="btn-primary btn-sm">
                            View Details
                        </button>
                        <button onclick="addToQueue('${sub._id}')" class="btn-success btn-sm">
                            Add to Queue
                        </button>
                        <button onclick="regenerateSubmission('${sub._id}')" class="btn-warning btn-sm">
                            Regenerate
                        </button>
                        <button onclick="deleteSubmission('${sub._id}')" class="btn-danger btn-sm">
                            Delete
                        </button>
                    </div>
                </div>
            `;
        } else if (sub.status === 'failed') {
            return `
                <div class="submission-card failed-card">
                    <img class="submission-thumbnail" 
                         src="${sub.photo || 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'300\' height=\'200\'><rect fill=\'%23f0f0f0\' width=\'300\' height=\'200\'/></svg>'}"
                         alt="${sub.name}"
                         loading="lazy">
                    <div class="submission-info">
                        <h3>${escapeHtml(sub.name)}</h3>
                        <p><strong>Submitted:</strong> ${new Date(sub.createdAt).toLocaleString()}</p>
                        <p class="failure-reason"><strong>Failed:</strong> ${escapeHtml(sub.failureReason || 'Unknown error')}</p>
                        <p><strong>Attempts:</strong> ${sub.retryCount || 0}/3</p>
                        <span class="submission-status ${sub.status}">${sub.status.toUpperCase()}</span>
                    </div>
                    <div class="submission-actions">
                        <button onclick="retryFailedSubmission('${sub._id}')" class="btn-warning btn-sm">
                            Retry
                        </button>
                        <button onclick="deleteSubmission('${sub._id}')" class="btn-danger btn-sm">
                            Delete
                        </button>
                    </div>
                </div>
            `;
        } else {
            // Default display for pending, approved, processing
            return `
                <div class="submission-card">
                    <img class="submission-thumbnail" 
                         src="${sub.photo || 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'300\' height=\'200\'><rect fill=\'%23f0f0f0\' width=\'300\' height=\'200\'/></svg>'}"
                         alt="${sub.name}"
                         loading="lazy">
                    <div class="submission-info">
                        <h3>${escapeHtml(sub.name)}</h3>
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
                                Approve
                            </button>
                            <button onclick="rejectSubmission('${sub._id}')" class="btn-danger btn-sm">
                                Reject
                            </button>
                        ` : ''}
                        ${sub.status === 'processing' ? `
                            <button onclick="verifyStatus('${sub._id}')" class="btn-warning btn-sm">
                                Verify Status
                            </button>
                        ` : ''}
                        ${sub.status === 'rejected' || sub.status === 'processing' ? `
                            <button onclick="addToQueue('${sub._id}')" class="btn-success btn-sm">
                                Add to Queue
                            </button>
                        ` : ''}
                        <button onclick="loadSubmissionForGeneration('${sub._id}')" class="btn-primary btn-sm">
                            Generate
                        </button>
                        <button onclick="deleteSubmission('${sub._id}')" class="btn-danger btn-sm">
                            Delete
                        </button>
                    </div>
                </div>
            `;
        }
    }).join('');
    
    // Thumbnails now load directly from S3 URLs - no need for separate API calls
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
        // Optimistic UI update
        const submission = allSubmissions.find(s => s._id === id);
        if (submission) {
            submission.status = 'approved';
            filterSubmissions();
        }
        
        const response = await fetch(`${API_BASE_URL}/submissions/${id}/approve`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            // Immediate refresh to sync with server
            await loadSubmissions();
            showStatus('Submission approved!', 'success');
        } else {
            // Revert optimistic update on error
            await loadSubmissions();
            showStatus('Failed to approve submission', 'error');
        }
    } catch (error) {
        console.error('Error approving submission:', error);
        await loadSubmissions();
        showStatus('Failed to approve submission', 'error');
    }
}

// Reject Submission
async function rejectSubmission(id) {
    if (!await customConfirm('Are you sure you want to reject this submission?')) return;
    
    try {
        // Optimistic UI update
        const submission = allSubmissions.find(s => s._id === id);
        if (submission) {
            submission.status = 'rejected';
            filterSubmissions();
        }
        
        const response = await fetch(`${API_BASE_URL}/submissions/${id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ status: 'rejected' })
        });

        if (response.ok) {
            // Immediate refresh to sync with server
            await loadSubmissions();
            showStatus('Submission rejected', 'info');
        } else {
            // Revert optimistic update on error
            await loadSubmissions();
            showStatus('Failed to reject submission', 'error');
        }
    } catch (error) {
        console.error('Error rejecting submission:', error);
        await loadSubmissions();
        showStatus('Failed to reject submission', 'error');
    }
}

// Delete Submission
async function deleteSubmission(id) {
    if (!await customConfirm('Are you sure you want to delete this submission? This cannot be undone.')) return;
    
    try {
        // Optimistic UI update
        allSubmissions = allSubmissions.filter(s => s._id !== id);
        filterSubmissions();
        
        const response = await fetch(`${API_BASE_URL}/submissions/${id}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            // Immediate refresh to sync with server
            await loadSubmissions();
            showStatus('Submission deleted', 'info');
        } else {
            // Revert optimistic update on error
            await loadSubmissions();
            showStatus('Failed to delete submission', 'error');
        }
    } catch (error) {
        console.error('Error deleting submission:', error);
        await loadSubmissions();
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

// View completed submission in expanded modal
async function viewCompletedSubmission(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) throw new Error('Failed to fetch submission');
        
        const submission = await response.json();
        
        // Create modal HTML
        const modalHTML = `
            <div class="modal-overlay" onclick="closeCompletedModal()">
                <div class="modal-content completed-modal" onclick="event.stopPropagation()">
                    <button class="modal-close" onclick="closeCompletedModal()">×</button>
                    <h2>${escapeHtml(submission.name)}'s Stickers</h2>
                    
                    <div class="completed-details">
                        <div class="left-column">
                            <img src="${submission.photo}" alt="Original" class="original-photo">
                            <div class="submission-metadata">
                                <p><strong>Name:</strong> ${escapeHtml(submission.name)}</p>
                                <p><strong>Completed:</strong> ${new Date(submission.processedAt || submission.createdAt).toLocaleString()}</p>
                                <p><strong>Prompt:</strong> ${escapeHtml(submission.prompt)}</p>
                                ${submission.customText ? `<p><strong>Custom Text:</strong> ${escapeHtml(submission.customText)}</p>` : ''}
                            </div>
                            ${submission.processingLogs && submission.processingLogs.length > 0 ? `
                                <details class="processing-logs">
                                    <summary>▼ Processing Logs</summary>
                                    <div class="log-entries">
                                        ${submission.processingLogs.map(log => `
                                            <div class="log-entry ${log.level}">
                                                <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
                                                <span class="log-message">${escapeHtml(log.message)}</span>
                                            </div>
                                        `).join('')}
                                    </div>
                                </details>
                            ` : ''}
                        </div>
                        
                        <div class="right-column">
                            <div class="stickers-grid">
                                ${submission.generatedImages.map((img, idx) => `
                                    <div class="sticker-item">
                                        <img src="${img.url}" 
                                             alt="Sticker ${idx + 1}"
                                             onclick='openLightbox(${JSON.stringify(submission.generatedImages)}, ${idx})'
                                             style="cursor: pointer;">
                                        <button onclick="downloadImageFromUrl('${img.url}', '${img.filename}')" class="btn-sm btn-primary">
                                            Download
                                        </button>
                                    </div>
                                `).join('')}
                            </div>
                            
                            <div class="modal-actions">
                                <button onclick="downloadAllStickers('${id}')" class="btn-primary">
                                    Download All
                                </button>
                                <button onclick="addToQueue('${id}')" class="btn-success">
                                    Add to Queue
                                </button>
                                <button onclick="regenerateSubmission('${id}')" class="btn-warning">
                                    Regenerate
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Add to page
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    } catch (error) {
        console.error('Error viewing submission:', error);
        showStatus('Failed to load submission details', 'error');
    }
}

function closeCompletedModal() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) modal.remove();
}

// Regenerate submission
async function regenerateSubmission(id) {
    if (!await customConfirm('Create a duplicate of this submission and regenerate? The original will be kept.')) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}/regenerate`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            closeCompletedModal();
            await loadSubmissions();
            showStatus('Duplicate created and added to queue for regeneration!', 'success');
        } else {
            showStatus('Failed to regenerate submission', 'error');
        }
    } catch (error) {
        console.error('Regenerate error:', error);
        showStatus('Error regenerating submission', 'error');
    }
}

// Add submission to queue
async function addToQueue(id) {
    // Get the submission to check its current status
    const submission = allSubmissions.find(s => s._id === id);
    const isPendingStatus = submission && (submission.status === 'completed' || submission.status === 'rejected' || submission.status === 'failed');
    
    const message = isPendingStatus 
        ? 'Move this submission back to Pending? (You will need to approve it again)'
        : 'Add this submission to the processing queue?';
    
    if (!await customConfirm(message)) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}/add-to-queue`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            await loadSubmissions();
            const successMsg = isPendingStatus 
                ? 'Submission moved to Pending. You can now review and approve it.' 
                : 'Submission added to queue!';
            showStatus(successMsg, 'success');
        } else {
            showStatus('Failed to add submission to queue', 'error');
        }
    } catch (error) {
        console.error('Add to queue error:', error);
        showStatus('Error adding submission to queue', 'error');
    }
}

// Verify and fix submission status
async function verifyStatus(id) {
    console.log('Verifying status for:', id);
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}/verify-status`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        console.log('Verify response status:', response.status);
        
        if (response.ok) {
            const data = await response.json();
            console.log('Verify response data:', data);
            
            await loadSubmissions();
            
            if (data.fixed) {
                showStatus(data.message, 'success');
            } else {
                showStatus(data.message, 'info');
            }
        } else {
            const errorData = await response.json().catch(() => ({}));
            console.error('Verify failed:', errorData);
            showStatus(`Failed to verify status: ${errorData.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error('Verify status error:', error);
        showStatus(`Error verifying status: ${error.message}`, 'error');
    }
}

// Retry failed submission
async function retryFailedSubmission(id) {
    try {
        const response = await fetch(`${API_BASE_URL}/submissions/${id}/approve`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            await loadSubmissions();
            showStatus('Submission moved to queue for retry!', 'success');
        } else {
            showStatus('Failed to retry submission', 'error');
        }
    } catch (error) {
        console.error('Retry error:', error);
        showStatus('Error retrying submission', 'error');
    }
}

// Download all stickers
async function downloadAllStickers(id) {
    const submission = allSubmissions.find(s => s._id === id);
    if (!submission || !submission.generatedImages) return;
    
    for (const img of submission.generatedImages) {
        await downloadImageFromUrl(img.url, img.filename);
        // Small delay between downloads
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    showStatus('All stickers downloaded!', 'success');
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
                    eventId: currentEvent._id,
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
            progressStatus.textContent = 'Processing... (this may take 30-60 seconds)';
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
        
        // Use S3 URL directly (already print-ready from processor)
        const imageUrl = imageData.url;
        
        slot.innerHTML = `
            <img src="${imageUrl}" alt="Generated Sticker ${i + 1}">
            <div class="image-info">600 DPI • 2.5"</div>
            <button class="download-btn" onclick="downloadImageFromUrl('${imageUrl}', 'sticker_${i + 1}_${imageData.filename}')">
                Download
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

// Download image from URL via backend proxy (bypasses CORS)
async function downloadImageFromUrl(url, filename) {
    try {
        console.log('🔽 Starting download...', { url, filename });
        
        // Use backend proxy to download S3 images and bypass CORS
        const proxyUrl = `${API_BASE_URL}/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
        console.log('📡 Calling backend proxy:', proxyUrl);
        
        const response = await fetch(proxyUrl, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            }
        });
        
        console.log('📥 Backend response status:', response.status);
        
        if (!response.ok) {
            throw new Error('Download failed');
        }
        
        // Extract filename from Content-Disposition header
        const contentDisposition = response.headers.get('Content-Disposition');
        let downloadFilename = filename; // fallback to original
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="(.+?)"/);
            if (filenameMatch) {
                downloadFilename = filenameMatch[1];
                console.log('📝 Using filename from backend:', downloadFilename);
            }
        }
        
        const blob = await response.blob();
        console.log('💾 Received blob, size:', blob.size, 'bytes');
        
        const blobUrl = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = downloadFilename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        console.log('✅ Download triggered successfully');
        
        // Clean up blob URL
        setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
    } catch (error) {
        console.error('❌ Download error:', error);
        await customAlert('Failed to download image. Please try again.');
    }
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
                    Delete
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
    if (!await customConfirm('Delete this preset?')) return;
    
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

// System Health Monitoring
let statusBannerDismissed = false;

async function checkSystemHealth() {
    try {
        // Check processor heartbeat
        const response = await fetch(`${API_BASE_URL}/processor/status`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            }
        });
        
        if (!response.ok) {
            return;
        }
        
        const status = await response.json();
        
        // Check for stuck submissions
        const submissionsResponse = await fetch(`${API_BASE_URL}/submissions`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('adminToken')}`
            }
        });
        
        if (!submissionsResponse.ok) {
            return;
        }
        
        const data = await submissionsResponse.json();
        const submissions = data.submissions || data; // Handle both old and new format
        const stuckInApproved = submissions.filter(sub => {
            if (sub.status !== 'approved') return false;
            const approvedTime = new Date(sub.approvedAt);
            const now = new Date();
            return (now - approvedTime) > 60000; // Stuck for more than 1 minute
        });
        
        const stuckInProcessing = submissions.filter(sub => {
            if (sub.status !== 'processing') return false;
            const processingTime = new Date(sub.processingStartedAt);
            const now = new Date();
            return (now - processingTime) > 120000; // Stuck for more than 2 minutes
        });
        
        // Display warnings
        if (!status.isHealthy) {
            showSystemStatusBanner(
                'Processing service is not responding. New submissions will not be processed automatically.',
                'error'
            );
        } else if (stuckInProcessing.length > 0) {
            showSystemStatusBanner(
                `${stuckInProcessing.length} submission(s) stuck in processing. There may be an issue with the generation service.`,
                'warning'
            );
        } else if (stuckInApproved.length > 0 && status.isHealthy) {
            showSystemStatusBanner(
                `${stuckInApproved.length} approved submission(s) waiting to be processed. This is normal during high volume.`,
                'info'
            );
        } else if (!statusBannerDismissed) {
            hideSystemStatusBanner();
        }
    } catch (error) {
        console.error('System health check error:', error);
    }
}

function showSystemStatusBanner(message, type = 'warning') {
    if (statusBannerDismissed) return;
    
    const banner = document.getElementById('systemStatusBanner');
    const messageEl = document.getElementById('systemStatusMessage');
    const icon = banner.querySelector('.status-icon');
    
    if (!banner || !messageEl) return;
    
    messageEl.textContent = message;
    banner.classList.remove('error', 'warning', 'info');
    
    if (type === 'error') {
        banner.classList.add('error');
        icon.textContent = '🔴';
    } else if (type === 'warning') {
        icon.textContent = '⚠️';
    } else {
        icon.textContent = 'ℹ️';
    }
    
    banner.style.display = 'block';
}

function hideSystemStatusBanner() {
    const banner = document.getElementById('systemStatusBanner');
    if (banner) {
        banner.style.display = 'none';
    }
}

function dismissStatusBanner() {
    statusBannerDismissed = true;
    hideSystemStatusBanner();
}

// Start monitoring system health every 30 seconds
setInterval(checkSystemHealth, 30000);
// Initial check after 5 seconds
setTimeout(checkSystemHealth, 5000);

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

// ===== CAPTURE SETTINGS =====

let captureSettings = null;
let promptPresetCount = 0;
let customTextPresetCount = 0;

// Load Capture Settings (per-event)
async function loadCaptureSettings() {
    if (!currentEvent) {
        console.warn('No event selected');
        return;
    }
    
    try {
        // Get settings from current event
        captureSettings = currentEvent.captureSettings || {
            promptMode: 'free',
            customTextMode: 'free'
        };
        displayCaptureSettings();
    } catch (error) {
        console.error('Error loading capture settings:', error);
    }
}

// Display Capture Settings
function displayCaptureSettings() {
    if (!captureSettings) return;
    
    // Set prompt mode
    const promptModeRadio = document.querySelector(`input[name="promptMode"][value="${captureSettings.promptMode || 'free'}"]`);
    if (promptModeRadio) {
        promptModeRadio.checked = true;
    }
    
    // Set custom text mode
    const customTextModeRadio = document.querySelector(`input[name="customTextMode"][value="${captureSettings.customTextMode || 'free'}"]`);
    if (customTextModeRadio) {
        customTextModeRadio.checked = true;
    }
    
    // Set locked values
    document.getElementById('lockedPromptTitle').value = captureSettings.lockedPromptTitle || '';
    document.getElementById('lockedPromptValue').value = captureSettings.lockedPromptValue || '';
    document.getElementById('lockedCustomTextValue').value = captureSettings.lockedCustomTextValue || '';
    
    // Display prompt presets
    const promptList = document.getElementById('promptPresetsList');
    promptList.innerHTML = '';
    promptPresetCount = 0;
    if (captureSettings.promptPresets && captureSettings.promptPresets.length > 0) {
        captureSettings.promptPresets.forEach((preset, index) => {
            addPromptPresetToList(preset.name, preset.value, index);
        });
    }
    
    // Display prompt suggestions
    const promptSuggestionsList = document.getElementById('promptSuggestionsList');
    promptSuggestionsList.innerHTML = '';
    if (captureSettings.promptMode === 'suggestions' && captureSettings.promptPresets && captureSettings.promptPresets.length > 0) {
        captureSettings.promptPresets.forEach((preset, index) => {
            addPromptSuggestionToList(preset.name, preset.value, index);
        });
    }
    
    // Display custom text presets
    const textList = document.getElementById('customTextPresetsList');
    textList.innerHTML = '';
    customTextPresetCount = 0;
    if (captureSettings.customTextPresets && captureSettings.customTextPresets.length > 0) {
        captureSettings.customTextPresets.forEach((preset, index) => {
            addCustomTextPresetToList(preset.name, preset.value, index);
        });
    }
    
    // Display custom text suggestions
    const customTextSuggestionsList = document.getElementById('customTextSuggestionsList');
    customTextSuggestionsList.innerHTML = '';
    if (captureSettings.customTextMode === 'suggestions' && captureSettings.customTextPresets && captureSettings.customTextPresets.length > 0) {
        captureSettings.customTextPresets.forEach((preset, index) => {
            addCustomTextSuggestionToList(preset.name, preset.value, index);
        });
    }
    
    // Update view
    updateSettingsView();
}

// Update Settings View
function updateSettingsView() {
    const promptMode = document.querySelector('input[name="promptMode"]:checked').value;
    const customTextMode = document.querySelector('input[name="customTextMode"]:checked').value;
    
    document.getElementById('lockedPromptSettings').style.display = promptMode === 'locked' ? 'block' : 'none';
    document.getElementById('promptPresetsSettings').style.display = promptMode === 'presets' ? 'block' : 'none';
    document.getElementById('promptSuggestionsSettings').style.display = promptMode === 'suggestions' ? 'block' : 'none';
    
    document.getElementById('lockedCustomTextSettings').style.display = customTextMode === 'locked' ? 'block' : 'none';
    document.getElementById('customTextPresetsSettings').style.display = customTextMode === 'presets' ? 'block' : 'none';
    document.getElementById('customTextSuggestionsSettings').style.display = customTextMode === 'suggestions' ? 'block' : 'none';
}

// Add Prompt Preset
function addPromptPreset() {
    addPromptPresetToList('', '', promptPresetCount);
}

function addPromptPresetToList(name = '', value = '', index) {
    const list = document.getElementById('promptPresetsList');
    const id = `prompt-preset-${index}`;
    promptPresetCount = Math.max(promptPresetCount, index + 1);
    
    const div = document.createElement('div');
    div.className = 'preset-item';
    div.id = id;
    div.innerHTML = `
        <button onclick="document.getElementById('${id}').remove()" class="btn-danger btn-sm">×</button>
        <div class="preset-name">
            <label>Button Name</label>
            <input type="text" value="${escapeHtml(name)}" placeholder="e.g., Astronaut">
            <span class="hint">Shown to users on capture page</span>
        </div>
        <div class="preset-value">
            <label>Prompt Value</label>
            <input type="text" value="${escapeHtml(value)}" placeholder="e.g., astronaut in space suit floating...">
            <span class="hint">Hidden from users, used for generation</span>
        </div>
    `;
    list.appendChild(div);
}

// Add Custom Text Preset
function addCustomTextPreset() {
    addCustomTextPresetToList('', '', customTextPresetCount);
}

function addCustomTextPresetToList(name = '', value = '', index) {
    const list = document.getElementById('customTextPresetsList');
    const id = `text-preset-${index}`;
    customTextPresetCount = Math.max(customTextPresetCount, index + 1);
    
    const div = document.createElement('div');
    div.className = 'preset-item';
    div.id = id;
    div.innerHTML = `
        <button onclick="document.getElementById('${id}').remove()" class="btn-danger btn-sm">×</button>
        <div class="preset-value">
            <label>Text Value</label>
            <input type="text" placeholder="e.g., AWESOME!" value="${escapeHtml(value)}">
        </div>
    `;
    list.appendChild(div);
}

// Add Prompt Suggestion
function addPromptSuggestion() {
    addPromptSuggestionToList('', '', promptPresetCount);
}

function addPromptSuggestionToList(name = '', value = '', index) {
    const list = document.getElementById('promptSuggestionsList');
    const id = `prompt-suggestion-${index}`;
    promptPresetCount = Math.max(promptPresetCount, index + 1);
    
    const div = document.createElement('div');
    div.className = 'preset-item';
    div.id = id;
    div.innerHTML = `
        <button onclick="document.getElementById('${id}').remove()" class="btn-danger btn-sm">×</button>
        <div class="preset-name">
            <label>Button Name</label>
            <input type="text" value="${escapeHtml(name)}" placeholder="e.g., Astronaut">
            <span class="hint">Shown to users on capture page</span>
        </div>
        <div class="preset-value">
            <label>Prompt Value</label>
            <input type="text" value="${escapeHtml(value)}" placeholder="e.g., astronaut in space suit floating...">
            <span class="hint">Hidden from users, used for generation</span>
        </div>
    `;
    list.appendChild(div);
}

// Add Custom Text Suggestion
function addCustomTextSuggestion() {
    addCustomTextSuggestionToList('', '', customTextPresetCount);
}

function addCustomTextSuggestionToList(name = '', value = '', index) {
    const list = document.getElementById('customTextSuggestionsList');
    const id = `text-suggestion-${index}`;
    customTextPresetCount = Math.max(customTextPresetCount, index + 1);
    
    const div = document.createElement('div');
    div.className = 'preset-item';
    div.id = id;
    div.innerHTML = `
        <button onclick="document.getElementById('${id}').remove()" class="btn-danger btn-sm">×</button>
        <div class="preset-value">
            <label>Text Value</label>
            <input type="text" placeholder="e.g., AWESOME!" value="${escapeHtml(value)}">
        </div>
    `;
    list.appendChild(div);
}

// Save Capture Settings (per-event)
async function saveCaptureSettings() {
    const statusDiv = document.getElementById('settingsStatus');
    
    if (!currentEvent) {
        statusDiv.textContent = '⚠️ No event selected';
        statusDiv.className = 'status-message error';
        statusDiv.style.display = 'block';
        return;
    }
    
    try {
        const promptMode = document.querySelector('input[name="promptMode"]:checked').value;
        const customTextMode = document.querySelector('input[name="customTextMode"]:checked').value;
        
        const lockedPromptTitle = document.getElementById('lockedPromptTitle').value.trim();
        const lockedPromptValue = document.getElementById('lockedPromptValue').value.trim();
        const lockedCustomTextValue = document.getElementById('lockedCustomTextValue').value.trim();
        
        // Gather prompt presets or suggestions
        const promptPresets = [];
        const listSelector = promptMode === 'suggestions' ? '#promptSuggestionsList' : '#promptPresetsList';
        document.querySelectorAll(`${listSelector} .preset-item`).forEach(item => {
            const name = item.querySelector('.preset-name input').value.trim();
            const value = item.querySelector('.preset-value input').value.trim();
            if (name && value) {
                promptPresets.push({ name, value });
            }
        });
        
        // Gather custom text presets or suggestions
        const customTextPresets = [];
        const textListSelector = customTextMode === 'suggestions' ? '#customTextSuggestionsList' : '#customTextPresetsList';
        document.querySelectorAll(`${textListSelector} .preset-item`).forEach(item => {
            const value = item.querySelector('.preset-value input').value.trim();
            if (value) {
                // Use the text value as both name and value
                customTextPresets.push({ name: value, value: value });
            }
        });
        
        // Validate
        if (promptMode === 'locked') {
            if (!lockedPromptTitle) {
                statusDiv.textContent = '⚠️ Locked prompt requires a title';
                statusDiv.className = 'status-message error';
                statusDiv.style.display = 'block';
                return;
            }
            if (!lockedPromptValue) {
                statusDiv.textContent = '⚠️ Locked prompt requires a value';
                statusDiv.className = 'status-message error';
                statusDiv.style.display = 'block';
                return;
            }
        }
        
        if (customTextMode === 'locked' && !lockedCustomTextValue) {
            statusDiv.textContent = '⚠️ Locked custom text requires a value';
            statusDiv.className = 'status-message error';
            statusDiv.style.display = 'block';
            return;
        }
        
        if (promptMode === 'presets' && promptPresets.length === 0) {
            statusDiv.textContent = '⚠️ Preset mode requires at least one prompt option';
            statusDiv.className = 'status-message error';
            statusDiv.style.display = 'block';
            return;
        }
        
        if (customTextMode === 'presets' && customTextPresets.length === 0) {
            statusDiv.textContent = '⚠️ Preset mode requires at least one text option';
            statusDiv.className = 'status-message error';
            statusDiv.style.display = 'block';
            return;
        }
        
        // Suggestions mode is flexible - no validation needed (can have 0+ suggestions)
        
        // Save to current event
        const response = await fetch(`${API_BASE_URL}/events/${currentEvent._id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                captureSettings: {
                    promptMode,
                    lockedPromptTitle,
                    lockedPromptValue,
                    promptPresets,
                    customTextMode,
                    lockedCustomTextValue,
                    customTextPresets
                }
            })
        });
        
        if (response.ok) {
            const updatedEvent = await response.json();
            currentEvent = updatedEvent;
            captureSettings = updatedEvent.captureSettings;
            statusDiv.textContent = '✓ Settings saved for this event!';
            statusDiv.className = 'status-message success';
            statusDiv.style.display = 'block';
            
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 3000);
        } else {
            const data = await response.json();
            statusDiv.textContent = `❌ ${data.error || 'Failed to save settings'}`;
            statusDiv.className = 'status-message error';
            statusDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Error saving capture settings:', error);
        statusDiv.textContent = `❌ Error: ${error.message}`;
        statusDiv.className = 'status-message error';
        statusDiv.style.display = 'block';
    }
}

// Load capture settings on tab switch
const originalSwitchTab = switchTab;
switchTab = function(tab) {
    originalSwitchTab(tab);
    if (tab === 'settings' && !captureSettings) {
        loadCaptureSettings();
    }
    if (tab === 'branding') {
        loadBrandingSettings();
    }
};

// ===== BRANDING SETTINGS =====

let brandingSettings = null;
let currentLogoFile = null;
let currentLogoDataUrl = null;

// Initialize branding tab
function initBrandingTab() {
    const dropZone = document.getElementById('logoDropZone');
    const fileInput = document.getElementById('logoFileInput');
    const sampleStickerInput = document.getElementById('sampleStickerInput');
    
    // Click to upload logo
    dropZone.addEventListener('click', () => {
        fileInput.click();
    });
    
    // File input change for logo
    fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleLogoFile(e.target.files[0]);
        }
    });
    
    // Drag and drop for logo
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });
    
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleLogoFile(e.dataTransfer.files[0]);
        }
    });
    
    // Sample sticker upload
    sampleStickerInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleSampleStickerFile(e.target.files[0]);
        }
    });
}

// Handle logo file upload
function handleLogoFile(file) {
    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
    if (!validTypes.includes(file.type)) {
        showStatus('Please upload a PNG, JPG, or SVG file', 'error', 'brandingTab');
        return;
    }
    
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
        showStatus('Logo file must be less than 5MB', 'error', 'brandingTab');
        return;
    }
    
    currentLogoFile = file;
    
    // Read file as data URL
    const reader = new FileReader();
    reader.onload = (e) => {
        currentLogoDataUrl = e.target.result;
        displayLogoPreview(e.target.result);
        uploadLogoToServer(e.target.result);
    };
    reader.readAsDataURL(file);
}

// Display logo preview
function displayLogoPreview(dataUrl) {
    document.getElementById('logoDropZone').style.display = 'none';
    document.getElementById('logoPreview').style.display = 'block';
    document.getElementById('logoPreviewImage').src = dataUrl;
    
    // Update preview overlay
    const previewOverlay = document.getElementById('previewLogoOverlay');
    previewOverlay.src = dataUrl;
    previewOverlay.style.display = 'block';
    
    // Hide placeholder
    document.querySelector('.preview-placeholder').style.display = 'none';
    
    updateBrandingPreview();
}

// Upload logo to server
async function uploadLogoToServer(dataUrl) {
    const token = localStorage.getItem('adminToken');
    
    try {
        showStatus('Uploading logo...', 'info', 'brandingTab');
        
        const response = await fetch(`${API_BASE_URL}/events/${currentEvent._id}/branding/logo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ logo: dataUrl })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to upload logo');
        }
        
        const result = await response.json();
        showStatus('✅ Logo uploaded successfully', 'success', 'brandingTab');
        
        // Reload branding settings to get the new logo URL
        await loadBrandingSettings();
        
    } catch (error) {
        console.error('Logo upload error:', error);
        showStatus(`❌ Error: ${error.message}`, 'error', 'brandingTab');
    }
}

// Replace logo
function replaceLogo() {
    document.getElementById('logoFileInput').click();
}

// Remove logo
async function removeLogo() {
    const confirmed = await customConfirm('Are you sure you want to remove the logo?');
    if (!confirmed) return;
    
    const token = localStorage.getItem('adminToken');
    
    try {
        showStatus('Removing logo...', 'info', 'brandingTab');
        
        const response = await fetch(`${API_BASE_URL}/events/${currentEvent._id}/branding/logo`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to remove logo');
        }
        
        showStatus('✅ Logo removed successfully', 'success', 'brandingTab');
        
        // Reset UI
        document.getElementById('logoDropZone').style.display = 'flex';
        document.getElementById('logoPreview').style.display = 'none';
        document.getElementById('previewLogoOverlay').style.display = 'none';
        document.querySelector('.preview-placeholder').style.display = 'block';
        document.getElementById('brandingEnabled').checked = false;
        
        currentLogoFile = null;
        currentLogoDataUrl = null;
        
        await loadBrandingSettings();
        
    } catch (error) {
        console.error('Logo removal error:', error);
        showStatus(`❌ Error: ${error.message}`, 'error', 'brandingTab');
    }
}

// Load branding settings
async function loadBrandingSettings() {
    if (!currentEvent) return;
    
    try {
        // Event already has branding settings embedded
        brandingSettings = currentEvent.brandingSettings || {
            enabled: false,
            logoUrl: '',
            position: { x: 50, y: 10 },
            size: { width: 20, maintainAspectRatio: true },
            opacity: 100
        };
        
        // Update UI
        document.getElementById('brandingEnabled').checked = brandingSettings.enabled || false;
        document.getElementById('positionX').value = brandingSettings.position?.x || 50;
        document.getElementById('positionY').value = brandingSettings.position?.y || 10;
        document.getElementById('logoSize').value = brandingSettings.size?.width || 20;
        document.getElementById('maintainAspectRatio').checked = brandingSettings.size?.maintainAspectRatio !== false;
        document.getElementById('logoOpacity').value = brandingSettings.opacity || 100;
        
        // Update value displays
        document.getElementById('posXValue').textContent = brandingSettings.position?.x || 50;
        document.getElementById('posYValue').textContent = brandingSettings.position?.y || 10;
        document.getElementById('sizeValue').textContent = brandingSettings.size?.width || 20;
        document.getElementById('opacityValue').textContent = brandingSettings.opacity || 100;
        
        // Load logo if exists
        if (brandingSettings.logoUrl) {
            currentLogoDataUrl = brandingSettings.logoUrl;
            displayLogoPreview(brandingSettings.logoUrl);
        } else {
            document.getElementById('logoDropZone').style.display = 'flex';
            document.getElementById('logoPreview').style.display = 'none';
        }
        
    } catch (error) {
        console.error('Error loading branding settings:', error);
        showStatus(`❌ Error loading branding settings: ${error.message}`, 'error', 'brandingTab');
    }
}

// Update branding preview
function updateBrandingPreview() {
    const posX = document.getElementById('positionX').value;
    const posY = document.getElementById('positionY').value;
    const size = document.getElementById('logoSize').value;
    const opacity = document.getElementById('logoOpacity').value;
    
    // Update value displays
    document.getElementById('posXValue').textContent = posX;
    document.getElementById('posYValue').textContent = posY;
    document.getElementById('sizeValue').textContent = size;
    document.getElementById('opacityValue').textContent = opacity;
    
    // Update preview overlay position and size
    const overlay = document.getElementById('previewLogoOverlay');
    if (overlay && overlay.style.display !== 'none') {
        overlay.style.left = `${posX}%`;
        overlay.style.top = `${posY}%`;
        overlay.style.width = `${size}%`;
        overlay.style.opacity = opacity / 100;
        overlay.style.transform = 'translate(-50%, -50%)';
    }
}

// Set logo position (quick presets)
function setLogoPosition(x, y) {
    document.getElementById('positionX').value = x;
    document.getElementById('positionY').value = y;
    updateBrandingPreview();
}

// Toggle branding enabled
function toggleBranding() {
    const enabled = document.getElementById('brandingEnabled').checked;
    
    if (enabled && !currentLogoDataUrl) {
        showStatus('Please upload a logo first', 'error', 'brandingTab');
        document.getElementById('brandingEnabled').checked = false;
        return;
    }
}

// Save branding settings
async function saveBrandingSettings() {
    const token = localStorage.getItem('adminToken');
    
    const settings = {
        enabled: document.getElementById('brandingEnabled').checked,
        position: {
            x: parseFloat(document.getElementById('positionX').value),
            y: parseFloat(document.getElementById('positionY').value)
        },
        size: {
            width: parseFloat(document.getElementById('logoSize').value),
            maintainAspectRatio: document.getElementById('maintainAspectRatio').checked
        },
        opacity: parseFloat(document.getElementById('logoOpacity').value)
    };
    
    try {
        showStatus('Saving branding settings...', 'info', 'brandingTab');
        
        const response = await fetch(`${API_BASE_URL}/events/${currentEvent._id}/branding`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(settings)
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to save branding settings');
        }
        
        const result = await response.json();
        showStatus('✅ Branding settings saved successfully', 'success', 'brandingTab');
        
        // Update current event with new settings
        currentEvent.brandingSettings = result.brandingSettings;
        brandingSettings = result.brandingSettings;
        
    } catch (error) {
        console.error('Save branding settings error:', error);
        showStatus(`❌ Error: ${error.message}`, 'error', 'brandingTab');
    }
}

// Upload sample sticker for preview
function uploadSampleSticker() {
    document.getElementById('sampleStickerInput').click();
}

// Handle sample sticker file
function handleSampleStickerFile(file) {
    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!validTypes.includes(file.type)) {
        showStatus('Please upload a PNG, JPG, or WEBP image', 'error', 'brandingTab');
        return;
    }
    
    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
        showStatus('Sample sticker must be less than 10MB', 'error', 'brandingTab');
        return;
    }
    
    // Read file as data URL
    const reader = new FileReader();
    reader.onload = (e) => {
        displaySampleSticker(e.target.result);
    };
    reader.readAsDataURL(file);
}

// Display sample sticker in preview
function displaySampleSticker(dataUrl) {
    const sampleImg = document.getElementById('previewSampleSticker');
    const placeholder = document.querySelector('.preview-placeholder');
    const clearBtn = document.getElementById('clearSampleBtn');
    
    sampleImg.src = dataUrl;
    sampleImg.style.display = 'block';
    placeholder.style.display = 'none';
    clearBtn.style.display = 'inline-block';
    
    // Ensure logo overlay stays on top if it exists
    updateBrandingPreview();
}

// Clear sample sticker
function clearSampleSticker() {
    const sampleImg = document.getElementById('previewSampleSticker');
    const placeholder = document.querySelector('.preview-placeholder');
    const clearBtn = document.getElementById('clearSampleBtn');
    
    sampleImg.style.display = 'none';
    sampleImg.src = '';
    clearBtn.style.display = 'none';
    
    // Show placeholder if no logo
    if (!currentLogoDataUrl) {
        placeholder.style.display = 'block';
    }
}

// Initialize branding tab when page loads
document.addEventListener('DOMContentLoaded', () => {
    initBrandingTab();
});

// ===== STICKER LIGHTBOX =====

let lightboxStickers = [];
let lightboxCurrentIndex = 0;

function openLightbox(stickers, startIndex = 0) {
    lightboxStickers = stickers;
    lightboxCurrentIndex = startIndex;
    updateLightbox();
    document.getElementById('stickerLightbox').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox(event) {
    if (!event || event.target.id === 'stickerLightbox' || event.target.classList.contains('lightbox-close')) {
        document.getElementById('stickerLightbox').classList.remove('active');
        document.body.style.overflow = 'auto';
        lightboxStickers = [];
        lightboxCurrentIndex = 0;
    }
}

function updateLightbox() {
    if (lightboxStickers.length === 0) return;
    
    const currentSticker = lightboxStickers[lightboxCurrentIndex];
    document.getElementById('lightboxImage').src = currentSticker.url;
    document.getElementById('lightboxCounter').textContent = `${lightboxCurrentIndex + 1} / ${lightboxStickers.length}`;
    
    // Update button states
    document.getElementById('prevBtn').disabled = lightboxCurrentIndex === 0;
    document.getElementById('nextBtn').disabled = lightboxCurrentIndex === lightboxStickers.length - 1;
}

function previousSticker() {
    if (lightboxCurrentIndex > 0) {
        lightboxCurrentIndex--;
        updateLightbox();
    }
}

function nextSticker() {
    if (lightboxCurrentIndex < lightboxStickers.length - 1) {
        lightboxCurrentIndex++;
        updateLightbox();
    }
}

function downloadCurrentSticker() {
    if (lightboxStickers.length === 0) return;
    
    const currentSticker = lightboxStickers[lightboxCurrentIndex];
    downloadImageFromUrl(currentSticker.url, currentSticker.filename);
}

// Keyboard navigation for lightbox
document.addEventListener('keydown', (e) => {
    const lightbox = document.getElementById('stickerLightbox');
    if (lightbox.classList.contains('active')) {
        if (e.key === 'Escape') {
            closeLightbox();
        } else if (e.key === 'ArrowLeft') {
            previousSticker();
        } else if (e.key === 'ArrowRight') {
            nextSticker();
        }
    }
});

