// API Configuration
// Automatically detect environment
const isLocalhost = window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' ||
                    window.location.hostname.includes('192.168.');

const API_BASE_URL = isLocalhost ? 'http://localhost:3000/api' : '/api';

// Log for debugging
console.log('🌐 Environment Detection:', {
    hostname: window.location.hostname,
    isLocalhost: isLocalhost,
    API_BASE_URL: API_BASE_URL
});
