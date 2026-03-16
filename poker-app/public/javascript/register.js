function registerApp() {
    return {
        form: {
            username: '',
            email: '',
            password: '',
            confirmPassword: ''
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

        validateForm() {
            if (!this.form.username || !this.form.email || !this.form.password || !this.form.confirmPassword) {
                this.showMessage('Please fill in all fields');
                return false;
            }

            if (this.form.username.length < 3) {
                this.showMessage('Username must be at least 3 characters long');
                return false;
            }

            if (this.form.password.length < 6) {
                this.showMessage('Password must be at least 6 characters long');
                return false;
            }

            if (this.form.password !== this.form.confirmPassword) {
                this.showMessage('Passwords do not match');
                return false;
            }

            // Basic email validation
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(this.form.email)) {
                this.showMessage('Please enter a valid email address');
                return false;
            }

            return true;
        },

        async handleRegister() {
            if (!this.validateForm()) {
                return;
            }

            this.loading = true;
            this.message = '';

            try {
                const response = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        username: this.form.username,
                        email: this.form.email,
                        password: this.form.password
                    })
                });

                const data = await response.json();

                if (response.ok) {
                    // Store token and user info
                    localStorage.setItem('authToken', data.token);
                    localStorage.setItem('userData', JSON.stringify(data.player));

                    this.showMessage('Account created successfully! Redirecting...', 'success');

                    // Redirect to home page
                    setTimeout(() => {
                        window.location.href = 'home.html';
                    }, 1000);
                } else {
                    this.showMessage(data.message || 'Registration failed');
                }
            } catch (error) {
                console.error('Registration error:', error);
                this.showMessage('Network error. Please try again.');
            } finally {
                this.loading = false;
            }
        }
    }
}