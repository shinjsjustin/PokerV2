/**
 * Authentication utility functions
 */

// Get the authentication token from localStorage
function getAuthToken() {
    return localStorage.getItem('authToken');
}

// Get user data from localStorage
function getUserData() {
    const userData = localStorage.getItem('userData');
    return userData ? JSON.parse(userData) : null;
}

// Check if user is authenticated
function isAuthenticated() {
    const token = getAuthToken();
    if (!token) return false;
    
    // Check if token is expired (basic check)
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const currentTime = Date.now() / 1000;
        return payload.exp > currentTime;
    } catch (error) {
        console.error('Invalid token format:', error);
        return false;
    }
}

// Clear authentication data
function clearAuth() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('userData');
}

// Make authenticated API requests
async function authenticatedFetch(url, options = {}) {
    const token = getAuthToken();
    if (!token) {
        throw new Error('No authentication token found');
    }
    
    const defaultOptions = {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers
        }
    };
    
    const response = await fetch(url, { ...options, ...defaultOptions });
    
    // If token is expired, clear auth and redirect
    if (response.status === 401) {
        clearAuth();
        window.location.href = 'index.html';
        return;
    }
    
    return response;
}

// Handle token expiration globally
function setupTokenExpirationHandler() {
    const token = getAuthToken();
    if (!token) return;
    
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const expirationTime = payload.exp * 1000; // Convert to milliseconds
        const currentTime = Date.now();
        const timeUntilExpiration = expirationTime - currentTime;
        
        if (timeUntilExpiration > 0) {
            // Set a timeout to handle expiration
            setTimeout(() => {
                alert('Your session has expired. Please log in again.');
                clearAuth();
                window.location.href = 'index.html';
            }, timeUntilExpiration);
        } else {
            // Token already expired
            clearAuth();
            window.location.href = 'index.html';
        }
    } catch (error) {
        console.error('Error parsing token:', error);
        clearAuth();
        window.location.href = 'index.html';
    }
}

// Initialize token expiration handler on page load
document.addEventListener('DOMContentLoaded', () => {
    if (getAuthToken()) {
        setupTokenExpirationHandler();
    }
});

// Global error handler for network requests
window.addEventListener('unhandledrejection', (event) => {
    console.error('Network error:', event.reason);
});

// Utility functions for common operations
const AuthUtils = {
    // Format user display name
    formatUserName(user) {
        return user.username || user.email || 'User';
    },
    
    // Get user avatar (can be extended later)
    getUserAvatar(user) {
        // For now, return a default avatar based on username
        const letter = (user.username || user.email || 'U').charAt(0).toUpperCase();
        return `data:image/svg+xml;base64,${btoa(`
            <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                <circle cx="20" cy="20" r="20" fill="#4F46E5"/>
                <text x="20" y="28" text-anchor="middle" fill="white" font-size="16" font-family="Arial">${letter}</text>
            </svg>
        `)}`;
    },
    
    // Validate email format
    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    },
    
    // Validate password strength
    isValidPassword(password) {
        return password && password.length >= 6;
    },
    
    // Generate random username suggestion
    generateUsernameSuggestion() {
        const adjectives = ['Lucky', 'Bold', 'Swift', 'Sharp', 'Clever', 'Brave'];
        const nouns = ['Player', 'Gamer', 'Champion', 'Winner', 'Pro', 'Ace'];
        const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)];
        const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
        const randomNumber = Math.floor(Math.random() * 1000);
        return `${randomAdjective}${randomNoun}${randomNumber}`;
    }
};

// Export for use in other scripts (if using modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getAuthToken,
        getUserData,
        isAuthenticated,
        clearAuth,
        authenticatedFetch,
        setupTokenExpirationHandler,
        AuthUtils
    };
}