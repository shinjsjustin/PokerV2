function loginApp() {
    return {
        form: {
            username: '',
            password: ''
        },
        loading: false,
        message: '',
        messageType: '',

        init() {
            // Redirect if already logged in
            if (getAuthToken()) {
                window.location.href = 'home.html';
            }
        },

        showMessage(text, type = 'error') {
            this.message = text;
            this.messageType = type;
            setTimeout(() => {
                this.message = '';
            }, 5000);
        },

        async handleLogin() {
            if (!this.form.username || !this.form.password) {
                this.showMessage('Please fill in all fields');
                return;
            }

            this.loading = true;
            this.message = '';

            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(this.form)
                });

                const data = await response.json();

                if (response.ok) {
                    // Store token and user info
                    localStorage.setItem('authToken', data.token);
                    localStorage.setItem('userData', JSON.stringify(data.player));

                    this.showMessage('Login successful! Redirecting...', 'success');

                    // Redirect to home page
                    setTimeout(() => {
                        window.location.href = 'home.html';
                    }, 1000);
                } else {
                    this.showMessage(data.message || 'Login failed');
                }
            } catch (error) {
                console.error('Login error:', error);
                this.showMessage('Network error. Please try again.');
            } finally {
                this.loading = false;
            }
        }
    }
}