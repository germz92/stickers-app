async function submitPasswordReset() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const message = document.getElementById('resetMessage');
    const btn = document.getElementById('resetBtn');
    const password = document.getElementById('resetPassword').value;
    const confirm = document.getElementById('resetPasswordConfirm').value;

    message.className = '';
    message.textContent = '';

    if (!token) {
        message.className = 'invite-error';
        message.textContent = 'Missing reset token. Open the link from your email.';
        return;
    }
    if (!password || password.length < 8) {
        message.className = 'invite-error';
        message.textContent = 'Password must be at least 8 characters.';
        return;
    }
    if (password !== confirm) {
        message.className = 'invite-error';
        message.textContent = 'Passwords do not match.';
        return;
    }

    btn.disabled = true;
    try {
        const response = await fetch(`${API_BASE_URL}/auth/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not reset password');

        message.className = 'invite-success';
        message.textContent = 'Password updated. Redirecting to login…';
        setTimeout(() => {
            window.location.href = '/admin.html';
        }, 800);
    } catch (error) {
        message.className = 'invite-error';
        message.textContent = error.message;
        btn.disabled = false;
    }
}

document.getElementById('resetPasswordConfirm')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitPasswordReset();
});
